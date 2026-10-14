import type { ForgeVerb } from '../../src/provider.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForgeApiError, ForgeNetworkError, ForgeTimeoutError, MergeBlockedError, MergeConflictError, RateLimitedError, SubscriptionClosedError } from '../../src/errors.ts'
import { fake } from '../../src/fake/index.ts'

const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
const issue = { forge: 'fake', instance: 'fake.test', repo, kind: 'issue' as const, number: '1' }
const pull = { forge: 'fake', instance: 'fake.test', repo, kind: 'pull_request' as const, number: '2' }
const seed = {
  repos: [{ repo: 'acme/widgets' }],
  threads: [
    { repo: 'acme/widgets', kind: 'issue' as const, title: 'Crash on start' },
    { repo: 'acme/widgets', kind: 'pull_request' as const, title: 'Fix crash', head: { ref: 'fix', sha: 'a'.repeat(40) } },
  ],
  notifications: [{ repo: 'acme/widgets', number: 1 }],
}

afterEach(() => {
  vi.useRealTimers()
})

describe('fake forge failure injection', () => {
  it('rejects the next calls of a verb, then serves it again', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    factory.failNext('threads.comment', new ForgeApiError('Server error', 502, ''), { times: 2 })

    await expect(forge.threads.comment(issue, 'One')).rejects.toThrow('Server error')
    await expect(forge.threads.comment(issue, 'Two')).rejects.toThrow('Server error')
    await forge.threads.comment(issue, 'Three')

    expect(factory.store.repos.get('acme/widgets')!.threads.get('1')!.comments.map(comment => comment.body)).toEqual(['Three'])
  })

  it('applies the write before rejecting when asked', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    factory.failNext('threads.close', () => new ForgeTimeoutError('Timed out', 30_000), { applied: true })

    await expect(forge.threads.close(issue)).rejects.toThrow(ForgeTimeoutError)

    expect(factory.store.repos.get('acme/widgets')!.threads.get('1')!.thread.state).toBe('closed')
  })

  it('fails the pages of a listing through the listing verb', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    factory.failNext('threads.comments', new ForgeApiError('Server error', 500, ''))

    await expect(Array.fromAsync(forge.threads.comments(issue))).rejects.toThrow('Server error')
    expect(await Array.fromAsync(forge.threads.comments(issue))).toEqual([])
  })

  it('refuses a verb that sends no request of its own', () => {
    expect(() => fake().failNext('threads.upsertComment', new Error('boom'))).toThrow('threads.upsertComment sends no request of its own; fail threads.comments, threads.comment or threads.editComment instead')
    expect(() => fake().failNext('webhooks.verify', new Error('boom'))).toThrow('webhooks.verify sends no request of its own; it runs locally')
  })

  it('refuses a verb that the fake forge does not implement', () => {
    const factory = fake()

    expect(() => factory.failNext('threads.transfer', new Error('boom'))).toThrow(new TypeError('threads.transfer is not implemented by the fake forge, so it sends no request to fail'))
    expect(() => factory.failNext('threads.commentsPage', new Error('boom'))).not.toThrow()
    expect(() => factory.failNext('sources.subscribe', new Error('boom'))).not.toThrow()
  })
})

describe('fake forge offline', () => {
  it('rejects pages, iterables and writes with ForgeNetworkError until online', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    factory.offline()

    await expect(forge.threads.get(issue)).rejects.toThrow(ForgeNetworkError)
    await expect(forge.threads.listPage(repo)).rejects.toThrow(ForgeNetworkError)
    await expect(Array.fromAsync(forge.notifications.list())).rejects.toThrow(ForgeNetworkError)
    await expect(forge.threads.comment(issue, 'Hello')).rejects.toThrow(ForgeNetworkError)
    await expect(forge.sources.subscribe()[Symbol.asyncIterator]().next()).rejects.toThrow(ForgeNetworkError)

    factory.online()

    expect((await forge.threads.get(issue)).title).toBe('Crash on start')
  })

  it('closes an open subscription with the cursor of its last event', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const iterator = forge.sources.subscribe()[Symbol.asyncIterator]()
    const first = iterator.next()
    await forge.threads.close(issue)
    const { value } = await first
    const closed = iterator.next()
    factory.offline()

    const error = await closed.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SubscriptionClosedError)
    expect((error as SubscriptionClosedError).cursor).toBe(value!.cursor)
  })
})

describe('fake forge latency', () => {
  it('delays each request by the latency of its verb', async () => {
    vi.useFakeTimers()
    const factory = fake({ seed, latency: (verb: ForgeVerb) => verb === 'threads.get' ? 100 : 0 })
    const forge = factory.create()
    let settled = false
    const read = forge.threads.get(issue).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(99)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await read
    expect(settled).toBe(true)
  })

  it('rejects with the reason of an aborted signal and leaves the write unsent', async () => {
    vi.useFakeTimers()
    const factory = fake({ seed })
    factory.setLatency(1000)
    const forge = factory.create()
    const controller = new AbortController()
    const write = forge.threads.comment(issue, 'Hello', { signal: controller.signal })
    const reason = new Error('Cancelled')

    controller.abort(reason)

    await expect(write).rejects.toBe(reason)
    expect(factory.store.repos.get('acme/widgets')!.threads.get('1')!.comments).toEqual([])
  })

  it('rejects with ForgeTimeoutError when the latency exceeds the timeout', async () => {
    vi.useFakeTimers()
    const forge = fake({ seed, latency: 5000, timeout: 1000 }).create()
    const read = forge.threads.get(issue)
    const settled = expect(read).rejects.toThrow(ForgeTimeoutError)

    await vi.advanceTimersByTimeAsync(1000)
    await settled
  })
})

describe('fake forge clock', () => {
  it('stamps writes with the injected clock', async () => {
    let time = Date.parse('2026-01-01T00:00:00Z')
    const factory = fake({ seed, now: () => new Date(time) })
    const forge = factory.create()

    time += 60_000
    const comment = await forge.threads.comment(issue, 'Later')
    time += 60_000
    await forge.threads.close(issue)

    expect(comment.createdAt).toEqual(new Date('2026-01-01T00:01:00Z'))
    expect(factory.store.events.map(event => event.occurredAt)).toEqual([new Date('2026-01-01T00:01:00Z'), new Date('2026-01-01T00:02:00Z')])
    expect((await forge.threads.get(issue)).closedAt).toEqual(new Date('2026-01-01T00:02:00Z'))
    expect((await forge.search.threadsPage({ since: new Date('2026-01-01T00:02:00Z') })).items.map(thread => thread.ref.number)).toEqual(['1'])
  })
})

describe('fake forge copies', () => {
  it('returns copies, so changing a result leaves the store as it was', async () => {
    const factory = fake({ seed })
    const forge = factory.create()

    const thread = await forge.threads.get(issue)
    thread.title = 'Optimistic'
    const comment = await forge.threads.comment(issue, 'Hello')
    comment.body = 'Optimistic'
    const [listed] = (await forge.threads.commentsPage(issue)).items
    listed!.body = 'Optimistic'

    const state = factory.store.repos.get('acme/widgets')!.threads.get('1')!
    expect(state.thread.title).toBe('Crash on start')
    expect(state.comments.map(item => item.body)).toEqual(['Hello'])

    state.thread.title = 'Set up by the test'
    expect((await forge.threads.get(issue)).title).toBe('Set up by the test')
  })
})

type Listing = (forge: ReturnType<ReturnType<typeof fake>['create']>) => (cursor?: { etag?: string }) => Promise<{ items: unknown[], etag?: string, notModified?: boolean }>

describe('fake forge conditional reads', () => {
  const listings: Record<string, Listing> = {
    'notifications.listPage': forge => cursor => forge.notifications.listPage({ cursor }),
    'threads.listPage': forge => cursor => forge.threads.listPage(repo, { cursor }),
    'repos.eventsPage': forge => cursor => forge.repos.eventsPage(repo, { cursor }),
    'users.eventsPage': forge => cursor => forge.users.eventsPage('fake-user', { cursor }),
    'threads.eventsPage': forge => cursor => forge.threads.eventsPage(issue, { cursor }),
    'threads.commentsPage': forge => cursor => forge.threads.commentsPage(issue, { cursor }),
  }

  it.each(Object.entries(listings))('serves %s as not modified until a write changes it', async (_, listing) => {
    const forge = fake({ seed }).create()
    await forge.threads.comment(issue, 'First')
    const read = listing(forge)

    const first = await read()
    const again = await read({ etag: first.etag })
    await forge.threads.comment(issue, 'Second')
    await forge.notifications.markRead({ forge: 'fake', instance: 'fake.test', id: '1' })
    const changed = await read({ etag: first.etag })

    expect(first.etag).toMatch(/^W\/"/)
    expect(again).toEqual({ items: [], notModified: true, etag: first.etag })
    expect(changed.notModified).toBeUndefined()
    expect(changed.etag).not.toBe(first.etag)
  })

  it('gives later pages no etag', async () => {
    const forge = fake({ seed }).create()
    await forge.threads.comment(issue, 'First')
    await forge.threads.comment(issue, 'Second')

    const first = await forge.threads.commentsPage(issue, { perPage: 1 })
    const second = await forge.threads.commentsPage(issue, { perPage: 1, cursor: first.cursor })

    expect(first.etag).toBeDefined()
    expect(second.etag).toBeUndefined()
  })
})

describe('fake forge merges', () => {
  it('refuses a merge whose expected head has moved', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const head = (await forge.threads.get(pull)).branches!.head.sha!

    factory.store.repos.get('acme/widgets')!.threads.get('2')!.thread.branches!.head.sha = 'b'.repeat(40)

    await expect(forge.threads.merge(pull, { sha: head })).rejects.toThrow(MergeConflictError)
    await forge.threads.merge(pull, { sha: 'b'.repeat(40) })
    expect((await forge.threads.get(pull)).state).toBe('merged')
    await expect(forge.threads.merge(pull)).rejects.toThrow(MergeBlockedError)
  })

  it('sends the approval of approveAndMerge before refusing a blocked merge', async () => {
    const factory = fake({ seed: { threads: [{ ...seed.threads[1]!, mergeable: 'blocked' }] }, support: { 'threads.approveAndMerge': true } })
    const forge = factory.create()

    await expect(forge.threads.approveAndMerge({ ...pull, number: '1' })).rejects.toThrow(MergeBlockedError)
    expect(factory.store.repos.get('acme/widgets')!.threads.get('1')!.reviews.map(review => review.state)).toEqual(['approved'])
  })

  it('refuses a blocked or conflicted pull request', async () => {
    const factory = fake({ seed: { threads: [{ ...seed.threads[1]!, mergeable: 'blocked' }] } })
    const forge = factory.create()

    await expect(forge.threads.merge({ ...pull, number: '1' })).rejects.toThrow(MergeBlockedError)
    factory.store.repos.get('acme/widgets')!.threads.get('1')!.mergeable = 'conflict'
    await expect(forge.threads.merge({ ...pull, number: '1' })).rejects.toThrow(MergeConflictError)
  })
})

describe('fake forge repeated writes', () => {
  it('leaves the same state and records no new event when a write repeats', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const writes = async () => {
      await forge.threads.close(issue)
      await forge.threads.react(issue, '+1')
      await forge.threads.setAssignees(issue, ['jane'])
      await forge.threads.requestReview(pull, ['jane'])
    }

    await writes()
    const closedAt = factory.store.repos.get('acme/widgets')!.threads.get('1')!.thread.closedAt
    const events = factory.store.events.length
    await writes()
    await forge.threads.unreact(issue, '+1')
    await forge.threads.unreact(issue, '+1')

    const state = factory.store.repos.get('acme/widgets')!.threads
    expect(factory.store.events.map(event => event.action).slice(events)).toEqual(['deleted'])
    expect(state.get('1')!.thread.closedAt).toBe(closedAt)
    expect(state.get('2')!.thread.reviewers.map(reviewer => reviewer.actor.login)).toEqual(['jane'])
  })

  it('records the assignees that setAssignees adds and removes', async () => {
    const factory = fake({ seed: { threads: [{ ...seed.threads[0]!, assignees: ['jane'] }] } })
    await factory.create().threads.setAssignees(issue, ['jane', 'joe'])
    await factory.create().threads.setAssignees(issue, ['joe'])

    expect(factory.store.events.map(event => event.summary)).toEqual(['fake-user assigned joe', 'fake-user unassigned jane'])
  })

  it('refuses a second open pull request from the same head to the same base', async () => {
    const forge = fake({ seed }).create()
    const input = { kind: 'pull_request' as const, title: 'Retry uploads', head: 'retry', base: 'main' }

    const created = await forge.threads.create(repo, input)

    expect(created.branches).toMatchObject({ head: { ref: 'retry' }, base: { ref: 'main' } })
    await expect(forge.threads.create(repo, input)).rejects.toMatchObject({ status: 422 })
    await forge.threads.create(repo, { ...input, base: 'next' })
  })
})

describe('fake forge rate limit', () => {
  it('spends the budget on each request and resets it with the clock', async () => {
    let time = Date.parse('2026-01-01T00:00:00Z')
    const forge = fake({ seed, now: () => new Date(time), rateLimit: { limit: 2, window: 60_000 } }).create()

    const page = await forge.threads.listPage(repo)
    await forge.threads.get(issue)
    const error = await forge.threads.get(issue).catch((error: unknown) => error)
    time += 60_000

    expect(page.rateLimit).toEqual({ limit: 2, remaining: 1, resetAt: new Date('2026-01-01T00:01:00Z') })
    expect(error).toBeInstanceOf(RateLimitedError)
    expect((error as RateLimitedError).resetAt).toEqual(new Date('2026-01-01T00:01:00Z'))
    expect((await forge.threads.listPage(repo)).rateLimit).toEqual({ limit: 2, remaining: 1, resetAt: new Date('2026-01-01T00:02:00Z') })
  })

  it('spends nothing on a not-modified page', async () => {
    const factory = fake({ seed })
    factory.setRateLimit({ limit: 10 })
    const forge = factory.create()

    const first = await forge.notifications.listPage()
    const again = await forge.notifications.listPage({ cursor: { etag: first.etag } })

    expect(first.rateLimit?.remaining).toBe(9)
    expect(again).toMatchObject({ notModified: true, rateLimit: { remaining: 9 } })
    expect(forge.rateLimits()).toMatchObject([{ remaining: 9 }])
  })

  it('reports the budget of the latest request in rateLimits() until the window ends on its clock', async () => {
    let time = Date.parse('2026-01-01T00:00:00Z')
    const factory = fake({ seed, now: () => new Date(time), rateLimit: { limit: 1, window: 60_000 } })
    const forge = factory.create()
    const other = factory.create()

    expect(forge.rateLimits()).toEqual([])

    await forge.threads.get(issue)
    const exhausted = [{ limit: 1, remaining: 0, resetAt: new Date('2026-01-01T00:01:00Z') }]

    expect(forge.rateLimits()).toEqual(exhausted)
    expect(other.rateLimits()).toEqual(exhausted)
    await expect(other.threads.get(issue)).rejects.toThrow(RateLimitedError)
    expect(other.rateLimits()).toEqual(exhausted)

    time += 59_999
    expect(forge.rateLimits()).toEqual(exhausted)
    time += 1
    expect(forge.rateLimits()).toEqual([])
  })

  it('forgets the reported budget when the budget is replaced', async () => {
    const factory = fake({ seed, rateLimit: { limit: 5 } })
    const forge = factory.create()
    await forge.threads.get(issue)

    factory.setRateLimit({ limit: 10 })

    expect(forge.rateLimits()).toEqual([])
  })

  it('rejects with a secondary limit through failNext() while the budget has requests left', async () => {
    const factory = fake({ seed, rateLimit: { limit: 10 } })
    const forge = factory.create()
    factory.failNext('threads.comment', new RateLimitedError('Secondary rate limit', 403, '', { secondary: true }))

    await expect(forge.threads.comment(issue, 'Hello')).rejects.toMatchObject({ secondary: true, resetAt: undefined })
    expect(forge.rateLimits()).toMatchObject([{ remaining: 9 }])
  })
})

describe('fake forge offline queue', () => {
  it('posts a queued comment once when the first send timed out after the forge received it', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const mutation = { key: 'mutation-1', body: 'Thanks for the report' }

    factory.failNext('threads.comment', new ForgeTimeoutError('Request timed out', 30_000), { applied: true })
    await expect(forge.threads.upsertComment(issue, mutation)).rejects.toThrow(ForgeTimeoutError)
    const retried = await forge.threads.upsertComment(issue, mutation)

    expect(retried.created).toBe(false)
    expect(await Array.fromAsync(forge.threads.comments(issue))).toEqual([retried.comment])
  })
})
