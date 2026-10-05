import type { Notification, ResolvedThreadRef } from '../../src/model.ts'
import type { ForgeProvider, ForgeVerb } from '../../src/provider.ts'
import { describe, expect, it } from 'vitest'
import {
  ForgeTimeoutError,
  InsufficientScopeError,
  MergeBlockedError,
  MergeConflictError,
  MergeMethodRequiredError,
  RateLimitedError,
  SubscriptionClosedError,
  TokenRevokedError,
  UnsupportedOperationError,
  WebhookVerificationError,
} from '../../src/errors.ts'
import { isResolvedThread, notificationThread, repoKey, threadKey } from '../../src/model.ts'
import { fixtureFetch, stubFetch } from '../utils/fixtures.ts'
import { FakeWebSocket } from '../utils/websocket.ts'
import { contracts, WEBHOOK_SECRET } from './providers.ts'

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) {
    items.push(item)
  }
  return items
}

describe.each(contracts)('contract: $name', (contract) => {
  function provider() {
    const { fetch, calls } = fixtureFetch(contract.fixtures)
    return { instance: contract.create(fetch), calls }
  }

  const capabilities = contract.create(stubFetch(500)).capabilities
  const notifications = contract.notifications
  const merge = contract.merge
  const probe = (instance: ForgeProvider) => contract.probe?.(instance) ?? instance.notifications!.listPage()

  function threadRef(): ResolvedThreadRef {
    return {
      forge: contract.name,
      instance: contract.instance,
      repo: { forge: contract.name, instance: contract.instance, ...contract.repo },
      kind: 'pull_request',
      number: contract.thread.number,
    }
  }

  describe.runIf(notifications)('notifications', () => {
    it('lists notifications across every page', async () => {
      const { instance } = provider()
      const items = await collect(instance.notifications!.list())

      expect(items).toHaveLength(notifications!.count)
      const first = items[0] as Notification
      expect(first.ref.id).toBe(notifications!.first.id)
      expect(first.ref.forge).toBe(contract.name)
      expect(first.ref.instance).toBe(contract.instance)
      expect(first.reason).toBe(notifications!.first.reason)
      expect(first.reasonRaw).toBe(notifications!.first.reasonRaw)
      expect(first.unread).toBe(true)
      expect(first.subjectState).toBe(notifications!.first.subjectState)
      expect(first.updatedAt).toBeInstanceOf(Date)
      expect(notificationThread(first)!.number).toBe(contract.thread.number)
      expect(notificationThread(first)!.repo).toMatchObject(contract.repo)
      expect(notificationThread(first)!.repo.externalId).toBeTruthy()
      const thread = notificationThread(first)!
      expect(isResolvedThread(thread) && threadKey(thread)).toBe(`${repoKey(notificationThread(first)!.repo)}#pull_request/${contract.thread.number}`)
      expect(repoKey(notificationThread(first)!.repo)).toBe(`${contract.name}:${contract.instance}/@${notificationThread(first)!.repo.externalId}`)
    })

    it('keeps notification ids distinct from thread numbers', async () => {
      const { instance } = provider()
      for (const notification of await collect(instance.notifications!.list())) {
        expect(notification.ref.id).not.toBe(notificationThread(notification)!.number)
      }
    })

    it('exposes a resumable cursor from the first page', async () => {
      const { instance } = provider()
      const page = await instance.notifications!.listPage()

      expect(page.cursor?.nextUrl).toContain('page=2')
      const next = await instance.notifications!.listPage({ cursor: page.cursor })
      expect(next.items.length).toBeGreaterThan(0)
      expect(next.cursor?.nextUrl).toBeUndefined()
    })

    it('marks a notification read, or omits markRead when the forge has no read state', async () => {
      const { instance, calls } = provider()
      expect(instance.can('notifications.markRead')).toBe(Boolean(notifications!.markRead))
      if (!notifications!.markRead) {
        return
      }
      await instance.notifications!.markRead!({ forge: contract.name, instance: contract.instance, id: notifications!.first.id })

      expect(calls).toMatchObject([notifications!.markRead])
    })

    it('marks a notification done through the documented path, or omits markDone', async () => {
      const { instance, calls } = provider()
      expect(instance.can('notifications.markDone')).toBe(Boolean(notifications!.markDone))
      if (!notifications!.markDone) {
        return
      }
      await instance.notifications!.markDone!({ forge: contract.name, instance: contract.instance, id: notifications!.first.id })

      expect(calls[0]).toMatchObject(notifications!.markDone)
    })

    it('unsubscribes from a notification, or omits unsubscribe', async () => {
      const { instance, calls } = provider()
      expect(instance.can('notifications.unsubscribe')).toBe(Boolean(notifications!.unsubscribe))
      if (!notifications!.unsubscribe) {
        return
      }
      await instance.notifications!.unsubscribe!(
        { forge: contract.name, instance: contract.instance, id: notifications!.first.id },
        { thread: threadRef() },
      )

      expect(calls.at(-1)).toMatchObject(notifications!.unsubscribe)
    })
  })

  it('gets a thread', async () => {
    const { instance } = provider()
    const thread = await instance.threads.get(threadRef())

    expect(thread.kind).toBe('pull_request')
    expect(thread.ref.number).toBe(contract.thread.number)
    expect(thread.ref.repo).toMatchObject(contract.repo)
    expect(thread.title).toBe(contract.thread.title)
    expect(thread.state).toBe('open')
    expect(thread.createdAt).toBeInstanceOf(Date)
    if (contract.thread.label) {
      expect(thread.labels.map(label => label.name)).toContain(contract.thread.label)
    }
    expect(thread.raw).toBeTypeOf('object')
  })

  it('gets the repository with its stable id and visibility', async () => {
    const { instance } = provider()
    const repo = await instance.repos.get(threadRef().repo)

    expect(repo.ref).toMatchObject(contract.repo)
    expect(repo.ref.externalId).toBeTruthy()
    expect(['public', 'private', 'internal']).toContain(repo.visibility)
    expect(repo.topics).toBeInstanceOf(Array)
    expect(typeof repo.isFork).toBe('boolean')
    expect(repo.cloneUrls?.https ?? repo.url).toBeTruthy()
  })

  it('lists open pull requests in the repository', async () => {
    const { instance } = provider()
    const iterable = instance.threads.list(threadRef().repo, { kind: 'pull_request' })
    const threads = await collect(iterable)

    expect(threads.length).toBeGreaterThan(0)
    expect(threads.every(thread => thread.kind === 'pull_request' && thread.state === 'open')).toBe(true)
    expect(threads.map(thread => thread.ref.number)).toContain(contract.thread.number)
    expect(iterable.warnings).toEqual([])
  })

  it('reads several threads at once, reporting failures as warnings', async () => {
    const { instance } = provider()
    const results = await instance.threads.getMany([threadRef(), { ...threadRef(), number: undefined }])

    expect(results).toHaveLength(2)
    expect(results[0]!.ok && results[0]!.thread.title).toBe(contract.thread.title)
    expect(results[1]!.ok === false && results[1]!.warning.code).toBe('thread_unresolved')
  })

  it('gives threads assignees, reviewers, draft status and pull branches', async () => {
    const { instance } = provider()
    const thread = await instance.threads.get(threadRef())

    expect(thread.isDraft).toBe(false)
    expect(thread.assignees).toBeInstanceOf(Array)
    expect(thread.reviewers).toBeInstanceOf(Array)
    expect(thread.branches?.base.ref).toBeTruthy()
    expect(thread.lastActivityAt).toBeInstanceOf(Date)
  })

  it('lists conversation comments with identity', async () => {
    const { instance } = provider()
    const comments = await collect(instance.threads.comments(threadRef()))

    expect(comments.length).toBeGreaterThan(0)
    for (const comment of comments) {
      expect(comment.ref.id).toBeTruthy()
      expect(comment.ref.thread.number).toBe(contract.thread.number)
      expect(comment.body.length).toBeGreaterThan(0)
    }
  })

  it('lists thread events with normalised kinds', async () => {
    const { instance } = provider()
    const events = await collect(instance.threads.events(threadRef()))

    expect(events.map(event => event.kind)).toEqual(contract.thread.eventKinds)
    for (const event of events) {
      expect(event.occurredAt).toBeInstanceOf(Date)
      expect(event.source).toBe('poll')
      expect(event.summary.length).toBeGreaterThan(0)
      expect(event.thread?.number).toBe(contract.thread.number)
    }
    expect(events.some(event => event.actor?.isBotHint)).toBe(contract.thread.botActor)
  })

  it('comments on a pull request', async () => {
    const { instance, calls } = provider()
    const comment = await instance.threads.comment!(threadRef(), 'Thanks!')
    const write = calls.filter(call => call.method !== 'GET' && !contract.writes.ignore?.test(call.url)).at(-1)!

    expect(write).toMatchObject(contract.writes.comment)
    expect(write.body).toContain('Thanks!')
    expect(comment.body).toBe('Thanks!')
    expect(comment.ref.thread.number).toBe(contract.thread.number)
    expect(comment.ref.id).toBeTruthy()
  })

  it('closes and reopens a pull request where the forge allows it', async () => {
    const { instance, calls } = provider()
    const reopen = contract.writes.reopen
    expect(Boolean(capabilities.writes.reopen.pull_request)).toBe(Boolean(reopen))
    await instance.threads.close!(threadRef())
    if (reopen) {
      await instance.threads.reopen!(threadRef())
    }

    const writes = calls.filter(call => call.method !== 'GET' && !contract.writes.ignore?.test(call.url))
    expect(writes.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: contract.writes.close.method, url: contract.writes.close.url },
      ...reopen ? [{ method: reopen.method, url: reopen.url }] : [],
    ])
    expect(writes[0]!.body ?? '').toContain(contract.writes.close.bodyContains)
    if (reopen) {
      expect(writes[1]!.body).toContain(reopen.bodyContains)
    }
  })

  describe.runIf(merge)('approve and merge', () => {
    it('refuses to guess when the repository allows several merge methods', async () => {
      const { fetch, calls } = fixtureFetch(contract.fixtures, {
        [`GET ${merge!.reads.at(-1)!.url}`]: { status: 200, body: merge!.multiMethodRepo },
      })
      const instance = contract.create(fetch)

      const error = await instance.threads.approveAndMerge!(threadRef()).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(MergeMethodRequiredError)
      expect((error as MergeMethodRequiredError).allowed.length).toBeGreaterThan(1)
      expect(calls.map(call => call.method)).toEqual(merge!.reads.map(() => 'GET'))
    })

    it('approves then merges with the only allowed method', async () => {
      const { instance, calls } = provider()
      await instance.threads.approveAndMerge!(threadRef())

      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        ...merge!.reads,
        { method: merge!.review.method, url: merge!.review.url },
        { method: merge!.merge.method, url: merge!.merge.url },
        ...merge!.settle ?? [],
      ])
      expect(calls[merge!.reads.length + 1]!.body ?? '').toContain(merge!.merge.body)
    })

    it('merges with an explicit method without reading the repository', async () => {
      const { instance, calls } = provider()
      await instance.threads.merge!(threadRef(), { method: merge!.explicit.method })

      expect(calls).toHaveLength(1 + (merge!.settle?.length ?? 0))
      expect(calls[0]!.url).toBe(merge!.merge.url)
      expect(calls[0]!.body).toContain(merge!.explicit.bodyContains)
    })

    it.each([
      [405, MergeBlockedError],
      [406, MergeConflictError],
      [409, MergeConflictError],
      [403, InsufficientScopeError],
    ])('maps a %i from the merge endpoint to a typed error', async (status, ErrorType) => {
      const { fetch } = fixtureFetch(contract.fixtures, {
        [`${merge!.merge.method} ${merge!.merge.url}`]: { status, body: { message: 'nope' } },
      })
      const instance = contract.create(fetch)

      await expect(instance.threads.merge!(threadRef(), { method: 'merge' })).rejects.toThrow(ErrorType)
    })
  })

  it('ingests a signed webhook', async () => {
    const { instance } = provider()
    const signature = await contract.webhook.sign(contract.webhook.body, WEBHOOK_SECRET)
    const delivery = { headers: contract.webhook.headers(signature), body: contract.webhook.body }

    expect(await instance.webhooks.verify(delivery)).toBe(true)
    const events = await instance.webhooks.ingest(delivery)

    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe(contract.webhook.expect.kind)
    expect(events[0]!.action).toBe(contract.webhook.expect.action)
    expect(events[0]!.thread?.kind).toBe(contract.webhook.expect.threadKind)
    expect(events[0]!.source).toBe('webhook')
    expect(events[0]!.actor?.login).toBe(contract.webhook.expect.actor)
    expect(events[0]!.thread?.number).toBe(contract.webhook.expect.threadNumber)
    expect(events[0]!.thread?.displayNumber).toBe(contract.webhook.expect.displayNumber)
    expect(events[0]!.thread?.repo.name).toBe('widgets')
    expect(events[0]!.occurredAt).toBeInstanceOf(Date)
  })

  it('rejects a webhook with a bad signature', async () => {
    const { instance } = provider()
    const delivery = {
      headers: contract.webhook.headers(await contract.webhook.sign(contract.webhook.body, 'not-the-secret')),
      body: contract.webhook.body,
    }

    expect(await instance.webhooks.verify(delivery)).toBe(false)
    await expect(instance.webhooks.ingest(delivery)).rejects.toThrow(WebhookVerificationError)
  })

  describe.runIf(contract.checks)('checks', () => {
    it('summarises the checks on a pull request read', async () => {
      const { instance } = provider()
      const thread = await instance.threads.get(threadRef())

      expect(thread.checks).toMatchObject(contract.checks!.summary)
      expect(thread.warnings?.filter(warning => warning.code === 'checks_unreadable') ?? []).toEqual([])
    })

    it('lists each check with an addressable ref', async () => {
      const { instance } = provider()
      const { items: checks } = await instance.threads.checks(threadRef())

      expect(checks.map(check => check.name)).toEqual(contract.checks!.names)
      expect(checks.every(check => check.ref.repo.name === contract.repo.name && check.ref.id && check.stateRaw)).toBe(true)
    })
  })

  describe.runIf(contract.reviews)('reviews', () => {
    it('lists reviews on a pull request', async () => {
      const { instance } = provider()
      const { items } = await instance.threads.reviewsPage(threadRef())

      expect(items.map(review => review.state)).toEqual(contract.reviews!.states)
      expect(items.every(review => review.ref.id && review.ref.thread.number === contract.thread.number)).toBe(true)
      expect(items.some(review => review.comments !== false)).toBe(contract.reviews!.comments)
    })
  })

  describe.runIf(contract.releases)('releases', () => {
    const repoRef = () => ({ forge: contract.name, instance: contract.instance, ...contract.repo })

    it('lists, gets and reads the latest release', async () => {
      const { instance } = provider()
      const page = await instance.releases!.listPage(repoRef())
      const release = await instance.releases!.get({ forge: contract.name, instance: contract.instance, repo: repoRef(), id: contract.releases!.get.id })
      const latest = await instance.releases!.latest(repoRef())

      expect(page.items).toHaveLength(contract.releases!.count)
      expect(release.tag).toBe(contract.releases!.get.tag)
      expect(release.ref.id).toBe(contract.releases!.get.id)
      expect(latest?.tag).toBe(contract.releases!.latest)
      expect(latest?.publishedAt).toBeInstanceOf(Date)
    })
  })

  describe.runIf(contract.securityAlerts)('security alerts', () => {
    it('lists alerts of every readable kind', async () => {
      const { instance } = provider()
      const alerts = await collect(instance.securityAlerts!.list({ forge: contract.name, instance: contract.instance, ...contract.repo }))

      expect(alerts.map(alert => (alert as { kind: string }).kind)).toEqual(contract.securityAlerts!.kinds)
      expect(alerts.map(alert => (alert as { severity: string }).severity)).toEqual(contract.securityAlerts!.severities)
    })
  })

  describe.runIf(contract.subscribe)('subscribe', () => {
    function stream() {
      const { fetch } = fixtureFetch(contract.fixtures)
      const sockets: FakeWebSocket[] = []
      const instance = contract.create(fetch, {
        webSocket: (url) => {
          const socket = new FakeWebSocket(url, contract.subscribe!.messages)
          sockets.push(socket)
          return socket
        },
      })
      return { instance, sockets }
    }

    it('yields normalised events with a resumable cursor, skipping non-commit messages', async () => {
      const { instance, sockets } = stream()
      const items = []
      for await (const item of instance.sources!.subscribe()) {
        items.push(item)
        if (items.length === contract.subscribe!.kinds.length) {
          break
        }
      }

      expect(items.map(item => item.event.kind)).toEqual(contract.subscribe!.kinds)
      expect(items.every(item => item.event.source === 'subscribe')).toBe(true)
      expect(items[0]!.event.thread?.number).toBe(contract.thread.number)
      expect(items.map(item => item.cursor)).toEqual([...items.map(item => item.cursor)].sort())
      expect(sockets[0]!.closed).toBe(true)
    })

    it('resumes from a cursor', async () => {
      const { instance, sockets } = stream()
      const iterator = instance.sources!.subscribe({ cursor: '1758000000000001' })[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return!()

      expect(new URL(sockets[0]!.url).searchParams.get('cursor')).toBe('1758000000000001')
    })

    it('ends quietly when the signal aborts', async () => {
      const { instance, sockets } = stream()
      const controller = new AbortController()
      const items = []
      for await (const item of instance.sources!.subscribe({ signal: controller.signal })) {
        items.push(item)
        controller.abort()
      }

      expect(items).toHaveLength(1)
      expect(sockets[0]!.closed).toBe(true)
    })

    it('surfaces a dropped connection as SubscriptionClosedError with the last cursor', async () => {
      const { instance } = stream()
      const items = []
      const error = await (async () => {
        for await (const item of instance.sources!.subscribe()) {
          items.push(item)
        }
      })().catch((error: unknown) => error)

      expect(error).toBeInstanceOf(SubscriptionClosedError)
      expect((error as SubscriptionClosedError).cursor).toBe(contract.subscribe!.lastCursor)
    })
  })

  it('sends raw requests through the hardened fetcher', async () => {
    const { instance, calls } = provider()
    const response = await instance.request<Record<string, unknown>>('get', contract.request.path)

    expect(response.status).toBe(200)
    expect(response.data).toHaveProperty(contract.request.field)
    expect(response.headers).toBeInstanceOf(Headers)
    expect(calls[0]!.method).toBe('GET')
    await expect(contract.create(stubFetch(401)).request('GET', contract.request.path)).rejects.toThrow(TokenRevokedError)
  })

  it('maps a revoked token to TokenRevokedError', async () => {
    const instance = contract.create(stubFetch(401, {}, { message: 'Bad credentials' }))
    await expect(probe(instance)).rejects.toThrow(TokenRevokedError)
  })

  it('maps a rate limit to RateLimitedError with a reset time', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600
    const instance = contract.create(stubFetch(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetAt),
    }))

    const error = await probe(instance).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RateLimitedError)
    expect((error as RateLimitedError).resetAt?.getTime()).toBe(resetAt * 1000)
  })

  it('maps a hung request to ForgeTimeoutError', async () => {
    const instance = contract.create(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted', { cause: init.signal!.reason }), { name: 'TimeoutError' })))
    }), { timeout: 50 })

    await expect(probe(instance)).rejects.toThrow(ForgeTimeoutError)
  })
  it('has every repository, thread, check, CI, search and webhook verb present, rejecting the ones the capabilities refuse', async () => {
    const repoRef = () => ({ forge: contract.name, instance: contract.instance, ...contract.repo })
    const verbs = [
      ['repos.labelsPage', (forge: ForgeProvider) => forge.repos.labelsPage(repoRef())],
      ['repos.createLabel', (forge: ForgeProvider) => forge.repos.createLabel(repoRef(), { name: 'triage' })],
      ['repos.milestonesPage', (forge: ForgeProvider) => forge.repos.milestonesPage(repoRef())],
      ['repos.collaboratorsPage', (forge: ForgeProvider) => forge.repos.collaboratorsPage(repoRef())],
      ['repos.permissionFor', (forge: ForgeProvider) => forge.repos.permissionFor(repoRef(), 'octocat')],
      ['repos.addCollaborator', (forge: ForgeProvider) => forge.repos.addCollaborator(repoRef(), 'octocat', 'write')],
      ['repos.assignableUsersPage', (forge: ForgeProvider) => forge.repos.assignableUsersPage(repoRef())],
      ['repos.reviewerCandidatesPage', (forge: ForgeProvider) => forge.repos.reviewerCandidatesPage(threadRef())],
      ['threads.addLabels', (forge: ForgeProvider) => forge.threads.addLabels(threadRef(), ['bug'])],
      ['threads.removeLabels', (forge: ForgeProvider) => forge.threads.removeLabels(threadRef(), ['bug'])],
      ['threads.setMilestone', (forge: ForgeProvider) => forge.threads.setMilestone(threadRef(), '1')],
      ['threads.react', (forge: ForgeProvider) => forge.threads.react(threadRef(), '+1')],
      ['threads.unreact', (forge: ForgeProvider) => forge.threads.unreact(threadRef(), '+1')],
      ['threads.transfer', (forge: ForgeProvider) => forge.threads.transfer(threadRef(), repoRef())],
      ['threads.markDuplicate', (forge: ForgeProvider) => forge.threads.markDuplicate(threadRef(), threadRef())],
      ['threads.upsertComment', (forge: ForgeProvider) => forge.threads.upsertComment(threadRef(), { key: 'k', body: 'b' })],
      ['threads.reviewsPage', (forge: ForgeProvider) => forge.threads.reviewsPage(threadRef())],
      ['threads.createReview', (forge: ForgeProvider) => forge.threads.createReview(threadRef(), { event: 'approve' })],
      ['threads.submitReview', (forge: ForgeProvider) => forge.threads.submitReview({ forge: contract.name, instance: contract.instance, thread: threadRef(), id: '1' }, 'approve')],
      ['threads.approve', (forge: ForgeProvider) => forge.threads.approve(threadRef())],
      ['threads.resolveReviewThread', (forge: ForgeProvider) => forge.threads.resolveReviewThread(threadRef(), '1')],
      ['threads.unresolveReviewThread', (forge: ForgeProvider) => forge.threads.unresolveReviewThread(threadRef(), '1')],
      ['checks.list', (forge: ForgeProvider) => forge.checks.list(repoRef(), 'deadbeef')],
      ['checks.report', (forge: ForgeProvider) => forge.checks.report(repoRef(), 'deadbeef', { name: 'forges', state: 'success' })],
      ['checks.rerun', (forge: ForgeProvider) => forge.checks.rerun({ forge: contract.name, instance: contract.instance, repo: repoRef(), id: '1', type: 'status' })],
      ['ci.runsPage', (forge: ForgeProvider) => forge.ci.runsPage(repoRef())],
      ['ci.run', (forge: ForgeProvider) => forge.ci.run({ forge: contract.name, instance: contract.instance, repo: repoRef(), id: '1' })],
      ['ci.jobsPage', (forge: ForgeProvider) => forge.ci.jobsPage({ forge: contract.name, instance: contract.instance, repo: repoRef(), id: '1' })],
      ['ci.log', (forge: ForgeProvider) => forge.ci.log({ forge: contract.name, instance: contract.instance, repo: repoRef(), id: '1' })],
      ['search.threadsPage', (forge: ForgeProvider) => forge.search.threadsPage({ text: 'crash', repo: repoRef() })],
      ['search.reposPage', (forge: ForgeProvider) => forge.search.reposPage({ text: 'widgets' })],
      ['webhooks.listPage', (forge: ForgeProvider) => forge.webhooks.listPage(repoRef())],
      ['webhooks.create', (forge: ForgeProvider) => forge.webhooks.create(repoRef(), { url: 'https://hooks.test/in', events: ['push'] })],
      ['webhooks.update', (forge: ForgeProvider) => forge.webhooks.update({ forge: contract.name, instance: contract.instance, target: repoRef(), id: '1' }, { active: false })],
      ['webhooks.delete', (forge: ForgeProvider) => forge.webhooks.delete({ forge: contract.name, instance: contract.instance, target: repoRef(), id: '1' })],
      ['webhooks.rotateSecret', (forge: ForgeProvider) => forge.webhooks.rotateSecret({ forge: contract.name, instance: contract.instance, target: repoRef(), id: '1' }, 's')],
      ['webhooks.deliveriesPage', (forge: ForgeProvider) => forge.webhooks.deliveriesPage({ forge: contract.name, instance: contract.instance, target: repoRef(), id: '1' })],
      ['webhooks.redeliver', (forge: ForgeProvider) => forge.webhooks.redeliver({ forge: contract.name, instance: contract.instance, hook: { forge: contract.name, instance: contract.instance, target: repoRef(), id: '1' }, id: '2' })],
    ] as const
    const { instance } = provider()

    for (const [verb, run] of verbs) {
      const [group, name] = verb.split('.') as ['repos' | 'threads' | 'checks' | 'ci' | 'search' | 'webhooks', string]
      expect(typeof (instance[group] as unknown as Record<string, unknown>)[name!]).toBe('function')
      if (!instance.can(verb as ForgeVerb, 'pull_request')) {
        await expect(run(instance), verb).rejects.toBeInstanceOf(UnsupportedOperationError)
      }
    }
  })
})
