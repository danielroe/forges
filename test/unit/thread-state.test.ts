import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { fake } from '../../src/fake/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'

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
