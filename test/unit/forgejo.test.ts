import { describe, expect, it } from 'vitest'
import { NotFoundError, TokenRevokedError, UnsupportedOperationError } from '../../src/errors.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitea } from '../../src/gitea/index.ts'
import { contentsFile, contentsListing, fixtureFetch, hangingFetch } from '../utils/fixtures.ts'

function provider(overrides = {}) {
  const { fetch, calls } = fixtureFetch('forgejo', overrides)
  return { instance: forgejo({ auth: { type: 'token', token: 't' }, fetch }).create(), calls }
}

describe('forgejo provider', () => {
  it('appends the api prefix to an instance root', () => {
    const codeberg = forgejo({ auth: { type: 'token', token: 't' } }).create()
    const selfHosted = forgejo({ baseUrl: 'https://git.example.org/', auth: { type: 'token', token: 't' } }).create()

    expect(codeberg.baseUrl).toBe('https://codeberg.org/api/v1')
    expect(codeberg.instance).toBe('codeberg.org')
    expect(selfHosted.baseUrl).toBe('https://git.example.org/api/v1')
  })

  it('emulates done as read plus unsubscribe', async () => {
    const { instance, calls } = provider()

    await instance.notifications!.markDone!({ forge: 'forgejo', instance: 'codeberg.org', id: '5512' })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'PATCH https://codeberg.org/api/v1/notifications/threads/5512?to-status=read',
      'GET https://codeberg.org/api/v1/notifications/threads/5512',
      'GET https://codeberg.org/api/v1/user',
      'DELETE https://codeberg.org/api/v1/repos/acme/widgets/issues/7/subscriptions/testuser',
    ])
  })

  it('aborts the notification lookup of an unsubscribe with the caller\'s reason', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const { fetch, started } = hangingFetch()
    const instance = forgejo({ auth: { type: 'token', token: 't' }, fetch }).create()

    const pending = instance.notifications.unsubscribe({ forge: 'forgejo', instance: 'codeberg.org', id: '5512' }, { signal: controller.signal })
    await started
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('skips the thread and lookups it can when the caller passes the thread', async () => {
    const { instance, calls } = provider()
    const thread = {
      forge: 'forgejo',
      instance: 'codeberg.org',
      repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' },
      kind: 'pull_request',
      number: '7',
    } as const

    await instance.notifications!.markDone!({ forge: 'forgejo', instance: 'codeberg.org', id: '5512' }, { thread })
    await instance.notifications!.unsubscribe!({ forge: 'forgejo', instance: 'codeberg.org', id: '5512' }, { thread })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'PATCH https://codeberg.org/api/v1/notifications/threads/5512?to-status=read',
      'GET https://codeberg.org/api/v1/user',
      'DELETE https://codeberg.org/api/v1/repos/acme/widgets/issues/7/subscriptions/testuser',
      'DELETE https://codeberg.org/api/v1/repos/acme/widgets/issues/7/subscriptions/testuser',
    ])
  })

  it('refuses to comment on a commit', async () => {
    const { instance } = provider()
    await expect(instance.threads.comment!({
      forge: 'forgejo',
      instance: 'codeberg.org',
      repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' },
      kind: 'commit',
      number: 'adbc9741',
    }, 'hi')).rejects.toThrow('forgejo does not support threads.comment for a commit')
    expect(instance.capabilities.writes.comment.commit).toBe(false)
  })

  it('sends the merge commit title and message as separate fields', async () => {
    const { instance, calls } = provider()
    await instance.threads.merge!({
      forge: 'forgejo',
      instance: 'codeberg.org',
      repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' },
      kind: 'pull_request',
      number: '7',
    }, { method: 'squash', title: 'Release widgets (#7)', message: 'Ships the widgets' })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST https://codeberg.org/api/v1/repos/acme/widgets/pulls/7/merge'])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ Do: 'squash', MergeTitleField: 'Release widgets (#7)', MergeMessageField: 'Ships the widgets' })
  })

  it.each([
    [200, false, 'merged'],
    [200, true, 'merged'],
    [201, true, 'queued'],
  ] as const)('resolves a %i merge response with whenChecksPass %s as %s', async (status, whenChecksPass, expected) => {
    const { instance, calls } = provider({ 'POST https://codeberg.org/api/v1/repos/acme/widgets/pulls/7/merge': { status } })
    const pull = { forge: 'forgejo', instance: 'codeberg.org', repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '7' } as const

    await expect(instance.threads.merge!(pull, { method: 'squash', whenChecksPass })).resolves.toEqual({ status: expected })
    expect(calls).toHaveLength(1)
  })

  it('changes the state of a pull request through the pulls endpoint, and resolves with the pull request in the response', async () => {
    const pull = { forge: 'forgejo', instance: 'codeberg.org', repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '7' } as const
    const { instance, calls } = provider({ 'PATCH https://codeberg.org/api/v1/repos/acme/widgets/pulls/7': { status: 201, body: { number: 7, title: 'Add widgets', state: 'open', head: { ref: 'feat', sha: 'abc' }, base: { ref: 'main' } } } })

    await expect(instance.threads.reopen!(pull)).resolves.toMatchObject({ kind: 'pull_request', state: 'open', branches: { head: { ref: 'feat', sha: 'abc' }, base: { ref: 'main' } } })
    expect(calls.map(call => [call.method, call.url, JSON.parse(call.body!)])).toEqual([['PATCH', 'https://codeberg.org/api/v1/repos/acme/widgets/pulls/7', { state: 'open' }]])
  })

  it('resolves an issue state change with the issue in the response', async () => {
    const issue = { forge: 'forgejo', instance: 'codeberg.org', repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, kind: 'issue', number: '8' } as const
    const { instance, calls } = provider({ 'PATCH https://codeberg.org/api/v1/repos/acme/widgets/issues/8': { status: 201, body: { number: 8, title: 'Crash', state: 'closed', closed_at: '2025-09-18T09:00:00Z' } } })

    await expect(instance.threads.close!(issue)).resolves.toMatchObject({ kind: 'issue', title: 'Crash', state: 'closed', closedAt: new Date('2025-09-18T09:00:00Z') })
    expect(calls.map(call => call.url)).toEqual(['https://codeberg.org/api/v1/repos/acme/widgets/issues/8'])
  })

  it('resolves setMilestone with the milestone of the issue in the response', async () => {
    const issue = { forge: 'forgejo', instance: 'codeberg.org', repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, kind: 'issue', number: '7' } as const
    const { instance, calls } = provider({ 'PATCH https://codeberg.org/api/v1/repos/acme/widgets/issues/7': { status: 201, body: { number: 7, milestone: { id: 12, title: 'v1.0', state: 'open' } } } })

    await expect(instance.threads.setMilestone!(issue, '12')).resolves.toMatchObject({ id: '12', title: 'v1.0', state: 'open' })
    expect(calls.map(call => [call.method, JSON.parse(call.body!)])).toEqual([['PATCH', { milestone: 12 }]])
  })

  it('resolves setAssignees with the assignees of the issue in the response', async () => {
    const pull = { forge: 'forgejo', instance: 'codeberg.org', repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '7' } as const
    const { instance, calls } = provider({ 'PATCH https://codeberg.org/api/v1/repos/acme/widgets/issues/7': { status: 201, body: { number: 7, assignees: [{ id: 3, login: 'ada' }] } } })

    await expect(instance.threads.setAssignees!(pull, ['ada'])).resolves.toMatchObject([{ login: 'ada', id: '3' }])
    expect(calls).toHaveLength(1)
  })

  it('reads on past a page of repositories that the visibility filter empties', async () => {
    const first = 'https://codeberg.org/api/v1/users/acme/repos?limit=1'
    const second = 'https://codeberg.org/api/v1/users/acme/repos?limit=1&page=2'
    const instance = forgejo({ fetch: async url => url === first
      ? Response.json([{ id: 1, name: 'site', full_name: 'acme/site', private: false, owner: { login: 'acme' } }], { headers: { link: `<${second}>; rel="next"` } })
      : Response.json([{ id: 2, name: 'vault', full_name: 'acme/vault', private: true, owner: { login: 'acme' } }]) }).create()

    const page = await instance.repos.byOwnerPage({ forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: '', kind: 'namespace' }, { visibility: 'private', perPage: 1 })

    expect(page.items.map(repo => repo.ref.name)).toEqual(['vault'])
  })
})

describe('forgejo release webhooks', () => {
  it('maps Forgejo release deliveries', async () => {
    const { hmacSha256Hex } = await import('../../src/crypto.ts')
    const provider = forgejo({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const body = JSON.stringify({
      action: 'published',
      release: { id: 31001, tag_name: 'v0.4.0', name: 'Four' },
      repository: { id: 64021, name: 'widgets', full_name: 'acme/widgets', owner: { id: 4001, login: 'acme' } },
      sender: { id: 4002, login: 'ada' },
    })
    const [event] = await provider.webhooks.ingest({ headers: { 'x-forgejo-event': 'release', 'x-forgejo-signature': await hmacSha256Hex('s', body) }, body })

    expect(event).toMatchObject({ kind: 'release', action: 'published', detail: { release: { id: '31001', tag: 'v0.4.0' }, name: 'Four' } })
  })
})

describe('forgejo path safety', () => {
  it('encodes owner, name and number in thread paths', async () => {
    const urls: string[] = []
    const provider = forgejo({ baseUrl: 'https://codeberg.org', auth: { type: 'token', token: 't' }, fetch: async (url) => {
      urls.push(url)
      return new Response('{"id":1,"body":"hi","user":{"id":1,"login":"a"}}', { status: 201 })
    } }).create()
    const repo = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme/x', name: 'widgets' }

    await provider.threads.comment({ forge: 'forgejo', instance: 'codeberg.org', repo, kind: 'pull_request', number: '1?x=' }, 'hi')

    expect(urls).toEqual(['https://codeberg.org/api/v1/repos/acme%2Fx/widgets/issues/1%3Fx%3D/comments'])
  })
})

describe('forgejo pagination without a link header', () => {
  const repo = { forge: 'gitea', instance: 'gitea.com', owner: 'acme', name: 'widgets' } as const
  const label = (id: number) => ({ id, name: `l${id}`, color: '000000' })
  const entry = (id: number) => ({ id, type: 'comment', body: 'hi', created_at: '2025-09-15T08:30:00Z', user: { id: 1, login: 'ada' } })

  function serve(responses: Record<string, { body: unknown[], total?: number }>) {
    const urls: string[] = []
    const fetch = async (url: string) => {
      urls.push(url)
      const response = responses[url]
      if (!response) {
        return Response.json({ message: 'not found' }, { status: 404 })
      }
      return Response.json(response.body, { headers: response.total === undefined ? {} : { 'x-total-count': String(response.total) } })
    }
    return { provider: gitea({ auth: { type: 'token', token: 't' }, fetch }).create(), urls }
  }

  it('continues a listing from its total count', async () => {
    const { provider, urls } = serve({
      'https://gitea.com/api/v1/repos/acme/widgets/labels': { body: [label(1), label(2)], total: 3 },
      'https://gitea.com/api/v1/repos/acme/widgets/labels?page=2&limit=2': { body: [label(3)], total: 3 },
    })

    const labels = await Array.fromAsync(provider.repos.labels(repo))

    expect(labels.map(item => item.name)).toEqual(['l1', 'l2', 'l3'])
    expect(urls).toHaveLength(2)
  })

  it('keeps the page size the forge capped the first page to', async () => {
    const { provider } = serve({
      'https://gitea.com/api/v1/repos/acme/widgets/labels?limit=5': { body: [label(1), label(2)], total: 3 },
    })

    const page = await provider.repos.labelsPage(repo, { perPage: 5 })

    expect(page.cursor?.nextUrl).toBe('https://gitea.com/api/v1/repos/acme/widgets/labels?limit=2&page=2')
  })

  it('follows a full timeline page whose count is the page length', async () => {
    const thread = { forge: 'gitea', instance: 'gitea.com', repo, kind: 'issue', number: '7' } as const
    const { provider } = serve({
      'https://gitea.com/api/v1/repos/acme/widgets/issues/7/timeline?limit=2': { body: [entry(1), entry(2)], total: 2 },
      'https://gitea.com/api/v1/repos/acme/widgets/issues/7/timeline?limit=2&page=2': { body: [entry(3)], total: 1 },
    })

    const events = await Array.fromAsync(provider.threads.events(thread, { perPage: 2 }))

    expect(events).toHaveLength(3)
  })

  it('stops when the forge ignored the limit and sent everything', async () => {
    const { provider } = serve({
      'https://gitea.com/api/v1/repos/acme/widgets/labels?limit=1': { body: [label(1), label(2)], total: 2 },
    })

    const page = await provider.repos.labelsPage(repo, { perPage: 1 })

    expect(page.items).toHaveLength(2)
    expect(page.cursor).toBeUndefined()
  })
})

describe('forgejo label filters', () => {
  const repository = { id: 64021, name: 'widgets', full_name: 'acme/widgets', owner: { id: 4001, login: 'acme' } }
  const issues = [
    { id: 1, number: 1, title: 'Both', state: 'open', labels: [{ id: 1, name: 'bug' }, { id: 2, name: 'ui' }], repository },
    { id: 2, number: 2, title: 'One', state: 'open', labels: [{ id: 1, name: 'bug' }], repository },
  ]
  const provider = forgejo({ auth: { type: 'token', token: 't' }, fetch: async () => Response.json(issues) }).create()
  const repo = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }

  it('lists only threads carrying every label', async () => {
    const page = await provider.threads.listPage(repo, { labels: ['bug', 'ui'] })

    expect(page.items.map(thread => thread.title)).toEqual(['Both'])
  })

  it('searches only threads carrying every label', async () => {
    const page = await provider.search.threadsPage({ labels: ['bug', 'ui'] })

    expect(page.items.map(thread => thread.title)).toEqual(['Both'])
  })
})

describe('forgejo merge settings', () => {
  const repo = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }

  it.each([
    ['rebase-merge', 'rebase_merge'],
    ['fast-forward-only', 'fast_forward_only'],
    ['manually-merged', undefined],
  ])('reads the default merge style %s', async (style, method) => {
    const body = { id: 64021, name: 'widgets', full_name: 'acme/widgets', owner: { id: 4001, login: 'acme' }, default_merge_style: style, default_delete_branch_after_merge: true }
    const provider = forgejo({ auth: { type: 'token', token: 't' }, fetch: async () => Response.json(body) }).create()
    const result = await provider.repos.get(repo)

    expect(result.defaultMergeMethod).toBe(method)
    expect(result.deleteBranchOnMerge).toBe(true)
  })
})

describe('forgejo label names', () => {
  function serve(owner: string) {
    const calls: Array<{ method: string, url: string, body?: string }> = []
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body as string | undefined })
      if (url === `https://codeberg.org/api/v1/repos/${owner}/widgets/labels?limit=50`) {
        return Response.json([{ id: 1, name: 'bug', color: 'ff0000' }])
      }
      if (url === 'https://codeberg.org/api/v1/orgs/acme/labels?limit=50') {
        return Response.json([{ id: 9, name: 'triage', color: '00ff00' }])
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      if (!init?.method && url === 'https://codeberg.org/api/v1/repos/acme/widgets/issues/7/labels') {
        return Response.json([{ id: 9, name: 'triage', color: '00ff00', description: 'Needs a look' }])
      }
      return init?.method === 'POST' ? Response.json([{ id: 1, name: 'bug', color: 'ff0000', description: '' }, { id: 9, name: 'triage', color: '00ff00', description: 'Needs a look' }]) : Response.json({ message: 'not found' }, { status: 404 })
    }
    const thread = { forge: 'forgejo', instance: 'codeberg.org', repo: { forge: 'forgejo', instance: 'codeberg.org', owner, name: 'widgets' }, kind: 'issue', number: '7' } as const
    return { provider: forgejo({ auth: { type: 'token', token: 't' }, fetch }).create(), thread, calls }
  }

  it('resolves a label the organisation shares', async () => {
    const { provider, thread, calls } = serve('acme')

    await expect(provider.threads.addLabels!(thread, ['bug', 'triage'])).resolves.toEqual([{ name: 'bug', colour: 'ff0000' }, { name: 'triage', colour: '00ff00', description: 'Needs a look' }])

    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: '{"labels":[1,9]}' })
  })

  it('reads the labels after removing some, as the delete response has no body', async () => {
    const { provider, thread, calls } = serve('acme')

    await expect(provider.threads.removeLabels!(thread, ['bug'])).resolves.toEqual([{ name: 'triage', colour: '00ff00', description: 'Needs a look' }])
    expect(calls.filter(call => call.url.includes('/issues/7/')).map(({ method, url }) => [method, url])).toEqual([
      ['DELETE', 'https://codeberg.org/api/v1/repos/acme/widgets/issues/7/labels/1'],
      ['GET', 'https://codeberg.org/api/v1/repos/acme/widgets/issues/7/labels'],
    ])
  })

  it('names a label neither the repository nor its owner has', async () => {
    const { provider, thread } = serve('ada')

    await expect(provider.threads.addLabels!(thread, ['triage'])).rejects.toThrow('No label named triage in ada/widgets')
  })
})

describe('forgejo search filters', () => {
  const repository = { id: 64021, name: 'widgets', full_name: 'acme/widgets', owner: { id: 4001, login: 'acme' } }
  const ada = { id: 1, login: 'Ada' }
  const grace = { id: 2, login: 'grace' }
  const issues = [
    { id: 1, number: 1, title: 'By Ada', state: 'open', user: ada, assignees: [grace], repository },
    { id: 2, number: 2, title: 'By Grace', state: 'open', user: grace, assignees: [ada], repository },
  ]
  const provider = forgejo({ auth: { type: 'token', token: 't' }, fetch: async () => Response.json(issues) }).create()

  it('searches only threads by the author', async () => {
    const page = await provider.search.threadsPage({ author: 'ada' })

    expect(page.items.map(thread => thread.title)).toEqual(['By Ada'])
  })

  it('searches only threads assigned to the assignee', async () => {
    const page = await provider.search.threadsPage({ assignee: 'ada' })

    expect(page.items.map(thread => thread.title)).toEqual(['By Grace'])
  })
})

describe('forgejo label webhooks', () => {
  it.each([['label_updated', 'edited'], ['label_cleared', 'unlabelled']])('maps %s to %s', async (action, expected) => {
    const { hmacSha256Hex } = await import('../../src/crypto.ts')
    const provider = forgejo({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const body = JSON.stringify({
      action,
      number: 3,
      issue: { id: 3, number: 3, title: 'x', state: 'open', labels: [] },
      repository: { id: 64021, name: 'widgets', full_name: 'acme/widgets', owner: { id: 4001, login: 'acme' } },
      sender: { id: 4002, login: 'ada' },
    })
    const [event] = await provider.webhooks.ingest({ headers: { 'x-forgejo-event': 'issues', 'x-forgejo-signature': await hmacSha256Hex('s', body) }, body })

    expect(event).toMatchObject({ kind: 'label', action: expected })
    expect(provider.webhooks.events).toContainEqual({ kind: 'label', action: expected })
  })
})

describe('forgejo actions', () => {
  const auth = { type: 'token', token: 't' } as const
  const repo = { forge: 'forgejo', instance: 'git.example.org', owner: 'acme', name: 'widgets' }

  it('reads Actions on Codeberg and gates a self-hosted instance on its version', () => {
    const ci = (options: { baseUrl?: string, instanceVersion?: string }) => forgejo({ auth, ...options }).create().capabilities.ci

    expect(ci({})).toEqual({ runs: true, run: true, jobs: true, job: 'emulated', log: true })
    expect(ci({ baseUrl: 'https://git.example.org' })).toEqual({ runs: false, run: false, jobs: false, job: false, log: false })
    expect(ci({ baseUrl: 'https://git.example.org', instanceVersion: '15.0.2+gitea-1.22.0' })).toEqual({ runs: true, run: true, jobs: false, job: false, log: false })
    expect(ci({ baseUrl: 'https://git.example.org', instanceVersion: '16.0.0+gitea-1.22.0' })).toEqual({ runs: true, run: true, jobs: true, job: 'emulated', log: true })
    expect(forgejo({ auth: { type: 'anonymous' } }).create().capabilities.ci).toEqual({ runs: true, run: true, jobs: true, job: 'emulated', log: true })
  })

  it('pages runs explicitly and keeps the branch where Forgejo ignores `ref`', async () => {
    const urls: string[] = []
    const run = (id: number, prettyref: string, status: string) => ({ id, workflow_id: 'test.yml', index_in_repo: id, prettyref, commit_sha: 'c4a92ff', status, started: '1970-01-01T00:00:00Z', stopped: '2026-10-02T03:42:02Z' })
    const provider = forgejo({ auth, baseUrl: 'https://git.example.org', instanceVersion: '14.0.5', fetch: async (url) => {
      urls.push(String(url))
      return Response.json({ total_count: 3, workflow_runs: [run(3, 'main', 'cancelled'), run(2, '#9', 'failure'), run(1, 'c4a92ff', 'failure')] })
    } }).create()

    const page = await provider.ci.runsPage(repo, { branch: 'main', state: 'failure' })

    expect(urls).toEqual(['https://git.example.org/api/v1/repos/acme/widgets/actions/runs?status=failure&status=cancelled&ref=refs%2Fheads%2Fmain&page=1&limit=50'])
    expect(page.items).toMatchObject([{ number: '3', branch: 'main', state: 'failure', stateRaw: 'cancelled', startedAt: undefined }])
    expect(page.total).toBe(3)
  })

  it('continues runs past a page that Forgejo capped below `perPage`', async () => {
    const urls: string[] = []
    const provider = forgejo({ auth, baseUrl: 'https://git.example.org', instanceVersion: '16.0.0', fetch: async (url) => {
      urls.push(String(url))
      const first = new URL(String(url)).searchParams.get('page') === '1' ? 120 : 70
      return Response.json({ total_count: 120, workflow_runs: Array.from({ length: 50 }, (_, index) => ({ id: first - index, status: 'success' })) })
    } }).create()

    const first = await provider.ci.runsPage(repo, { perPage: 100 })
    const second = await provider.ci.runsPage(repo, { perPage: 100, cursor: first.cursor })

    expect(first.items).toHaveLength(50)
    expect(first.total).toBe(120)
    expect(urls).toEqual([
      'https://git.example.org/api/v1/repos/acme/widgets/actions/runs?page=1&limit=100',
      'https://git.example.org/api/v1/repos/acme/widgets/actions/runs?page=2&limit=50',
    ])
    expect(second.items[0]!.ref.id).toBe('70')
    expect(second.cursor?.nextUrl).toBe('https://git.example.org/api/v1/repos/acme/widgets/actions/runs?page=3&limit=50')
  })

  it('streams a job log', async () => {
    const provider = forgejo({ auth, baseUrl: 'https://git.example.org', instanceVersion: '16.0.0', fetch: async url => new Response(String(url).endsWith('/actions/jobs/404013/logs') ? 'workflow prepared\n' : null, { status: 200 }) }).create()

    const log = await provider.ci.log({ forge: 'forgejo', instance: 'git.example.org', repo, id: '404013' })

    expect(await new Response(log).text()).toBe('workflow prepared\n')
  })
})

describe('gitea actions', () => {
  const auth = { type: 'token', token: 't' } as const
  const repo = { forge: 'gitea', instance: 'git.example.org', owner: 'acme', name: 'widgets' } as const
  const zero = '1970-01-01T00:00:00Z'
  const run = (id: number, status: string, conclusion = '') => ({ id, path: 'ci.yml@refs/heads/main', display_title: 'Fix the build', run_number: id, event: 'push', head_branch: 'main', head_sha: 'c4a92ff', status, conclusion, started_at: zero, completed_at: zero })

  function serve(responses: Map<string, unknown>) {
    const urls: string[] = []
    const provider = gitea({ auth, baseUrl: 'https://git.example.org', instanceVersion: '1.25.0', fetch: async (url) => {
      urls.push(String(url))
      return responses.has(String(url)) ? Response.json(responses.get(String(url))) : Response.json({ message: 'not found' }, { status: 404 })
    } }).create()
    return { provider, urls }
  }

  it('reads Actions on gitea.com and gates a self-hosted instance on its version', () => {
    const ci = (options: { auth?: typeof auth | { type: 'anonymous' }, baseUrl?: string, instanceVersion?: string }) => gitea(options).create().capabilities.ci

    expect(ci({ auth })).toEqual({ runs: true, run: true, jobs: true, job: true, log: true })
    expect(ci({ auth: { type: 'anonymous' } })).toEqual({ runs: false, run: true, jobs: true, job: 'unverified', log: false })
    expect(ci({ auth, baseUrl: 'https://git.example.org' })).toEqual({ runs: false, run: false, jobs: false, job: false, log: false })
    expect(ci({ auth, baseUrl: 'https://git.example.org', instanceVersion: '1.24.7' })).toEqual({ runs: false, run: false, jobs: false, job: false, log: true })
    expect(ci({ auth, baseUrl: 'https://git.example.org', instanceVersion: '1.25.0' })).toEqual({ runs: true, run: true, jobs: true, job: true, log: true })
  })

  it('reads a job whose ref names no run, and names the run from the job', async () => {
    const { provider } = serve(new Map([
      ['https://git.example.org/api/v1/repos/acme/widgets/actions/jobs/9', { id: 9, run_id: 7, name: 'test', status: 'completed', conclusion: 'success', started_at: zero, completed_at: zero }],
    ]))

    const job = await provider.ci.job({ forge: 'gitea', instance: 'git.example.org', repo, id: '9' })

    expect(job.ref.run).toEqual({ forge: 'gitea', instance: 'git.example.org', repo, id: '7' })
  })

  it('rejects a job that names no run when its ref names none either', async () => {
    const { provider } = serve(new Map([
      ['https://git.example.org/api/v1/repos/acme/widgets/actions/jobs/9', { id: 9, name: 'test', status: 'completed', conclusion: 'success', started_at: zero, completed_at: zero }],
    ]))

    await expect(provider.ci.job({ forge: 'gitea', instance: 'git.example.org', repo, id: '9' })).rejects.toThrow(UnsupportedOperationError)
  })

  it('filters runs on `branch` and on the statuses Gitea accepts', async () => {
    const { provider, urls } = serve(new Map([
      ['https://git.example.org/api/v1/repos/acme/widgets/actions/runs?status=queued&status=waiting&status=in_progress&branch=main&page=1&limit=50', { total_count: 2, workflow_runs: [run(2, 'queued'), run(1, 'waiting')] }],
    ]))

    const page = await provider.ci.runsPage(repo, { branch: 'main', state: 'pending' })

    expect(urls).toHaveLength(1)
    expect(page.items).toMatchObject([
      { name: 'ci.yml', number: '2', branch: 'main', sha: 'c4a92ff', state: 'pending', stateRaw: 'queued', startedAt: undefined, completedAt: undefined },
      { number: '1', state: 'pending', stateRaw: 'waiting' },
    ])
  })

  it('reads the result of a finished run from its conclusion', async () => {
    const pull = { ...run(7, 'completed', 'cancelled'), path: undefined, head_branch: undefined, started_at: '2026-10-02T03:40:00Z', completed_at: '2026-10-02T03:42:02Z' }
    const { provider } = serve(new Map([['https://git.example.org/api/v1/repos/acme/widgets/actions/runs/7', pull]]))

    const read = await provider.ci.run({ forge: 'gitea', instance: 'git.example.org', repo, id: '7' })

    expect(read).toMatchObject({ name: 'Fix the build', branch: undefined, state: 'failure', stateRaw: 'completed', completedAt: new Date('2026-10-02T03:42:02Z') })
  })

  it('continues jobs from `total_count`, which Gitea 1.25 sends without a `Link` header', async () => {
    const job = (id: number) => ({ id, run_id: 7, name: `job ${id}`, status: 'completed', conclusion: 'skipped', started_at: zero, completed_at: zero })
    const { provider } = serve(new Map([
      ['https://git.example.org/api/v1/repos/acme/widgets/actions/runs/7/jobs?page=1&limit=2', { total_count: 3, jobs: [job(1), job(2)] }],
    ]))

    const page = await provider.ci.jobsPage({ forge: 'gitea', instance: 'git.example.org', repo, id: '7' }, { perPage: 2 })

    expect(page.items).toMatchObject([{ name: 'job 1', state: 'neutral', startedAt: undefined }, { name: 'job 2' }])
    expect(page.cursor?.nextUrl).toBe('https://git.example.org/api/v1/repos/acme/widgets/actions/runs/7/jobs?page=2&limit=2')
  })
})

describe('gitea single-item reads', () => {
  it('reports a comment read that returns no content as not found', async () => {
    const repo = { forge: 'gitea', instance: 'gitea.com', owner: 'acme', name: 'widgets' }
    const provider = gitea({ auth: { type: 'token', token: 't' }, fetch: async () => new Response(null, { status: 204 }) }).create()
    const thread = { forge: 'gitea', instance: 'gitea.com', repo, kind: 'pull_request', number: '3' } as const

    await expect(provider.threads.getComment({ forge: 'gitea', instance: 'gitea.com', thread, id: '9' })).rejects.toThrow(NotFoundError)
  })
})

describe('gitea review replies', () => {
  const auth = { type: 'token', token: 't' } as const

  it('waits for Gitea 1.27 on a self-hosted instance, and Forgejo has no replies', () => {
    expect(gitea({ auth, baseUrl: 'https://git.example.org', instanceVersion: '1.26.4' }).create().capabilities.reviews.reply).toBe(false)
    expect(gitea({ auth, baseUrl: 'https://git.example.org', instanceVersion: '1.27.0' }).create().capabilities.reviews.reply).toBe(true)
    expect(forgejo({ auth }).create().capabilities.reviews.reply).toBe(false)
  })

  it('asks for write scopes to reply', () => {
    expect(gitea({ auth }).create().scopesFor('threads.replyToReviewComment')).toEqual({ token: ['write:issue', 'write:repository'] })
  })
})

describe('forgejo thread updates', () => {
  const repo = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' } as const
  const labels = { 'GET https://codeberg.org/api/v1/repos/acme/widgets/labels?limit=50': { status: 200, body: [{ id: 3, name: 'bug' }, { id: 5, name: 'ui' }] } }
  const thread = (kind: 'issue' | 'pull_request', number: string) => ({ forge: 'forgejo', instance: 'codeberg.org', repo, kind, number }) as const
  const writes = <T extends { method: string }>(calls: T[]) => calls.filter(call => call.method !== 'GET')

  it('lists comments since a time on the forge', async () => {
    const { instance, calls } = provider({ 'GET https://codeberg.org/api/v1/repos/acme/widgets/issues/9/comments?since=2026-03-01T12:00:00.000Z': { status: 200, body: [] } })
    await instance.threads.commentsPage(thread('issue', '9'), { since: new Date('2026-03-01T12:00:00Z') })

    expect(new URL(calls[0]!.url).searchParams.get('since')).toBe('2026-03-01T12:00:00.000Z')
  })

  it('closes, relabels and reassigns a pull request in one edit', async () => {
    const { instance, calls } = provider({ ...labels, 'PATCH https://codeberg.org/api/v1/repos/acme/widgets/pulls/7': { status: 201, body: { number: 7, state: 'closed' } } })
    await instance.threads.update(thread('pull_request', '7'), { state: 'closed', labels: ['bug', 'ui'], assignees: ['jane'] })

    expect(writes(calls).map(call => `${call.method} ${call.url}`)).toEqual(['PATCH https://codeberg.org/api/v1/repos/acme/widgets/pulls/7'])
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ state: 'closed', labels: [3, 5], assignees: ['jane'] })
  })

  it('replaces the labels of an issue before the edit, which takes none', async () => {
    const { instance, calls } = provider({
      ...labels,
      'PUT https://codeberg.org/api/v1/repos/acme/widgets/issues/9/labels': { status: 200, body: [] },
      'PATCH https://codeberg.org/api/v1/repos/acme/widgets/issues/9': { status: 201, body: { number: 9, state: 'open' } },
    })
    await instance.threads.update(thread('issue', '9'), { state: 'open', labels: ['ui'], assignees: [] })

    expect(writes(calls).map(call => `${call.method} ${call.url}`)).toEqual([
      'PUT https://codeberg.org/api/v1/repos/acme/widgets/issues/9/labels',
      'PATCH https://codeberg.org/api/v1/repos/acme/widgets/issues/9',
    ])
    expect(writes(calls).map(call => JSON.parse(call.body!))).toEqual([{ labels: [5] }, { state: 'open', assignees: [] }])
  })

  it('refuses a label the repository lacks before it writes anything', async () => {
    const { instance, calls } = provider({ ...labels, 'GET https://codeberg.org/api/v1/orgs/acme/labels?limit=50': { status: 200, body: [] } })

    await expect(instance.threads.update(thread('pull_request', '7'), { state: 'closed', labels: ['wontfix'] })).rejects.toThrow('No label named wontfix')
    expect(writes(calls)).toEqual([])
  })
})

describe('forgejo organisation teams', () => {
  const org = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: '', kind: 'namespace' } as const

  it('lists an organisation\'s teams and the members of one by its id', async () => {
    const { instance, calls } = provider()

    const teams = await Array.fromAsync(instance.orgs.teams(org))
    const members = await Array.fromAsync(instance.orgs.teamMembers(teams[0]!.ref))

    expect(teams.map(team => [team.ref.slug, team.ref.id, team.permission])).toEqual([
      ['stewards', '11', 'write'],
      ['core', '12', 'admin'],
    ])
    expect(teams[0]!.ref.org).toMatchObject({ kind: 'namespace', owner: 'acme', name: '' })
    expect(members.map(member => [member.login, member.isBotHint])).toEqual([['octocat', false], ['hubot', true]])
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /api/v1/orgs/acme/teams',
      'GET /api/v1/teams/11/members',
    ])
  })

  it('resolves a ref without an id by its slug', async () => {
    const { instance, calls } = provider()

    const members = await Array.fromAsync(instance.orgs.teamMembers({ forge: 'forgejo', instance: 'codeberg.org', org, slug: 'Stewards' }))

    expect(members.map(member => member.login)).toEqual(['octocat', 'hubot'])
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/api/v1/orgs/acme/teams', '/api/v1/teams/11/members'])
  })

  it('rejects a slug that names no team, even one that matches a team id', async () => {
    const { instance, calls } = provider()

    await expect(instance.orgs.teamMembersPage({ forge: 'forgejo', instance: 'codeberg.org', org, slug: '12' })).rejects.toThrow(NotFoundError)
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/api/v1/orgs/acme/teams'])
  })

  it('reports organisation teams unsupported without a credential', () => {
    const anonymous = forgejo({}).create()

    expect(anonymous.can('orgs.teams')).toBe(false)
    expect(anonymous.can('orgs.teamMembers')).toBe(false)
  })
})

describe('forgejo templates', () => {
  const repo = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' } as const
  const api = 'https://codeberg.org/api/v1/repos/acme/widgets'
  const pullFiles = {
    [`GET ${api}/contents`]: contentsListing('.forgejo/', '.github/', 'docs/'),
    [`GET ${api}/contents/.forgejo`]: contentsListing('.forgejo/pull_request_template.md'),
    [`GET ${api}/contents/.github`]: contentsListing('.github/PULL_REQUEST_TEMPLATE.md'),
    [`GET ${api}/contents/docs`]: contentsListing('docs/pull_request_template.md'),
    [`GET ${api}/contents/.forgejo/pull_request_template.md`]: contentsFile('.forgejo/pull_request_template.md', 'From .forgejo'),
    [`GET ${api}/contents/.github/PULL_REQUEST_TEMPLATE.md`]: contentsFile('.github/PULL_REQUEST_TEMPLATE.md', 'From .github'),
  }

  it('reads an issue form as YAML, with the fields Forgejo parses from it', async () => {
    const { instance } = provider({
      [`GET ${api}/issue_templates`]: { status: 200, body: [{
        name: 'Bug',
        title: 'bug: ',
        about: 'Something broke',
        labels: ['bug'],
        ref: 'refs/heads/',
        content: '',
        file_name: '.forgejo/issue_template/bug.yaml',
        body: [{ type: 'textarea', id: 'what', attributes: { label: 'What happened?' }, validations: { required: true } }],
      }] },
      [`GET ${api}/contents/.forgejo/issue_template/bug.yaml`]: contentsFile('.forgejo/issue_template/bug.yaml', 'name: Bug\nbody: []\n'),
    })

    const templates = await instance.repos.templates(repo, { kind: 'issue' })

    expect(templates).toEqual([expect.objectContaining({
      kind: 'issue',
      name: 'Bug',
      path: '.forgejo/issue_template/bug.yaml',
      format: 'form',
      body: 'name: Bug\nbody: []\n',
      title: 'bug: ',
      about: 'Something broke',
      labels: ['bug'],
      fields: [{ type: 'textarea', id: 'what', attributes: { label: 'What happened?' }, validations: { required: true } }],
    })])
  })

  it('reads the one pull request template the web UI would pick, `.forgejo` first', async () => {
    const { instance } = provider(pullFiles)

    const templates = await instance.repos.templates(repo, { kind: 'pull_request' })

    expect(templates).toMatchObject([{ kind: 'pull_request', path: '.forgejo/pull_request_template.md', format: 'markdown', body: 'From .forgejo' }])
  })

  it('stops at a template in the root, which wins over every folder', async () => {
    const { instance, calls } = provider({
      [`GET ${api}/contents`]: contentsListing('.forgejo/', 'PULL_REQUEST_TEMPLATE.md'),
      [`GET ${api}/contents/PULL_REQUEST_TEMPLATE.md`]: contentsFile('PULL_REQUEST_TEMPLATE.md', 'Prêt à merger ✓'),
    })

    const templates = await instance.repos.templates(repo, { kind: 'pull_request' })

    expect(templates).toMatchObject([{ path: 'PULL_REQUEST_TEMPLATE.md', body: 'Prêt à merger ✓' }])
    expect(calls.map(call => new URL(call.url).pathname)).not.toContain('/api/v1/repos/acme/widgets/contents/.forgejo')
  })

  it('skips the directories Gitea does not look in', async () => {
    const { fetch, calls } = fixtureFetch('forgejo', Object.fromEntries(Object.entries(pullFiles).map(([key, response]) => [key.replace('codeberg.org', 'gitea.com'), response])))
    const instance = gitea({ auth: { type: 'token', token: 't' }, fetch }).create()

    const templates = await instance.repos.templates({ ...repo, forge: 'gitea', instance: 'gitea.com' }, { kind: 'pull_request' })

    expect(templates).toMatchObject([{ path: '.github/PULL_REQUEST_TEMPLATE.md', body: 'From .github' }])
    expect(calls.map(call => new URL(call.url).pathname)).not.toContain('/api/v1/repos/acme/widgets/contents/docs')
  })
})

describe('forgejo thread listing filters', () => {
  it('leaves out the filters the listing does not apply, with a warning on the first page only', async () => {
    const urls: string[] = []
    const fetch = async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response('[]', { headers: { 'content-type': 'application/json', 'link': '<https://codeberg.org/api/v1/repos/acme/widgets/issues?page=2>; rel="next"' } })
    }
    const instance = forgejo({ auth: { type: 'token', token: 't' }, fetch }).create()
    const repo = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' } as const

    const first = await instance.threads.listPage(repo, { kind: 'issue', involves: 'ada', mentions: 'ada', milestone: 'v1' })
    const next = await instance.threads.listPage(repo, { kind: 'issue', involves: 'ada', cursor: { nextUrl: 'https://codeberg.org/api/v1/repos/acme/widgets/issues?page=2' } })

    expect(first.warnings?.filter(warning => warning.code === 'filter_unsupported').map(warning => warning.message)).toEqual([
      'This listing has no involves filter; it was ignored',
      'This listing has no mentions filter; it was ignored',
      'This listing has no milestone filter; it was ignored',
    ])
    expect(next.warnings?.some(warning => warning.code === 'filter_unsupported')).toBeFalsy()
    expect(urls.some(url => /ada|=v1/.test(url))).toBe(false)
  })
})

describe('forgejo getMany', () => {
  const repo = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' } as const
  const refs = Array.from({ length: 8 }, (_, index) => ({ forge: 'forgejo', instance: 'codeberg.org', repo, kind: 'issue', number: String(index + 1) }) as const)

  function failing(status: number, headers: Record<string, string> = {}) {
    const urls: string[] = []
    const fetch = async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response('{"message":"refused"}', { status, headers: { 'content-type': 'application/json', ...headers } })
    }
    return { urls, instance: forgejo({ auth: { type: 'token', token: 't' }, fetch }).create() }
  }

  it('rejects a rejected credential instead of warning per thread, and starts no further reads', async () => {
    const { urls, instance } = failing(401)

    await expect(instance.threads.getMany(refs)).rejects.toBeInstanceOf(TokenRevokedError)
    expect(urls.length).toBeLessThanOrEqual(4)
  })

  it('rejects a rate limit with its reset', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    const { instance } = failing(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })

    await expect(instance.threads.getMany(refs.slice(0, 1))).rejects.toMatchObject({ name: 'RateLimitedError', resetAt: new Date(reset * 1000) })
  })

  it('still turns a missing thread into a per-item warning', async () => {
    const { instance } = failing(404)

    const results = await instance.threads.getMany(refs.slice(0, 2))

    expect(results.map(result => result.ok ? 'ok' : result.warning.code)).toEqual(['thread_unreadable', 'thread_unreadable'])
  })
})
