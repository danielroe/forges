import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it } from 'vitest'
import { MergeMethodRequiredError, UnsupportedOperationError } from '../../src/errors.ts'
import { gitee } from '../../src/gitee/index.ts'
import { toCommit } from '../../src/gitee/normalise.ts'
import { verifyGiteeToken } from '../../src/gitee/webhooks.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const repo = { forge: 'gitee', instance: 'gitee.com', owner: 'acme', name: 'widgets' } as const
const pull = { forge: 'gitee', instance: 'gitee.com', repo, kind: 'pull_request', number: '7' } as const
const issue = { forge: 'gitee', instance: 'gitee.com', repo, kind: 'issue', number: 'I8ABCD' } as const

async function sign(secret: string, timestamp: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${secret}`)))))
}

describe('gitee', () => {
  it('reads commit parents as a repository commit or a pull request commit lists them', () => {
    expect(toCommit(repo, { sha: 'c', parents: [{ sha: 'a' }, { sha: 'b' }] }).parents).toEqual(['a', 'b'])
    expect(toCommit(repo, { sha: 'c', parents: { sha: 'a', shas: ['a', 'b'] } }).parents).toEqual(['a', 'b'])
    expect(toCommit(repo, { sha: 'c', parents: { sha: 'a' } }).parents).toEqual(['a'])
  })

  it('searches repositories by best match unless a sort Gitee supports is asked for', async () => {
    const urls: string[] = []
    const forge = gitee({ fetch: async (url) => {
      urls.push(url)
      return Response.json([])
    } }).create()

    await forge.search.reposPage({ text: 'widgets' })
    const created = await forge.search.reposPage({ text: 'widgets', sort: 'created' })
    await forge.search.reposPage({ text: 'widgets', sort: 'stars' })

    expect(urls.map(url => new URL(url).searchParams.get('sort'))).toEqual([null, null, 'stars_count'])
    expect(created.warnings).toContainEqual(expect.objectContaining({ code: 'sort_unsupported' }))
  })

  it('reports the total Gitee sends in `total_count`, falling back to `total_page`', async () => {
    const branch = { name: 'main', commit: { sha: 'a' } }
    const counted = gitee({ fetch: async () => Response.json([branch], { headers: { total_count: '15', total_page: '5' } }) }).create()
    const paged = gitee({ fetch: async () => Response.json([branch], { headers: { total_page: '5' } }) }).create()

    const countedPage = await counted.contents.branchesPage(repo, { perPage: 3 })
    const pagedPage = await paged.contents.branchesPage(repo, { perPage: 3 })

    expect(countedPage.total).toBe(15)
    expect(pagedPage.total).toBe(15)
  })

  it('leaves `aheadBy` unset when Gitee truncates the commits of a comparison', async () => {
    const commits = (length: number) => Array.from({ length }, (_, index) => ({ sha: `c${index}`, parents: [] }))
    const compare = (body: object) => gitee({ fetch: async () => Response.json(body) }).create().contents.compare(repo, 'main', 'dev')

    expect((await compare({ commits: commits(100), files: [], truncated: true })).aheadBy).toBeUndefined()
    expect((await compare({ commits: commits(78), files: [], truncated: true })).aheadBy).toBe(78)
    expect((await compare({ commits: commits(100), files: [], truncated: false })).aheadBy).toBe(100)
  })

  it('keeps the cursor page size when reporting a fallback total', async () => {
    const forge = gitee({ fetch: async url => new URL(url).searchParams.get('page') === '1'
      ? Response.json(Array.from({ length: 10 }, (_, index) => ({ name: `b${index}`, commit: { sha: 'a' } })), { headers: { total_page: '2' } })
      : Response.json([{ name: 'last', commit: { sha: 'a' } }], { headers: { total_page: '2' } }) }).create()

    const first = await forge.contents.branchesPage(repo, { perPage: 10 })
    const second = await forge.contents.branchesPage(repo, { cursor: first.cursor })

    // Both pages come from a 10-per-page listing, not this call's 50 default.
    expect(first.total).toBe(20)
    expect(second.total).toBe(20)
  })

  it('does not report one phase total for a multi-phase thread listing', async () => {
    const forge = gitee({ fetch: async () => Response.json([], { headers: { total_count: '5' } }) }).create()

    // Issues split into open and progressing phases, so no single total.
    const multi = await forge.threads.listPage(repo, { kind: 'issue', state: 'open' })
    // Pull requests page in one phase, so their total is the listing's.
    const single = await forge.threads.listPage(repo, { kind: 'pull_request', state: 'open' })

    expect(multi.total).toBeUndefined()
    expect(single.total).toBe(5)
  })

  it('pages contributors from the whole list Gitee returns', async () => {
    const urls: string[] = []
    const forge = gitee({ fetch: async (url) => {
      if (urls.push(url) > 5) {
        return new Response(null, { status: 500 })
      }
      return Response.json(Array.from({ length: 60 }, (_, index) => ({ name: `author ${index}`, email: '', contributions: 60 - index })))
    } }).create()

    const all = await Array.fromAsync(forge.repos.contributors(repo))
    expect(urls).toHaveLength(1)
    const exact = await Array.fromAsync(forge.repos.contributors(repo, { perPage: 60 }))
    const pages = await Array.fromAsync(forge.repos.contributors(repo, { perPage: 25 }))

    expect(all.map(item => item.name)).toEqual(Array.from({ length: 60 }, (_, index) => `author ${index}`))
    expect(exact).toEqual(all)
    expect(pages).toEqual(all)
    expect(all[0]!.email).toBeUndefined()
    expect(urls).toHaveLength(5)
  })

  it('sends the token in the Authorization header, never the URL', async () => {
    const { fetch, calls } = fixtureFetch('gitee')
    await gitee({ auth: { type: 'token', token: 'gitee-token' }, fetch }).create().repos.get(repo)

    expect(calls[0]!.authorization).toBe('token gitee-token')
    expect(calls[0]!.url).not.toContain('access_token')
  })

  it('passes the caller\'s signal to the fallback list when the flagged release is a prerelease', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const urls: string[] = []
    let markListStarted!: () => void
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve
    })
    const fetch: FetchLike = async (url, init) => {
      urls.push(url)
      if (url.endsWith('/releases/latest')) {
        return Response.json({ id: 2, tag_name: 'v2.0.0-beta', prerelease: true, created_at: '2025-01-02T00:00:00Z' })
      }
      markListStarted()
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })
    }
    const provider = gitee({ auth: { type: 'token', token: 't' }, fetch }).create()

    const pending = provider.releases.latest(repo, { signal: controller.signal })
    await listStarted
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(urls.at(-1)).toContain('/releases?')
  })

  it('verifies signed webhooks as well as passwords', async () => {
    const timestamp = String(Date.now())
    const signature = await sign('s3cret', timestamp)
    const stale = String(Date.now() - 7_200_000)

    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': signature, 'x-gitee-timestamp': timestamp }, body: '{}' }, 's3cret')).toBe(true)
    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': encodeURIComponent(signature), 'x-gitee-timestamp': timestamp }, body: '{}' }, 's3cret')).toBe(true)
    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': signature, 'x-gitee-timestamp': '1' }, body: '{}' }, 's3cret')).toBe(false)
    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': await sign('s3cret', stale), 'x-gitee-timestamp': stale }, body: '{}' }, 's3cret')).toBe(false)
    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': 's3cret' }, body: '{}' }, 's3cret')).toBe(true)
  })

  it('approves through the review endpoint, then merges with the requested method', async () => {
    const { fetch, calls } = fixtureFetch('gitee')
    await gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.approveAndMerge!(pull, { method: 'squash' })

    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /api/v5/repos/acme/widgets/pulls/7/review', 'PUT /api/v5/repos/acme/widgets/pulls/7/merge'])
    expect(JSON.parse(calls[1]!.body!)).toEqual({ merge_method: 'squash' })
    await expect(gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.approveAndMerge!(pull)).rejects.toThrow(MergeMethodRequiredError)
  })

  it('merges without approving, sending `message` as the description', async () => {
    const { fetch, calls } = fixtureFetch('gitee')
    await expect(gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.merge!(pull, { method: 'merge', message: 'Ship it' })).resolves.toEqual({
      status: 'merged',
      sha: 'feedfacefeedfacefeedfacefeedfacefeedface',
      raw: { sha: 'feedfacefeedfacefeedfacefeedfacefeedface', merged: true, message: 'Pull Request 已成功合并' },
    })

    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['PUT /api/v5/repos/acme/widgets/pulls/7/merge'])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ merge_method: 'merge', description: 'Ship it' })
  })

  it('sends `title` as the merge title', async () => {
    const { fetch, calls } = fixtureFetch('gitee')
    await gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.merge!(pull, { method: 'squash', title: 'Release widgets (!7)', message: 'Ship it' })

    expect(JSON.parse(calls[0]!.body!)).toEqual({ merge_method: 'squash', title: 'Release widgets (!7)', description: 'Ship it' })
  })

  it('writes issues through the owner-scoped endpoint and refuses several assignees', async () => {
    const { fetch, calls } = fixtureFetch('gitee', {
      'PATCH https://gitee.com/api/v5/repos/acme/issues/I8ABCD': { status: 200, body: { id: 7001, number: 'I8ABCD', state: 'closed', title: 'x' } },
    })
    const provider = gitee({ auth: { type: 'token', token: 't' }, fetch }).create()
    await provider.threads.close!(issue)

    expect(calls[0]).toMatchObject({ method: 'PATCH', url: 'https://gitee.com/api/v5/repos/acme/issues/I8ABCD' })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ repo: 'widgets', state: 'closed' })
    await expect(provider.threads.setAssignees!(issue, ['ada', 'grace'])).rejects.toThrow(UnsupportedOperationError)
  })
})

describe('gitee label filters', () => {
  const repository = { id: 1, path: 'widgets', name: 'widgets', full_name: 'acme/widgets', namespace: { path: 'acme' }, owner: { login: 'acme' } }
  const issues = [
    { id: 1, number: 'I1', title: 'Both', state: 'open', labels: [{ name: 'bug' }, { name: 'ui' }], repository },
    { id: 2, number: 'I2', title: 'One', state: 'open', labels: [{ name: 'bug' }], repository },
  ]
  const provider = gitee({ auth: { type: 'token', token: 't' }, fetch: async () => Response.json(issues) }).create()

  it('lists only threads carrying every label', async () => {
    const page = await provider.threads.listPage(repo, { kind: 'issue', labels: ['bug', 'ui'] })

    expect(page.items.map(thread => thread.title)).toEqual(['Both'])
  })

  it('searches only threads carrying every label', async () => {
    const page = await provider.search.threadsPage({ repo, labels: ['bug', 'ui'] })

    expect(page.items.map(thread => thread.title)).toEqual(['Both'])
  })
})

describe('gitee thread updates', () => {
  function provider(overrides = {}) {
    const { fetch, calls } = fixtureFetch('gitee', overrides)
    return { instance: gitee({ auth: { type: 'token', token: 't' }, fetch }).create(), calls }
  }

  it('closes, relabels and reassigns an issue in one request', async () => {
    const { instance, calls } = provider({ 'PATCH https://gitee.com/api/v5/repos/acme/issues/I8ABCD': { status: 200, body: { number: 'I8ABCD', state: 'closed', title: 'Retry uploads' } } })
    await instance.threads.update(issue, { state: 'closed', labels: ['bug', 'ui'], assignees: [] })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH https://gitee.com/api/v5/repos/acme/issues/I8ABCD'])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ repo: 'widgets', state: 'closed', labels: 'bug,ui', assignee: '' })
  })

  it('closes and relabels a pull request in one request', async () => {
    const { instance, calls } = provider()
    await instance.threads.update(pull, { title: 'Retry uploads', state: 'closed', labels: ['bug'] })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH https://gitee.com/api/v5/repos/acme/widgets/pulls/7'])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'Retry uploads', state: 'closed', labels: 'bug' })
  })

  it.each([
    [issue, ['jane', 'joe'], 'single assignee'],
    [pull, ['jane'], 'reviewers, not assignees'],
  ] as const)('refuses assignees it cannot set on %j before it writes anything', async (thread, assignees, message) => {
    const { instance, calls } = provider()

    await expect(instance.threads.update(thread, { state: 'closed', assignees: [...assignees] })).rejects.toThrow(message)
    expect(calls).toEqual([])
  })
})

describe('gitee labels', () => {
  it.each([['setLabels', 'PUT'], ['addLabels', 'POST']] as const)('resolves %s with the labels in the response', async (verb, method) => {
    const { fetch, calls } = fixtureFetch('gitee', { [`${method} https://gitee.com/api/v5/repos/acme/widgets/pulls/7/labels`]: { status: 200, body: [{ id: 1, name: 'bug', color: 'd73a4a' }, { id: 2, name: 'triage' }] } })

    await expect(gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads[verb](pull, ['bug'])).resolves.toEqual([{ name: 'bug', colour: 'd73a4a' }, { name: 'triage' }])
    expect(calls).toHaveLength(1)
  })

  it('reads the labels after removing some, as the delete response has no body', async () => {
    const { fetch, calls } = fixtureFetch('gitee', {
      'DELETE https://gitee.com/api/v5/repos/acme/widgets/pulls/7/labels/bug': { status: 204 },
      'GET https://gitee.com/api/v5/repos/acme/widgets/pulls/7/labels': { status: 200, body: [{ id: 2, name: 'triage', color: 'ededed' }] },
    })

    await expect(gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.removeLabels(pull, ['bug'])).resolves.toEqual([{ name: 'triage', colour: 'ededed' }])
    expect(calls.map(call => call.method)).toEqual(['DELETE', 'GET'])
  })
})

describe('gitee state changes', () => {
  it('resolves with the issue or pull request in the response', async () => {
    const issue = { ...pull, kind: 'issue', number: 'I7' } as const
    const { fetch, calls } = fixtureFetch('gitee', {
      'PATCH https://gitee.com/api/v5/repos/acme/issues/I7': { status: 200, body: { number: 'I7', title: 'Crash', state: 'closed' } },
      [`PATCH https://gitee.com/api/v5/repos/acme/widgets/pulls/${pull.number}`]: { status: 200, body: { number: Number(pull.number), title: 'Add widgets', state: 'closed', head: { ref: 'feat' }, base: { ref: 'main' } } },
    })
    const provider = gitee({ auth: { type: 'token', token: 't' }, fetch }).create()

    await expect(provider.threads.close(issue)).resolves.toMatchObject({ kind: 'issue', title: 'Crash', state: 'closed' })
    await expect(provider.threads.close(pull)).resolves.toMatchObject({ kind: 'pull_request', title: 'Add widgets', state: 'closed', branches: { head: { ref: 'feat' }, base: { ref: 'main' } } })
    expect(calls.map(call => call.method)).toEqual(['PATCH', 'PATCH'])
  })
})

describe('gitee assignees', () => {
  it('resolves setAssignees with the assignee of the issue in the response', async () => {
    const issue = { ...pull, kind: 'issue', number: 'I7' } as const
    const { fetch, calls } = fixtureFetch('gitee', { 'PATCH https://gitee.com/api/v5/repos/acme/issues/I7': { status: 200, body: { number: 'I7', assignee: { id: 3, login: 'ada' } } } })

    await expect(gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.setAssignees(issue, ['ada'])).resolves.toMatchObject([{ login: 'ada', id: '3' }])
    expect(calls).toHaveLength(1)
  })
})
