import type { ResolvedThreadRef } from '../../src/model.ts'
import { describe, expect, it } from 'vitest'
import { InsufficientScopeError, UnresolvedThreadError, UnsupportedOperationError } from '../../src/errors.ts'
import { repoKey, threadKey } from '../../src/model.ts'
import { parseAtUri } from '../../src/tangled/atproto.ts'
import { tangled } from '../../src/tangled/index.ts'
import { jetstreamUrl } from '../../src/tangled/subscribe.ts'
import { fixtureFetch } from '../utils/fixtures.ts'
import { FakeWebSocket } from '../utils/websocket.ts'

const OWNER = 'did:plc:acmeowner222222222222222'
const ADA = 'did:plc:adaauthor222222222222222'
const REPO_DID = 'did:plc:widgetsrepo2222222222222'
const PDS = 'https://pds.example.com'
const TICKET_URI = `at://${REPO_DID}/org.tangled.track.ticket/7`
const repo = {
  forge: 'tangled',
  instance: 'tangled.org',
  owner: OWNER,
  name: 'widgets',
} as const
const pull: ResolvedThreadRef = {
  forge: 'tangled',
  instance: 'tangled.org',
  repo,
  kind: 'pull_request',
  number: '7',
  externalId: TICKET_URI,
}

function provider(overrides = {}, auth = true) {
  const { fetch, calls } = fixtureFetch('tangled', overrides)
  return {
    instance: tangled({
      auth: auth
        ? {
            type: 'app_password',
            identifier: 'acme.example.com',
            password: 'pw',
            pds: PDS,
          }
        : undefined,
      fetch,
    }),
    calls,
  }
}

const session = {
  'POST https://pds.example.com/xrpc/com.atproto.server.createSession': {
    status: 200,
    body: {
      did: OWNER,
      accessJwt: 'access',
      refreshJwt: 'refresh',
      handle: 'acme.example.com',
    },
  },
}

describe('tangled identity', () => {
  it('keys threads by number under the owner DID and repo name', () => {
    expect(threadKey(pull)).toBe(`tangled:tangled.org/${OWNER}/widgets#pull_request/7`)
    expect(repoKey(repo)).toBe(`tangled:tangled.org/${OWNER}/widgets`)
  })

  it('parses AT-URIs and rejects anything else', () => {
    expect(parseAtUri(TICKET_URI)).toEqual({ did: REPO_DID, collection: 'org.tangled.track.ticket', rkey: '7' })
    expect(parseAtUri('https://tangled.org/x')).toBeUndefined()
  })

  it('refuses a ref without a number', async () => {
    const { instance } = provider()
    await expect(instance.threads.get({ ...pull, number: undefined })).rejects.toThrow(UnresolvedThreadError)
  })
})

describe('tangled reads', () => {
  it('reads a thread by its number', async () => {
    const { instance } = provider()
    const thread = await instance.threads.get(pull)

    expect(thread).toMatchObject({
      ref: {
        repo: { ...repo, externalId: REPO_DID, ownerHandle: 'acme.example.com' },
        kind: 'pull_request',
        number: '7',
      },
      title: 'Cache compiled templates',
      state: 'open',
      assignees: [
        expect.objectContaining({ id: OWNER }),
      ],
      branches: {
        head: { ref: 'template-cache', sha: '2222222222222222222222222222222222222222' },
        base: { ref: 'main' },
      },
      commentCount: 2,
      labels: [
        expect.objectContaining({ name: 'bug', colour: 'ff0000' }),
      ],
    })
    expect(thread.url).toBe('https://tangled.org/acme.example.com/widgets/pulls/7')
    expect(thread.raw).toBeTypeOf('object')
  })

  it('reads a repository whose owner is a handle', async () => {
    const { instance } = provider({
      'GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=acme.example.com': {
        status: 200,
        body: { did: OWNER },
      },
    })
    const found = await instance.repos.get({ ...repo, owner: 'acme.example.com' })

    expect(found.ref).toMatchObject({
      owner: OWNER,
      name: 'widgets',
      externalId: REPO_DID,
      ownerHandle: 'acme.example.com',
    })
    expect(found.defaultBranch).toBe('main')
    expect(found.cloneUrls).toEqual({
      https: 'https://tangled.org/acme.example.com/widgets',
      ssh: 'ssh://git@tangled.org/acme.example.com/widgets',
    })
  })

  it('lists open pull requests', async () => {
    const { instance } = provider()
    const threads = await Array.fromAsync(instance.threads.list(repo, { kind: 'pull_request' }))

    expect(threads.map(thread => thread.ref.number)).toEqual(['7'])
    expect(threads[0]!.state).toBe('open')
  })

  it('lists comments with the account that wrote them', async () => {
    const { instance } = provider()
    const comments = await Array.fromAsync(instance.threads.comments(pull))

    expect(comments.map(comment => comment.body)).toEqual(['First comment.', 'Second comment.'])
    expect(comments.map(comment => comment.author?.login)).toEqual(['ada.example.com', 'grace.example.com'])
    expect(comments[0]!.url).toBe(`${'https://tangled.org/acme.example.com/widgets/pulls/7'}#comment-3m0000000001`)
  })

  it('lists reactions with the account that made them', async () => {
    const { instance } = provider()
    const reactions = await Array.fromAsync(instance.threads.reactions(pull))

    expect(reactions).toHaveLength(1)
    expect(reactions[0]).toMatchObject({
      content: '+1',
      actor: { id: ADA },
    })
  })

  it('lists events from records on the thread', async () => {
    const { instance } = provider()
    const events = await Array.fromAsync(instance.threads.events(pull))

    expect(events.map(event => [event.kind, event.action])).toEqual([
      ['comment', 'created'],
      ['comment', 'created'],
      ['reaction', 'created'],
    ])
    expect(events.every(event => event.thread?.number === '7')).toBe(true)
  })

  it('searches threads and repositories', async () => {
    const { instance } = provider()
    const threads = await instance.search.threads({ text: 'cache', perPage: 50 }).page()
    expect(threads.items.map(thread => thread.ref.number)).toEqual(['7'])

    const repos = await instance.search.repos({ text: 'widgets', perPage: 50 }).page()
    expect(repos.items.map(found => found.ref.name)).toEqual(['widgets'])
  })

  it('reads a file and a tree from the mirror', async () => {
    const { instance } = provider()
    const file = await instance.contents.getFile(repo, 'README.md', { ref: 'main' })
    const content = typeof file.content === 'string'
      ? file.content
      : new TextDecoder().decode(file.content)
    expect(content).toContain('automated fixture target')

    const tree = await instance.contents.tree(repo, { ref: 'main' }).page()
    expect(tree.items.map(entry => [entry.path, entry.type])).toEqual([
      ['README.md', 'file'],
      ['src', 'directory'],
    ])
  })

  it('lists branches and commits', async () => {
    const { instance } = provider()
    const branches = await instance.contents.branches(repo, { perPage: 50 }).page()
    expect(branches.items.map(branch => [branch.name, branch.isDefault])).toEqual([
      ['main', true],
      ['template-cache', false],
    ])

    const commits = await instance.commits.list(repo, { perPage: 30 }).page()
    expect(commits.items.map(commit => commit.sha)).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
  })

  it('pages branches with the mirror\'s numeric cursor', async () => {
    const listing = `GET https://api.tangled.org/xrpc/org.tangled.temp.git.listBranches?repo=${encodeURIComponent(REPO_DID)}&limit=1`
    const { instance } = provider({
      [listing]: {
        status: 200,
        body: {
          branches: [
            {
              name: 'main',
              oid: 'a'.repeat(40),
            },
          ],
          cursor: '1',
          defaultBranch: 'main',
          total: 2,
        },
      },
      [`${listing}&cursor=1`]: {
        status: 200,
        body: {
          branches: [
            {
              name: 'template-cache',
              oid: '2'.repeat(40),
            },
          ],
          defaultBranch: 'main',
          total: 2,
        },
      },
    })
    const branches = await Array.fromAsync(instance.contents.branches(repo, { perPage: 1 }))

    expect(branches.map(branch => branch.name)).toEqual(['main', 'template-cache'])
  })
})

describe('tangled writes', () => {
  it('comments on a thread', async () => {
    const { instance, calls } = provider(session)
    const comment = await instance.threads.createComment(pull, 'Thanks!')

    expect(comment.body).toBe('Thanks!')
    expect(comment.ref.thread.number).toBe('7')
    const write = calls.filter(call => call.method === 'POST' && call.url.includes('knot1.tangled.sh')).at(-1)!
    expect(write.url).toBe('https://knot1.tangled.sh/xrpc/com.atproto.repo.createRecord')
    expect(write.body).toContain('Thanks!')
  })

  it('closes and reopens a thread, writing the state to its record', async () => {
    const { instance, calls } = provider(session)
    await instance.threads.close(pull)
    await instance.threads.reopen(pull)

    const puts = calls.filter(call => call.url.endsWith('/com.atproto.repo.putRecord'))
    expect(puts.map(put => JSON.parse(put.body!).record.state)).toEqual(['closed', 'open'])
    for (const put of puts) {
      expect(put.url).toBe('https://knot1.tangled.sh/xrpc/com.atproto.repo.putRecord')
    }
  })

  it('closes an issue as completed', async () => {
    const issue = { ...pull, kind: 'issue' as const }
    const ticket = `GET https://knot1.tangled.sh/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(REPO_DID)}&collection=org.tangled.track.ticket&rkey=7`
    const { instance, calls } = provider({
      ...session,
      [ticket]: {
        status: 200,
        body: {
          uri: TICKET_URI,
          cid: 'bafyreiticket00000000000000000000000000000000000000000000000001',
          value: {
            'title': { text: 'An issue' },
            'state': 'open',
            'createdAt': '2026-09-01T10:00:00Z',
            'x-tngl-editor': ADA,
          },
        },
      },
    })
    const closed = await instance.threads.close(issue, { reason: 'completed' })

    expect(closed).toMatchObject({ state: 'closed', stateReason: 'completed', stateRaw: 'completed' })
    const put = calls.find(call => call.url.endsWith('/com.atproto.repo.putRecord'))!
    expect(JSON.parse(put.body!).record.state).toBe('completed')
  })

  it('closes a pull request without a reason, as completed would mean merged', async () => {
    const { instance, calls } = provider(session)
    await instance.threads.close(pull, { reason: 'completed' })

    const put = calls.find(call => call.url.endsWith('/com.atproto.repo.putRecord'))!
    expect(JSON.parse(put.body!).record.state).toBe('closed')
  })

  it('skips a put that changes nothing', async () => {
    const { instance, calls } = provider(session)
    await instance.threads.setLabels(pull, ['bug'])

    expect(calls.some(call => call.url.endsWith('/com.atproto.repo.putRecord'))).toBe(false)
  })

  it('refuses to change a thread the account may not edit', async () => {
    const { instance } = provider({
      ...session,
      'POST https://pds.example.com/xrpc/com.atproto.server.createSession': {
        status: 200,
        body: {
          did: 'did:plc:stranger000000000000000',
          accessJwt: 'access',
          refreshJwt: 'refresh',
          handle: 'stranger.example.com',
        },
      },
    })
    await expect(instance.threads.close(pull)).rejects.toThrow(InsufficientScopeError)
  })

  it('lets the author change a thread that a collaborator edited last', async () => {
    const ticket = `GET https://knot1.tangled.sh/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(REPO_DID)}&collection=org.tangled.track.ticket&rkey=7`
    const { instance, calls } = provider({
      ...session,
      'POST https://pds.example.com/xrpc/com.atproto.server.createSession': {
        status: 200,
        body: {
          did: ADA,
          accessJwt: 'access',
          refreshJwt: 'refresh',
          handle: 'ada.example.com',
        },
      },
      [ticket]: {
        status: 200,
        body: {
          uri: TICKET_URI,
          cid: 'bafyreiticket00000000000000000000000000000000000000000000000001',
          value: {
            'title': { text: 'Cache compiled templates' },
            'state': 'open',
            'targetBranch': 'main',
            'createdAt': '2026-09-01T10:00:00Z',
            'x-tngl-editor': 'did:plc:gracecollab2222222222222',
          },
        },
      },
    })
    await instance.threads.close(pull)

    const put = calls.find(call => call.url.endsWith('/com.atproto.repo.putRecord'))!
    expect(JSON.parse(put.body!).record.state).toBe('closed')
  })

  it('changes labels on a thread', async () => {
    const definition = (key: string) => ({
      uri: `at://${REPO_DID}/org.tangled.label.definition/${key}`,
      cid: 'bafy',
      value: { $type: 'org.tangled.label.definition', name: key, createdAt: '2026-01-01T00:00:00Z' },
    })
    const { instance, calls } = provider({
      ...session,
      'GET https://api.tangled.org/xrpc/org.tangled.label.listDefinitions?subject=did%3Aplc%3Awidgetsrepo2222222222222&order=asc&limit=100': {
        status: 200,
        body: {
          items: [
            definition('bug'),
            definition('docs'),
          ],
        },
      },
    })
    await instance.threads.setLabels(pull, ['docs'])
    await instance.threads.addLabels(pull, ['docs'])
    await instance.threads.removeLabels(pull, ['bug'])

    const puts = calls.filter(call => call.url.endsWith('/com.atproto.repo.putRecord'))
    expect(puts.map(put => JSON.parse(put.body!).record.tangledLabels)).toEqual([
      [
        { key: 'docs' },
      ],
      [
        { key: 'bug' },
        { key: 'docs' },
      ],
      [],
    ])
  })

  it('subscribes with a record in the account\'s own repository', async () => {
    const { instance, calls } = provider(session)
    expect(await instance.threads.subscription(pull)).toBe('none')
    await instance.threads.subscribe(pull)
    const create = calls.find(call => call.url === `${PDS}/xrpc/com.atproto.repo.createRecord`)!
    expect(JSON.parse(create.body!).record.subject).toMatchObject({ uri: TICKET_URI })
  })

  it('reads and deletes an existing subscription', async () => {
    const { instance, calls } = provider({
      ...session,
      [`POST ${PDS}/xrpc/com.atproto.repo.deleteRecord`]: { status: 200, body: {} },
      [`GET ${PDS}/xrpc/com.atproto.repo.listRecords?repo=${OWNER}&collection=org.tangled.feed.subscription&limit=100`]: {
        status: 200,
        body: {
          records: [
            {
              uri: `at://${OWNER}/org.tangled.feed.subscription/3m0000000099`,
              cid: 'bafy',
              value: {
                subject: { uri: TICKET_URI },
                createdAt: '2026-01-01T00:00:00Z',
              },
            },
          ],
        },
      },
    })
    expect(await instance.threads.subscription(pull)).toBe('subscribed')
    calls.length = 0
    await instance.threads.unsubscribe(pull)

    const deleted = calls.find(call => call.url === `${PDS}/xrpc/com.atproto.repo.deleteRecord`)!
    expect(JSON.parse(deleted.body!)).toMatchObject({ repo: OWNER, collection: 'org.tangled.feed.subscription', rkey: '3m0000000099' })
  })

  it('reacts by writing to the account\'s own repository', async () => {
    const { instance, calls } = provider(session)
    await instance.threads.react(pull, 'heart')

    const create = calls.find(call => call.url === `${PDS}/xrpc/com.atproto.repo.createRecord`)!
    expect(JSON.parse(create.body!).record).toMatchObject({
      reaction: '❤️',
      subject: { uri: TICKET_URI },
    })
  })

  it('opens an issue', async () => {
    const { instance, calls } = provider(session)
    const created = await instance.threads.create(repo, {
      kind: 'issue',
      title: 'New issue',
      body: 'Body.',
      labels: ['bug'],
    })

    expect(created.ref.number).toBe('8')
    const ticket = calls.find(call => call.url.endsWith('/com.atproto.repo.createRecord') && call.url.includes('knot1.tangled.sh'))!
    expect(JSON.parse(ticket.body!).record).toMatchObject({
      title: { text: 'New issue' },
      state: 'open',
      tangledLabels: [
        { key: 'bug' },
      ],
    })
  })

  it('opens a pull request by submitting its round', async () => {
    const { instance, calls } = provider(session)
    const created = await instance.threads.create(repo, {
      kind: 'pull_request',
      title: 'New pull',
      body: 'Body.',
      base: 'main',
      head: 'template-cache',
    })

    expect(created.branches?.head.sha).toBe('2222222222222222222222222222222222222222')
    const submit = calls.find(call => call.url.endsWith('/org.tangled.review.submitPatch'))!
    expect(JSON.parse(submit.body!).patch).toMatchObject({
      ticket: '8',
      base: { oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      head: { oid: '2222222222222222222222222222222222222222' },
      sourceBranch: 'template-cache',
    })
  })

  it('refuses fork pulls and drafts', async () => {
    const { instance } = provider(session)
    await expect(instance.threads.create(repo, {
      kind: 'pull_request',
      title: 'x',
      base: 'main',
      head: 'owner:branch',
    })).rejects.toThrow(UnsupportedOperationError)
    await expect(instance.threads.create(repo, {
      kind: 'pull_request',
      title: 'x',
      base: 'main',
      head: 'main',
      draft: true,
    })).rejects.toThrow(UnsupportedOperationError)
  })

  it('merges a pull request through the mirror', async () => {
    const { instance, calls } = provider(session)
    const result = await instance.threads.merge(pull, { method: 'rebase' })

    expect(result.status).toBe('merged')
    const merge = calls.find(call => call.url.endsWith('/sh.tangled.git.mergeCommit'))!
    expect(JSON.parse(merge.body!)).toMatchObject({
      target: { branch: 'main' },
      source: { commit: '2222222222222222222222222222222222222222' },
      style: 'rebase',
    })
    const puts = calls.filter(call => call.url.endsWith('/com.atproto.repo.putRecord'))
    expect(JSON.parse(puts.at(-1)!.body!).record.state).toBe('completed')
  })
})

describe('tangled webhooks', () => {
  it('lists no webhooks for a repository without a spindle', async () => {
    const { instance, calls } = provider(session)
    const hooks = await instance.webhooks.list({ ...repo, externalId: REPO_DID }).page()

    expect(hooks.items).toEqual([])
    expect(calls.some(call => call.url.includes('webhook'))).toBe(false)
  })

  it('authenticates to a spindle on a port with its DID', async () => {
    const { instance } = provider({
      ...session,
      [`GET https://api.tangled.org/xrpc/org.tangled.repo.getRepoByRepoDid?repoDid=${encodeURIComponent(REPO_DID)}`]: {
        status: 200,
        body: {
          uri: `at://${REPO_DID}/org.tangled.repo.manifest/self`,
          knot: 'knot1.tangled.sh',
          value: {
            declaration: { owner: OWNER, name: 'widgets' },
            spindle: 'did:web:spindle.example.com%3A8443',
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      },
      [`GET ${PDS}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent('did:web:spindle.example.com%3A8443')}&lxm=org.tangled.webhook.listWebhooks`]: {
        status: 200,
        body: { token: 'token-spindle' },
      },
      [`GET https://spindle.example.com:8443/xrpc/org.tangled.webhook.listWebhooks?repo=${encodeURIComponent(REPO_DID)}`]: {
        status: 200,
        body: {
          webhooks: [
            {
              id: '3',
              url: 'https://example.com/hook',
              active: true,
              events: ['push'],
            },
          ],
        },
      },
    })
    const hooks = await instance.webhooks.list({ ...repo, externalId: REPO_DID }).page()

    expect(hooks.items.map(hook => [hook.ref.id, hook.events])).toEqual([
      [
        '3',
        ['push'],
      ],
    ])
  })

  it('verifies a signed delivery with the provider secret', async () => {
    const body = (await import('../utils/fixtures.ts')).payloadFixture('tangled', 'webhooks/pull-request-created')
    const secret = 'webhook-secret'
    const forged = await (await import('../../src/crypto.ts')).hmacSha256Hex('not-the-secret', body)
    const headers = {
      'x-tangled-event': 'pull_request:created',
      'x-tangled-delivery': 'e1f2a3b4-0000-4000-8000-000000000004',
      'x-tangled-hook-id': '17',
      'x-tangled-signature-256': `sha256=${forged}`,
    }
    const unsigned = tangled({
      auth: {
        type: 'app_password',
        identifier: 'acme.example.com',
        password: 'pw',
        pds: PDS,
      },
      webhookSecret: secret,
      fetch: fixtureFetch('tangled').fetch,
    })
    expect(await unsigned.webhooks.verify({ headers, body })).toBe(false)
    const signed = await (await import('../../src/crypto.ts')).hmacSha256Hex(secret, body)
    expect(await unsigned.webhooks.verify({
      headers: { ...headers, 'x-tangled-signature-256': `sha256=${signed}` },
      body,
    })).toBe(true)
  })

  it('translates a pull request webhook without tying it to a record', async () => {
    const body = (await import('../utils/fixtures.ts')).payloadFixture('tangled', 'webhooks/pull-request-created')
    const secret = 'webhook-secret'
    const signed = await (await import('../../src/crypto.ts')).hmacSha256Hex(secret, body)
    const delivery = {
      headers: {
        'x-tangled-event': 'pull_request:created',
        'x-tangled-delivery': 'e1f2a3b4-0000-4000-8000-000000000004',
        'x-tangled-hook-id': '17',
        'x-tangled-signature-256': `sha256=${signed}`,
      },
      body,
    }
    const instance = tangled({
      auth: {
        type: 'app_password',
        identifier: 'acme.example.com',
        password: 'pw',
        pds: PDS,
      },
      webhookSecret: secret,
      fetch: fixtureFetch('tangled').fetch,
    })
    const event = (await instance.webhooks.ingest(delivery))[0]!

    expect(event).toMatchObject({
      kind: 'state_change',
      action: 'opened',
      actor: { id: ADA },
      repo: { name: 'widgets' },
      threadSnapshot: { title: 'Cache compiled templates' },
    })
    expect(event.thread).toBeUndefined()
  })
})

describe('tangled stream', () => {
  it('builds a jetstream URL from collections and a cursor', () => {
    const url = jetstreamUrl('wss://jetstream.example/subscribe', ['org.tangled.track.ticket'], '1')
    expect(url).toBe('wss://jetstream.example/subscribe?wantedCollections=org.tangled.track.ticket&cursor=1')
  })

  it('streams commit records as events', async () => {
    const { messages } = JSON.parse((await import('node:fs')).readFileSync('test/fixtures/tangled/jetstream/thread-activity.json', 'utf8')) as { messages: unknown[] }
    const instance = tangled({
      auth: {
        type: 'app_password',
        identifier: 'acme.example.com',
        password: 'pw',
        pds: PDS,
      },
      fetch: fixtureFetch('tangled').fetch,
      webSocket: url => new FakeWebSocket(url, messages),
    })
    const events = []
    for await (const { event } of instance.sources.stream({
      signal: AbortSignal.timeout(2000),
    })) {
      events.push(event)
      if (events.length === 3) {
        break
      }
    }
    expect(events.map(event => [event!.kind, event!.thread?.number])).toEqual([
      ['state_change', '7'],
      ['reaction', '7'],
      ['comment', '7'],
    ])
  })
})
