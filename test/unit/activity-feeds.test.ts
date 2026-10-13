import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it, vi } from 'vitest'
import { completeEvent } from '../../src/events.ts'
import { fake } from '../../src/fake/index.ts'
import { toFeedEvent as toForgejoFeedEvent } from '../../src/forgejo/feed.ts'
import { toFeedEvent as toGiteeFeedEvent } from '../../src/gitee/feed.ts'
import { gitee } from '../../src/gitee/index.ts'
import { toFeedEvent as toGitHubFeedEvent, translateGitHubWebhook } from '../../src/github/events.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { accountFeedPage } from '../../src/tangled/feed.ts'
import { redact } from '../recording/redact.ts'

const repository = { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme', id: 2 } }
const sender = { login: 'octocat', id: 3, type: 'User' }

function feedItem(type: string, payload: Record<string, unknown>) {
  return { id: '1', type, actor: sender, repo: { id: 1, name: 'acme/widgets' }, payload, created_at: '2026-01-02T03:04:05Z' }
}

function webhook(event: string, payload: Record<string, unknown>) {
  return completeEvent(translateGitHubWebhook('github.com', { headers: { 'x-github-event': event, 'x-github-delivery': 'id' }, body: JSON.stringify({ repository, sender, ...payload }) })[0]!)
}

function shape(event: ReturnType<typeof completeEvent>) {
  return { kind: event.kind, action: event.action, thread: event.thread && { kind: event.thread.kind, number: event.thread.number }, detail: event.detail, actor: event.actor?.login, repo: `${event.repo?.owner}/${event.repo?.name}` }
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { headers })
}

describe('github activity feeds', () => {
  it('normalises a feed event like the webhook delivery for the same change', () => {
    const merged = completeEvent(toGitHubFeedEvent('github.com', feedItem('PullRequestEvent', { action: 'merged', number: 4, pull_request: { number: 4 } })))
    const review = completeEvent(toGitHubFeedEvent('github.com', feedItem('PullRequestReviewEvent', { action: 'created', pull_request: { number: 4 }, review: { id: 5, state: 'approved', body: 'Ship it' } })))
    const comment = completeEvent(toGitHubFeedEvent('github.com', feedItem('IssueCommentEvent', { action: 'created', issue: { number: 4, pull_request: {} }, comment: { id: 9, body: 'Thanks!' } })))

    expect(shape(merged)).toEqual({ ...shape(webhook('pull_request', { action: 'closed', pull_request: { number: 4, merged: true } })), detail: { type: 'state_change', state: 'merged' } })
    expect(shape(review)).toEqual(shape(webhook('pull_request_review', { action: 'submitted', pull_request: { number: 4 }, review: { id: 5, state: 'approved', body: 'Ship it' } })))
    expect(shape(comment)).toEqual(shape(webhook('issue_comment', { action: 'created', issue: { number: 4, pull_request: {} }, comment: { id: 9, body: 'Thanks!' } })))
    expect(merged).toMatchObject({ source: 'poll', kindRaw: 'PullRequestEvent.merged', occurredAt: new Date('2026-01-02T03:04:05Z') })
  })

  it('reports whether a feed event is public where the feed says', () => {
    const visible = toGitHubFeedEvent('github.com', { ...feedItem('IssuesEvent', { action: 'closed', issue: { number: 4 } }), public: true })
    const hidden = toGitHubFeedEvent('github.com', { ...feedItem('WatchEvent', { action: 'started' }), public: false })
    const unknown = toGitHubFeedEvent('github.com', feedItem('WatchEvent', { action: 'started' }))
    const forgejo = toForgejoFeedEvent({ forge: 'forgejo', instance: 'codeberg.org' }, { id: 1, op_type: 'star_repo', is_private: true, created: '2026-01-02T03:04:05Z' })

    expect([visible.isPublic, hidden.isPublic, forgejo.isPublic]).toEqual([true, false, false])
    expect(unknown).not.toHaveProperty('isPublic')
    expect(webhook('issues', { action: 'closed', issue: { number: 4 } })).not.toHaveProperty('isPublic')
  })

  it('keeps feed types with no shared kind as `other`', () => {
    const star = completeEvent(toGitHubFeedEvent('github.com', feedItem('WatchEvent', { action: 'started' })))
    const wiki = completeEvent(toGitHubFeedEvent('github.com', feedItem('GollumEvent', { pages: [] })))

    expect(star).toMatchObject({ kind: 'other', kindRaw: 'WatchEvent.started', action: 'other', summary: 'octocat starred the repository' })
    expect(wiki).toMatchObject({ kind: 'other', kindRaw: 'GollumEvent', summary: 'octocat edited the wiki' })
  })

  it('reports a push without a commit count as one of unknown size', () => {
    const push = toGitHubFeedEvent('github.com', feedItem('PushEvent', { ref: 'refs/heads/main', before: 'a', head: 'b' }))

    expect(push).toMatchObject({ kind: 'push', summary: 'octocat pushed to main', detail: { type: 'push', ref: 'refs/heads/main', before: 'a', after: 'b', commits: [] } })
    expect(push.detail).toHaveProperty('commitCount', undefined)
  })

  it('reads the commits of a feed push that lists them', () => {
    const push = toGitHubFeedEvent('github.com', feedItem('PushEvent', { ref: 'refs/heads/main', before: 'a', head: 'b', size: 2, commits: [{ sha: 'b', message: 'Fix', author: { name: 'Ada' } }] }))

    expect(push).toMatchObject({ summary: 'octocat pushed 2 commit(s) to main', detail: { commitCount: 2, commits: [{ sha: 'b', message: 'Fix', author: 'Ada' }] } })
  })

  it('reads the first page conditionally and leaves later pages unconditional', async () => {
    const conditions: Array<string | null> = []
    const provider = github({
      fetch: async (url, init) => {
        conditions.push((init!.headers as Headers).get('if-none-match'))
        if (conditions.length === 2) {
          return new Response(null, { status: 304, headers: { etag: 'W/"first"' } })
        }
        return json([feedItem('WatchEvent', { action: 'started' })], url.includes('page=2') ? {} : { etag: 'W/"first"', link: '<https://api.github.com/repos/acme/widgets/events?page=2>; rel="next"' })
      },
    }).create()
    const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }

    const page = await provider.repos.eventsPage(repo)
    const again = await provider.repos.eventsPage(repo, { cursor: { etag: page.etag } })
    const next = await provider.repos.eventsPage(repo, { cursor: page.cursor })

    expect(page).toMatchObject({ etag: 'W/"first"', items: [{ source: 'poll' }] })
    expect(again).toMatchObject({ notModified: true, items: [], etag: 'W/"first"' })
    expect(next.etag).toBeUndefined()
    expect(conditions).toEqual([null, 'W/"first"', null])
  })

  it('waits out the poll interval before reading a feed again, unless forced', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-02T00:00:00Z'), toFake: ['Date'] })
    try {
      const urls: string[] = []
      const provider = github({
        fetch: async (url) => {
          urls.push(new URL(url).pathname)
          return json([feedItem('WatchEvent', { action: 'started' })], { 'etag': 'W/"first"', 'x-poll-interval': '60' })
        },
      }).create()
      const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }

      const page = await provider.repos.eventsPage(repo)
      const soon = await provider.repos.eventsPage(repo, { cursor: { etag: page.etag } })
      await provider.users.eventsPage('octocat')
      await provider.repos.eventsPage(repo, { force: true })
      vi.advanceTimersByTime(60_000)
      await provider.repos.eventsPage(repo)

      expect(soon).toEqual({ items: [], throttled: true, etag: 'W/"first"', warnings: [{ code: 'feed_throttled', message: expect.stringContaining('wait 60s more') }] })
      expect(urls).toEqual(['/repos/acme/widgets/events', '/users/octocat/events', '/repos/acme/widgets/events', '/repos/acme/widgets/events'])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('tells a second iteration within the poll interval apart from an empty feed', async () => {
    const provider = github({
      fetch: async () => json([feedItem('WatchEvent', { action: 'started' })], { 'x-poll-interval': '60' }),
    }).create()
    const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }

    const first = provider.repos.events(repo)
    const read = await Array.fromAsync(first)
    const second = provider.repos.events(repo)
    const reread = await Array.fromAsync(second)

    expect(read).toHaveLength(1)
    expect(first.warnings).toEqual([])
    expect(reread).toEqual([])
    expect(second.warnings).toEqual([{ code: 'feed_throttled', message: expect.stringMatching(/force: true/) }])
  })
})

describe('gitlab activity feeds', () => {
  it('resolves the projects a user feed names once, and keeps events in projects it cannot read', async () => {
    const lookups: unknown[] = []
    const event = (id: number, project: number) => ({ id, project_id: project, action_name: 'opened', target_type: 'MergeRequest', target_iid: id, author: { id: 3, username: 'ada' }, created_at: '2026-01-02T03:04:05Z' })
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/api/graphql')) {
        lookups.push(JSON.parse(String(init!.body)).variables.ids)
        return json({ data: { projects: { nodes: [{ id: 'gid://gitlab/Project/1', fullPath: 'acme/tools/widgets' }] } } })
      }
      return url.includes('page=2')
        ? json([event(12, 1)])
        : json([event(10, 1), event(11, 2)], { link: '<https://gitlab.com/api/v4/users/ada/events?page=2>; rel="next"' })
    }
    const provider = gitlab({ fetch }).create()

    const page = await provider.users.eventsPage('ada')
    const next = await provider.users.eventsPage('ada', { cursor: page.cursor })

    expect(page.items.map(item => [item.repo && `${item.repo.owner}/${item.repo.name}`, item.thread?.number])).toEqual([['acme/tools/widgets', '10'], [undefined, undefined]])
    expect(page.warnings).toEqual([expect.objectContaining({ code: 'record_unreachable', subject: 'project 2' })])
    expect(next.items[0]).toMatchObject({ kind: 'state_change', action: 'opened', thread: { kind: 'pull_request', number: '12' } })
    expect(lookups).toEqual([['gid://gitlab/Project/1', 'gid://gitlab/Project/2']])
  })
})

describe('forgejo activity feeds', () => {
  const origin = { forge: 'forgejo', instance: 'codeberg.org' }
  const activity = (op_type: string, content: string) => ({ id: 1, op_type, act_user: { id: 3, login: 'ada' }, repo: repository, content, created: '2026-01-02T03:04:05+02:00' })

  it('reads the thread number from Forgejo and Gitea content alike', () => {
    for (const content of ['["14805","Fix the build"]', '14805|Fix the build']) {
      expect(toForgejoFeedEvent(origin, activity('create_pull_request', content))).toMatchObject({
        kind: 'state_change',
        action: 'opened',
        thread: { kind: 'pull_request', number: '14805' },
        detail: { type: 'state_change', state: 'open' },
      })
    }
  })

  it('reads a push from its commits', () => {
    const content = JSON.stringify({ Commits: [{ Sha1: 'b', Message: 'Fix', AuthorName: 'Ada' }], HeadCommit: { Sha1: 'b' }, CompareURL: 'acme/widgets/compare/a...b', Len: 2 })
    const event = toForgejoFeedEvent(origin, { ...activity('commit_repo', content), ref_name: 'refs/heads/main' })

    expect(event).toMatchObject({ kind: 'push', summary: 'ada pushed 2 commit(s) to main', detail: { before: 'a', after: 'b', commitCount: 2, commits: [{ sha: 'b', message: 'Fix', author: 'Ada' }] } })
  })

  it('takes a tag from the activity type, as Gitea before 1.14 stored the short name', () => {
    for (const [op_type, action] of [['push_tag', 'created'], ['delete_tag', 'deleted']] as const) {
      for (const ref_name of ['refs/tags/v1.0.0', 'v1.0.0']) {
        expect(toForgejoFeedEvent(origin, { ...activity(op_type, ''), ref_name })).toMatchObject({
          kind: 'ref',
          action,
          detail: { type: 'ref', ref: 'v1.0.0', refType: 'tag' },
          summary: `ada ${action} tag v1.0.0`,
        })
      }
    }
  })
})

describe('gitee activity feeds', () => {
  const event = (type: string, payload: Record<string, unknown>) => ({ id: '9', type, actor: { id: 3, login: 'ada' }, repo: { id: 1, full_name: 'acme/widgets', path: 'widgets' }, created_at: '2026-01-02T11:04:05+08:00', payload })

  it('normalises pushes, thread changes and comments', () => {
    expect(toGiteeFeedEvent('gitee.com', event('PushEvent', { ref: 'refs/heads/main', before: 'a', after: 'b', size: 1, commits: [{ sha: 'b', message: 'Fix' }] }))).toMatchObject({ kind: 'push', detail: { commitCount: 1 } })
    expect(toGiteeFeedEvent('gitee.com', event('PullRequestEvent', { action: 'merged', number: 4 }))).toMatchObject({ kind: 'state_change', action: 'merged', thread: { kind: 'pull_request', number: '4' }, detail: { state: 'merged' } })
    expect(toGiteeFeedEvent('gitee.com', event('IssueEvent', { action: 'open', number: 'I8ABCD' }))).toMatchObject({ kind: 'state_change', action: 'opened', thread: { kind: 'issue', number: 'I8ABCD' } })
    expect(toGiteeFeedEvent('gitee.com', event('IssueCommentEvent', { issue: { number: 'I8ABCD' }, comment: { id: 5, body: 'Thanks' } }))).toMatchObject({ kind: 'comment', detail: { comment: { id: '5' }, body: 'Thanks' } })
  })

  it('pages by the id of the last event', async () => {
    const urls: string[] = []
    const provider = gitee({ fetch: async (url) => {
      urls.push(url)
      return json([event('StarEvent', { action: 'starred' })])
    } }).create()
    const repo = { forge: 'gitee', instance: 'gitee.com', owner: 'acme', name: 'widgets' }

    const page = await provider.repos.eventsPage(repo, { perPage: 1 })
    await provider.repos.eventsPage(repo, { perPage: 1, cursor: page.cursor })

    expect(page.cursor).toEqual({ token: '9' })
    expect(urls.map(url => new URL(url).searchParams.get('prev_id'))).toEqual([null, '9'])
  })

  it('does not read a user feed without credentials', () => {
    expect(gitee().create().can('users.events')).toBe(false)
  })
})

describe('tangled activity feeds', () => {
  const did = 'did:plc:ada'
  const records: Record<string, string[]> = {
    'sh.tangled.repo.issue': ['3m0000000004', '3m0000000001'],
    'sh.tangled.feed.comment': ['3m0000000005', '3m0000000003', '3m0000000002'],
    'sh.tangled.feed.star': ['3m0000000009'],
  }
  const lists: Array<[string, string | undefined]> = []
  let revision = 'rev1'
  const cids: Record<string, string> = {}
  const atproto = {
    revisionOf: async () => revision,
    collectionsOf: async () => Object.keys(records),
    listRecordsPage: async (_did: string, collection: string, { limit, cursor }: { limit: number, cursor?: string }) => {
      lists.push([collection, cursor])
      return records[collection]!.filter(rkey => !cursor || rkey < cursor).slice(0, limit).map(rkey => ({ uri: `at://${did}/${collection}/${rkey}`, cid: cids[rkey] ?? 'cid1', value: {} }))
    },
  } as unknown as Parameters<typeof accountFeedPage>[0]['atproto']
  const events: string[] = []
  const recordEvent: Parameters<typeof accountFeedPage>[0]['recordEvent'] = async (activity) => {
    events.push(activity.uri)
    return { forge: 'tangled', instance: 'tangled.org', id: activity.uri, kind: 'other', summary: '', occurredAt: new Date(0), source: 'poll', payload: {} }
  }

  it('merges the thread collections of an account newest first, across pages', async () => {
    const first = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2 })
    const second = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2, cursor: first.cursor })
    const third = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2, cursor: second.cursor })

    expect([first, second, third].map(page => page.items.map(item => item.id.slice(-2)))).toEqual([['05', '04'], ['03', '02'], ['01']])
    expect(third.cursor).toBeUndefined()
    expect(first.etag).toMatch(/^rev1:[\da-f]{16}$/)
    expect(lists.map(([collection]) => collection)).not.toContain('sh.tangled.feed.star')
  })

  it('reports an unchanged revision as not modified without listing records', async () => {
    const { etag } = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2 })
    lists.length = 0
    const page = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2, cursor: { etag } })

    expect(page).toEqual({ items: [], notModified: true, etag })
    expect(lists).toEqual([])
  })

  it('reports a page whose records did not change as not modified, even after other writes', async () => {
    const { etag } = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2 })
    revision = 'rev2'
    events.length = 0
    const page = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2, cursor: { etag } })
    revision = 'rev1'

    expect(page).toEqual({ items: [], notModified: true, etag: `rev2:${etag!.split(':')[1]}` })
    expect(events).toEqual([])
  })

  it('reads the page again when a record on it was edited', async () => {
    const { etag } = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2 })
    revision = 'rev2'
    cids['3m0000000004'] = 'cid2'
    const page = await accountFeedPage({ atproto, recordEvent }, did, { perPage: 2, cursor: { etag } })
    revision = 'rev1'
    delete cids['3m0000000004']

    expect(page.notModified).toBeUndefined()
    expect(page.items.map(item => item.id.slice(-2))).toEqual(['05', '04'])
    expect(page.etag).not.toBe(etag)
  })

  it('still knows an `etag` that holds only the revision', async () => {
    lists.length = 0
    const page = await accountFeedPage({ atproto, recordEvent }, did, { cursor: { etag: 'rev1' } })

    expect(page).toEqual({ items: [], notModified: true, etag: 'rev1' })
    expect(lists).toEqual([])
  })

  it('dates a record without `createdAt` by when it was read, not 1970', async () => {
    const before = Date.now()
    const page = await accountFeedPage({ atproto, recordEvent: async (activity, source, fallbackTime, threads, signal) => ({
      ...await recordEvent(activity, source, fallbackTime, threads, signal),
      occurredAt: fallbackTime,
    }) }, did, { perPage: 2 })

    expect(page.items).toHaveLength(2)
    expect(page.items.every(item => item.occurredAt.getTime() >= before)).toBe(true)
  })
})

describe('fake activity feeds', () => {
  it('lists the recorded writes of a repository and an account, newest first', async () => {
    const forge = fake({ seed: { repos: [{ repo: 'acme/widgets' }], threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Crash' }] } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const [issue] = (await forge.threads.listPage(repo)).items

    await forge.threads.comment(issue!.ref, 'Looking')
    await forge.threads.close(issue!.ref)
    const me = await forge.users.me()

    for (const events of [await Array.fromAsync(forge.repos.events(repo)), await Array.fromAsync(forge.users.events(me.login))]) {
      expect(events.map(event => [event.kind, event.action, event.source])).toEqual([['state_change', 'closed', 'poll'], ['comment', 'created', 'poll']])
    }
  })
})

describe('feed redaction', () => {
  it('redacts the addresses in a Forgejo push activity', () => {
    const content = JSON.stringify({ Len: 1, Commits: [{ Sha1: 'b', AuthorEmail: 'ada@example.com', CommitterEmail: 'bot@example.com' }] })

    expect(JSON.parse((redact({ content }) as { content: string }).content)).toEqual({ Len: 1, Commits: [{ Sha1: 'b', AuthorEmail: 'redacted@example.invalid', CommitterEmail: 'redacted@example.invalid' }] })
  })
})
