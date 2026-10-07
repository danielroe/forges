import type { ResolvedThreadRef } from '../../src/model.ts'
import { describe, expect, it } from 'vitest'
import { InsufficientScopeError, SubscriptionClosedError, TokenRevokedError, UnresolvedThreadError, UnsupportedOperationError } from '../../src/errors.ts'
import { notificationThread, repoKey, threadKey } from '../../src/model.ts'
import { parseAtUri } from '../../src/tangled/atproto.ts'
import { tangled } from '../../src/tangled/index.ts'
import { jetstreamUrl } from '../../src/tangled/subscribe.ts'
import { fixtureFetch } from '../utils/fixtures.ts'
import { FakeWebSocket } from '../utils/websocket.ts'

const OWNER = 'did:plc:acmeowner222222222222222'
const ADA = 'did:plc:adaauthor222222222222222'
const PULL = `at://${ADA}/sh.tangled.repo.pull/3mwqpull22222`
const PDS = 'https://pds.example.com'
const C = 'https://constellation.microcosm.blue/links'
const repo = { forge: 'tangled', instance: 'tangled.org', owner: OWNER, name: 'widgets' } as const
const pull: ResolvedThreadRef = { forge: 'tangled', instance: 'tangled.org', repo, kind: 'pull_request', number: PULL }

function provider(overrides = {}, auth = true) {
  const { fetch, calls } = fixtureFetch('tangled', overrides)
  return {
    instance: tangled({
      auth: auth ? { type: 'app_password', identifier: 'acme.example.com', password: 'pw', pds: PDS } : undefined,
      fetch,
    }).create(),
    calls,
  }
}

describe('tangled identity', () => {
  it('keys threads by AT-URI under the owner DID and repo name', () => {
    expect(threadKey(pull)).toBe(`tangled:tangled.org/${OWNER}/widgets#pull_request/${PULL}`)
    expect(repoKey(repo)).toBe(`tangled:tangled.org/${OWNER}/widgets`)
  })

  it('never collides two authors whose record keys match', () => {
    const other = { ...pull, number: PULL.replace(ADA, 'did:plc:someoneelse2222222222222') }
    expect(threadKey(pull)).not.toBe(threadKey(other))
  })

  it('parses AT-URIs and rejects anything else', () => {
    expect(parseAtUri(PULL)).toEqual({ did: ADA, collection: 'sh.tangled.repo.pull', rkey: '3mwqpull22222' })
    expect(parseAtUri('https://tangled.org/x')).toBeUndefined()
  })

  it('resolves the repo DID to its owner and name through backlinks', async () => {
    const { instance } = provider()
    const thread = await instance.threads.get({ ...pull, repo: { ...repo, owner: 'unknown', name: 'unknown' } })

    expect(thread.ref.repo).toEqual({ ...repo, externalId: 'did:plc:widgetsrepo2222222222222' })
    expect(thread.author).toMatchObject({ login: 'ada.example.com', id: ADA })
  })

  it('refuses a ref whose number is not an issue or pull AT-URI', async () => {
    const { instance } = provider()
    await expect(instance.threads.get({ ...pull, number: '4' })).rejects.toThrow(UnresolvedThreadError)
    await expect(instance.threads.get({ ...pull, kind: 'issue' })).rejects.toThrow(UnresolvedThreadError)
  })
})

describe('tangled state', () => {
  it('ignores state records from anyone but the author, repo owner or a collaborator', async () => {
    const { instance } = provider()
    const thread = await instance.threads.get(pull)

    expect(thread.state).toBe('open')
    expect(thread.commentCount).toBe(1)
  })

  it('honours a close from a collaborator listed by the knot', async () => {
    const { instance } = provider({
      'GET https://knot.example.com/xrpc/sh.tangled.repo.listCollaborators?subject=did:plc:widgetsrepo2222222222222&limit=1000': {
        status: 200,
        body: { items: [{ subject: 'did:plc:strangerdid2222222222222', addedBy: OWNER, createdAt: '2025-09-01T00:00:00Z' }] },
      },
    })

    expect((await instance.threads.get(pull)).state).toBe('closed')
  })

  it('falls back to author and owner when the knot predates collaborator XRPC', async () => {
    const { instance } = provider({
      'GET https://knot.example.com/xrpc/sh.tangled.repo.listCollaborators?subject=did:plc:widgetsrepo2222222222222&limit=1000': {
        status: 404,
        body: { error: 'MethodNotImplemented' },
      },
    })

    expect((await instance.threads.get(pull)).state).toBe('open')
  })

  it('honours a close from the repo owner', async () => {
    const { instance } = provider({
      [`GET ${C}?target=${PULL}&collection=sh.tangled.repo.pull.status&path=.pull&limit=100`]: {
        status: 200,
        body: { linking_records: [{ did: OWNER, collection: 'sh.tangled.repo.pull.status', rkey: '3mwqowner2222' }], cursor: null },
      },
      [`GET ${PDS}/xrpc/com.atproto.repo.getRecord?repo=${OWNER}&collection=sh.tangled.repo.pull.status&rkey=3mwqowner2222`]: {
        status: 200,
        body: { uri: 'x', value: { pull: PULL, status: 'sh.tangled.repo.pull.status.merged', createdAt: '2025-09-19T00:00:00Z' } },
      },
    })
    const thread = await instance.threads.get(pull)

    expect(thread).toMatchObject({ state: 'merged', stateRaw: 'merged' })
    expect(thread.closedAt?.toISOString()).toBe('2025-09-19T00:00:00.000Z')
  })
})

describe('tangled index listing', () => {
  it('lists from the index in one request per page and warns that states may be stale', async () => {
    const { fetch, calls } = fixtureFetch('tangled')
    const listing = tangled({ fetch, listSource: 'index' }).create().threads.list(repo, { kind: 'pull_request' })
    const threads = []
    for await (const thread of listing) {
      threads.push(thread)
    }

    expect(threads.map(thread => [thread.ref.number, thread.state, thread.commentCount])).toEqual([[PULL, 'open', 1]])
    expect(calls.filter(call => call.url.startsWith('https://api.tangled.org'))).toHaveLength(1)
    expect(calls.some(call => call.url.includes('constellation'))).toBe(false)
    expect(listing.warnings.map(warning => warning.code)).toEqual(['index_possibly_stale'])
  })
})

describe('tangled writes', () => {
  it('is read-only without credentials', async () => {
    const { instance } = provider({}, false)

    expect(instance.can('threads.comment', 'issue')).toBe(false)
    expect(instance.can('notifications.list')).toBe(false)
    await expect(instance.threads.comment(pull, 'x')).rejects.toThrow(UnsupportedOperationError)
  })

  it('writes a feed comment with a strong ref to the thread', async () => {
    const { instance, calls } = provider()
    const comment = await instance.threads.comment!(pull, 'Thanks!')
    const write = JSON.parse(calls.find(call => call.url.endsWith('createRecord'))!.body!)

    expect(comment.ref.id).toBe('at://did:plc:acmeowner222222222222222/sh.tangled.feed.comment/3mwqcreated22')

    expect(calls.find(call => call.url.endsWith('createSession'))!.body).toContain('acme.example.com')
    expect(calls.find(call => call.url.endsWith('createRecord'))!.authorization).toBe('Bearer fixture-access-jwt')
    expect(write).toMatchObject({
      repo: OWNER,
      collection: 'sh.tangled.feed.comment',
      record: {
        $type: 'sh.tangled.feed.comment',
        body: { $type: 'sh.tangled.markup.markdown', text: 'Thanks!' },
        subject: { uri: PULL, cid: 'bafyreipullcid' },
      },
    })
  })

  it('refuses to change state for an account the appview would ignore', async () => {
    const { instance, calls } = provider({
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: { status: 200, body: { did: 'did:plc:strangerdid2222222222222', accessJwt: 'a', refreshJwt: 'r' } },
    })

    await expect(instance.threads.close!(pull)).rejects.toThrow(InsufficientScopeError)
    expect(calls.some(call => call.url.endsWith('createRecord'))).toBe(false)
  })

  it('accepts state changes from Tangled\'s own account', async () => {
    const { instance, calls } = provider({
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: { status: 200, body: { did: 'did:plc:wshs7t2adsemcrrd4snkeqli', accessJwt: 'a', refreshJwt: 'r' } },
    })
    await instance.threads.reopen!(pull)

    expect(calls.at(-1)!.url).toBe(`${PDS}/xrpc/com.atproto.repo.createRecord`)
  })

  it('refreshes an expired session once', async () => {
    let attempts = 0
    const { fetch: base, calls } = fixtureFetch('tangled', {
      [`POST ${PDS}/xrpc/com.atproto.server.refreshSession`]: { status: 200, body: { did: OWNER, accessJwt: 'fresh-jwt', refreshJwt: 'fresh-refresh' } },
    })
    const instance = tangled({
      auth: { type: 'app_password', identifier: OWNER, password: 'pw', pds: PDS },
      fetch: async (url, init) => {
        if (url.endsWith('createRecord') && attempts++ === 0) {
          return new Response('{"error":"ExpiredToken","message":"Token has expired"}', { status: 400 })
        }
        return base(url, init)
      },
    }).create()
    await instance.threads.close!(pull)

    expect(calls.map(call => call.url.split('/').at(-1))).toContain('com.atproto.server.refreshSession')
    expect(calls.at(-1)!.authorization).toBe('Bearer fresh-jwt')
  })

  it('sends writes through the OAuth client fetch', async () => {
    const { fetch: base } = fixtureFetch('tangled')
    const signed: string[] = []
    const instance = tangled({
      auth: {
        type: 'oauth',
        did: OWNER,
        pds: PDS,
        fetch: async (url, init) => {
          signed.push(url)
          return base(url, init)
        },
      },
      fetch: base,
    }).create()
    await instance.threads.reopen!(pull)

    expect(signed).toEqual([`${PDS}/xrpc/com.atproto.repo.createRecord`])
  })

  it('maps a rejected app password to TokenRevokedError', async () => {
    const { instance } = provider({
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: { status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } },
    })

    await expect(instance.threads.comment(pull, 'x')).rejects.toThrow(TokenRevokedError)
  })

  it('maps a 401 through the OAuth client fetch to TokenRevokedError', async () => {
    const { fetch: base } = fixtureFetch('tangled')
    const instance = tangled({
      auth: {
        type: 'oauth',
        did: OWNER,
        pds: PDS,
        fetch: async () => new Response('{"error":"InvalidToken"}', { status: 401 }),
      },
      fetch: base,
    }).create()

    await expect(instance.threads.reopen!(pull)).rejects.toThrow(TokenRevokedError)
  })
})

describe('tangled notifications (experimental)', () => {
  function notifying() {
    const { fetch, calls } = fixtureFetch('tangled')
    return {
      instance: tangled({
        auth: { type: 'app_password', identifier: 'acme.example.com', password: 'pw', pds: PDS },
        notificationsUrl: 'https://notifs.example.com',
        fetch,
      }).create(),
      calls,
    }
  }

  it('is unsupported without a notifications service, and experimental with one', async () => {
    expect(provider().instance.can('notifications.list')).toBe(false)
    await expect(provider().instance.notifications.listPage()).rejects.toThrow(UnsupportedOperationError)
    expect(notifying().instance.capabilities.notifications.list).toBe('experimental')
  })

  it('lists notifications with a service-auth token scoped to the method', async () => {
    const { instance, calls } = notifying()
    const page = await instance.notifications!.listPage()
    const [comment, follow] = page.items

    expect(calls.find(call => call.url.includes('getServiceAuth'))!.url).toContain('aud=did%3Aweb%3Anotifs.example.com')
    expect(calls.find(call => call.url.startsWith('https://notifs.example.com'))!.authorization).toBe('Bearer fixture-service-jwt-listNotifications')
    expect(comment).toMatchObject({
      reason: 'comment',
      reasonRaw: 'pull_commented',
      unread: true,
      title: 'Cache compiled templates',
      subject: { type: 'thread', thread: { kind: 'pull_request', number: PULL, repo: { owner: OWNER, name: 'widgets' } } },
    })
    expect(comment!.ref.id).not.toBe(notificationThread(comment!)!.number)
    expect(follow!.subject).toMatchObject({ type: 'actor', actor: { id: 'did:plc:strangerdid2222222222222' } })
    expect(follow!.reason).toBe('followed')
    expect(page.cursor).toBeUndefined()
  })

  it('marks a notification read by its source record URI', async () => {
    const { instance, calls } = notifying()
    await instance.notifications!.markRead!({ forge: 'tangled', instance: 'tangled.org', id: 'at://did:plc:x/sh.tangled.feed.comment/1' })

    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ uri: 'at://did:plc:x/sh.tangled.feed.comment/1', read: true })
    expect(calls.at(-1)!.authorization).toBe('Bearer fixture-service-jwt-updateSeen')
  })
})

describe('tangled subscribe', () => {
  it('requests only the collections it is given', () => {
    const url = new URL(jetstreamUrl('wss://jetstream.example/subscribe', ['sh.tangled.repo.issue', 'sh.tangled.feed.comment']))

    expect(url.searchParams.getAll('wantedCollections')).toEqual(['sh.tangled.repo.issue', 'sh.tangled.feed.comment'])
  })

  it('keeps events whose thread cannot be resolved, without a thread', async () => {
    const { fetch } = fixtureFetch('tangled')
    const instance = tangled({
      fetch,
      webSocket: url => new FakeWebSocket(url, [{
        did: ADA,
        time_us: 1,
        kind: 'commit',
        commit: {
          rev: 'r',
          operation: 'create',
          collection: 'sh.tangled.feed.reaction',
          rkey: '3mwqother2222',
          record: { subject: `at://${ADA}/sh.tangled.repo.issue/3mwqmissing22`, reaction: '👀', createdAt: '2025-09-18T00:00:00Z' },
        },
      }]),
    }).create()
    const iterator = instance.sources!.subscribe()[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.value).toMatchObject({ cursor: '1', event: { kind: 'reaction', id: `at://${ADA}/sh.tangled.feed.reaction/3mwqother2222` } })
    expect(first.value!.event.thread).toBeUndefined()
    await expect(iterator.next()).rejects.toThrow(SubscriptionClosedError)
  })
})

describe('tangled webhooks', () => {
  it('fills the thread number through resolveDisplayNumber when provided', async () => {
    const instance = tangled({
      webhookSecret: 's',
      resolveDisplayNumber: async (_repo, kind, number) => kind === 'pull_request' && number === '4' ? PULL : undefined,
    }).create()
    const body = JSON.stringify({ action: 'closed', pull_request: { number: 4 }, repository: { name: 'widgets', owner: { did: OWNER } }, sender: { did: OWNER } })
    const { hmacSha256Hex } = await import('../../src/crypto.ts')
    const [event] = await instance.webhooks.ingest({
      headers: { 'x-tangled-event': 'pull_request:closed', 'x-tangled-signature-256': `sha256=${await hmacSha256Hex('s', body)}` },
      body,
    })

    expect(event!.thread).toMatchObject({ number: PULL, externalId: PULL, displayNumber: '4' })
  })
})

describe('tangled anonymous auth', () => {
  it('treats `{ type: \'anonymous\' }` like no credentials', () => {
    const provider = tangled({ auth: { type: 'anonymous' } }).create()

    expect(provider.capabilities.writes.comment.issue).toBe(false)
  })
})
