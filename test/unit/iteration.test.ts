import type { ResolvedThreadRef } from '../../src/model.ts'
import { describe, expect, it } from 'vitest'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { normaliseMarkdown } from '../../src/bitbucket/normalise.ts'
import { hmacSha256Hex } from '../../src/crypto.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitea } from '../../src/gitea/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { notificationThread } from '../../src/model.ts'
import { tangled } from '../../src/tangled/index.ts'
import { forgeIterable, phased, versionAtLeast } from '../../src/utils.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const ghRepo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' } as const
const ghPull: ResolvedThreadRef = { forge: 'github', instance: 'github.com', repo: ghRepo, kind: 'pull_request', number: '42' }

async function sign(body: string, secret = 's') {
  return `sha256=${await hmacSha256Hex(secret, body)}`
}

describe('cross-cutting', () => {
  it('compares versions numerically and ignores suffixes', () => {
    expect(versionAtLeast('3.13.0', '3.13')).toBe(true)
    expect(versionAtLeast('3.9.2', '3.13')).toBe(false)
    expect(versionAtLeast('7.0.0+gitea-1.22.0', '7')).toBe(true)
    expect(versionAtLeast(undefined, '1')).toBe(false)
  })

  it('collects warnings on the iterable while yielding items', async () => {
    const iterable = forgeIterable(async function* (warn) {
      yield 1
      warn({ code: 'x', message: 'skipped one' })
      yield 2
    })
    const items = []
    for await (const item of iterable) {
      items.push(item)
    }

    expect(items).toEqual([1, 2])
    expect(iterable.warnings).toEqual([{ code: 'x', message: 'skipped one' }])
  })

  it('serialises a notification to JSON with dates as ISO strings', async () => {
    const { fetch } = fixtureFetch('github')
    const page = await github({ auth: { type: 'token', token: 't' }, fetch }).create().notifications!.listPage()
    const roundTrip = JSON.parse(JSON.stringify(page.items[0]))

    expect(roundTrip.updatedAt).toBe(page.items[0]!.updatedAt.toISOString())
    expect(roundTrip.subject.type).toBe('thread')
  })
})

describe('github iteration', () => {
  it('gates mark-as-done on GHES by version, without a network call when the version is given', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const ghes = github({ baseUrl: 'https://ghe.example.com/api/v3', auth: { type: 'token', token: 't' }, fetch }).create()
    const known = github({ baseUrl: 'https://ghe.example.com/api/v3', auth: { type: 'token', token: 't' }, instanceVersion: '3.14.1', fetch }).create()

    expect(ghes.capabilities.notifications.markDone).toBe(false)
    expect(known.capabilities.notifications.markDone).toBe(true)
    expect(known.capabilities.version).toBe('3.14.1')
    const refreshed = await ghes.refreshCapabilities()
    expect(refreshed).toMatchObject({ version: '3.12.4', notifications: { markDone: false } })
    expect(ghes.capabilities.version).toBe('3.12.4')
    await ghes.refreshCapabilities()
    expect(calls.map(call => call.url)).toEqual(['https://ghe.example.com/api/v3/meta'])
  })

  it('makes no call to refresh github.com capabilities', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()

    expect((await provider.refreshCapabilities()).notifications.markDone).toBe(true)
    expect(calls).toEqual([])
  })

  it('reads reviewers, teams and branches from a pull request', async () => {
    const { fetch } = fixtureFetch('github')
    const thread = await github({ auth: { type: 'token', token: 't' }, fetch }).create().threads.get(ghPull)

    expect(thread.reviewers.map(reviewer => [reviewer.actor.login, reviewer.state, reviewer.isTeam ?? false])).toEqual([
      ['hubot', 'pending', false],
      ['core', 'pending', true],
    ])
    expect(thread.branches).toMatchObject({ head: { ref: 'retry-uploader', repo: { name: 'widgets' } }, base: { ref: 'main' } })
    expect(thread.assignees.map(actor => actor.login)).toEqual(['hubot'])
  })

  it('batches getMany into one GraphQL document and keeps REST and GraphQL threads alike', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    const [result] = await provider.threads.getMany([ghPull])
    const rest = await provider.threads.get(ghPull)

    expect(calls.filter(call => call.operationName === 'ThreadsBatch')).toHaveLength(1)
    const batched = result!.ok ? result!.thread : undefined
    expect(batched).toMatchObject({ kind: 'pull_request', state: rest.state, stateRaw: rest.stateRaw, title: rest.title, isDraft: rest.isDraft })
    expect(batched!.branches?.head.sha).toBe(rest.branches?.head.sha)
  })

  it('fills the check rollup on listed pulls with one batched read', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    const page = await provider.threads.listPage(ghPull.repo, { kind: 'pull_request' })

    expect(calls.filter(call => call.operationName === 'ThreadsBatch')).toHaveLength(1)
    expect(page.items.find(thread => thread.ref.number === ghPull.number)?.checks?.state).toBeDefined()
  })

  it('reads and changes the thread subscription through GraphQL', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()

    expect(await provider.threads.subscription!(ghPull)).toBe('subscribed')
    await provider.threads.unsubscribe!(ghPull)
    expect(JSON.parse(calls.at(-1)!.body!).variables).toEqual({ id: 'PR_kwDOAAB5ac6abcdef', state: 'UNSUBSCRIBED' })
  })

  it('turns a push delivery into one push event with its commits in detail', async () => {
    const provider = github({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      before: 'aaa',
      after: 'bbb',
      forced: true,
      commits: [{ id: 'c1', message: 'one' }, { id: 'c2', message: 'two' }],
      repository: { id: 31337, name: 'widgets', full_name: 'acme/widgets' },
      installation: { id: 55123 },
    })
    const events = await provider.webhooks.ingest({ headers: { 'x-github-event': 'push', 'x-hub-signature-256': await sign(body) }, body })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'push', installationId: '55123', detail: { type: 'push', ref: 'refs/heads/main', commitCount: 2, forced: true } })
  })

  it('maps repository, installation and release deliveries to repo-level kinds', async () => {
    const provider = github({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const repository = { id: 31337, name: 'gizmos', full_name: 'acme/gizmos', owner: { login: 'acme', id: 1 } }
    const ingest = async (event: string, payload: unknown) => {
      const body = JSON.stringify(payload)
      return (await provider.webhooks.ingest({ headers: { 'x-github-event': event, 'x-hub-signature-256': await sign(body) }, body }))[0]!
    }

    expect(await ingest('repository', { action: 'renamed', repository, changes: { repository: { name: { from: 'widgets' } } } }))
      .toMatchObject({ kind: 'repo', action: 'renamed', detail: { from: 'widgets', to: 'gizmos' } })
    expect(await ingest('installation_repositories', { action: 'added', installation: { id: 9 }, repositories_added: [repository] }))
      .toMatchObject({ kind: 'installation', installationId: '9', detail: { installationId: '9', added: [{ name: 'gizmos' }] } })
    expect(await ingest('release', { action: 'published', repository, release: { id: 5, tag_name: 'v1.0.0', name: 'One' } }))
      .toMatchObject({ kind: 'release', action: 'published', detail: { release: { id: '5', tag: 'v1.0.0' }, name: 'One' } })
    expect(await ingest('delete', { ref: 'old', ref_type: 'branch', repository })).toMatchObject({ kind: 'ref', action: 'deleted', detail: { ref: 'old', refType: 'branch' } })
  })
})

describe('forgejo and gitea', () => {
  it('counts unread notifications and marks a repo read', async () => {
    const { fetch, calls } = fixtureFetch('forgejo', {
      'GET https://codeberg.org/api/v1/notifications/new': { status: 200, body: { new: 3 } },
      'PUT https://codeberg.org/api/v1/repos/acme/widgets/notifications?to-status=read': { status: 205 },
    })
    const provider = forgejo({ auth: { type: 'token', token: 't' }, fetch }).create()

    expect(await provider.notifications!.unreadCount!()).toBe(3)
    await provider.notifications!.markAllRead!({ repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' } })
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: 'https://codeberg.org/api/v1/repos/acme/widgets/notifications?to-status=read' })
  })

  it('shares the implementation but reports gitea as its own forge', async () => {
    const factory = gitea({ auth: { type: 'token', token: 't' }, webhookSecret: 's' })
    const provider = factory.create()
    const body = JSON.stringify({ action: 'opened', issue: { number: 3 }, repository: { id: 1, name: 'w', full_name: 'a/w' }, sender: { id: 2, login: 'ada' } })
    const signature = await hmacSha256Hex('s', body)

    expect(provider.forge).toBe('gitea')
    expect(provider.instance).toBe('gitea.com')
    const [event] = await provider.webhooks.ingest({ headers: { 'x-gitea-event': 'issues', 'x-gitea-signature': signature }, body })
    expect(event).toMatchObject({ forge: 'gitea', thread: { forge: 'gitea', repo: { forge: 'gitea' } } })
    expect(await provider.webhooks.verify({ headers: { 'x-forgejo-event': 'issues', 'x-forgejo-signature': signature }, body })).toBe(false)
  })
})

describe('gitlab iteration', () => {
  it('counts pending to-dos from the X-Total header', async () => {
    const { fetch } = fixtureFetch('gitlab', {
      'GET https://gitlab.com/api/v4/todos?state=pending&per_page=1': { status: 200, headers: { 'x-total': '7' }, body: [] },
    })
    expect(await gitlab({ auth: { type: 'token', token: 't' }, fetch }).create().notifications!.unreadCount!()).toBe(7)
  })

  it('reports a tag push that creates a ref as a ref event', async () => {
    const provider = gitlab({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const [event] = await provider.webhooks.ingest({
      headers: { 'x-gitlab-event': 'Tag Push Hook', 'x-gitlab-token': 's' },
      body: JSON.stringify({ object_kind: 'tag_push', ref: 'refs/tags/v1.0.0', before: '0000000000000000000000000000000000000000', after: 'abc', project: { id: 1, path_with_namespace: 'acme/widgets' } }),
    })

    expect(event).toMatchObject({ kind: 'ref', action: 'created', detail: { type: 'ref', ref: 'refs/tags/v1.0.0', refType: 'tag' } })
  })
})

describe('bitbucket iteration', () => {
  it('rewrites collapsible HTML blocks, which Bitbucket does not render', () => {
    expect(normaliseMarkdown('<details><summary>Logs</summary>\n\nline\n</details>')).toBe('**Logs**\n\n\nline\n')
    expect(bitbucket({ auth: { type: 'token', token: 't' } }).create().normaliseMarkdown).toBe(normaliseMarkdown)
  })

  it('reads reviewer state from participants', async () => {
    const { fetch } = fixtureFetch('bitbucket')
    const thread = await bitbucket({ auth: { type: 'token', token: 't' }, fetch }).create().threads.get({
      forge: 'bitbucket',
      instance: 'bitbucket.org',
      repo: { forge: 'bitbucket', instance: 'bitbucket.org', owner: 'acme', name: 'widgets' },
      kind: 'pull_request',
      number: '31',
    })

    expect(thread.reviewers).toEqual([expect.objectContaining({ state: 'approved', actor: expect.objectContaining({ isBotHint: true }) })])
  })

  it('emits one event per ref change in a push', async () => {
    const provider = bitbucket({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const body = JSON.stringify({
      repository: { full_name: 'acme/widgets', uuid: '{r}' },
      push: { changes: [
        { new: { name: 'main', type: 'branch', target: { hash: 'b' } }, old: { name: 'main', type: 'branch', target: { hash: 'a' } }, commits: [{ hash: 'b' }] },
        { old: { name: 'gone', type: 'branch' }, new: null, closed: true },
      ] },
    })
    const events = await provider.webhooks.ingest({ headers: { 'x-event-key': 'repo:push', 'x-hub-signature': await sign(body) }, body })

    expect(events.map(event => event.kind)).toEqual(['push', 'ref'])
    expect(events[0]!.detail).toMatchObject({ before: 'a', after: 'b', commitCount: 1 })
  })
})

describe('tangled iteration', () => {
  const OWNER = 'did:plc:acmeowner222222222222222'
  const PULL = 'at://did:plc:adaauthor222222222222222/sh.tangled.repo.pull/3mwqpull22222'
  const pull: ResolvedThreadRef = {
    forge: 'tangled',
    instance: 'tangled.org',
    repo: { forge: 'tangled', instance: 'tangled.org', owner: OWNER, name: 'widgets' },
    kind: 'pull_request',
    number: PULL,
  }

  it('turns an unreachable participant PDS into a warning, not a failure', async () => {
    const { fetch: base } = fixtureFetch('tangled')
    const provider = tangled({
      fetch: async (url, init) => {
        if (url.includes('com.atproto.repo.getRecord') && url.includes('sh.tangled.feed.reaction')) {
          throw new TypeError('fetch failed')
        }
        return base(url, init)
      },
    }).create()
    const events = provider.threads.events(pull)
    const kinds = []
    for await (const event of events) {
      kinds.push(event.kind)
    }

    expect(kinds).toEqual(['comment', 'label'])
    expect(events.warnings).toEqual([expect.objectContaining({ code: 'record_unreachable', subject: expect.stringContaining('sh.tangled.feed.reaction') })])
  })

  it('maps the hosting knot to its SSH host for clone URLs', async () => {
    const { fetch } = fixtureFetch('tangled')
    const repo = await tangled({ fetch }).create().repos.get(pull.repo)

    expect(repo.cloneUrls).toEqual({
      https: `https://tangled.org/${OWNER}/widgets`,
      ssh: `ssh://git@tangled.org/${OWNER}/widgets`,
    })
    expect(repo.ref.externalId).toBe('did:plc:widgetsrepo2222222222222')
    const custom = await tangled({ fetch, sshHosts: { 'knot1.tangled.sh': 'git.example.org' } }).create().repos.get(pull.repo)
    expect(custom.cloneUrls?.ssh).toBe(`ssh://git@git.example.org/${OWNER}/widgets`)
  })

  it('places a star on the repo subject and keeps a thread subject a thread', async () => {
    const { fetch } = fixtureFetch('tangled', {
      'GET https://notifs.example.com/xrpc/org.tangled.temp.notification.listNotifications?read=unread&limit=100': {
        status: 200,
        body: { notifications: [{ uri: 'at://did:plc:x/sh.tangled.feed.star/1', read: false, type: 'repo_starred', actorDid: 'did:plc:x', repoDid: 'did:plc:widgetsrepo2222222222222', createdAt: '2025-09-18T00:00:00Z' }], workUnreadCount: 0, socialUnreadCount: 1 },
      },
    })
    const provider = tangled({ auth: { type: 'app_password', identifier: 'acme.example.com', password: 'pw', pds: 'https://pds.example.com' }, notificationsUrl: 'https://notifs.example.com', fetch }).create()
    const [star] = (await provider.notifications!.listPage()).items

    expect(star).toMatchObject({ reason: 'starred', subject: { type: 'repo', repo: { owner: OWNER, name: 'widgets' } } })
    expect(notificationThread(star!)).toBeUndefined()
  })
})

describe('phased', () => {
  it('runs each phase to the end before the next, carrying inner tokens', async () => {
    const phases = [
      async (cursor?: { token?: string }) => cursor?.token === 'b' ? { items: ['a2'] } : { items: ['a1'], cursor: { token: 'b' } },
      async () => ({ items: ['b1'] }),
    ]
    const first = await phased(phases)
    const second = await phased(phases, first.cursor)
    const third = await phased(phases, second.cursor)

    expect([first.items, second.items, third.items]).toEqual([['a1'], ['a2'], ['b1']])
    expect([first.cursor?.token, second.cursor?.token, third.cursor]).toEqual(['0:b', '1:', undefined])
  })
})
