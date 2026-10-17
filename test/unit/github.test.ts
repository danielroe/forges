import type { GitHubAuth } from '../../src/github/auth.ts'
import type { TypedGraphQLDocument } from '../../src/github/index.ts'
import type { GitHubNotification } from '../../src/github/types.ts'
import type { ThreadRef } from '../../src/model.ts'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { declaredCapabilities } from '../../src/capabilities.ts'
import { BranchMovedError, ContentNotTextError, ForbiddenError, InsufficientScopeError, NotFoundError, ReadOnlyError, UnresolvedThreadError, UnsupportedOperationError } from '../../src/errors.ts'
import { abortable } from '../../src/fetch.ts'
import { createAppCredentials } from '../../src/github/auth.ts'
import { graphqlOperations, graphqlUrl } from '../../src/github/graphql-client.ts'
import { github } from '../../src/github/index.ts'
import { toEvent, toNotification, toReason, toRepo } from '../../src/github/normalise.ts'
import { commentMarker, upsertComment } from '../../src/helpers.ts'
import { notificationThread } from '../../src/model.ts'
import { contentsFile, contentsListing, fixtureFetch, loadFixtures } from '../utils/fixtures.ts'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' } as const
const pull = { forge: 'github', instance: 'github.com', repo, kind: 'pull_request', number: '42' } as const
const discussion: ThreadRef = { forge: 'github', instance: 'github.com', repo, kind: 'discussion', number: '31' }
const HEAD = '6dcb09b5b57875f334f61aebed695e2e4193db5e'

function tokenProvider(overrides = {}) {
  const { fetch, calls } = fixtureFetch('github', overrides)
  return { provider: github({ auth: { type: 'token', token: 't' }, fetch }), calls }
}

function appProvider(installationId?: number) {
  const { fetch, calls } = fixtureFetch('github')
  return {
    provider: github({ auth: { type: 'app', appId: 12345, privateKey, installationId }, fetch }),
    calls,
  }
}

describe('github provider', () => {
  it('reports github.com as the instance for the default base url', () => {
    const provider = github({ auth: { type: 'token', token: 't' } })

    expect(provider.instance).toBe('github.com')
    expect(provider.baseUrl).toBe('https://api.github.com')
  })

  it('keeps a GHES host distinct from github.com', () => {
    const provider = github({
      baseUrl: 'https://ghe.example.com/api/v3',
      auth: { type: 'token', token: 't' },
    })

    expect(provider.instance).toBe('ghe.example.com')
  })

  it('derives the GraphQL endpoint for github.com and GHES', () => {
    expect(graphqlUrl('https://api.github.com')).toBe('https://api.github.com/graphql')
    expect(graphqlUrl('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com/api/graphql')
  })

  describe('repositories of a user', () => {
    function userProvider() {
      const urls: string[] = []
      const provider = github({ auth: { type: 'token', token: 't' }, fetch: async (url) => {
        urls.push(url)
        if (url === 'https://api.github.com/user') {
          return Response.json({ login: 'Octocat', id: 1 })
        }
        if (url.startsWith('https://api.github.com/user/repos')) {
          return Response.json([{ id: 2, name: 'vault', full_name: 'octocat/vault', private: true, visibility: 'private', owner: { login: 'octocat' } }])
        }
        if (url.startsWith('https://api.github.com/users/')) {
          return Response.json([])
        }
        return Response.json({ message: 'Not Found' }, { status: 404 })
      } })
      return { provider, urls }
    }

    it('lists the private repositories of the authenticated user', async () => {
      const { provider, urls } = userProvider()

      const page = await provider.repos.byOwner({ ...repo, owner: 'octocat', name: '', kind: 'namespace' }, { visibility: 'private' }).page()

      expect(page.items.map(item => item.ref.name)).toEqual(['vault'])
      expect(urls).toEqual([
        'https://api.github.com/orgs/octocat/repos?type=private',
        'https://api.github.com/user',
        'https://api.github.com/user/repos?affiliation=owner&visibility=private',
      ])
    })

    it('lists no private repositories of another user, since GitHub lists only their public ones', async () => {
      const { provider, urls } = userProvider()

      const page = await provider.repos.byOwner({ ...repo, owner: 'hubot', name: '', kind: 'namespace' }, { visibility: 'private' }).page()

      expect(urls).toEqual(['https://api.github.com/orgs/hubot/repos?type=private', 'https://api.github.com/user'])
      expect(page.items).toEqual([])
      expect(page.warnings).toContainEqual(expect.objectContaining({ code: 'filter_unsupported' }))
    })

    it('lists public repositories of a user or an organisation in one request', async () => {
      const { provider, urls } = userProvider()

      await provider.repos.byOwner({ ...repo, owner: 'hubot', name: '', kind: 'namespace' }, { visibility: 'public' }).page()

      expect(urls).toEqual(['https://api.github.com/users/hubot/repos?type=owner'])
    })
  })

  it('marks done with DELETE on the thread, not the subscription', async () => {
    const { provider, calls } = tokenProvider()

    await provider.notifications!.markDone!({ forge: 'github', instance: 'github.com', id: '901234567' })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://api.github.com/notifications/threads/901234567',
    })
  })

  it('maps releases to release subjects and check suites to other, keeping their type', () => {
    const base = {
      unread: true,
      reason: 'ci_activity',
      updated_at: '2025-09-18T09:12:44Z',
      last_read_at: null,
      url: 'https://api.github.com/notifications/threads/901234570',
      repository: { name: 'widgets', full_name: 'acme/widgets' },
    }
    const checkSuite = toNotification('github.com', {
      ...base,
      id: '901234570',
      subject: { title: 'ci failed', url: null, latest_comment_url: null, type: 'CheckSuite' },
    })
    const release = toNotification('github.com', {
      ...base,
      id: '901234571',
      subject: { title: 'v1.0.0', url: 'https://api.github.com/repos/acme/widgets/releases/400850047', latest_comment_url: null, type: 'Release' },
    })

    expect(checkSuite.subject).toMatchObject({ type: 'other', typeRaw: 'CheckSuite' })
    expect(notificationThread(checkSuite)).toBeUndefined()
    expect(release.subject).toEqual({
      type: 'release',
      release: { forge: 'github', instance: 'github.com', repo: expect.objectContaining({ owner: 'acme', name: 'widgets' }), id: '400850047' },
    })
  })

  it('links the latest comment only when the notification names an issue comment', () => {
    const notification = (latest: string | null) => toNotification('github.com', {
      id: '901234572',
      unread: true,
      reason: 'comment',
      updated_at: '2025-09-18T09:12:44Z',
      last_read_at: null,
      url: 'https://api.github.com/notifications/threads/901234572',
      repository: { name: 'widgets', full_name: 'acme/widgets' },
      subject: { title: 'Bug', url: 'https://api.github.com/repos/acme/widgets/pulls/7', latest_comment_url: latest, type: 'PullRequest' },
    })

    expect(notification('https://api.github.com/repos/acme/widgets/issues/comments/770001').latestComment).toMatchObject({ id: '770001', thread: { kind: 'pull_request', number: '7' } })
    expect(notification('https://api.github.com/repos/acme/widgets/pulls/7').latestComment).toBeUndefined()
    expect(notification('https://api.github.com/repos/acme/widgets/pulls/comments/880001').latestComment).toBeUndefined()
    expect(notification(null).latestComment).toBeUndefined()
  })

  it('refuses to address an unresolved thread', async () => {
    const { provider } = tokenProvider()
    await expect(provider.threads.get({ ...pull, number: undefined })).rejects.toThrow(UnresolvedThreadError)
  })

  it('normalises reasons and keeps the native string', () => {
    expect(toReason('assign')).toBe('assigned')
    expect(toReason('security_advisory_credit')).toBe('security_alert')
    expect(toReason('member_feature_requested')).toBe('unknown')
  })

  it('dates a commit timeline entry from its author, which carries no created_at', () => {
    const event = toEvent('github.com', pull, {
      event: 'committed',
      sha: 'adbc9741c0ffee00',
      author: { name: 'Ada Lovelace', date: '2025-03-31T13:49:12Z' },
    })

    expect(event.kind).toBe('commit')
    expect(event.kindRaw).toBe('committed')
    expect(event.occurredAt.toISOString()).toBe('2025-03-31T13:49:12.000Z')
    expect(event.summary).toBe('Ada Lovelace committed adbc974')
  })

  it('ends the notification listing on the last page and reports the etag on the page', async () => {
    const conditions: Array<string | null> = []
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async (_url, init) => {
        conditions.push((init!.headers as Headers).get('if-none-match'))
        return conditions.length === 1
          ? new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'etag': 'W/"first"' } })
          : new Response(null, { status: 304, headers: { etag: 'W/"first"' } })
      },
    })

    const page = await provider.notifications.list().page()

    expect(page.cursor).toBeUndefined()
    expect(page.etag).toBe('W/"first"')

    const again = await provider.notifications.list({ cursor: { etag: page.etag } }).page()

    expect(again.notModified).toBe(true)
    expect(again.etag).toBe('W/"first"')
    expect(conditions).toEqual([null, 'W/"first"'])
  })
})

describe('github discussions', () => {
  it('resolves a discussion notification subject to its number through GraphQL', async () => {
    const { provider, calls } = tokenProvider()
    const page = await provider.notifications!.list({ cursor: { nextUrl: 'https://api.github.com/notifications?all=false&page=2' } }).page()

    expect(notificationThread(page.items[0]!)!).toMatchObject({ kind: 'discussion', number: '31', externalId: 'D_kwDOAAB5ac4AAQ1f' })
    expect(notificationThread(page.items[0]!)!.typeRaw).toBe('Discussion')
    expect(calls.filter(call => call.operationName === 'RecentDiscussions')).toHaveLength(1)
  })

  it('leaves a discussion unresolved when the title search is ambiguous', async () => {
    const { fetch } = fixtureFetch('github', {
      'POST https://api.github.com/graphql RecentDiscussions': {
        status: 200,
        body: { data: { r0: { discussions: { nodes: [
          { id: 'D_kwDOAAB5ac4AAQ1f', number: 31, title: 'Weekly digest discussion', updatedAt: '2025-09-17T11:44:58Z' },
          { id: 'D_kwDOAAB5ac4AAQ2g', number: 64, title: 'Weekly digest discussion', updatedAt: '2025-09-17T11:45:01Z' },
        ] } } } },
      },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })
    const page = await provider.notifications!.list({ cursor: { nextUrl: 'https://api.github.com/notifications?all=false&page=2' } }).page()

    expect(notificationThread(page.items[0]!)!.kind).toBe('discussion')
    expect(notificationThread(page.items[0]!)!.number).toBeUndefined()
  })

  it('gets a discussion as a first-class thread', async () => {
    const { provider } = tokenProvider()
    const thread = await provider.threads.get(discussion)

    expect(thread).toMatchObject({ kind: 'discussion', title: 'Weekly digest discussion', state: 'open', commentCount: 1 })
    expect(thread.ref.externalId).toBe('D_kwDOAAB5ac4AAQ1f')
    expect(thread.author?.login).toBe('octocat')
    expect(thread.createdAt).toBeInstanceOf(Date)
  })

  it('lists discussion comments and replies as comment events', async () => {
    const { provider } = tokenProvider()
    const events = []
    for await (const event of provider.threads.events(discussion)) {
      events.push(event)
    }

    expect(events.map(event => [event.kind, event.kindRaw, event.actor?.isBotHint])).toEqual([
      ['comment', 'DiscussionComment', false],
      ['comment', 'DiscussionCommentReply', true],
    ])
  })

  it('names a bot from GraphQL as the REST API does', async () => {
    const { provider } = tokenProvider()
    const events = []
    for await (const event of provider.threads.events(discussion)) {
      events.push(event)
    }

    expect(events[1]!.actor).toMatchObject({ login: 'github-actions[bot]', id: '41898282', app: { slug: 'github-actions' } })
    expect(events[0]!.actor).not.toHaveProperty('app')
  })

  it('looks up the node id once before mutating a discussion without one', async () => {
    const { provider, calls } = tokenProvider()
    await provider.threads.close(discussion, { reason: 'completed' })

    expect(calls.map(call => call.operationName)).toEqual(['DiscussionThread', 'CloseDiscussion'])
    expect(JSON.parse(calls[1]!.body!).variables).toEqual({ id: 'D_kwDOAAB5ac4AAQ1f', reason: 'RESOLVED' })
  })

  it('resolves a discussion state change with the discussion from the mutation', async () => {
    const { provider, calls } = tokenProvider()
    const ref = { ...discussion, externalId: 'D_kwDOAAB5ac4AAQ1f' }

    await expect(provider.threads.close(ref)).resolves.toMatchObject({ kind: 'discussion', title: 'Weekly digest discussion', state: 'closed', closedAt: new Date('2025-09-18T09:00:00Z') })
    await expect(provider.threads.reopen!(ref)).resolves.toMatchObject({ kind: 'discussion', state: 'open', closedAt: undefined })

    expect(calls.map(call => call.operationName)).toEqual(['CloseDiscussion', 'ReopenDiscussion'])
    expect(JSON.parse(calls[0]!.body!).query).toContain('closeDiscussion(input: { discussionId: $id, reason: $reason }) { discussion { id number title body closed')
  })

  it('maps close reasons a discussion has, and passes `reasonRaw` through', async () => {
    const { provider, calls } = tokenProvider()
    const ref = { ...discussion, externalId: 'D_kwDOAAB5ac4AAQ1f' }

    await expect(provider.threads.close(ref, { reason: 'not_planned' })).rejects.toThrow(UnsupportedOperationError)
    await provider.threads.close(ref, { reasonRaw: 'outdated' })

    expect(JSON.parse(calls.at(-1)!.body!).variables).toEqual({ id: 'D_kwDOAAB5ac4AAQ1f', reason: 'OUTDATED' })
  })

  it('mutates directly when the ref already carries the node id', async () => {
    const { provider, calls } = tokenProvider()
    await provider.threads.createComment!({ ...discussion, externalId: 'D_kwDOAAB5ac4AAQ1f' }, 'Nice')
    await provider.threads.reopen!({ ...discussion, externalId: 'D_kwDOAAB5ac4AAQ1f' })

    expect(calls.map(call => call.operationName)).toEqual(['AddDiscussionComment', 'ReopenDiscussion'])
  })

  it('closes an issue with its reason', async () => {
    const requests: Array<{ method?: string, url: string, body?: unknown }> = []
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async (url, init) => {
        requests.push({ method: init?.method, url, body: init?.body && JSON.parse(String(init.body)) })
        return Response.json({ number: 7, title: 'Flaky test', state: 'closed', state_reason: 'not_planned', closed_at: '2025-09-18T09:00:00Z' })
      },
    })

    const closed = await provider.threads.close({ forge: 'github', instance: 'github.com', repo, kind: 'issue', number: '7' }, { reason: 'not_planned' })

    expect(closed).toMatchObject({ title: 'Flaky test', state: 'closed', stateReason: 'not_planned', closedAt: new Date('2025-09-18T09:00:00Z') })

    expect(requests).toEqual([{ method: 'PATCH', url: 'https://api.github.com/repos/acme/widgets/issues/7', body: { state: 'closed', state_reason: 'not_planned' } }])
  })

  describe('setMilestone', () => {
    const issue = { forge: 'github', instance: 'github.com', repo, kind: 'issue', number: '7' } as const

    function milestoneProvider() {
      const requests: Array<{ method?: string, url: string, body?: unknown }> = []
      const provider = github({
        auth: { type: 'token', token: 't' },
        fetch: async (url, init) => {
          requests.push({ method: init?.method, url, body: init?.body && JSON.parse(String(init.body)) })
          const milestones = [{ number: 3, title: 'v1.0', state: 'closed' }, { number: 4, title: 'v2.0', state: 'open' }]
          return url.includes('/milestones')
            ? Response.json(milestones)
            : Response.json({ number: 7, milestone: milestones.find(milestone => milestone.number === (requests.at(-1)!.body as { milestone: number | null }).milestone) ?? null })
        },
      })
      return { provider, requests }
    }

    it('sends a numeric id as it is', async () => {
      const { provider, requests } = milestoneProvider()

      await expect(provider.threads.setMilestone(issue, '3')).resolves.toMatchObject({ id: '3', title: 'v1.0', state: 'closed' })

      expect(requests).toEqual([{ method: 'PATCH', url: 'https://api.github.com/repos/acme/widgets/issues/7', body: { milestone: 3 } }])
    })

    it('looks a title up among open and closed milestones', async () => {
      const { provider, requests } = milestoneProvider()

      await expect(provider.threads.setMilestone(issue, 'v2.0')).resolves.toMatchObject({ id: '4', title: 'v2.0', state: 'open' })

      expect(requests.map(request => request.url)).toEqual([
        'https://api.github.com/repos/acme/widgets/milestones?state=all',
        'https://api.github.com/repos/acme/widgets/issues/7',
      ])
      expect(requests.at(-1)!.body).toEqual({ milestone: 4 })
    })

    it('refuses a title no milestone has instead of clearing the milestone', async () => {
      const { provider, requests } = milestoneProvider()

      await expect(provider.threads.setMilestone(issue, 'v3.0')).rejects.toThrow('No milestone titled v3.0')
      expect(requests.filter(request => request.method === 'PATCH')).toEqual([])
    })
  })
})

describe('github thread updates', () => {
  it('closes, relabels and reassigns an issue in one request', async () => {
    const { provider, calls } = tokenProvider()
    await provider.threads.update({ ...pull, kind: 'issue' }, { title: 'Retry uploads', state: 'closed', labels: ['bug'], assignees: ['octocat', { forge: 'github', instance: 'github.com', login: 'hubot', id: '2', isBotHint: true }] })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH https://api.github.com/repos/acme/widgets/issues/42'])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'Retry uploads', state: 'closed', labels: ['bug'], assignees: ['octocat', 'hubot'] })
  })

  it('sends a pull request with labels or assignees through the issue, then reads it back', async () => {
    const { provider, calls } = tokenProvider()
    const thread = await provider.threads.update(pull, { state: 'closed', labels: [], assignees: [] })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'PATCH https://api.github.com/repos/acme/widgets/issues/42',
      'GET https://api.github.com/repos/acme/widgets/pulls/42',
    ])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ state: 'closed', labels: [], assignees: [] })
    expect(thread.ref.kind).toBe('pull_request')
  })

  it('lists comments since a time when upserting a comment with since', async () => {
    const marked = { id: 7, body: `Deployed\n\n${commentMarker('mutation-1')}`, created_at: '2026-03-01T12:00:03Z', updated_at: '2026-03-01T12:00:03Z' }
    const { provider, calls } = tokenProvider({
      'GET https://api.github.com/repos/acme/widgets/issues/42/comments?since=2026-03-01T12:00:00.000Z': { status: 200, body: [marked] },
      'PATCH https://api.github.com/repos/acme/widgets/issues/comments/7': { status: 200, body: marked },
    })

    const result = await upsertComment(provider, pull, { key: 'mutation-1', body: 'Deployed to staging', since: new Date('2026-03-01T12:00:00Z') })

    expect(result.created).toBe(false)
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /repos/acme/widgets/issues/42/comments',
      'PATCH /repos/acme/widgets/issues/comments/7',
    ])
    expect(new URL(calls[0]!.url).searchParams.get('since')).toBe('2026-03-01T12:00:00.000Z')
  })

  it('edits a pull request without labels or assignees through the pulls endpoint', async () => {
    const { provider, calls } = tokenProvider({ 'PATCH https://api.github.com/repos/acme/widgets/pulls/42': { status: 200, body: { number: 42, state: 'closed', title: 'Retry uploads' } } })
    await provider.threads.update(pull, { title: 'Retry uploads', state: 'closed' })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PATCH https://api.github.com/repos/acme/widgets/pulls/42'])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'Retry uploads', state: 'closed' })
  })

  it('resolves a discussion state update with the discussion from the mutation', async () => {
    const { provider, calls } = tokenProvider()

    await expect(provider.threads.update(discussion, { state: 'closed' })).resolves.toMatchObject({ state: 'closed' })
    expect(calls.map(call => call.operationName)).toEqual(['DiscussionThread', 'CloseDiscussion'])
  })

  it('refuses labels on a discussion before it writes anything', async () => {
    const { provider, calls } = tokenProvider()

    await expect(provider.threads.update(discussion, { state: 'closed', labels: ['bug'] })).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })
})

describe('github app installations', () => {
  it('only supports installations under app auth', async () => {
    expect(tokenProvider().provider.can('installations.list')).toBe(false)
    await expect(tokenProvider().provider.installations.get('1')).rejects.toThrow(UnsupportedOperationError)
    expect(appProvider().provider.capabilities.installations.list).toBe(true)
  })

  it('declares only installations for an app without an installation', async () => {
    const { provider, calls } = appProvider()

    expect(provider.can('installations.list')).toBe(true)
    expect(provider.can('repos.get')).toBe(false)
    expect(provider.can('threads.list', 'issue')).toBe(false)
    expect(provider.can('notifications.list')).toBe(false)
    await expect(provider.repos.get(repo)).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it('declares notifications only for classic tokens', () => {
    const can = (auth: GitHubAuth) => github({ auth }).can('notifications.list')

    expect(can({ type: 'token', token: 'ghp_x' })).toBe(true)
    expect(can({ type: 'token', token: 'gho_x' })).toBe(true)
    expect(can({ type: 'token', token: () => 'github_pat_x' })).toBe(true)
    expect(can({ type: 'token', token: 'github_pat_x' })).toBe(false)
    expect(can({ type: 'token', token: 'ghu_x' })).toBe(false)
    expect(can({ type: 'token', token: 'ghs_x' })).toBe(false)
    expect(can({ type: 'token', token: () => 'x', kind: 'fine-grained' })).toBe(false)
    expect(can({ type: 'app', appId: 1, privateKey: '', installationId: 1 })).toBe(false)
  })

  it('lists the repositories of an installation token', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 'ghs_x' }, fetch })
    await provider.repos.list().page()

    expect(provider.can('users.me')).toBe(false)
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/installation/repositories'])
  })

  it('exchanges app credentials for an installation token and reuses it', async () => {
    const { provider, calls } = appProvider(55123)

    await provider.repos.get(repo)
    await provider.repos.get(repo)

    const tokenCalls = calls.filter(call => call.url.endsWith('/access_tokens'))
    expect(tokenCalls).toHaveLength(1)
    expect(calls.at(-1)!.authorization).toBe('Bearer ghs_fixtureinstallationtoken')
  })

  it('shares one installation token exchange between concurrent requests', async () => {
    const { provider, calls } = appProvider(55123)

    await Promise.all([provider.repos.get(repo), provider.repos.get(repo)])

    expect(calls.filter(call => call.url.endsWith('/access_tokens'))).toHaveLength(1)
  })

  it('does not start an installation token exchange for an already-aborted caller', async () => {
    const { fetch } = fixtureFetch('github')
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    const provider = github({ auth: { type: 'app', appId: 12345, privateKey }, fetch })
    const reason = new Error('cancelled')

    try {
      await expect(provider.installations.token('55123', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)

      expect(importKey).not.toHaveBeenCalled()
    }
    finally {
      importKey.mockRestore()
    }
  })

  it('aborts one caller without cancelling a shared installation token exchange', async () => {
    const { fetch: replay, calls } = fixtureFetch('github')
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    let exchanges = 0
    const provider = github({
      auth: { type: 'app', appId: 12345, privateKey },
      fetch: async (input, init) => {
        exchanges++
        started.resolve()
        await abortable(pending.promise, init?.signal ?? undefined)
        return replay(input, init)
      },
    })
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const first = expect(provider.installations.token('55123', { signal: controller.signal })).rejects.toBe(reason)
    const second = provider.installations.token('55123')

    await started.promise
    controller.abort(reason)
    await first
    pending.resolve()

    await expect(second).resolves.toMatchObject({ token: 'ghs_fixtureinstallationtoken' })
    await expect(provider.installations.token('55123')).resolves.toMatchObject({ token: 'ghs_fixtureinstallationtoken' })
    expect(exchanges).toBe(1)
    expect(calls.filter(call => call.url.endsWith('/access_tokens'))).toHaveLength(1)
  })

  it('retries a failed shared installation token exchange', async () => {
    const { fetch: replay } = fixtureFetch('github')
    const fetch = vi.fn(replay).mockResolvedValueOnce(Response.json({ message: 'Unavailable' }, { status: 500 }))
    const provider = github({ auth: { type: 'app', appId: 12345, privateKey }, fetch })

    const results = await Promise.allSettled([provider.installations.token('55123'), provider.installations.token('55123')])

    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(provider.installations.token('55123')).resolves.toMatchObject({ token: 'ghs_fixtureinstallationtoken' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries failed shared app JWT signing', async () => {
    const reason = new Error('signing failed')
    const importKey = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(reason)
    const credentials = createAppCredentials({ type: 'app', appId: 12345, privateKey }, { baseUrl: 'https://api.github.com' })

    try {
      const results = await Promise.allSettled([credentials.appJwt(), credentials.appJwt()])

      expect(results).toEqual([{ status: 'rejected', reason }, { status: 'rejected', reason }])
      expect(importKey).toHaveBeenCalledTimes(1)
      const jwt = await credentials.appJwt()
      expect(jwt.split('.')).toHaveLength(3)
      await expect(credentials.appJwt()).resolves.toBe(jwt)
      expect(importKey).toHaveBeenCalledTimes(2)
    }
    finally {
      importKey.mockRestore()
    }
  })

  it('reports the retries and rate limits of the installation token exchange', async () => {
    const { fetch: replay } = fixtureFetch('github')
    const onRetry = vi.fn()
    const onRateLimit = vi.fn()
    let limited = false
    const provider = github({
      auth: { type: 'app', appId: 12345, privateKey, installationId: 55123 },
      fetch: async (input, init) => {
        if (String(input).endsWith('/access_tokens') && !limited) {
          limited = true
          return new Response('{"message":"You have exceeded a secondary rate limit."}', { status: 403, headers: { 'retry-after': '0' } })
        }
        const response = await replay(input, init)
        const headers = new Headers(response.headers)
        headers.set('x-ratelimit-remaining', '10')
        return new Response(response.body, { status: response.status, headers })
      },
      onRetry,
      onRateLimit,
    })

    await provider.repos.get(repo)

    const exchange = 'https://api.github.com/app/installations/55123/access_tokens'
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({ url: exchange, method: 'POST', wait: 0 })
    expect(onRateLimit.mock.calls.map(([{ url, method }]) => `${method} ${url}`)).toEqual([`POST ${exchange}`, 'GET https://api.github.com/repos/acme/widgets'])
  })

  it('lists installations and their repositories', async () => {
    const { provider } = appProvider()
    const installations = []
    for await (const installation of provider.installations!.list()) {
      installations.push(installation)
    }
    const repos = []
    for await (const ref of provider.installations!.repos(installations[0]!)) {
      repos.push(ref)
    }

    expect(installations.map(installation => [installation.id, installation.account?.login, installation.targetTypeRaw])).toEqual([
      ['55123', 'acme', 'Organization'],
      ['55124', 'octocat', 'User'],
    ])
    expect(repos.map(repo => repo.ref)).toEqual([expect.objectContaining({ owner: 'acme', name: 'widgets', instance: 'github.com' })])
  })

  it('derives one provider per installation sharing a single app JWT', async () => {
    const { provider, calls } = appProvider()
    const derived = []
    for await (const entry of provider.installations!.providers()) {
      derived.push(entry)
      await entry.provider.repos.get(repo)
    }

    expect(derived).toHaveLength(2)
    const jwtCalls = calls.filter(call => call.url.endsWith('/app/installations') || call.url.endsWith('/access_tokens'))
    expect(jwtCalls).toHaveLength(3)
    expect(new Set(jwtCalls.map(call => call.authorization)).size).toBe(1)
    expect(calls.filter(call => call.url.endsWith('/repos/acme/widgets')).map(call => call.authorization)).toEqual([
      'Bearer ghs_fixtureinstallationtoken',
      'Bearer ghs_fixtureinstallationtokentwo',
    ])
  })
})

describe('github repository and thread metadata', () => {
  it('lists repository labels, milestones and collaborators', async () => {
    const { provider } = tokenProvider()

    const labels = await Array.fromAsync(provider.repos.labels(repo))
    const milestones = await Array.fromAsync(provider.repos.milestones(repo))
    const collaborators = await Array.fromAsync(provider.repos.collaborators(repo))

    expect(labels.map(label => label.name)).toEqual(['bug', 'good first issue'])
    expect(labels[0]!.colour).toBe('d73a4a')
    expect(milestones[0]).toMatchObject({ id: '3', title: 'v2', state: 'open' })
    expect(milestones[0]!.dueOn).toBeInstanceOf(Date)
    expect(collaborators.map(item => [item.actor.login, item.role])).toEqual([['octocat', 'maintain'], ['hubot', 'read']])
  })

  it('lists contributors with and without an account', async () => {
    const urls: string[] = []
    const provider = github({ fetch: async (url) => {
      urls.push(url)
      return Response.json([
        { login: 'octocat', id: 1, type: 'User', contributions: 10 },
        { type: 'Anonymous', name: 'Ada', email: 'ada@example.com', contributions: 3 },
      ])
    } })

    const { items } = await provider.repos.contributors(repo).page()

    expect(new URL(urls[0]!).searchParams.get('anon')).toBe('1')
    expect(items.map(({ actor, name, email, contributions }) => ({ login: actor?.login, name, email, contributions }))).toEqual([
      { login: 'octocat', name: undefined, email: undefined, contributions: 10 },
      { login: undefined, name: 'Ada', email: 'ada@example.com', contributions: 3 },
    ])
  })

  it('reads one account\'s role on a repository', async () => {
    const { provider } = tokenProvider()

    expect(await provider.repos.permissionFor(repo, 'octocat')).toBe('maintain')
  })

  it('adds collaborators with the permission names GitHub accepts', async () => {
    const url = 'https://api.github.com/repos/acme/widgets/collaborators/octocat'
    const { fetch, calls } = fixtureFetch('github', { [`PUT ${url}`]: { status: 204 } })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    for (const role of ['read', 'triage', 'write', 'maintain', 'admin'] as const) {
      await provider.repos.addCollaborator(repo, 'octocat', role)
    }

    expect(calls.map(call => JSON.parse(call.body!).permission)).toEqual(['pull', 'triage', 'push', 'maintain', 'admin'])
  })

  it('tells an invitation apart from a collaborator who has access', async () => {
    const url = 'https://api.github.com/repos/acme/widgets/collaborators'
    const { fetch } = fixtureFetch('github', {
      [`PUT ${url}/octocat`]: { status: 201, body: { id: 1, permissions: 'write', invitee: { login: 'octocat', id: 583231 } } },
      [`PUT ${url}/hubot`]: { status: 204 },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    expect(await provider.repos.addCollaborator(repo, 'octocat', 'write')).toEqual({ status: 'invited' })
    expect(await provider.repos.addCollaborator(repo, 'hubot', 'write')).toEqual({ status: 'added' })
  })

  it('ignores a label the thread no longer carries when removing labels', async () => {
    const { provider } = tokenProvider({
      'DELETE https://api.github.com/repos/acme/widgets/issues/42/labels/bug': { status: 404, body: { message: 'Label does not exist', documentation_url: 'https://docs.github.com/rest/issues/labels#remove-a-label-from-an-issue' } },
      'DELETE https://api.github.com/repos/acme/widgets/issues/43/labels/bug': { status: 404, body: { message: 'Not Found' } },
      'GET https://api.github.com/repos/acme/widgets/issues/42/labels?per_page=100': { status: 200, body: [{ name: 'triage', color: 'ededed' }] },
    })

    await expect(provider.threads.removeLabels(pull, ['bug'])).resolves.toEqual([{ name: 'triage', colour: 'ededed' }])
    await expect(provider.threads.removeLabels({ ...pull, number: '43' }, ['bug'])).rejects.toThrow(NotFoundError)
  })

  it('resolves removeLabels with the labels in the last delete response', async () => {
    const { provider, calls } = tokenProvider({
      'DELETE https://api.github.com/repos/acme/widgets/issues/42/labels/bug': { status: 200, body: [{ name: 'triage', color: 'ededed' }, { name: 'ui', color: '0e8a16' }] },
      'DELETE https://api.github.com/repos/acme/widgets/issues/42/labels/ui': { status: 200, body: [{ name: 'triage', color: 'ededed' }] },
    })

    await expect(provider.threads.removeLabels(pull, ['bug', 'ui'])).resolves.toEqual([{ name: 'triage', colour: 'ededed' }])
    expect(calls.map(call => call.method)).toEqual(['DELETE', 'DELETE'])
  })

  it.each(['setLabels', 'addLabels'] as const)('resolves %s with the labels in the response', async (verb) => {
    const labels = [{ name: 'bug', color: 'd73a4a', description: 'Something is broken' }, { name: 'triage', color: 'ededed', description: null }]
    const { provider, calls } = tokenProvider({
      [`${verb === 'setLabels' ? 'PUT' : 'POST'} https://api.github.com/repos/acme/widgets/issues/42/labels`]: { status: 200, body: labels },
    })

    await expect(provider.threads[verb](pull, ['bug'])).resolves.toEqual([{ name: 'bug', colour: 'd73a4a', description: 'Something is broken' }, { name: 'triage', colour: 'ededed' }])
    expect(calls).toHaveLength(1)
  })

  it('resolves setAssignees with the assignees in the response', async () => {
    const { provider, calls } = tokenProvider({
      'PATCH https://api.github.com/repos/acme/widgets/issues/42': { status: 200, body: { number: 42, assignees: [{ login: 'octocat', id: 583231, type: 'User' }] } },
    })

    await expect(provider.threads.setAssignees(pull, ['octocat'])).resolves.toMatchObject([{ login: 'octocat', id: '583231' }])
    expect(calls.map(call => [call.method, JSON.parse(call.body!)])).toEqual([['PATCH', { assignees: ['octocat'] }]])
  })

  it('adds and removes labels without replacing the rest', async () => {
    const { provider, calls } = tokenProvider()

    await provider.threads.addLabels(pull, ['bug'])
    await provider.threads.removeLabels(pull, ['bug'])

    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /repos/acme/widgets/issues/42/labels',
      'DELETE /repos/acme/widgets/issues/42/labels/bug',
    ])
  })

  it('removes a reaction by finding the viewer\'s own award', async () => {
    const { provider, calls } = tokenProvider()

    await provider.threads.react(pull, '+1')
    await provider.threads.unreact(pull, '+1')

    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /repos/acme/widgets/issues/42/reactions',
      'GET /repos/acme/widgets/issues/42/reactions',
      'GET /user',
      'DELETE /repos/acme/widgets/issues/42/reactions/77',
    ])
  })

  it('reads merge methods and per-repo features from the repository', async () => {
    const { provider } = tokenProvider()

    const result = await provider.repos.get(repo)

    expect(result.mergeMethods).toEqual(['squash'])
    expect(result.features).toMatchObject({ issues: true, discussions: true, wiki: false })
  })
})

describe('github moderation', () => {
  const issue = { forge: 'github', instance: 'github.com', repo, kind: 'issue', number: '17' } as const
  const org = { forge: 'github', instance: 'github.com', owner: 'acme', name: '', kind: 'namespace' } as const
  const commit = { forge: 'github', instance: 'github.com', repo, sha: HEAD } as const

  it('locks and unlocks an issue or pull request through REST, with the reason GitHub names', async () => {
    const { provider, calls } = tokenProvider()

    await provider.threads.lock(issue, { reason: 'too_heated' })
    await provider.threads.unlock(issue)
    await provider.threads.lock(pull)
    await provider.threads.unlock(pull)

    expect(calls.map(call => `${call.method} ${call.url} ${call.body ?? ''}`)).toEqual([
      'PUT https://api.github.com/repos/acme/widgets/issues/17/lock {"lock_reason":"too heated"}',
      'DELETE https://api.github.com/repos/acme/widgets/issues/17/lock ',
      'PUT https://api.github.com/repos/acme/widgets/issues/42/lock {}',
      'DELETE https://api.github.com/repos/acme/widgets/issues/42/lock ',
    ])
  })

  it('locks and unlocks a discussion through GraphQL, without a reason', async () => {
    const { provider, calls } = tokenProvider()
    const ref = { ...discussion, externalId: 'D_kwDOAAB5ac4AAQ1f' }

    await provider.threads.lock(ref, { reason: 'off_topic' })
    await provider.threads.unlock(ref)

    expect(calls.map(call => [call.operationName, JSON.parse(call.body!).variables])).toEqual([
      ['LockLockable', { id: 'D_kwDOAAB5ac4AAQ1f' }],
      ['UnlockLockable', { id: 'D_kwDOAAB5ac4AAQ1f' }],
    ])
  })

  it('hides and unhides a comment by its node id, with the classifier GitHub names', async () => {
    const { provider, calls } = tokenProvider()

    await provider.threads.hideComment({ forge: 'github', instance: 'github.com', thread: issue, id: '770001' }, 'low_quality')
    await provider.threads.unhideComment({ forge: 'github', instance: 'github.com', thread: pull, id: '770001' })
    await provider.commits.hideComment({ forge: 'github', instance: 'github.com', commit, id: '770005' }, 'spam')
    await provider.commits.unhideComment({ forge: 'github', instance: 'github.com', commit, id: '770005' })
    await provider.threads.hideComment({ forge: 'github', instance: 'github.com', thread: discussion, id: 'DC_kwDOAAB5ac4AAQ2a' }, 'outdated')
    await provider.threads.unhideComment({ forge: 'github', instance: 'github.com', thread: discussion, id: 'DC_kwDOAAB5ac4AAQ2a' })

    expect(calls.map(call => call.operationName ? `${call.operationName} ${JSON.stringify(JSON.parse(call.body!).variables)}` : `${call.method} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/acme/widgets/issues/comments/770001',
      'MinimizeComment {"id":"IC_kwDOAAB5ac5abc001","classifier":"LOW_QUALITY"}',
      'GET https://api.github.com/repos/acme/widgets/issues/comments/770001',
      'UnminimizeComment {"id":"IC_kwDOAAB5ac5abc001"}',
      'GET https://api.github.com/repos/acme/widgets/comments/770005',
      'MinimizeComment {"id":"CC_kwDOAAB5ac4ABcd5","classifier":"SPAM"}',
      'GET https://api.github.com/repos/acme/widgets/comments/770005',
      'UnminimizeComment {"id":"CC_kwDOAAB5ac4ABcd5"}',
      'MinimizeComment {"id":"DC_kwDOAAB5ac4AAQ2a","classifier":"OUTDATED"}',
      'UnminimizeComment {"id":"DC_kwDOAAB5ac4AAQ2a"}',
    ])
  })

  it('blocks and unblocks an account for an organisation and for the viewer', async () => {
    const { provider, calls } = tokenProvider()

    await provider.orgs.block(org, 'spammer')
    await provider.orgs.unblock(org, 'spammer')
    await provider.users.block('spammer')
    await provider.users.unblock('spammer')

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'PUT https://api.github.com/orgs/acme/blocks/spammer',
      'DELETE https://api.github.com/orgs/acme/blocks/spammer',
      'PUT https://api.github.com/user/blocks/spammer',
      'DELETE https://api.github.com/user/blocks/spammer',
    ])
    expect(provider.scopesFor('orgs.block')).toEqual({ token: ['admin:org'], permissions: { organization_user_blocking: 'write' } })
    expect(provider.scopesFor('users.unblock').permissions).toEqual({ blocking: 'write' })
  })

  it('blocks for the viewer only with a user token', () => {
    const app = github({ auth: { type: 'app', appId: 1, privateKey, installationId: 1 } })

    expect(app.can('users.block')).toBe(false)
    expect(app.can('orgs.block')).toBe(true)
    expect(declaredCapabilities(github({ baseUrl: 'https://ghe.example.com/api/v3', auth: { type: 'token', token: 't' } })).orgs.block).toBe('unverified')
  })
})

describe('github closing references', () => {
  const issue = { forge: 'github', instance: 'github.com', repo, kind: 'issue', number: '17' } as const

  it('lists the issues a pull request closes, in any repository', async () => {
    const { provider, calls } = tokenProvider()

    const page = await provider.threads.closingIssues(pull, { perPage: 10 }).page()

    expect(page.items.map(thread => `${thread.ref.repo.name}#${thread.ref.number} ${thread.kind} ${thread.state}`)).toEqual(['widgets#17 issue open', 'docs#3 issue open'])
    expect(page.items[1]!.ref.repo).toMatchObject({ owner: 'acme', name: 'docs', externalId: '1296270' })
    expect(page.cursor).toBeUndefined()
    expect(JSON.parse(calls[0]!.body!).variables).toEqual({ owner: 'acme', name: 'widgets', number: 42, first: 10, after: null })
  })

  it('lists the pull requests that close an issue, merged or not', async () => {
    const { provider, calls } = tokenProvider()

    const pulls = await Array.fromAsync(provider.threads.closingPullRequests(issue))

    expect(pulls.map(thread => `#${thread.ref.number} ${thread.kind} ${thread.branches?.head.ref}`)).toEqual(['#42 pull_request cache-dir'])
    expect(calls[0]!.operationName).toBe('ClosingPullRequests')
  })

  it('reads closing references only for the kind they belong to, and only with a credential', async () => {
    const { provider, calls } = tokenProvider()

    await expect(provider.threads.closingIssues(issue).page()).rejects.toThrow(UnsupportedOperationError)
    await expect(provider.threads.closingPullRequests(pull).page()).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toHaveLength(0)
    expect(github().can('threads.closingIssues')).toBe(false)
  })
})

describe('github organisation teams', () => {
  const org = { forge: 'github', instance: 'github.com', owner: 'acme', name: '', kind: 'namespace' } as const

  it('lists an organisation\'s teams and their members', async () => {
    const { provider, calls } = tokenProvider()

    const teams = await Array.fromAsync(provider.orgs.teams(org))
    const members = await Array.fromAsync(provider.orgs.teamMembers(teams[0]!.ref))

    expect(teams.map(team => [team.ref.slug, team.ref.id, team.name, team.visibilityRaw, team.parent?.slug])).toEqual([
      ['stewards', '1', 'Stewards', 'closed', undefined],
      ['core', '2', 'Core', 'secret', 'stewards'],
    ])
    expect(teams[0]!.ref.org).toMatchObject({ kind: 'namespace', owner: 'acme', name: '' })
    expect(members.map(member => [member.login, member.isBotHint])).toEqual([['octocat', false], ['hubot', true]])
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /orgs/acme/teams',
      'GET /orgs/acme/teams/stewards/members',
    ])
  })

  it('reports organisation teams unsupported without a credential', () => {
    const anonymous = github({})

    expect(anonymous.can('orgs.teams')).toBe(false)
    expect(anonymous.can('orgs.teamMembers')).toBe(false)
  })
})

describe('github contributor statistics', () => {
  it('retries while GitHub reports the statistics are not ready', async () => {
    const responses = [
      new Response(null, { status: 202 }),
      Response.json([{ author: { login: 'octocat', id: 583231 }, total: 2, weeks: [{ w: 1704067200, a: 1, d: 0, c: 2 }] }]),
    ]
    let calls = 0
    const provider = github({ fetch: async () => responses[calls++]! })

    const stats = await provider.repos.contributorStats(repo)

    expect(calls).toBe(2)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.actor?.login).toBe('octocat')
    expect(stats[0]!.weeks[0]).toEqual({ week: new Date('2024-01-01T00:00:00Z'), additions: 1, deletions: 0, commits: 2 })
  })

  it('throws once GitHub still reports the statistics are not ready', async () => {
    let calls = 0
    const provider = github({ fetch: async () => {
      calls++
      return new Response('{}', { status: 202 })
    } })
    vi.useFakeTimers()
    try {
      const stats = provider.repos.contributorStats(repo)
      const settled = expect(stats).rejects.toMatchObject({ name: 'ForgeApiError', status: 202 })
      await vi.runAllTimersAsync()
      await settled
    }
    finally {
      vi.useRealTimers()
    }

    expect(calls).toBe(6)
  })
})

describe('github templates', () => {
  const api = 'https://api.github.com/repos/acme'
  const missing = { status: 404, body: { message: 'Not Found' } }
  const dotGithub = (visibility = 'public') => ({ status: 200, body: { name: '.github', full_name: 'acme/.github', owner: { login: 'acme' }, private: visibility !== 'public', visibility } })

  it('takes the pull request template from `.github` over the root and `docs`', async () => {
    const { provider, calls } = tokenProvider({
      [`GET ${api}/widgets/contents`]: contentsListing('.github/', 'docs/', 'pull_request_template.md'),
      [`GET ${api}/widgets/contents/.github`]: contentsListing('.github/ISSUE_TEMPLATE/', '.github/PULL_REQUEST_TEMPLATE.md'),
      [`GET ${api}/widgets/contents/docs`]: contentsListing('docs/pull_request_template.md'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE`]: contentsListing('.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/question.md'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE/bug.yml`]: contentsFile('.github/ISSUE_TEMPLATE/bug.yml', 'name: Bug\nbody: []\n'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE/question.md`]: contentsFile('.github/ISSUE_TEMPLATE/question.md', '---\nname: Question\n---\nAsk away'),
      [`GET ${api}/widgets/contents/.github/PULL_REQUEST_TEMPLATE.md`]: contentsFile('.github/PULL_REQUEST_TEMPLATE.md', '### Linked issue'),
    })

    const templates = await provider.repos.templates(repo)

    expect(templates.map(({ kind, name, path, format, body, source }) => ({ kind, name, path, format, body, source }))).toEqual([
      { kind: 'issue', name: 'bug.yml', path: '.github/ISSUE_TEMPLATE/bug.yml', format: 'form', body: 'name: Bug\nbody: []\n', source: undefined },
      { kind: 'issue', name: 'question.md', path: '.github/ISSUE_TEMPLATE/question.md', format: 'markdown', body: '---\nname: Question\n---\nAsk away', source: undefined },
      { kind: 'pull_request', name: 'PULL_REQUEST_TEMPLATE.md', path: '.github/PULL_REQUEST_TEMPLATE.md', format: 'markdown', body: '### Linked issue', source: undefined },
    ])
    expect(calls.some(call => call.url.includes('/acme/.github/'))).toBe(false)
  })

  it('falls back to the owner\'s `.github` repository only for the kinds the repository leaves out', async () => {
    const { provider, calls } = tokenProvider({
      [`GET ${api}/widgets/contents`]: contentsListing('.github/', 'README.md'),
      [`GET ${api}/widgets/contents/.github`]: contentsListing('.github/ISSUE_TEMPLATE/'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE`]: contentsListing('.github/ISSUE_TEMPLATE/config.yml'),
      [`GET ${api}/.github`]: dotGithub(),
      [`GET ${api}/.github/contents`]: contentsListing('.github/', 'pull_request_template.md'),
      [`GET ${api}/.github/contents/.github`]: contentsListing('.github/ISSUE_TEMPLATE/'),
      [`GET ${api}/.github/contents/.github/ISSUE_TEMPLATE`]: contentsListing('.github/ISSUE_TEMPLATE/bug.yml'),
      [`GET ${api}/.github/contents/.github/ISSUE_TEMPLATE/bug.yml`]: contentsFile('.github/ISSUE_TEMPLATE/bug.yml', 'name: Bug\n'),
      [`GET ${api}/.github/contents/pull_request_template.md`]: contentsFile('pull_request_template.md', 'Thanks!'),
    })

    const templates = await provider.repos.templates(repo)

    expect(templates).toEqual([expect.objectContaining({ kind: 'pull_request', path: 'pull_request_template.md', body: 'Thanks!', source: { forge: 'github', instance: 'github.com', owner: 'acme', name: '.github' } })])
    expect(calls.map(call => new URL(call.url).pathname)).not.toContain('/repos/acme/.github/contents/.github/ISSUE_TEMPLATE')
  })

  it('still falls back for issues when the template folder holds nothing GitHub reads', async () => {
    const { provider } = tokenProvider({
      [`GET ${api}/widgets/contents`]: contentsListing('.github/'),
      [`GET ${api}/widgets/contents/.github`]: contentsListing('.github/ISSUE_TEMPLATE/'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE`]: contentsListing('.github/ISSUE_TEMPLATE/README.txt'),
      [`GET ${api}/.github`]: dotGithub(),
      [`GET ${api}/.github/contents`]: contentsListing('.github/'),
      [`GET ${api}/.github/contents/.github`]: contentsListing('.github/ISSUE_TEMPLATE/'),
      [`GET ${api}/.github/contents/.github/ISSUE_TEMPLATE`]: contentsListing('.github/ISSUE_TEMPLATE/bug.yml'),
      [`GET ${api}/.github/contents/.github/ISSUE_TEMPLATE/bug.yml`]: contentsFile('.github/ISSUE_TEMPLATE/bug.yml', 'name: Bug\n'),
    })

    const templates = await provider.repos.templates(repo, { kind: 'issue' })

    expect(templates).toMatchObject([{ kind: 'issue', path: '.github/ISSUE_TEMPLATE/bug.yml', source: { name: '.github' } }])
  })

  it('rejects when the `.github` fallback fails, whether or not the repository has templates of its own', async () => {
    const refused = { [`GET ${api}/.github`]: dotGithub(), [`GET ${api}/.github/contents`]: { status: 403, body: { message: 'Resource not accessible by integration' } } }
    const own = {
      [`GET ${api}/widgets/contents`]: contentsListing('PULL_REQUEST_TEMPLATE.md'),
      [`GET ${api}/widgets/contents/PULL_REQUEST_TEMPLATE.md`]: contentsFile('PULL_REQUEST_TEMPLATE.md', 'What changed'),
      ...refused,
    }

    await expect(tokenProvider(own).provider.repos.templates(repo)).rejects.toBeInstanceOf(InsufficientScopeError)
    await expect(tokenProvider({ [`GET ${api}/widgets/contents`]: contentsListing('README.md'), ...refused }).provider.repos.templates(repo)).rejects.toBeInstanceOf(InsufficientScopeError)
  })

  it('finds nothing when the owner has no `.github` repository', async () => {
    const { provider } = tokenProvider({
      [`GET ${api}/widgets/contents`]: contentsListing('README.md'),
      [`GET ${api}/.github`]: missing,
    })

    await expect(provider.repos.templates(repo)).resolves.toEqual([])
  })

  it('skips a private `.github` repository, and uses an internal one', async () => {
    const fallback = {
      [`GET ${api}/widgets/contents`]: contentsListing('README.md'),
      [`GET ${api}/.github/contents`]: contentsListing('pull_request_template.md'),
      [`GET ${api}/.github/contents/pull_request_template.md`]: contentsFile('pull_request_template.md', 'Thanks!'),
    }

    const hidden = tokenProvider({ ...fallback, [`GET ${api}/.github`]: dotGithub('private') })
    await expect(hidden.provider.repos.templates(repo, { kind: 'pull_request' })).resolves.toEqual([])
    expect(hidden.calls.map(call => new URL(call.url).pathname)).not.toContain('/repos/acme/.github/contents')
    await expect(tokenProvider({ ...fallback, [`GET ${api}/.github`]: dotGithub('internal') }).provider.repos.templates(repo, { kind: 'pull_request' })).resolves.toMatchObject([{ body: 'Thanks!', source: { name: '.github' } }])
  })

  it('falls back to the `.github` repository of the owner a repository was transferred to', async () => {
    const { provider, calls } = tokenProvider({
      'GET https://api.github.com/repos/old/widgets/contents': { status: 200, body: [{ type: 'file', name: 'README.md', path: 'README.md', sha: 'f', url: 'https://api.github.com/repos/acme/widgets/contents/README.md?ref=main' }] },
      [`GET ${api}/.github`]: dotGithub(),
      [`GET ${api}/.github/contents`]: contentsListing('pull_request_template.md'),
      [`GET ${api}/.github/contents/pull_request_template.md`]: contentsFile('pull_request_template.md', 'Thanks!'),
    })

    const templates = await provider.repos.templates({ ...repo, owner: 'old' }, { kind: 'pull_request' })

    expect(templates).toMatchObject([{ body: 'Thanks!', source: { owner: 'acme', name: '.github' } }])
    expect(calls.some(call => call.url.includes('/repos/old/.github'))).toBe(false)
  })

  it('falls back to `.github` for an empty repository', async () => {
    const { provider } = tokenProvider({
      [`GET ${api}/widgets/contents`]: { status: 404, body: { message: 'This repository is empty.' } },
      [`GET ${api}/widgets`]: { status: 200, body: { name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } } },
      [`GET ${api}/.github`]: dotGithub(),
      [`GET ${api}/.github/contents`]: contentsListing('pull_request_template.md'),
      [`GET ${api}/.github/contents/pull_request_template.md`]: contentsFile('pull_request_template.md', 'Thanks!'),
    })

    await expect(provider.repos.templates(repo, { kind: 'pull_request' })).resolves.toMatchObject([{ body: 'Thanks!', source: { name: '.github' } }])
  })

  it('lists issue forms before Markdown templates, as the template chooser does', async () => {
    const { provider } = tokenProvider({
      [`GET ${api}/widgets/contents`]: contentsListing('.github/'),
      [`GET ${api}/widgets/contents/.github`]: contentsListing('.github/ISSUE_TEMPLATE/'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE`]: contentsListing('.github/ISSUE_TEMPLATE/a-question.md', '.github/ISSUE_TEMPLATE/b-bug.yml', '.github/ISSUE_TEMPLATE/c-idea.md', '.github/ISSUE_TEMPLATE/d-docs.yaml'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE/a-question.md`]: contentsFile('.github/ISSUE_TEMPLATE/a-question.md', 'Ask'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE/b-bug.yml`]: contentsFile('.github/ISSUE_TEMPLATE/b-bug.yml', 'name: Bug\n'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE/c-idea.md`]: contentsFile('.github/ISSUE_TEMPLATE/c-idea.md', 'Idea'),
      [`GET ${api}/widgets/contents/.github/ISSUE_TEMPLATE/d-docs.yaml`]: contentsFile('.github/ISSUE_TEMPLATE/d-docs.yaml', 'name: Docs\n'),
    })

    const templates = await provider.repos.templates(repo, { kind: 'issue' })

    expect(templates.map(template => template.name)).toEqual(['b-bug.yml', 'd-docs.yaml', 'a-question.md', 'c-idea.md'])
  })

  it('reads the legacy single issue template when the repository has no template folder', async () => {
    const { provider } = tokenProvider({
      [`GET ${api}/widgets/contents`]: contentsListing('ISSUE_TEMPLATE.md', 'PULL_REQUEST_TEMPLATE.md'),
      [`GET ${api}/widgets/contents/ISSUE_TEMPLATE.md`]: contentsFile('ISSUE_TEMPLATE.md', 'Steps to reproduce'),
      [`GET ${api}/widgets/contents/PULL_REQUEST_TEMPLATE.md`]: contentsFile('PULL_REQUEST_TEMPLATE.md', 'What changed'),
    })

    const templates = await provider.repos.templates(repo)

    expect(templates.map(({ kind, path, format }) => ({ kind, path, format }))).toEqual([
      { kind: 'issue', path: 'ISSUE_TEMPLATE.md', format: 'markdown' },
      { kind: 'pull_request', path: 'PULL_REQUEST_TEMPLATE.md', format: 'markdown' },
    ])
  })

  it('reads every template of a `PULL_REQUEST_TEMPLATE` folder after the default one', async () => {
    const { provider } = tokenProvider({
      [`GET ${api}/widgets/contents`]: contentsListing('docs/', 'pull_request_template.md'),
      [`GET ${api}/widgets/contents/docs`]: contentsListing('docs/PULL_REQUEST_TEMPLATE/'),
      [`GET ${api}/widgets/contents/docs/PULL_REQUEST_TEMPLATE`]: contentsListing('docs/PULL_REQUEST_TEMPLATE/hotfix.md'),
      [`GET ${api}/widgets/contents/pull_request_template.md`]: contentsFile('pull_request_template.md', 'Default'),
      [`GET ${api}/widgets/contents/docs/PULL_REQUEST_TEMPLATE/hotfix.md`]: contentsFile('docs/PULL_REQUEST_TEMPLATE/hotfix.md', 'Hotfix'),
    })

    const templates = await provider.repos.templates(repo, { kind: 'pull_request' })

    expect(templates.map(template => template.body)).toEqual(['Default', 'Hotfix'])
  })

  it('rejects with NotFoundError for a repository that does not exist', async () => {
    const { provider } = tokenProvider({ [`GET ${api}/widgets/contents`]: missing, [`GET ${api}/widgets`]: missing })

    await expect(provider.repos.templates(repo)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('github reviews', () => {
  it('lists reviews with their inline comments and resolution state', async () => {
    const { provider, calls } = tokenProvider()

    const reviews = await Array.fromAsync(provider.threads.reviews(pull))

    expect(reviews.map(review => review.state)).toEqual(['changes_requested', 'approved'])
    expect(reviews[0]!.ref.id).toBe('880097')
    expect(reviews[0]!.submittedAt).toBeInstanceOf(Date)
    const comments = reviews[0]!.comments as Exclude<typeof reviews[0]['comments'], false>
    expect(comments).toMatchObject([{ path: 'src/index.ts', line: 12, side: 'right', thread: { id: 'PRRT_kwDOAAB5ac5abcde', resolved: false } }])
    expect(reviews[1]!.comments).toEqual([])
    expect(calls.map(call => call.operationName ?? new URL(call.url).pathname)).toEqual([
      '/repos/acme/widgets/pulls/42/reviews',
      '/repos/acme/widgets/pulls/42/comments',
      'ReviewThreads',
    ])
  })

  it('reads review comments once across the pages of reviews', async () => {
    const reviewsUrl = 'https://api.github.com/repos/acme/widgets/pulls/42/reviews'
    const { fetch, calls } = fixtureFetch('github', {
      [`GET ${reviewsUrl}?per_page=1`]: { status: 200, headers: { link: `<${reviewsUrl}?per_page=1&page=2>; rel="next"` }, body: [{ id: 1, state: 'APPROVED', user: { login: 'a' } }] },
      [`GET ${reviewsUrl}?per_page=1&page=2`]: { status: 200, body: [{ id: 2, state: 'COMMENTED', user: { login: 'b' } }] },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    const reviews = await Array.fromAsync(provider.threads.reviews(pull, { perPage: 1 }))

    expect(reviews.map(review => review.ref.id)).toEqual(['1', '2'])
    expect(calls.filter(call => new URL(call.url).pathname.endsWith('/comments'))).toHaveLength(1)
    expect(calls.filter(call => call.operationName === 'ReviewThreads')).toHaveLength(1)
  })

  it('reads review comments again for a page resumed after they expire', async () => {
    const reviewsUrl = 'https://api.github.com/repos/acme/widgets/pulls/42/reviews'
    const { fetch, calls } = fixtureFetch('github', {
      [`GET ${reviewsUrl}?per_page=1`]: { status: 200, headers: { link: `<${reviewsUrl}?per_page=1&page=2>; rel="next"` }, body: [{ id: 1, state: 'APPROVED', user: { login: 'a' } }] },
      [`GET ${reviewsUrl}?per_page=1&page=2`]: { status: 200, body: [{ id: 2, state: 'COMMENTED', user: { login: 'b' } }] },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })
    vi.useFakeTimers({ now: 0, toFake: ['Date'] })
    try {
      const first = await provider.threads.reviews(pull, { perPage: 1 }).page()
      vi.setSystemTime(10 * 60_000)
      await provider.threads.reviews(pull, { perPage: 1, cursor: first.cursor }).page()
    }
    finally {
      vi.useRealTimers()
    }

    expect(calls.filter(call => new URL(call.url).pathname.endsWith('/comments'))).toHaveLength(2)
  })

  it('creates a pending review and submits it', async () => {
    const { provider, calls } = tokenProvider()

    const review = await provider.threads.createReview(pull, { body: 'nit', comments: [{ path: 'src/index.ts', line: 12, body: 'const' }] })
    await provider.threads.submitReview(review.ref, 'approve', 'LGTM')

    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: 'nit', comments: [{ path: 'src/index.ts', body: 'const', line: 12 }] })
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /repos/acme/widgets/pulls/42/reviews',
      'POST /repos/acme/widgets/pulls/42/reviews/880099/events',
    ])
  })

  it('approves through the review endpoint and resolves a review thread', async () => {
    const { provider, calls } = tokenProvider()

    await provider.threads.approve(pull, 'LGTM')
    await provider.threads.resolveReviewThread(pull, 'PRRT_kwDOAAB5ac5abcde')

    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ event: 'APPROVE', body: 'LGTM' })
    expect(calls[1]!.operationName).toBe('ResolveReviewThread')
  })

  it('replies to a reply through the comment it answers', async () => {
    const { fetch, calls } = fixtureFetch('github/recorded/github.com-writes/steps/reply-to-review-comment')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })
    const scratch = { forge: 'github', instance: 'github.com', repo: { forge: 'github', instance: 'github.com', owner: 'forges-fixtures', name: 'forges-fixtures' }, kind: 'pull_request', number: '136' } as const
    const [comment] = (await provider.threads.reviews(scratch).page()).items.flatMap(review => review.comments || [])

    const reply = await provider.threads.replyToReviewComment(scratch, comment!, 'A reply')
    await provider.threads.replyToReviewComment(scratch, reply, 'A reply')

    expect(calls.filter(call => call.url.endsWith('/replies')).map(call => new URL(call.url).pathname)).toEqual([
      `/repos/forges-fixtures/forges-fixtures/pulls/136/comments/${comment!.ref!.id}/replies`,
      `/repos/forges-fixtures/forges-fixtures/pulls/136/comments/${comment!.ref!.id}/replies`,
    ])
    expect(reply).toMatchObject({ inReplyTo: comment!.ref!.id, thread: comment!.thread })
  })

  it('needs the id of the review comment it replies to', async () => {
    const { provider, calls } = tokenProvider()

    await expect(provider.threads.replyToReviewComment(pull, { thread: { id: 'PRRT_kwDOAAB5ac5abcde', resolved: false } }, 'hi')).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toHaveLength(0)
  })
})

describe('github checks and CI', () => {
  const sha = '6dcb09b5b57875f334f61aebed695e2e4193db5e'

  it('writes a commit status under token auth and a check run under app auth', async () => {
    const token = tokenProvider()
    const app = appProvider(55123)

    const status = await token.provider.checks.report(repo, sha, { name: 'forges/coverage', state: 'success', description: '84%', url: 'https://ci.example/run/1' })
    const run = await app.provider.checks.report(repo, sha, { name: 'forges/coverage', state: 'success' })

    expect(status.ref.type).toBe('status')
    expect(JSON.parse(token.calls[0]!.body!)).toMatchObject({ state: 'success', context: 'forges/coverage' })
    expect(run.ref.type).toBe('check_run')
    expect(JSON.parse(app.calls.at(-1)!.body!)).toMatchObject({ head_sha: sha, status: 'completed', conclusion: 'success' })
  })

  it('lists the checks on a commit and re-runs a check run, refusing a status', async () => {
    const { provider } = tokenProvider()

    const page = await provider.checks.list(repo, sha)
    await provider.checks.rerun({ forge: 'github', instance: 'github.com', repo, id: '4002', type: 'check_run' })

    expect(page.items.map(check => check.ref.type)).toContain('check_run')
    await expect(provider.checks.rerun({ forge: 'github', instance: 'github.com', repo, id: '4101', type: 'status' }))
      .rejects
      .toBeInstanceOf(UnsupportedOperationError)
  })

  it('adds the commit statuses to the check-run total', async () => {
    const { fetch } = fixtureFetch('github/recorded/github.com-app/steps/check')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    const page = await provider.checks.list({ forge: 'github', instance: 'github.com', owner: 'h3js', name: 'h3' }, '04ba6e021cde76fa6fc0084866f231c575647beb')

    // The recording has seven check runs and one commit status.
    expect(page.items).toHaveLength(8)
    expect(page.total).toBe(8)
  })

  it('counts every page of commit statuses', async () => {
    const statusUrl = (page: number) => `https://api.github.com/repos/acme/widgets/commits/${sha}/status?per_page=100${page > 1 ? `&page=${page}` : ''}`
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async (url) => {
        if (url.includes('/check-runs')) {
          return Response.json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] })
        }
        if (url.includes('page=2')) {
          return Response.json({ state: 'failure', total_count: 2, statuses: [{ id: 3, context: 'lint', state: 'failure' }] })
        }
        return new Response(JSON.stringify({ state: 'success', total_count: 2, statuses: [{ id: 2, context: 'test', state: 'success' }] }), {
          status: 200,
          headers: { link: `<${statusUrl(2)}>; rel="next"` },
        })
      },
    })

    const page = await provider.checks.list(repo, sha)

    expect(page.items).toHaveLength(3)
    expect(page.total).toBe(3)
  })

  it('rejects a checks read aborted after one of its two sources has answered', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    let markStatusStarted!: () => void
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve
    })
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async (url, init) => {
        if (url.includes('/check-runs')) {
          return Response.json({ check_runs: [] })
        }
        markStatusStarted()
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
        })
      },
    })

    const pending = provider.checks.list(repo, sha, { signal: controller.signal })
    await statusStarted
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('reports why the job of a check run cannot be re-run, unless the check run has no job', async () => {
    const rerun = (status: number) => github({
      auth: { type: 'token', token: 't' },
      fetch: async url => new Response('{"message":"x"}', { status: url.endsWith('/rerequest') ? 422 : status }),
    }).checks.rerun({ forge: 'github', instance: 'github.com', repo, id: '1', type: 'check_run' })

    await expect(rerun(403)).rejects.toMatchObject({ status: 403 })
    await expect(rerun(404)).rejects.toMatchObject({ status: 422 })
  })

  it('reads workflow runs, their jobs and a job log', async () => {
    const { provider } = tokenProvider()

    const runs = await Array.fromAsync(provider.ci.runs(repo))
    const jobs = await Array.fromAsync(provider.ci.jobs(runs[0]!.ref))
    const log = await new Response(await provider.ci.log(jobs[1]!.ref)).text()

    expect(runs[0]).toMatchObject({ name: 'ci', state: 'failure', number: '120', branch: 'main', eventRaw: 'push' })
    expect(jobs.map(job => job.state)).toEqual(['success', 'failure'])
    expect(jobs[1]!.ref.run?.id).toBe('77')
    expect(log).toContain('lint failed')
  })
})

describe('github repositories', () => {
  it('leaves out a licence GitHub could not identify', () => {
    const repo = toRepo('github.com', { name: 'widgets', full_name: 'acme/widgets', license: { spdx_id: 'NOASSERTION' }, homepage: '', stargazers_count: 3 })

    expect(repo).toMatchObject({ stars: 3 })
    expect(repo.licence).toBeUndefined()
    expect(repo.homepage).toBeUndefined()
  })

  it('keeps a merge commit default it does not know as raw', () => {
    const repo = toRepo('github.com', { name: 'widgets', full_name: 'acme/widgets', squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_SUMMARY' })

    expect(repo.mergeCommit).toEqual({ squash: { title: 'pull_request_title', titleRaw: 'PR_TITLE', messageRaw: 'PR_SUMMARY' } })
  })

  it('leaves the merge commit defaults out where GitHub withholds them', () => {
    const repo = toRepo('github.com', { name: 'widgets', full_name: 'acme/widgets' })

    expect(repo.mergeCommit).toBeUndefined()
    expect(repo.deleteBranchOnMerge).toBeUndefined()
  })
})

describe('github contents', () => {
  const sha = '6dcb09b5b57875f334f61aebed695e2e4193db5e'

  it('reads a text file and falls through to the blob endpoint for a large one', async () => {
    const { provider, calls } = tokenProvider()

    const text = await provider.contents.getFile(repo, 'package.json', { ref: 'main', as: 'text' })
    const binary = await provider.contents.getFile(repo, 'assets/large.bin')

    expect(text).toMatchObject({ path: 'package.json', encoding: 'utf-8', sha: 'aa1', size: 42 })
    expect(text.content).toBe('{"name":"widgets"}\n')
    expect(binary.encoding).toBe('binary')
    expect([...(binary.content as Uint8Array)]).toEqual([0, 1, 2, 250])
    expect(calls.at(-1)!.url).toContain('/git/blobs/bb2')
  })

  it('rejects a binary file read as text', async () => {
    const { provider } = tokenProvider()

    await expect(provider.contents.getFile(repo, 'assets/large.bin', { as: 'text' })).rejects.toBeInstanceOf(ContentNotTextError)
  })

  it('warns when the tree is truncated', async () => {
    const { provider } = tokenProvider()

    const page = await provider.contents.tree(repo, { ref: 'main', recursive: true }).page()

    expect(page.items).toEqual([
      { path: 'src', type: 'directory', sha: 't1', size: undefined, mode: '040000' },
      { path: 'src/index.ts', type: 'file', sha: 'b1', size: 120, mode: '100644' },
    ])
    expect(page.warnings?.[0]?.code).toBe('tree_truncated')
  })

  it('lists the default branch tree without reading the repository', async () => {
    const { fetch, calls } = fixtureFetch('github', {
      'GET https://api.github.com/repos/acme/widgets/git/trees/HEAD%3Asrc': { status: 200, body: { sha: 't1', tree: [], truncated: false } },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    await provider.contents.tree(repo, { path: 'src' }).page()

    expect(calls.map(call => call.url)).toEqual(['https://api.github.com/repos/acme/widgets/git/trees/HEAD%3Asrc'])
  })

  it('reads branches, tags, commits and a comparison', async () => {
    const { provider } = tokenProvider()

    const branches = await Array.fromAsync(provider.contents.branches(repo))
    const tags = await Array.fromAsync(provider.contents.tags(repo))
    const commit = await provider.commits.get({ forge: 'github', instance: 'github.com', repo, sha })
    const comparison = await provider.contents.compare(repo, 'v1.0.0', 'main')

    expect(branches[0]).toMatchObject({ name: 'main', sha, isProtected: true })
    expect(tags[0]).toMatchObject({ name: 'v1.0.0', sha })
    expect(commit).toMatchObject({ sha, message: 'fix: handle empty input', stats: { additions: 4, deletions: 1 } })
    expect(commit.author?.actor?.login).toBe('octocat')
    expect(commit.files?.[0]).toMatchObject({ path: 'src/index.ts', status: 'modified', patch: '@@ -1 +1 @@' })
    expect(comparison).toMatchObject({ aheadBy: 2, behindBy: 0, mergeBaseSha: '0'.repeat(40) })
  })

  it('lists a commit with an empty author email without an actor', async () => {
    // GitHub sends `{}` rather than null when the commit was made with an empty email.
    const { provider } = tokenProvider({
      'GET https://api.github.com/repos/acme/widgets/commits': { status: 200, body: [{ sha, commit: { message: 'fix: handle empty input', author: { name: 'Octo Cat' } }, author: {}, committer: {} }] },
    })

    const { items } = await provider.commits.list(repo).page()

    expect(items[0]!.author).toEqual({ actor: undefined, name: 'Octo Cat', email: undefined, date: undefined })
    expect(items[0]!.committer?.actor).toBeUndefined()
  })

  it('reads the newest commits of a comparison from its last pages', async () => {
    const all = Array.from({ length: 250 }, (_, index) => ({ sha: String(index + 1), commit: { message: `commit ${index + 1}` } }))
    const pages: Array<string | null> = []
    const provider = github({ auth: { type: 'token', token: 't' }, fetch: async (input) => {
      const url = new URL(String(input))
      const perPage = Number(url.searchParams.get('per_page') ?? 250)
      const page = Number(url.searchParams.get('page') ?? 1)
      pages.push(`${url.searchParams.get('per_page')}:${url.searchParams.get('page')}`)
      const commits = url.searchParams.has('per_page') ? all.slice((page - 1) * perPage, page * perPage) : all.slice(-250)
      return Response.json({ total_commits: all.length, ahead_by: all.length, behind_by: 0, commits, files: page === 1 ? [{ filename: 'a.ts', status: 'modified' }] : [] })
    } })
    const shas = async (commitLimit?: number) => (await provider.contents.compare(repo, 'v1.0.0', 'main', { commitLimit })).commits.map(commit => commit.sha)

    expect(await shas(3)).toEqual(['250', '249', '248'])
    expect(pages.splice(0)).toEqual(['3:null', '3:83', '3:84'])
    expect(await shas(150)).toEqual(all.slice(100).map(commit => commit.sha).toReversed())
    expect(pages.splice(0)).toEqual(['100:null', '100:2', '100:3'])
    expect(await shas()).toEqual(all.map(commit => commit.sha).toReversed())
    expect(pages.splice(0)).toEqual(['null:null'])
  })

  it('resolves a sha without a request and a branch with one', async () => {
    const { provider, calls } = tokenProvider()

    expect(await provider.contents.resolveRef(repo, sha.toUpperCase())).toBe(sha)
    expect(calls).toHaveLength(0)
    expect(await provider.contents.resolveRef(repo, 'main')).toBe(sha)
    expect(calls).toHaveLength(1)
  })

  it('lists the files and commits of a pull request', async () => {
    const { provider } = tokenProvider()
    const pull = { forge: 'github', instance: 'github.com', repo, kind: 'pull_request', number: '42' } as const

    const files = await Array.fromAsync(provider.threads.files(pull))
    const commits = await Array.fromAsync(provider.threads.commits(pull))

    expect(files[0]).toMatchObject({ path: 'src/index.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 4 })
    expect(commits[0]!.sha).toBe(sha)
    await expect(Array.fromAsync(provider.threads.files({ ...pull, kind: 'issue' }))).rejects.toBeInstanceOf(UnsupportedOperationError)
  })
})

describe('github release assets', () => {
  it('reads a release by tag and streams an asset without forwarding the credential', async () => {
    const { provider, calls } = tokenProvider()

    const release = await provider.releases.getByTag(repo, 'v1.2.0')
    const asset = release.assets![0]!
    const downloaded = await new Response(await provider.releases.downloadAsset(asset.ref!)).json() as { bytes: string }

    expect(asset).toMatchObject({ name: 'widgets-v1.2.0.tgz', contentType: 'application/gzip' })
    expect(asset.ref).toMatchObject({ id: '7001', release: { id: '9001', tag: 'v1.2.0' } })
    expect(downloaded.bytes).toBe('asset bytes')
    expect(calls.at(-1)!.url).toContain('objects.githubusercontent.com')
    expect(calls.at(-1)!.headers.get('authorization')).toBeNull()
    expect(calls.at(-2)!.headers.get('accept')).toBe('application/octet-stream')
  })

  it('streams an asset without credentials', async () => {
    const { fetch } = fixtureFetch('github')
    const provider = github({ fetch })

    const release = await provider.releases.getByTag(repo, 'v1.2.0')
    const downloaded = await new Response(await provider.releases.downloadAsset(release.assets![0]!.ref!)).json() as { bytes: string }

    expect(downloaded.bytes).toBe('asset bytes')
  })
})

describe('github thread listing filters', () => {
  function listing(milestones: Array<{ number: number, title: string }> = []) {
    const urls: URL[] = []
    const fetch = async (input: string | URL | Request) => {
      const url = new URL(String(input))
      urls.push(url)
      const body = url.pathname.endsWith('/milestones')
        ? milestones.map(milestone => ({ ...milestone, id: milestone.number, state: 'open' }))
        : url.pathname.startsWith('/search/') ? { total_count: 0, items: [] } : []
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }
    return { urls, provider: github({ auth: { type: 'token', token: 't' }, fetch }) }
  }

  it('sends mentions and the number of the milestone titled in the query, reading pull requests from the issues listing', async () => {
    const { urls, provider } = listing([{ number: 3, title: 'v2' }, { number: 7, title: '3' }])

    await provider.threads.list(repo, { kind: 'pull_request', mentions: 'ada', milestone: '3' }).page()

    expect(urls.map(url => url.pathname)).toEqual(['/repos/acme/widgets/milestones', '/repos/acme/widgets/issues'])
    expect(urls[0]!.searchParams.get('state')).toBe('all')
    expect(urls[1]!.searchParams.get('mentioned')).toBe('ada')
    expect(urls[1]!.searchParams.get('milestone')).toBe('7')
  })

  it('lists nothing for a milestone title the repository lacks, and passes none on', async () => {
    const { urls, provider } = listing()

    const missing = await provider.threads.list(repo, { milestone: 'v9' }).page()
    await provider.threads.list(repo, { milestone: 'none' }).page()

    expect(missing.items).toEqual([])
    expect(urls.map(url => url.pathname)).toEqual(['/repos/acme/widgets/milestones', '/repos/acme/widgets/issues'])
    expect(urls[1]!.searchParams.get('milestone')).toBe('none')
  })

  it('warns that the issues listing has no involves filter', async () => {
    const { urls, provider } = listing()

    const page = await provider.threads.list(repo, { involves: 'ada' }).page()

    expect(page.warnings?.map(warning => warning.code)).toEqual(['filter_unsupported'])
    expect(urls[0]!.search).not.toContain('ada')
  })

  it('adds mentions and the milestone to the search behind merged pull requests', async () => {
    const { urls, provider } = listing()

    await provider.threads.list(repo, { state: 'merged', involves: 'ada', mentions: 'bob', milestone: 'v "2"' }).page()

    expect(urls[0]!.searchParams.get('q')).toContain('is:merged mentions:bob milestone:"v 2"')
    expect(urls[0]!.searchParams.get('q')).toContain('involves:ada')
  })
})

describe('github search', () => {
  it('translates a structured query into qualifiers and reads the repo from each result', async () => {
    const { provider, calls } = tokenProvider()

    const { items } = await provider.search.threads({ text: 'crash', repo, kind: 'issue', state: 'open', sort: 'updated', direction: 'desc' }).page()

    expect(new URL(calls[0]!.url).searchParams.get('q')).toBe('crash repo:acme/widgets is:issue state:open')
    expect(items[0]!.ref).toMatchObject({ kind: 'issue', number: '42' })
    expect(items[0]!.ref.repo).toMatchObject({ owner: 'acme', name: 'widgets' })
    expect(items[0]!.title).toBe('Widget crashes on load')
  })

  it('reports the search budget apart from the core budget', async () => {
    const { fetch: replay } = fixtureFetch('github')
    const resources: Array<string | undefined> = []
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async (input, init) => {
        const response = await replay(input, init)
        const headers = new Headers(response.headers)
        headers.set('x-ratelimit-remaining', '10')
        headers.set('x-ratelimit-resource', new URL(String(input)).pathname.startsWith('/search/') ? 'search' : 'core')
        return new Response(response.body, { status: response.status, headers })
      },
      onRateLimit: ({ rateLimit }) => resources.push(rateLimit.resource),
    })

    const page = await provider.search.threads({ text: 'crash', repo, kind: 'issue', state: 'open', sort: 'updated', direction: 'desc' }).page()
    await provider.repos.get(repo)

    expect(page.rateLimit).toEqual({ remaining: 10, resource: 'search' })
    expect(resources).toEqual(['search', 'core'])
  })

  it('warns rather than filtering when a repository sort is unsupported', async () => {
    const { provider } = tokenProvider()

    const page = await provider.search.repos({ text: 'widgets', owner: 'acme', sort: 'stars' }).page()

    expect(page.items[0]!.ref.name).toBe('widgets')
    expect(page.warnings).toBeUndefined()
  })

  describe('code', () => {
    const h3 = { forge: 'github', instance: 'github.com', owner: 'h3js', name: 'h3' } as const
    const search = 'https://api.github.com/search/code?q=import+repo%3Ah3js%2Fh3&per_page=3'

    it('asks for text matches, and reads the indexed commit from each file', async () => {
      const { fetch, calls } = fixtureFetch('github/recorded/github.com')
      const provider = github({ auth: { type: 'token', token: 't' }, fetch })

      const { items } = await provider.search.code({ text: 'import', repo: h3, perPage: 3 }).page()

      expect(calls[0]!.headers.get('accept')).toBe('application/vnd.github.text-match+json')
      expect(items[1]).toMatchObject({
        repo: h3,
        path: 'docs/99.blog/3.v2.md',
        ref: '66cfb8a357b6285451bad498c2c40002601fae98',
        fragments: [{ text: '```js\nimport { H3, serve } from "h3";\n' }, { text: '```js\nimport { defineHandler } from "h3";\n' }],
        url: 'https://github.com/h3js/h3/blob/66cfb8a357b6285451bad498c2c40002601fae98/docs/99.blog/3.v2.md',
      })
    })

    it('warns when GitHub stops the search before it finishes', async () => {
      const recorded = loadFixtures('github/recorded/github.com').find(fixture => fixture.request.url === search)!.response
      const { fetch } = fixtureFetch('github/recorded/github.com', { [`GET ${search}`]: { ...recorded, body: { ...recorded.body as object, incomplete_results: true } } })
      const provider = github({ auth: { type: 'token', token: 't' }, fetch })

      const page = await provider.search.code({ text: 'import', repo: h3, perPage: 3 }).page()

      expect(page.items).toHaveLength(3)
      expect(page.total).toBe(208)
      expect(page.warnings).toEqual([expect.objectContaining({ code: 'search_incomplete' })])
    })
  })
})

describe('github webhook management', () => {
  const hook = { forge: 'github', instance: 'github.com', target: repo, id: '12345678' } as const

  it('lists hooks with normalised kinds beside the native names', async () => {
    const { provider } = tokenProvider()

    const { items } = await provider.webhooks.list(repo).page()

    expect(items[0]).toMatchObject({ url: 'https://hooks.example/forges', active: true, contentType: 'json' })
    expect(items[0]!.nativeEvents).toEqual(['issues', 'issue_comment', 'push'])
    expect(items[0]!.events.sort()).toEqual(['assignment', 'comment', 'label', 'push', 'state_change'])
  })

  it('translates normalised kinds into native event names on create', async () => {
    const { provider, calls } = tokenProvider()

    await provider.webhooks.create(repo, { url: 'https://hooks.example/forges', events: ['state_change', 'push'], secret: 's3cret' })

    expect(JSON.parse(calls[0]!.body!)).toEqual({
      name: 'web',
      active: true,
      events: ['issues', 'pull_request', 'discussion', 'push'],
      config: { url: 'https://hooks.example/forges', content_type: 'json', secret: 's3cret' },
    })
  })

  it('reads deliveries and replays one', async () => {
    const { provider, calls } = tokenProvider()

    const { items } = await provider.webhooks.deliveries(hook).page()
    await provider.webhooks.redeliver(items[0]!.ref)

    expect(items[0]).toMatchObject({ event: 'issues.opened', status: 200, ok: true, duration: 123 })
    expect(calls.at(-1)!.url).toContain('/hooks/12345678/deliveries/55001/attempts')
  })

  it('maps a 404 from a hook endpoint to ForbiddenError, since GitHub answers 404 for a missing hook scope', async () => {
    const { fetch } = fixtureFetch('github', { 'GET https://api.github.com/repos/acme/widgets/hooks': { status: 404, body: { message: 'Not Found' } } })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    const error = await provider.webhooks.list(repo).page().catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ForbiddenError)
    expect((error as ForbiddenError).reason).toBe('resource_protected')
  })

  it('reports the scopes a verb needs, as data', () => {
    const { provider } = tokenProvider()

    expect(provider.scopesFor('webhooks.create')).toEqual({ token: ['admin:repo_hook', 'admin:org_hook'], permissions: { webhooks: 'admin' } })
    expect(provider.scopesFor('threads.close').permissions).toMatchObject({ issues: 'write' })
    expect(provider.scopesFor('threads.replyToReviewComment').permissions).toMatchObject({ pull_requests: 'write' })
    expect(provider.scopesFor('threads.updateBranch').permissions).toEqual({ pull_requests: 'write', contents: 'write' })
  })
})

describe('github release writes', () => {
  const releaseRef = { forge: 'github', instance: 'github.com', repo, id: '9001', tag: 'v1.2.0' } as const
  const immutable = { id: 9001, tag_name: 'v1.2.0', draft: false, prerelease: false, immutable: true }

  it('rejects release writes on a read-only provider without sending them', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch, readOnly: true })

    await expect(provider.releases.create(repo, { tag: 'v1.3.0' })).rejects.toThrow(ReadOnlyError)
    expect(provider.can('releases.update')).toBe(false)
    expect(calls).toEqual([])
  })

  it('normalises a refused write to an immutable release as a forbidden error', async () => {
    const { fetch, calls } = fixtureFetch('github', {
      'PATCH https://api.github.com/repos/acme/widgets/releases/9001': { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Release', code: 'custom', field: 'tag_name', message: 'tag_name cannot be changed when release is immutable' }] } },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    await expect(provider.releases.update(releaseRef, { tag: 'v2.0.0' })).rejects.toMatchObject({ name: 'ForbiddenError', status: 422, reason: 'immutable_release', reasonRaw: 'tag_name cannot be changed when release is immutable' })
    expect(calls.map(call => call.method)).toEqual(['PATCH'])
  })

  it('still edits the name and notes of an immutable release', async () => {
    const { fetch, calls } = fixtureFetch('github', {
      'PATCH https://api.github.com/repos/acme/widgets/releases/9001': { status: 200, body: { ...immutable, name: 'Edited' } },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    const updated = await provider.releases.update(releaseRef, { name: 'Edited', body: 'Notes' })

    expect(updated).toMatchObject({ name: 'Edited', immutable: true })
    expect(calls.map(call => call.method)).toEqual(['PATCH'])
  })
})

const widgets = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' } as const
const secretScanning = 'GET https://api.github.com/repos/acme/widgets/secret-scanning/alerts?state=open'

describe('github checks, releases and security alerts', () => {
  it('summarises the status rollup when reading several pull requests', async () => {
    const { fetch } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })
    const [result] = await provider.threads.getMany([{ forge: 'github', instance: 'github.com', repo: widgets, kind: 'pull_request', number: '42' }])

    expect(result?.ok && result.thread.checks).toEqual({ state: 'failure', stateRaw: 'failure', total: 3, failed: 1, url: 'https://github.com/acme/widgets/pull/42/checks' })
  })

  it('reads diff stats when reading several pull requests', async () => {
    const { fetch } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })
    const [result] = await provider.threads.getMany([{ forge: 'github', instance: 'github.com', repo: widgets, kind: 'pull_request', number: '42' }])

    expect(result?.ok && result.thread.stats).toEqual({ additions: 24, deletions: 3, changedFileCount: 2, commitCount: 2 })
  })

  it('reads when each pending review was last requested when reading several pull requests', async () => {
    const { fetch } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })
    const [result] = await provider.threads.getMany([{ forge: 'github', instance: 'github.com', repo: widgets, kind: 'pull_request', number: '42' }])

    expect(result?.ok && result.thread.reviewers?.map(reviewer => [reviewer.actor.login, reviewer.requestedAt])).toEqual([['hubot', new Date('2025-09-17T11:30:00Z')]])
  })

  it('reads how the author relates to the repository when reading several pull requests', async () => {
    const { fetch } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })
    const [result] = await provider.threads.getMany([{ forge: 'github', instance: 'github.com', repo: widgets, kind: 'pull_request', number: '42' }])

    expect(result?.ok && result.thread).toMatchObject({ authorAssociation: 'first_time_contributor', authorAssociationRaw: 'FIRST_TIME_CONTRIBUTOR' })
  })

  it('reports a token missing a GraphQL scope on every thread it could not read', async () => {
    const message = 'Your token has not been granted the required scopes to execute this query.'
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async () => Response.json({ errors: [{ type: 'INSUFFICIENT_SCOPES', message }] }),
    })
    const results = await provider.threads.getMany([{ forge: 'github', instance: 'github.com', repo: widgets, kind: 'pull_request', number: '42' }, { forge: 'github', instance: 'github.com', repo: widgets, kind: 'issue', number: '7' }])

    expect(results.map(result => !result.ok && result.warning)).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ code: 'insufficient_scope', message: `GraphQL ThreadsBatch failed: ${message}`, cause: expect.objectContaining({ name: 'InsufficientScopeError' }) })))
  })

  it('reads the scopes that a GraphQL scope error names', async () => {
    const message = 'Your token has not been granted the required scopes to execute this query. The \'email\' field requires one of the following scopes: [\'user:email\', \'read:user\'], but your token has only been granted the: [\'repo\'] scopes. Please modify your token\'s scopes at: https://github.com/settings/tokens.'
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async () => Response.json({ errors: [{ type: 'INSUFFICIENT_SCOPES', message }] }),
    })

    await expect(provider.graphql('query { viewer { email } }')).rejects.toMatchObject({ name: 'InsufficientScopeError', acceptedScopes: ['user:email', 'read:user'], grantedScopes: ['repo'] })
  })

  it('reports a missing GraphQL scope only on the thread whose alias was denied', async () => {
    const message = 'Your token has not been granted the required scopes to execute this query.'
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async () => Response.json({
        data: { t0: null, t1: null },
        errors: [{ type: 'INSUFFICIENT_SCOPES', message, path: ['t0'] }, { type: 'NOT_FOUND', message: 'Could not resolve to an Issue with the number of 7.', path: ['t1'] }],
      }),
    })
    const results = await provider.threads.getMany([{ forge: 'github', instance: 'github.com', repo: widgets, kind: 'pull_request', number: '42' }, { forge: 'github', instance: 'github.com', repo: widgets, kind: 'issue', number: '7' }])

    expect(results.map(result => !result.ok && result.warning)).toEqual([
      expect.objectContaining({ code: 'insufficient_scope', subject: '42', cause: expect.objectContaining({ name: 'InsufficientScopeError' }) }),
      expect.objectContaining({ code: 'thread_unreadable', message: 'Could not resolve to an Issue with the number of 7.', subject: '7' }),
    ])
  })

  it('reports an unreadable alert kind as a warning when listing every kind, and throws when asked for it', async () => {
    const { fetch } = fixtureFetch('github', { [secretScanning]: { status: 403, body: { message: 'Resource not accessible by personal access token' } } })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })
    const page = await provider.securityAlerts!.list(widgets).page()
    const rest = await provider.securityAlerts!.list(widgets, { cursor: page.cursor }).page()
    const secret = await provider.securityAlerts!.list(widgets, { cursor: rest.cursor }).page()
    const last = await provider.securityAlerts!.list(widgets, { cursor: secret.cursor }).page()

    expect(secret.items).toEqual([])
    expect(secret.warnings?.map(warning => warning.code)).toEqual(['insufficient_scope'])
    expect(last.items.map(alert => alert.kind)).toEqual(['advisory', 'advisory'])
    expect(last.cursor).toBeUndefined()
    await expect(provider.securityAlerts!.list(widgets, { kind: 'secret' }).page()).rejects.toThrow(InsufficientScopeError)
  })

  it('lists repository advisories, drafts and private vulnerability reports included, by state', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    const open = await provider.securityAlerts!.list(widgets, { kind: 'advisory' }).page()
    const closed = await provider.securityAlerts!.list(widgets, { kind: 'advisory', state: 'closed' }).page()
    const all = await provider.securityAlerts!.list(widgets, { kind: 'advisory', state: 'all' }).page()

    expect(open.items.map(alert => `${alert.ref.id} ${alert.stateRaw} ${alert.severity}`)).toEqual(['GHSA-7r2x-4m9q-hv3c triage high', 'GHSA-c5pf-8w3j-qj6m draft unknown'])
    expect(open.items[0]).toMatchObject({
      ref: { id: 'GHSA-7r2x-4m9q-hv3c', kind: 'advisory' },
      kindRaw: 'repository_advisory',
      state: 'open',
      title: 'Path traversal in the template cache',
      package: { ecosystem: 'npm', name: 'widgets', vulnerableRange: '< 2.4.1', fixedIn: '2.4.1' },
      url: 'https://github.com/acme/widgets/security/advisories/GHSA-7r2x-4m9q-hv3c',
    })
    expect(open.items[1]!.package).toBeUndefined()
    expect(closed.items.map(alert => `${alert.stateRaw} ${alert.state} ${alert.dismissedAt?.toISOString()}`)).toEqual(['published fixed undefined', 'withdrawn dismissed 2025-12-01T08:00:00.000Z'])
    expect(all.items).toHaveLength(4)
    expect(calls.map(call => call.url)).toEqual(Array.from({ length: 3 }).fill('https://api.github.com/repos/acme/widgets/security-advisories'))
    expect(github({ baseUrl: 'https://ghe.example.com/api/v3', auth: { type: 'token', token: 't' } }).can('securityAlerts.list', 'advisory')).toBe(false)
    expect(provider.scopesFor('securityAlerts.list').permissions).toMatchObject({ repository_advisories: 'read' })
  })

  it('resolves vulnerability and release notification subjects to refs', () => {
    const raw = (type: string, url: string): GitHubNotification => ({
      id: '1',
      unread: true,
      reason: 'security_alert',
      updated_at: '2025-09-01T00:00:00Z',
      last_read_at: null,
      url: 'https://api.github.com/notifications/threads/1',
      subject: { title: 'Alert', url, latest_comment_url: null, type },
      repository: { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme', id: 2 } } as GitHubNotification['repository'],
    })

    expect(toNotification('github.com', raw('RepositoryVulnerabilityAlert', 'https://api.github.com/repos/acme/widgets/dependabot/alerts/3')).subject)
      .toMatchObject({ type: 'security_alert', alert: { id: '3', kind: 'dependency', repo: { name: 'widgets' } } })
    expect(toNotification('github.com', raw('Release', 'https://api.github.com/repos/acme/widgets/releases/9001')).subject)
      .toMatchObject({ type: 'release', release: { id: '9001' } })
  })
})

describe('github graphql', () => {
  const viewer = 'query Viewer { viewer { login } }'
  const status = 'mutation Status($message: String) { changeUserStatus(input: { message: $message }) { status { message } } }'

  it('returns the data of a query from the GraphQL endpoint of the instance', async () => {
    const { fetch, calls } = fixtureFetch('github', {
      'POST https://ghe.example.com/api/graphql Viewer': { status: 200, body: { data: { viewer: { login: 'octocat' } } } },
    })
    const provider = github({ baseUrl: 'https://ghe.example.com/api/v3', auth: { type: 'token', token: 't' }, fetch })

    expect(await provider.graphql(viewer)).toEqual({ viewer: { login: 'octocat' } })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: viewer, variables: {}, operationName: 'Viewer' })
  })

  it('names the operation from the top level of the document', async () => {
    const search = '{ search(query: "query Foo", type: ISSUE, first: 1) { issueCount } }'
    const { fetch, calls } = fixtureFetch('github', {
      'POST https://api.github.com/graphql': { status: 200, body: { data: { search: { issueCount: 0 } } } },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    expect(await provider.graphql(search)).toEqual({ search: { issueCount: 0 } })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: search, variables: {} })
  })

  it('sends a typed document as its text and types the result and variables from it', async () => {
    class TypedDocumentString<TResult, TVariables> extends String implements TypedGraphQLDocument<TResult, TVariables> {
      declare __apiType?: (variables: TVariables) => TResult
    }
    const Repo = new TypedDocumentString<{ repository: { stargazerCount: number } | null }, { owner: string, name: string }>('query Repo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { stargazerCount } }')
    const Viewer = new TypedDocumentString<{ viewer: { login: string } }, { [key: string]: never }>(viewer)
    const { fetch, calls } = fixtureFetch('github', {
      'POST https://api.github.com/graphql Repo': { status: 200, body: { data: { repository: { stargazerCount: 3 } } } },
      'POST https://api.github.com/graphql Viewer': { status: 200, body: { data: { viewer: { login: 'octocat' } } } },
      'POST https://api.github.com/graphql': { status: 200, body: { data: { total: 1 } } },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    const repository = await provider.graphql(Repo, { owner: 'o', name: 'n' })
    expectTypeOf(repository).toEqualTypeOf<{ repository: { stargazerCount: number } | null }>()
    expect(repository).toEqual({ repository: { stargazerCount: 3 } })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: String(Repo), variables: { owner: 'o', name: 'n' }, operationName: 'Repo' })
    expectTypeOf(await provider.graphql(Viewer)).toEqualTypeOf<{ viewer: { login: string } }>()
    expectTypeOf(await provider.graphql<{ total: number }>('query { total }')).toEqualTypeOf<{ total: number }>()

    // @ts-expect-error Repo requires its variables
    await provider.graphql(Repo).catch(() => {})
    // @ts-expect-error owner is a string
    await provider.graphql(Repo, { owner: 1, name: 'n' }).catch(() => {})
  })

  it('rejects with the errors of the response', async () => {
    const message = 'Your token has not been granted the required scopes to execute this query.'
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async () => Response.json({ errors: [{ type: 'INSUFFICIENT_SCOPES', message }] }),
    })

    await expect(provider.graphql(viewer)).rejects.toThrow(InsufficientScopeError)
    await expect(provider.graphql(viewer)).rejects.toThrow(`GraphQL Viewer failed: ${message}`)
  })

  it('runs queries on a read-only provider and rejects mutations', async () => {
    const named = 'query Named($mutation: String) { viewer { login } }'
    const { fetch, calls } = fixtureFetch('github', {
      'POST https://api.github.com/graphql Viewer': { status: 200, body: { data: { viewer: { login: 'octocat' } } } },
      'POST https://api.github.com/graphql Named': { status: 200, body: { data: { viewer: { login: 'octocat' } } } },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch, readOnly: true })

    expect(await provider.graphql(viewer)).toEqual({ viewer: { login: 'octocat' } })
    expect(await provider.graphql(named)).toEqual({ viewer: { login: 'octocat' } })
    await expect(provider.graphql(status, { message: 'hi' })).rejects.toThrow(ReadOnlyError)
    expect(calls).toHaveLength(2)
  })

  it('reads the operations of a document from its top level', () => {
    expect(graphqlOperations(status)).toEqual([{ type: 'mutation', name: 'Status' }])
    expect(graphqlOperations('fragment F on User { login }\nmutation { addStar(input: { starrableId: "1" }) { clientMutationId } }')).toEqual([{ type: 'mutation' }])
    expect(graphqlOperations('{ viewer { login } }')).toEqual([{ type: 'query' }])
    expect(graphqlOperations('# mutation\nquery { search(query: "mutation } {", type: ISSUE, first: 1) { issueCount } }')).toEqual([{ type: 'query' }])
    expect(graphqlOperations('{ search(query: "query Foo", type: ISSUE, first: 1) { issueCount } }')).toEqual([{ type: 'query' }])
    expect(graphqlOperations('query { mutation: viewer { login } }')).toEqual([{ type: 'query' }])
    expect(graphqlOperations('query Search($query: String!, $mutation: String = """a \\""" mutation X { """) @cached { search(query: $query) { issueCount } }')).toEqual([{ type: 'query', name: 'Search' }])
    expect(graphqlOperations('# comment\rmutation Star { addStar(input: { starrableId: "1" }) { clientMutationId } }')).toEqual([{ type: 'mutation', name: 'Star' }])
    expect(graphqlOperations('query A { viewer { login } }\nmutation B { addStar(input: { starrableId: "1" }) { clientMutationId } }')).toEqual([{ type: 'query', name: 'A' }, { type: 'mutation', name: 'B' }])
  })
})

describe('github provider edge cases', () => {
  const commit = { forge: 'github', instance: 'github.com', repo, sha: 'abc123' } as const

  it('lists the comments on a commit, each naming the commit', async () => {
    const urls: string[] = []
    const forge = github({ auth: { type: 'token', token: 't' }, fetch: async (url) => {
      urls.push(url)
      return Response.json([{ id: 7, body: 'Nice', created_at: '2025-01-01T00:00:00Z', user: { login: 'octocat' } }])
    } })
    const [comment] = (await forge.commits.comments(commit).page()).items

    expect(urls).toEqual(['https://api.github.com/repos/acme/widgets/commits/abc123/comments'])
    expect(comment).toMatchObject({ body: 'Nice', ref: { id: '7', commit } })
  })

  it('rejects removing a reaction when the viewer cannot be read', async () => {
    const forge = github({
      auth: { type: 'token', token: 't' },
      fetch: async url => url.endsWith('/user') ? new Response('{}', { status: 500 }) : Response.json([{ id: 1, content: '+1', user: { login: 'octocat' } }]),
    })

    await expect(forge.threads.unreact(pull, '+1')).rejects.toThrow()
  })
})

describe('github data residency', () => {
  it('treats ghe.com hosts as github.com rather than Enterprise Server', async () => {
    const provider = github({ auth: { type: 'token', token: 't' }, baseUrl: 'https://api.acme.ghe.com' })

    expect(provider.instance).toBe('acme.ghe.com')
    expect(provider.urlFor({ repo: { forge: 'github', instance: 'acme.ghe.com', owner: 'acme', name: 'widgets' } })).toBe('https://acme.ghe.com/acme/widgets')
    expect(provider.can('notifications.markDone')).toBe(true)
    expect(await provider.refreshCapabilities()).not.toHaveProperty('version', expect.anything())
  })
})

describe('github merge', () => {
  it('merges without approving and sends `message` as the commit message', async () => {
    const bodies: Array<{ url: string, body?: string }> = []
    const provider = github({ auth: { type: 'token', token: 't' }, fetch: async (url, init) => {
      bodies.push({ url, body: init?.body as string | undefined })
      return new Response('{"status":"merged"}', { status: 200 })
    } })

    await provider.threads.merge(pull, { method: 'squash', message: 'Ship it' })

    expect(bodies).toEqual([{ url: 'https://api.github.com/repos/acme/widgets/pulls/42/merge-async', body: '{"merge_method":"squash","commit_message":"Ship it","merge_action":"direct_merge"}' }])
  })

  it('updates a branch with a merge through REST, which checks the head sha', async () => {
    const { provider, calls } = tokenProvider()

    expect(await provider.threads.updateBranch(pull, { sha: HEAD })).toMatchObject({ status: 'queued' })
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['PUT /repos/acme/widgets/pulls/42/update-branch'])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ expected_head_sha: HEAD })
  })

  it('rebases a branch through GraphQL, by the node id of the pull request', async () => {
    const { provider, calls } = tokenProvider()

    expect(await provider.threads.updateBranch(pull, { method: 'rebase', sha: HEAD })).toMatchObject({ status: 'queued' })
    expect(calls[1]!.operationName).toBe('UpdatePullRequestBranch')
    expect(JSON.parse(calls[1]!.body!).variables).toEqual({ id: 'PR_kwDOAAB5ac6abcdef', sha: HEAD, method: 'REBASE' })
  })

  it('rejects a branch update with BranchMovedError once the head has moved', async () => {
    const moved = '0'.repeat(40)
    const { provider } = tokenProvider({
      'PUT https://api.github.com/repos/acme/widgets/pulls/42/update-branch': { status: 422, headers: {}, body: { message: 'expected head sha didn\'t match current head ref.' } },
    })
    const rebase = tokenProvider()

    await expect(provider.threads.updateBranch(pull, { sha: moved })).rejects.toBeInstanceOf(BranchMovedError)
    await expect(rebase.provider.threads.updateBranch(pull, { method: 'rebase', sha: moved })).rejects.toBeInstanceOf(BranchMovedError)
    expect(rebase.calls).toHaveLength(1)
  })
})

describe('github path safety', () => {
  function recordingProvider(options: { readOnly?: boolean } = {}) {
    const urls: string[] = []
    const fetch = async (url: string) => {
      urls.push(url)
      return new Response('{}', { status: 200 })
    }
    return { provider: github({ auth: { type: 'token', token: 't' }, fetch, ...options }), urls }
  }

  it('keeps a thread number that tries to climb out of the repository inside it', async () => {
    const { provider, urls } = recordingProvider()

    await provider.threads.createComment({ ...pull, kind: 'issue', number: '1/../../../../user/keys' }, 'hi')

    expect(urls).toEqual(['https://api.github.com/repos/acme/widgets/issues/1%2F..%2F..%2F..%2F..%2Fuser%2Fkeys/comments'])
  })

  it('encodes owner, name and number so they cannot add path segments or a query', async () => {
    const { provider, urls } = recordingProvider()

    await provider.threads.createComment({ ...pull, repo: { ...repo, owner: 'acme/x', name: 'widgets?y=1' }, kind: 'issue', number: '1?x=' }, 'hi')

    expect(urls).toEqual(['https://api.github.com/repos/acme%2Fx/widgets%3Fy%3D1/issues/1%3Fx%3D/comments'])
  })

  it('rejects a mutating `request()` on a read-only provider', async () => {
    const { provider, urls } = recordingProvider({ readOnly: true })

    await expect(provider.request('DELETE', '/repos/acme/widgets')).rejects.toThrow('is a write and this github provider is read-only')
    await provider.request('GET', '/repos/acme/widgets')
    expect(urls).toEqual(['https://api.github.com/repos/acme/widgets'])
  })
})

describe('github single-item reads', () => {
  function serve(responses: Record<string, unknown>) {
    return github({ auth: { type: 'token', token: 't' }, fetch: async (url) => {
      const key = new URL(String(url)).pathname
      return key in responses ? Response.json(responses[key]) : Response.json({ message: 'Not Found' }, { status: 404 })
    } })
  }

  it('rejects a discussion comment id that names a node of another type', async () => {
    const provider = serve({ '/graphql': { data: { node: {} } } })

    await expect(provider.threads.getComment({ forge: 'github', instance: 'github.com', thread: discussion, id: 'D_kwDOAAB5ac4AAQ1f' })).rejects.toThrow(NotFoundError)
  })

  it('reads a CI job whose ref names no run, and names the run from the job', async () => {
    const provider = serve({ '/repos/acme/widgets/actions/jobs/9': { id: 9, run_id: 7, name: 'test', status: 'completed', conclusion: 'success' } })

    const job = await provider.ci.getJob({ forge: 'github', instance: 'github.com', repo, id: '9' })

    expect(job.name).toBe('test')
    expect(job.ref.run).toEqual({ forge: 'github', instance: 'github.com', repo, id: '7' })
  })

  it('rejects a CI job that names no run when its ref names none either', async () => {
    const provider = serve({ '/repos/acme/widgets/actions/jobs/9': { id: 9, name: 'test', status: 'completed', conclusion: 'success' } })

    await expect(provider.ci.getJob({ forge: 'github', instance: 'github.com', repo, id: '9' })).rejects.toThrow(UnsupportedOperationError)
  })
})
