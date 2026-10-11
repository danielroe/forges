import type { FetchLike } from '../../src/fetch.ts'
import type { ResolvedThreadRef } from '../../src/model.ts'
import { gzipSync } from 'node:zlib'
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

  it('reads a repo whose owner is a handle, as parseUrl returns it', async () => {
    const { instance } = provider({
      'GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=acme.example.com': { status: 200, body: { did: OWNER } },
    })
    const parsed = instance.parseUrl('https://tangled.org/@acme.example.com/widgets')!
    const found = await instance.repos.get(parsed.repo)

    expect(found.ref).toEqual({ ...repo, externalId: 'did:plc:widgetsrepo2222222222222' })
    expect(found.displayName).toBeUndefined()
  })

  it('refuses a handle that the DID document does not claim', async () => {
    const { instance } = provider({
      'GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=impostor.example.com': { status: 200, body: { did: OWNER } },
    })

    await expect(instance.repos.get({ ...repo, owner: 'impostor.example.com' })).rejects.toThrow('does not claim the handle')
  })

  it('finds a repo by its name where the record key differs', async () => {
    const record = { uri: `at://${OWNER}/sh.tangled.repo/3lzrepokey222`, cid: 'bafy', value: { $type: 'sh.tangled.repo', knot: 'knot1.tangled.sh', name: 'gadgets', repoDid: 'did:plc:gadgetsrepo222222222222', createdAt: '2025-09-01T00:00:00Z' } }
    const { instance } = provider({
      [`GET ${PDS}/xrpc/com.atproto.repo.getRecord?repo=${OWNER}&collection=sh.tangled.repo&rkey=gadgets`]: { status: 400, body: { error: 'RecordNotFound' } },
      [`GET ${PDS}/xrpc/com.atproto.repo.listRecords?repo=${OWNER}&collection=sh.tangled.repo&limit=100`]: { status: 200, body: { records: [record] } },
    })
    const found = await instance.repos.get({ ...repo, name: 'gadgets' })

    expect(found.ref).toMatchObject({ owner: OWNER, name: '3lzrepokey222', externalId: 'did:plc:gadgetsrepo222222222222' })
    expect(found.displayName).toBe('gadgets')
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

describe('tangled cancellation', () => {
  function heldProvider(held: RegExp) {
    const { fetch: served } = fixtureFetch('tangled')
    let holding = true
    let markHeld!: () => void
    const reached = new Promise<void>((resolve) => {
      markHeld = resolve
    })
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetch: FetchLike = async (input, init) => {
      if (holding && held.test(input)) {
        markHeld()
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
          void released.then(resolve)
        })
      }
      return served(input, init)
    }
    const instance = tangled({ auth: { type: 'app_password', identifier: 'acme.example.com', password: 'pw', pds: PDS }, fetch }).create()
    return {
      instance,
      reached,
      release: () => {
        holding = false
        release()
      },
    }
  }

  it('reads a thread after an earlier read was aborted while collaborators loaded', async () => {
    const { instance, reached, release } = heldProvider(/listCollaborators/)
    const controller = new AbortController()
    const reason = new Error('cancelled')

    const aborted = instance.threads.get(pull, { signal: controller.signal })
    await reached
    controller.abort(reason)
    await expect(aborted).rejects.toBe(reason)
    release()

    expect((await instance.threads.get(pull)).state).toBe('open')
  })

  it('rejects a comment aborted while its author resolved', async () => {
    const { instance, reached } = heldProvider(new RegExp(`plc\\.directory/${OWNER}`))
    const controller = new AbortController()
    const reason = new Error('cancelled')

    const pending = instance.threads.comment(pull, 'Thanks!', { signal: controller.signal })
    await reached
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('does not reject a concurrent read when another caller aborts a shared lookup', async () => {
    const { instance, reached, release } = heldProvider(/plc\.directory/)
    const controller = new AbortController()
    const reason = new Error('cancelled')

    const aborted = instance.threads.get(pull, { signal: controller.signal })
    await reached
    const concurrent = instance.threads.get(pull)
    controller.abort(reason)
    release()

    await expect(aborted).rejects.toBe(reason)
    expect((await concurrent).state).toBe('open')
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

  it('signs in at the PDS a handle resolves to', async () => {
    const { fetch, calls } = fixtureFetch('tangled', {
      'GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=acme.example.com': { status: 200, body: { did: OWNER } },
    })
    const instance = tangled({ auth: { type: 'app_password', identifier: 'acme.example.com', password: 'pw' }, fetch }).create()
    await instance.threads.comment!(pull, 'Thanks!')

    expect(calls.find(call => call.url.endsWith('createSession'))!.url).toBe(`${PDS}/xrpc/com.atproto.server.createSession`)
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

const KNOT = 'https://knot1.tangled.sh/xrpc'
const REPO_DID = 'did:plc:widgetsrepo2222222222222'
const BLOB = `GET ${PDS}/xrpc/com.atproto.sync.getBlob?did=${ADA}&cid=bafkreipatchblob`
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const PATCH = `From ${SHA_A} Mon Sep 17 00:00:00 2001
From: =?UTF-8?q?Ada=20L=C3=B8velace?= <ada@example.com>
Date: Mon, 15 Sep 2025 10:00:00 +0200
Subject: [PATCH 1/2] Cache compiled templates
 by content hash

Keyed by the hash of the source.
---
 src/cache.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/src/cache.ts b/src/cache.ts
index 1111111..2222222 100644
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -1,2 +1,2 @@
 export const cache = new Map()
-export const size = 1
+export const size = 2
--\x20
2.43.0


From ${SHA_B} Mon Sep 17 00:00:00 2001
From: Ada <ada@example.com>
Date: Mon, 15 Sep 2025 11:00:00 +0200
Subject: [PATCH 2/2] Rename the cache

---
diff --git a/src/cache.ts b/src/cache.ts
index 2222222..3333333 100644
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -1,2 +1,3 @@
 export const cache = new Map()
 export const size = 2
+export const limit = 3
diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
--\x20
2.43.0
`

describe('tangled contents', () => {
  it('reads changed files and commits from the gzipped patch of the latest round', async () => {
    const { instance } = provider({ [BLOB]: { status: 200, encoding: 'base64', body: gzipSync(PATCH).toString('base64') } }, false)

    const files = await instance.threads.filesPage(pull)
    expect(files.items).toEqual([
      expect.objectContaining({ path: 'src/cache.ts', status: 'modified', additions: 2, deletions: 1, sha: '3333333' }),
      expect.objectContaining({ path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 }),
    ])
    expect(files.warnings?.map(warning => [warning.code, warning.subject])).toEqual([['files_approximate', 'src/cache.ts']])

    const commits = await instance.threads.commitsPage(pull)
    expect(commits.items.map(commit => [commit.sha, commit.author?.name, commit.message, commit.stats])).toEqual([
      [SHA_A, 'Ada Løvelace', 'Cache compiled templates by content hash\n\nKeyed by the hash of the source.', { additions: 1, deletions: 1 }],
      [SHA_B, 'Ada', 'Rename the cache', { additions: 1, deletions: 0 }],
    ])
    expect(commits.items[0]!.author?.date).toEqual(new Date('2025-09-15T08:00:00Z'))
  })

  it('reads a plain diff as the files of a pull without commits', async () => {
    const diff = PATCH.slice(PATCH.indexOf('diff --git'), PATCH.indexOf('\n-- \n'))
    const { instance } = provider({ [BLOB]: { status: 200, encoding: 'base64', body: gzipSync(diff).toString('base64') } }, false)

    expect((await instance.threads.filesPage(pull)).items).toEqual([expect.objectContaining({ path: 'src/cache.ts', additions: 1, deletions: 1 })])
    expect((await instance.threads.commitsPage(pull)).items).toEqual([])
  })

  it('takes the commit an annotated tag points at, and a lightweight tag as is', async () => {
    const { instance } = provider({
      [`GET ${KNOT}/sh.tangled.repo.tags?repo=${REPO_DID}&limit=2`]: { status: 200, body: { tags: [
        { name: 'v2', hash: 'c'.repeat(40), tag: { Target: Array.from({ length: 20 }).fill(0xDD), Message: 'v2' }, message: 'v2' },
        { name: 'v1', hash: 'e'.repeat(40), message: 'v1' },
      ] } },
    }, false)
    const tags = await instance.contents.tagsPage(repo, { perPage: 2 })

    expect(tags.items.map(tag => [tag.name, tag.sha])).toEqual([['v2', 'd'.repeat(40)], ['v1', 'e'.repeat(40)]])
    expect(tags.cursor).toEqual({ token: '2' })
  })

  it('decodes a binary file and types tree entries by mode', async () => {
    const { instance } = provider({
      [`GET ${KNOT}/sh.tangled.repo.blob?repo=${REPO_DID}&ref=main&path=logo.png`]: { status: 200, body: { ref: 'main', path: 'logo.png', content: 'iVBORw==', encoding: 'base64', size: 4, isBinary: true } },
      [`GET ${KNOT}/sh.tangled.repo.tree?repo=${REPO_DID}&path=src`]: { status: 200, body: { files: [
        { name: 'lib', mode: '0040000', size: 0 },
        { name: 'index.ts', mode: '0100644', size: 12 },
        { name: 'link', mode: '0120000', size: 4 },
        { name: 'vendor', mode: '0160000', size: 0 },
      ] } },
    }, false)
    const file = await instance.contents.file(repo, 'logo.png', { ref: 'main' })
    const tree = await instance.contents.treePage(repo, { path: 'src/', recursive: true })

    expect(file).toMatchObject({ encoding: 'binary', content: new Uint8Array([0x89, 0x50, 0x4E, 0x47]), size: 4 })
    expect(tree.items.map(entry => [entry.path, entry.type, entry.mode])).toEqual([
      ['src/lib', 'directory', '040000'],
      ['src/index.ts', 'file', '100644'],
      ['src/link', 'symlink', '120000'],
      ['src/vendor', 'submodule', '160000'],
    ])
    expect(tree.warnings?.map(warning => warning.code)).toEqual(['recursive_unsupported'])
  })

  it('warns about commit filters the knot cannot apply', async () => {
    const { instance } = provider({
      [`GET ${KNOT}/sh.tangled.repo.log?repo=${REPO_DID}&ref=main&limit=1`]: { status: 200, body: { commits: [{ hash: SHA_A, this: SHA_A, message: 'One', parent_hashes: [Array.from({ length: 20 }).fill(0xBB)] }] } },
    }, false)
    const page = await instance.contents.commitsPage(repo, { ref: 'main', perPage: 1, path: 'src', since: new Date(0) })

    expect(page.items.map(commit => [commit.sha, commit.parents])).toEqual([[SHA_A, [SHA_B]]])
    expect(page.warnings?.map(warning => warning.code)).toEqual(['filter_unsupported'])
    expect(page.cursor).toEqual({ token: '1' })
  })
})

const GRACE = 'did:plc:gracecomment222222222222'
const STRANGER = 'did:plc:strangerdid2222222222222'
function definition(rkey: string, value: Record<string, unknown>) {
  return {
    [`GET ${PDS}/xrpc/com.atproto.repo.getRecord?repo=${OWNER}&collection=sh.tangled.label.definition&rkey=${rkey}`]: { status: 200, body: { uri: `at://${OWNER}/sh.tangled.label.definition/${rkey}`, value: { $type: 'sh.tangled.label.definition', createdAt: '2025-09-01T00:00:00Z', ...value } } },
  }
}
function labelOp(did: string, rkey: string, performedAt: string, add: Array<[string, string]>, remove: Array<[string, string]> = []) {
  return {
    [`GET ${PDS}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=sh.tangled.label.op&rkey=${rkey}`]: { status: 200, body: { uri: `at://${did}/sh.tangled.label.op/${rkey}`, value: {
      subject: PULL,
      add: add.map(([key, value]) => ({ key: `at://${OWNER}/sh.tangled.label.definition/${key}`, value })),
      delete: remove.map(([key, value]) => ({ key: `at://${OWNER}/sh.tangled.label.definition/${key}`, value })),
      performedAt,
    } } },
  }
}

describe('tangled labels, reactions and people', () => {
  it('folds label ops from accounts with push access into labels and assignees', async () => {
    const { instance } = provider({
      [`GET ${C}?target=${PULL}&collection=sh.tangled.label.op&path=.subject&limit=100`]: { status: 200, body: { linking_records: [
        { did: OWNER, collection: 'sh.tangled.label.op', rkey: '3mwqlabelb222' },
        { did: OWNER, collection: 'sh.tangled.label.op', rkey: '3mwqlabela222' },
        { did: STRANGER, collection: 'sh.tangled.label.op', rkey: '3mwqlabels222' },
      ], cursor: null } },
      ...labelOp(OWNER, '3mwqlabela222', '2025-09-16T09:00:00Z', [['bug', 'null'], ['priority', 'high'], ['assignee', ADA], ['assignee', GRACE], ['docs', 'null']]),
      ...labelOp(OWNER, '3mwqlabelb222', '2025-09-17T09:00:00Z', [['priority', 'low']], [['bug', 'null'], ['assignee', ADA]]),
      ...labelOp(STRANGER, '3mwqlabels222', '2025-09-18T09:00:00Z', [['spam', 'null']]),
      ...definition('bug', { name: 'bug', color: '#EF4444', valueType: { type: 'null', format: 'any' } }),
      ...definition('priority', { name: 'priority', color: '#F59E0B', valueType: { type: 'string', format: 'any', enum: ['high', 'low'] } }),
      ...definition('assignee', { name: 'assignee', multiple: true, valueType: { type: 'string', format: 'did' } }),
      ...definition('docs', { name: 'docs', scope: ['sh.tangled.repo.issue'], valueType: { type: 'null', format: 'any' } }),
    }, false)
    const thread = await instance.threads.get(pull)

    expect(thread.labels).toEqual([{ name: 'priority:low', colour: 'F59E0B' }])
    expect(thread.assignees.map(actor => actor.login)).toEqual(['grace.example.com'])
  })

  it('gives the owner admin, collaborators write and anyone else read', async () => {
    const { instance } = provider({}, false)
    const collaborators = await instance.repos.collaboratorsPage(repo)

    expect(collaborators.items.map(collaborator => [collaborator.actor.id, collaborator.role])).toEqual([[OWNER, 'admin'], [GRACE, 'write']])
    expect(await instance.repos.permissionFor(repo, OWNER)).toBe('admin')
    expect(await instance.repos.permissionFor(repo, collaborators.items[1]!.actor)).toBe('write')
    expect(await instance.repos.permissionFor(repo, STRANGER)).toBe('read')
  })

  it('reads a user profile, and an account without one', async () => {
    const { instance } = provider({
      [`GET ${PDS}/xrpc/com.atproto.repo.getRecord?repo=${ADA}&collection=sh.tangled.actor.profile&rkey=self`]: { status: 200, body: { uri: `at://${ADA}/sh.tangled.actor.profile/self`, value: { description: 'Writes widgets', location: 'London', links: ['', 'https://ada.example.com'], avatar: { $type: 'blob', ref: { $link: 'bafkreiavatar' }, mimeType: 'image/png', size: 10 } } } },
      [`GET ${PDS}/xrpc/com.atproto.repo.getRecord?repo=${GRACE}&collection=sh.tangled.actor.profile&rkey=self`]: { status: 400, body: { error: 'RecordNotFound' } },
    }, false)

    expect(await instance.users.get(ADA)).toMatchObject({ login: 'ada.example.com', bio: 'Writes widgets', location: 'London', websiteUrl: 'https://ada.example.com', avatarUrl: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${ADA}&cid=bafkreiavatar` })
    expect(await instance.users.get(GRACE)).toMatchObject({ login: 'grace.example.com', bio: undefined })
  })
})
