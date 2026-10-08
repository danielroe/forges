import { describe, expect, it } from 'vitest'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitea } from '../../src/gitea/index.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

function provider() {
  const { fetch, calls } = fixtureFetch('forgejo')
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
      return init?.method === 'POST' ? Response.json([]) : Response.json({ message: 'not found' }, { status: 404 })
    }
    const thread = { forge: 'forgejo', instance: 'codeberg.org', repo: { forge: 'forgejo', instance: 'codeberg.org', owner, name: 'widgets' }, kind: 'issue', number: '7' } as const
    return { provider: forgejo({ auth: { type: 'token', token: 't' }, fetch }).create(), thread, calls }
  }

  it('resolves a label the organisation shares', async () => {
    const { provider, thread, calls } = serve('acme')

    await provider.threads.addLabels!(thread, ['bug', 'triage'])

    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: '{"labels":[1,9]}' })
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

    expect(ci({})).toEqual({ runs: true, run: true, jobs: true, log: 'experimental' })
    expect(ci({ baseUrl: 'https://git.example.org' })).toEqual({ runs: false, run: false, jobs: false, log: false })
    expect(ci({ baseUrl: 'https://git.example.org', instanceVersion: '15.0.2+gitea-1.22.0' })).toEqual({ runs: true, run: true, jobs: false, log: false })
    expect(ci({ baseUrl: 'https://git.example.org', instanceVersion: '16.0.0+gitea-1.22.0' })).toEqual({ runs: true, run: true, jobs: true, log: 'experimental' })
    expect(gitea({ auth }).create().capabilities.ci).toEqual({ runs: false, run: false, jobs: false, log: false })
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
