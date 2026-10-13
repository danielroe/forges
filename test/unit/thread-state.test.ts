import type { FetchLike } from '../../src/fetch.ts'
import type { ResolvedThreadRef } from '../../src/model.ts'
import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { toPullThread as toAzurePull } from '../../src/azure-devops/normalise.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { toPullThread as toBitbucketPull } from '../../src/bitbucket/normalise.ts'
import { toThread as toOriginThread } from '../../src/cursor-origin/normalise.ts'
import { fake } from '../../src/fake/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { toThread as toGitLabThread } from '../../src/gitlab/normalise.ts'
import { toThread as toTangledThread } from '../../src/tangled/normalise.ts'

const auth = { type: 'token', token: 't' } as const

function capture(body: (url: URL) => unknown): { fetch: FetchLike, urls: URL[] } {
  const urls: URL[] = []
  return {
    urls,
    fetch: async (input) => {
      const url = new URL(input)
      urls.push(url)
      return Response.json(body(url))
    },
  }
}

describe('listing merged pull requests', () => {
  it('lists nothing for issues, without a request', async () => {
    const { fetch, urls } = capture(() => [])
    const provider = gitlab({ auth, fetch }).create()

    expect(await provider.threads.listPage({ forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: 'widgets' }, { kind: 'issue', state: 'merged' })).toEqual({ items: [] })
    expect(urls).toEqual([])
  })

  it('lists pull requests only when no kind is given', async () => {
    const { fetch, urls } = capture(() => [])
    await gitlab({ auth, fetch }).create().threads.listPage({ forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: 'widgets' }, { state: 'merged' })

    expect(urls.map(url => url.pathname)).toEqual(['/api/v4/projects/acme%2Fwidgets/merge_requests'])
    expect(urls[0]!.searchParams.get('state')).toBe('merged')
  })

  it('reads merged GitHub pull requests from search', async () => {
    const { fetch, urls } = capture(() => ({ items: [{ number: 7, title: 'Fix', state: 'closed', user: { login: 'a' }, pull_request: { merged_at: '2026-01-01T00:00:00Z' } }] }))
    const page = await github({ fetch }).create().threads.listPage({ forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }, { state: 'merged', labels: ['bug'] })

    expect(urls[0]!.pathname).toBe('/search/issues')
    expect(urls[0]!.searchParams.get('q')).toBe('repo:acme/widgets is:pr label:"bug" is:merged')
    expect(urls[0]!.searchParams.get('sort')).toBe('created')
    expect(page.items.map(thread => [thread.ref.kind, thread.state])).toEqual([['pull_request', 'merged']])
  })

  it('asks Bitbucket for the merged state', async () => {
    const { fetch, urls } = capture(() => ({ values: [] }))
    await bitbucket({ auth, fetch }).create().threads.listPage({ forge: 'bitbucket', instance: 'bitbucket.org', owner: 'acme', name: 'widgets' }, { state: 'merged' })

    expect(urls[0]!.searchParams.getAll('state')).toEqual(['MERGED'])
  })

  it('asks Azure DevOps for completed pull requests', async () => {
    const { fetch, urls } = capture(() => ({ value: [] }))
    await azureDevOps({ auth, organization: 'acme', fetch }).create().threads.listPage({ forge: 'azure-devops', instance: 'dev.azure.com', owner: 'acme/Widgets', name: 'widgets' }, { state: 'merged' })

    expect(urls.map(url => url.searchParams.get('searchCriteria.status'))).toEqual(['completed'])
  })

  it('keeps only merged pull requests from a Forgejo closed listing', async () => {
    const { fetch, urls } = capture(() => [
      { number: 1, title: 'Merged', state: 'closed', pull_request: { merged: true } },
      { number: 2, title: 'Closed', state: 'closed', pull_request: { merged: false } },
    ])
    const page = await forgejo({ auth, fetch, baseUrl: 'https://codeberg.org' }).create().threads.listPage({ forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, { state: 'merged' })

    expect(urls[0]!.searchParams.get('state')).toBe('closed')
    expect(urls[0]!.searchParams.get('type')).toBe('pulls')
    expect(page.items.map(thread => thread.ref.number)).toEqual(['1'])
  })

  it('filters the fake forge by merged state', async () => {
    const provider = fake({
      seed: {
        repos: [{ repo: 'acme/widgets' }],
        threads: [
          { repo: 'acme/widgets', kind: 'pull_request', title: 'Merged', state: 'merged' },
          { repo: 'acme/widgets', kind: 'pull_request', title: 'Closed', state: 'closed' },
        ],
      },
    }).create()

    const page = await provider.threads.listPage({ forge: 'fake', instance: provider.instance, owner: 'acme', name: 'widgets' }, { state: 'merged' })

    expect(page.items.map(thread => thread.title)).toEqual(['Merged'])
  })

  it('reports merged GitHub pull requests as merged when listed from the pulls API', async () => {
    const { fetch, urls } = capture(url => url.pathname.endsWith('/pulls')
      ? [
          { number: 1, title: 'Merged', state: 'closed', merged_at: '2026-01-01T00:00:00Z', head: { ref: 'a', sha: 'b' }, base: { ref: 'main', sha: 'c' } },
          { number: 2, title: 'Closed', state: 'closed', merged_at: null, head: { ref: 'd', sha: 'e' }, base: { ref: 'main', sha: 'c' } },
        ]
      : {})
    const page = await github({ fetch }).create().threads.listPage({ forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }, { kind: 'pull_request', state: 'closed' })

    expect(urls[0]!.pathname).toBe('/repos/acme/widgets/pulls')
    expect(page.items.map(thread => [thread.ref.number, thread.state])).toEqual([['1', 'merged'], ['2', 'closed']])
  })

  it('reads on past pages that hold no merged pull requests', async () => {
    const urls: URL[] = []
    const fetch: FetchLike = async (input) => {
      const url = new URL(input)
      urls.push(url)
      const second = url.searchParams.get('page') === '2'
      return Response.json(
        [{ number: second ? 2 : 1, title: second ? 'Merged' : 'Closed', state: 'closed', pull_request: { merged: second } }],
        second ? {} : { headers: { link: `<${url.origin}${url.pathname}?state=closed&type=pulls&page=2>; rel="next"` } },
      )
    }
    const page = await forgejo({ auth, fetch, baseUrl: 'https://codeberg.org' }).create().threads.listPage({ forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, { state: 'merged' })

    expect(urls).toHaveLength(2)
    expect(page.items.map(thread => thread.ref.number)).toEqual(['2'])
    expect(page.cursor).toBeUndefined()
  })

  it('stops reading after ten empty pages and hands back the cursor', async () => {
    let reads = 0
    const fetch: FetchLike = async (input) => {
      const url = new URL(input)
      reads++
      return Response.json([{ number: reads, title: 'Closed', state: 'closed', pull_request: { merged: false } }], { headers: { link: `<${url.origin}${url.pathname}?page=${reads + 1}>; rel="next"` } })
    }
    const page = await forgejo({ auth, fetch, baseUrl: 'https://codeberg.org' }).create().threads.listPage({ forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, { state: 'merged' })

    expect(reads).toBe(10)
    expect(page.items).toEqual([])
    expect(page.cursor).toBeDefined()
  })
})

describe('merge details', () => {
  const pullRef = (forge: string, instance: string): ResolvedThreadRef => ({ forge, instance, repo: { forge, instance, owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '7' })

  it('reports who merged a Bitbucket pull request, but not who declined one', () => {
    const ref = pullRef('bitbucket', 'bitbucket.org')
    const raw = { id: 7, title: 'Fix', closed_by: { uuid: '{1}', nickname: 'merger' } }

    expect(toBitbucketPull(ref, { ...raw, state: 'MERGED' }).mergedBy?.login).toBe('merger')
    expect(toBitbucketPull(ref, { ...raw, state: 'DECLINED' }).mergedBy).toBeUndefined()
  })

  it('reads the completion of an Azure DevOps pull request as its merge, but not an abandonment', () => {
    const ref = pullRef('azure-devops', 'dev.azure.com')
    const raw = { pullRequestId: 7, title: 'Fix', sourceRefName: 'refs/heads/fix', targetRefName: 'refs/heads/main', repository: { id: 'r', name: 'widgets', project: { id: 'p', name: 'Widgets' } }, closedDate: '2026-01-02T00:00:00Z', closedBy: { id: 'u', uniqueName: 'merger' } }

    expect(toAzurePull(ref, { ...raw, status: 'completed' })).toMatchObject({ mergedAt: new Date('2026-01-02T00:00:00Z'), mergedBy: { login: 'merger' } })
    expect(toAzurePull(ref, { ...raw, status: 'abandoned' })).toMatchObject({ mergedAt: undefined, mergedBy: undefined })
  })

  it('prefers the GitLab merge user, and reads no merge for an issue', () => {
    const ref = pullRef('gitlab', 'gitlab.com')
    const raw = { iid: 7, title: 'Fix', state: 'merged', merged_at: '2026-01-02T00:00:00Z', merge_user: { id: 1, username: 'merger' }, merged_by: { id: 2, username: 'deprecated' } }

    expect(toGitLabThread(ref, raw)).toMatchObject({ mergedAt: new Date('2026-01-02T00:00:00Z'), mergedBy: { login: 'merger' } })
    expect(toGitLabThread(ref, { ...raw, merge_user: null }).mergedBy?.login).toBe('deprecated')
    expect(toGitLabThread({ ...ref, kind: 'issue' }, raw)).toMatchObject({ mergedAt: undefined, mergedBy: undefined })
  })

  it('reads when a Cursor Origin pull request was merged', () => {
    expect(toOriginThread(pullRef('cursor-origin', 'api.cursor.com'), { id: 'pr_7', number: '7', state: 'closed', merged: true, title: 'Fix', mergedAt: '2026-01-02T00:00:00Z' }).mergedAt).toEqual(new Date('2026-01-02T00:00:00Z'))
  })

  it('dates a Tangled merge by its state record', () => {
    const ref = pullRef('tangled', 'tangled.org')
    const record = { title: 'Fix', target: { repo: 'did:plc:repo', branch: 'main' }, createdAt: '2026-01-01T00:00:00Z' }
    const author = { forge: 'tangled', instance: 'tangled.org', login: 'alice', id: 'did:plc:alice', isBotHint: false }

    expect(toTangledThread(ref, record, author, { token: 'merged', at: '2026-01-02T00:00:00Z' }, 0).mergedAt).toEqual(new Date('2026-01-02T00:00:00Z'))
    expect(toTangledThread(ref, record, author, { token: 'closed', at: '2026-01-02T00:00:00Z' }, 0).mergedAt).toBeUndefined()
  })

  it('records the merge on the fake forge', async () => {
    const provider = fake({ viewer: 'merger', seed: { repos: [{ repo: 'acme/widgets' }], threads: [{ repo: 'acme/widgets', kind: 'pull_request', title: 'Fix' }] } }).create()
    const [thread] = (await provider.threads.listPage({ forge: 'fake', instance: provider.instance, owner: 'acme', name: 'widgets' }, { kind: 'pull_request' })).items
    await provider.threads.merge(thread!.ref)

    expect(await provider.threads.get(thread!.ref)).toMatchObject({ state: 'merged', mergedAt: expect.any(Date), mergedBy: { login: 'merger' } })
  })
})
