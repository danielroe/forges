import type { GitHubNotification } from '../../src/github/types.ts'
import type { ThreadRef } from '../../src/model.ts'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ContentNotTextError, ForbiddenError, InsufficientScopeError, UnresolvedThreadError, UnsupportedOperationError } from '../../src/errors.ts'
import { graphqlUrl } from '../../src/github/graphql-client.ts'
import { github } from '../../src/github/index.ts'
import { toEvent, toNotification, toReason } from '../../src/github/normalise.ts'
import { notificationThread } from '../../src/model.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' } as const
const pull = { forge: 'github', instance: 'github.com', repo, kind: 'pull_request', number: '42' } as const
const discussion: ThreadRef = { forge: 'github', instance: 'github.com', repo, kind: 'discussion', number: '31' }

function tokenProvider() {
  const { fetch, calls } = fixtureFetch('github')
  return { provider: github({ auth: { type: 'token', token: 't' }, fetch }).create(), calls }
}

function appProvider(installationId?: number) {
  const { fetch, calls } = fixtureFetch('github')
  return {
    provider: github({ auth: { type: 'app', appId: 12345, privateKey, installationId }, fetch }).create(),
    calls,
  }
}

describe('github provider', () => {
  it('reports github.com as the instance for the default base url', () => {
    const provider = github({ auth: { type: 'token', token: 't' } }).create()

    expect(provider.instance).toBe('github.com')
    expect(provider.baseUrl).toBe('https://api.github.com')
  })

  it('keeps a GHES host distinct from github.com', () => {
    const provider = github({
      baseUrl: 'https://ghe.example.com/api/v3',
      auth: { type: 'token', token: 't' },
    }).create()

    expect(provider.instance).toBe('ghe.example.com')
  })

  it('derives the GraphQL endpoint for github.com and GHES', () => {
    expect(graphqlUrl('https://api.github.com')).toBe('https://api.github.com/graphql')
    expect(graphqlUrl('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com/api/graphql')
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

  it('refuses to address an unresolved or other thread', async () => {
    const { provider } = tokenProvider()
    await expect(provider.threads.get({ ...pull, number: undefined })).rejects.toThrow(UnresolvedThreadError)
    await expect(provider.threads.get({ ...pull, kind: 'other', typeRaw: 'Release', number: '1' })).rejects.toThrow(UnresolvedThreadError)
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
    }).create()

    const page = await provider.notifications.listPage()

    expect(page.cursor).toBeUndefined()
    expect(page.etag).toBe('W/"first"')

    const again = await provider.notifications.listPage({ cursor: { etag: page.etag } })

    expect(again.notModified).toBe(true)
    expect(again.etag).toBe('W/"first"')
    expect(conditions).toEqual([null, 'W/"first"'])
  })
})

describe('github discussions', () => {
  it('resolves a discussion notification subject to its number through GraphQL', async () => {
    const { provider, calls } = tokenProvider()
    const page = await provider.notifications!.listPage({ cursor: { nextUrl: 'https://api.github.com/notifications?all=false&page=2' } })

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
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    const page = await provider.notifications!.listPage({ cursor: { nextUrl: 'https://api.github.com/notifications?all=false&page=2' } })

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

  it('looks up the node id once before mutating a discussion without one', async () => {
    const { provider, calls } = tokenProvider()
    await provider.threads.close(discussion, { reason: 'completed' })

    expect(calls.map(call => call.operationName)).toEqual(['DiscussionThread', 'CloseDiscussion'])
    expect(JSON.parse(calls[1]!.body!).variables).toEqual({ id: 'D_kwDOAAB5ac4AAQ1f', reason: 'RESOLVED' })
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
    await provider.threads.comment!({ ...discussion, externalId: 'D_kwDOAAB5ac4AAQ1f' }, 'Nice')
    await provider.threads.reopen!({ ...discussion, externalId: 'D_kwDOAAB5ac4AAQ1f' })

    expect(calls.map(call => call.operationName)).toEqual(['AddDiscussionComment', 'ReopenDiscussion'])
  })

  it('closes an issue with its reason', async () => {
    const requests: Array<{ method?: string, url: string, body?: unknown }> = []
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async (url, init) => {
        requests.push({ method: init?.method, url, body: init?.body && JSON.parse(String(init.body)) })
        return new Response(null, { status: 204 })
      },
    }).create()

    await provider.threads.close({ forge: 'github', instance: 'github.com', repo, kind: 'issue', number: '7' }, { reason: 'not_planned' })

    expect(requests).toEqual([{ method: 'PATCH', url: 'https://api.github.com/repos/acme/widgets/issues/7', body: { state: 'closed', state_reason: 'not_planned' } }])
  })

  it('refuses to close a commit', async () => {
    const { provider } = tokenProvider()
    await expect(provider.threads.close!({ ...pull, kind: 'commit', number: 'adbc974' })).rejects.toThrow(UnsupportedOperationError)
  })
})

describe('github app installations', () => {
  it('only supports installations under app auth', async () => {
    expect(tokenProvider().provider.can('installations.list')).toBe(false)
    await expect(tokenProvider().provider.installations.get('1')).rejects.toThrow(UnsupportedOperationError)
    expect(appProvider().provider.capabilities.installations).toBe(true)
  })

  it('exchanges app credentials for an installation token and reuses it', async () => {
    const { provider, calls } = appProvider(55123)

    await provider.notifications!.markRead!({ forge: 'github', instance: 'github.com', id: '901234567' })
    await provider.notifications!.markRead!({ forge: 'github', instance: 'github.com', id: '901234567' })

    const tokenCalls = calls.filter(call => call.url.endsWith('/access_tokens'))
    expect(tokenCalls).toHaveLength(1)
    expect(calls.at(-1)!.authorization).toBe('Bearer ghs_fixtureinstallationtoken')
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
      await entry.provider.notifications!.markRead!({ forge: 'github', instance: 'github.com', id: '901234567' })
    }

    expect(derived).toHaveLength(2)
    const jwtCalls = calls.filter(call => call.url.endsWith('/app/installations') || call.url.endsWith('/access_tokens'))
    expect(jwtCalls).toHaveLength(3)
    expect(new Set(jwtCalls.map(call => call.authorization)).size).toBe(1)
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.authorization)).toEqual([
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

  it('reads one account\'s role on a repository', async () => {
    const { provider } = tokenProvider()

    expect(await provider.repos.permissionFor(repo, 'octocat')).toBe('maintain')
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
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()

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
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    vi.useFakeTimers({ now: 0, toFake: ['Date'] })
    try {
      const first = await provider.threads.reviewsPage(pull, { perPage: 1 })
      vi.setSystemTime(10 * 60_000)
      await provider.threads.reviewsPage(pull, { perPage: 1, cursor: first.cursor })
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

    const { items } = await provider.checks.list(repo, sha)
    await provider.checks.rerun({ forge: 'github', instance: 'github.com', repo, id: '4002', type: 'check_run' })

    expect(items.map(check => check.ref.type)).toContain('check_run')
    await expect(provider.checks.rerun({ forge: 'github', instance: 'github.com', repo, id: '4101', type: 'status' }))
      .rejects
      .toBeInstanceOf(UnsupportedOperationError)
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

describe('github contents', () => {
  const sha = '6dcb09b5b57875f334f61aebed695e2e4193db5e'

  it('reads a text file and falls through to the blob endpoint for a large one', async () => {
    const { provider, calls } = tokenProvider()

    const text = await provider.contents.file(repo, 'package.json', { ref: 'main', as: 'text' })
    const binary = await provider.contents.file(repo, 'assets/large.bin')

    expect(text).toMatchObject({ path: 'package.json', encoding: 'utf-8', sha: 'aa1', size: 42 })
    expect(text.content).toBe('{"name":"widgets"}\n')
    expect(binary.encoding).toBe('binary')
    expect([...(binary.content as Uint8Array)]).toEqual([0, 1, 2, 250])
    expect(calls.at(-1)!.url).toContain('/git/blobs/bb2')
  })

  it('rejects a binary file read as text', async () => {
    const { provider } = tokenProvider()

    await expect(provider.contents.file(repo, 'assets/large.bin', { as: 'text' })).rejects.toBeInstanceOf(ContentNotTextError)
  })

  it('warns when the tree is truncated', async () => {
    const { provider } = tokenProvider()

    const page = await provider.contents.treePage(repo, { ref: 'main', recursive: true })

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
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()

    await provider.contents.treePage(repo, { path: 'src' })

    expect(calls.map(call => call.url)).toEqual(['https://api.github.com/repos/acme/widgets/git/trees/HEAD%3Asrc'])
  })

  it('reads branches, tags, commits and a comparison', async () => {
    const { provider } = tokenProvider()

    const branches = await Array.fromAsync(provider.contents.branches(repo))
    const tags = await Array.fromAsync(provider.contents.tags(repo))
    const commit = await provider.contents.commit(repo, sha)
    const comparison = await provider.contents.compare(repo, 'v1.0.0', 'main')

    expect(branches[0]).toMatchObject({ name: 'main', sha, isProtected: true })
    expect(tags[0]).toMatchObject({ name: 'v1.0.0', sha })
    expect(commit).toMatchObject({ sha, message: 'fix: handle empty input', stats: { additions: 4, deletions: 1 } })
    expect(commit.author?.actor?.login).toBe('octocat')
    expect(commit.files?.[0]).toMatchObject({ path: 'src/index.ts', status: 'modified', patch: '@@ -1 +1 @@' })
    expect(comparison).toMatchObject({ aheadBy: 2, behindBy: 0, mergeBaseSha: '0'.repeat(40) })
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
})

describe('github search', () => {
  it('translates a structured query into qualifiers and reads the repo from each result', async () => {
    const { provider, calls } = tokenProvider()

    const { items } = await provider.search.threadsPage({ text: 'crash', repo, kind: 'issue', state: 'open', sort: 'updated', direction: 'desc' })

    expect(new URL(calls[0]!.url).searchParams.get('q')).toBe('crash repo:acme/widgets is:issue state:open')
    expect(items[0]!.ref).toMatchObject({ kind: 'issue', number: '42' })
    expect(items[0]!.ref.repo).toMatchObject({ owner: 'acme', name: 'widgets' })
    expect(items[0]!.title).toBe('Widget crashes on load')
  })

  it('warns rather than filtering when a repository sort is unsupported', async () => {
    const { provider } = tokenProvider()

    const page = await provider.search.reposPage({ text: 'widgets', owner: 'acme', sort: 'stars' })

    expect(page.items[0]!.ref.name).toBe('widgets')
    expect(page.warnings).toBeUndefined()
  })
})

describe('github webhook management', () => {
  const hook = { forge: 'github', instance: 'github.com', target: repo, id: '12345678' } as const

  it('lists hooks with normalised kinds beside the native names', async () => {
    const { provider } = tokenProvider()

    const { items } = await provider.webhooks.listPage(repo)

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

    const { items } = await provider.webhooks.deliveriesPage(hook)
    await provider.webhooks.redeliver(items[0]!.ref)

    expect(items[0]).toMatchObject({ event: 'issues.opened', status: 200, ok: true, duration: 123 })
    expect(calls.at(-1)!.url).toContain('/hooks/12345678/deliveries/55001/attempts')
  })

  it('maps a 404 from a hook endpoint to ForbiddenError, since GitHub answers 404 for a missing hook scope', async () => {
    const { fetch } = fixtureFetch('github', { 'GET https://api.github.com/repos/acme/widgets/hooks': { status: 404, body: { message: 'Not Found' } } })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()

    const error = await provider.webhooks.listPage(repo).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ForbiddenError)
    expect((error as ForbiddenError).reason).toBe('resource_protected')
  })

  it('reports the scopes a verb needs, as data', () => {
    const { provider } = tokenProvider()

    expect(provider.scopesFor('webhooks.create')).toEqual({ token: ['admin:repo_hook', 'admin:org_hook'], permissions: { webhooks: 'admin' } })
    expect(provider.scopesFor('threads.close').permissions).toMatchObject({ issues: 'write' })
  })
})

const widgets = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' } as const
const secretScanning = 'GET https://api.github.com/repos/acme/widgets/secret-scanning/alerts?state=open'

describe('github checks, releases and security alerts', () => {
  it('summarises the status rollup when reading several pull requests', async () => {
    const { fetch } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    const [result] = await provider.threads.getMany([{ forge: 'github', instance: 'github.com', repo: widgets, kind: 'pull_request', number: '42' }])

    expect(result?.ok && result.thread.checks).toEqual({ state: 'failure', stateRaw: 'failure', total: 3, failed: 1, url: 'https://github.com/acme/widgets/pull/42/checks' })
  })

  it('reports an unreadable alert kind as a warning when listing every kind, and throws when asked for it', async () => {
    const { fetch } = fixtureFetch('github', { [secretScanning]: { status: 403, body: { message: 'Resource not accessible by personal access token' } } })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    const page = await provider.securityAlerts!.listPage(widgets)
    const rest = await provider.securityAlerts!.listPage(widgets, { cursor: page.cursor })
    const last = await provider.securityAlerts!.listPage(widgets, { cursor: rest.cursor })

    expect(last.items).toEqual([])
    expect(last.warnings?.map(warning => warning.code)).toEqual(['insufficient_scope'])
    await expect(provider.securityAlerts!.listPage(widgets, { kind: 'secret' })).rejects.toThrow(InsufficientScopeError)
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

describe('github provider edge cases', () => {
  const commit = { forge: 'github', instance: 'github.com', repo, kind: 'commit', number: 'abc123' } as const

  it('reads commit comments as comment events', async () => {
    const forge = github({ auth: { type: 'token', token: 't' }, fetch: async () => Response.json([{ id: 7, body: 'Nice', created_at: '2025-01-01T00:00:00Z', user: { login: 'octocat' } }]) }).create()
    const [event] = (await forge.threads.eventsPage(commit)).items

    expect(event).toMatchObject({ kind: 'comment', detail: { type: 'comment', body: 'Nice', comment: { id: '7' } } })
  })

  it('rejects removing a reaction when the viewer cannot be read', async () => {
    const forge = github({
      auth: { type: 'token', token: 't' },
      fetch: async url => url.endsWith('/user') ? new Response('{}', { status: 500 }) : Response.json([{ id: 1, content: '+1', user: { login: 'octocat' } }]),
    }).create()

    await expect(forge.threads.unreact(pull, '+1')).rejects.toThrow()
  })
})

describe('github data residency', () => {
  it('treats ghe.com hosts as github.com rather than Enterprise Server', async () => {
    const provider = github({ auth: { type: 'token', token: 't' }, baseUrl: 'https://api.acme.ghe.com' }).create()

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
    } }).create()

    await provider.threads.merge(pull, { method: 'squash', message: 'Ship it' })

    expect(bodies).toEqual([{ url: 'https://api.github.com/repos/acme/widgets/pulls/42/merge-async', body: '{"merge_method":"squash","commit_message":"Ship it","merge_action":"direct_merge"}' }])
  })
})

describe('github path safety', () => {
  function recordingProvider(options: { readOnly?: boolean } = {}) {
    const urls: string[] = []
    const fetch = async (url: string) => {
      urls.push(url)
      return new Response('{}', { status: 200 })
    }
    return { provider: github({ auth: { type: 'token', token: 't' }, fetch, ...options }).create(), urls }
  }

  it('keeps a thread number that tries to climb out of the repository inside it', async () => {
    const { provider, urls } = recordingProvider()

    await provider.threads.comment({ ...pull, kind: 'issue', number: '1/../../../../user/keys' }, 'hi')

    expect(urls).toEqual(['https://api.github.com/repos/acme/widgets/issues/1%2F..%2F..%2F..%2F..%2Fuser%2Fkeys/comments'])
  })

  it('encodes owner, name and number so they cannot add path segments or a query', async () => {
    const { provider, urls } = recordingProvider()

    await provider.threads.comment({ ...pull, repo: { ...repo, owner: 'acme/x', name: 'widgets?y=1' }, kind: 'issue', number: '1?x=' }, 'hi')

    expect(urls).toEqual(['https://api.github.com/repos/acme%2Fx/widgets%3Fy%3D1/issues/1%3Fx%3D/comments'])
  })

  it('rejects a mutating `request()` on a read-only provider', async () => {
    const { provider, urls } = recordingProvider({ readOnly: true })

    await expect(provider.request('DELETE', '/repos/acme/widgets')).rejects.toThrow('is a write and this github provider is read-only')
    await provider.request('GET', '/repos/acme/widgets')
    expect(urls).toEqual(['https://api.github.com/repos/acme/widgets'])
  })
})
