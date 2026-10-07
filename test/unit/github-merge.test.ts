import type { FetchLike } from '../../src/fetch.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeApiError, ForgeTimeoutError, InsufficientScopeError, MergeBlockedError, MergeConflictError, UnsupportedOperationError } from '../../src/errors.ts'
import { github } from '../../src/github/index.ts'

interface Reply {
  status: number
  body?: unknown
  delay?: number
}

const UUID = '3f1c2a9e-5b7d-4e8a-9c0f-1a2b3c4d5e6f'
const SHA = '6dcb09b5b57875f334f61aebed695e2e4193db5e'
const PULL = '/repos/acme/widgets/pulls/42'
const ASYNC = `${PULL}/merge-async`
const POLL = `${ASYNC}/${UUID}`

function pending(details: Record<string, unknown> = {}) {
  return {
    status: 'pending',
    details: { message: 'Merge request accepted', uuid: UUID, merge_method: 'squash', merge_action: 'direct_merge', expected_head_sha: SHA, bypass_rules: false, ...details },
  }
}
const merged = { status: 'merged', details: { message: 'Pull request merged', sha: '7a9c3e1f0b2d4c6e8a1f3b5d7c9e0a2b4d6f8a1c' } }

function scripted(routes: Record<string, Reply | Reply[]>) {
  const calls: Array<{ method: string, path: string, body?: unknown }> = []
  const aborted: string[] = []
  const queues = new Map(Object.entries(routes).map(([key, reply]) => [key, Array.isArray(reply) ? [...reply] : [reply]]))
  const fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? 'GET'
    const path = new URL(input).pathname.replace(/^\/api\/v3/, '')
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const queue = queues.get(`${method} ${path}`)
    const reply = queue && (queue.length > 1 ? queue.shift() : queue[0])
    if (!reply) {
      throw new Error(`Unexpected ${method} ${input}`)
    }
    if (reply.delay) {
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, reply.delay)
        function onAbort() {
          clearTimeout(timer)
          aborted.push(`${method} ${path}`)
          reject(signal!.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status })
  }
  return { fetch, calls, aborted }
}

function forge(routes: Record<string, Reply | Reply[]>, options: { baseUrl?: string, timeout?: number } = {}) {
  const { fetch, calls, aborted } = scripted(routes)
  const provider = github({ auth: { type: 'token', token: 't' }, fetch, ...options }).create()
  const instance = provider.instance
  const pull = { forge: 'github', instance, repo: { forge: 'github', instance, owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '42' } as const
  return {
    calls,
    aborted,
    async merge({ approve = true, ...mergeOptions }: Parameters<typeof provider.threads.approveAndMerge>[1] & { approve?: boolean } = {}): Promise<unknown> {
      const result = (approve ? provider.threads.approveAndMerge(pull, mergeOptions) : provider.threads.merge(pull, mergeOptions)).then(() => undefined, (error: unknown) => error)
      await vi.runAllTimersAsync()
      return result
    },
  }
}

const review = { 'POST /repos/acme/widgets/pulls/42/reviews': { status: 200, body: { id: 880099, state: 'APPROVED' } } }

describe('github merging', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('approves once, requests a direct merge, and polls until it merges', async () => {
    const { merge, calls } = forge({
      ...review,
      [`PUT ${ASYNC}`]: { status: 202, body: pending() },
      [`GET ${POLL}`]: [{ status: 200, body: pending() }, { status: 200, body: merged }],
    })

    expect(await merge({ method: 'squash', sha: SHA })).toBeUndefined()
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${PULL}/reviews`,
      `PUT ${ASYNC}`,
      `GET ${POLL}`,
      `GET ${POLL}`,
    ])
    expect(calls[1]!.body).toEqual({ merge_method: 'squash', sha: SHA, merge_action: 'direct_merge' })
  })

  it('sends the repository\'s only merge method and the expected head sha', async () => {
    const { merge, calls } = forge({
      'GET /repos/acme/widgets': { status: 200, body: { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true } },
      [`PUT ${ASYNC}`]: { status: 202, body: pending({ merge_method: 'rebase' }) },
      [`GET ${POLL}`]: { status: 200, body: merged },
    })

    expect(await merge({ approve: false, sha: SHA })).toBeUndefined()
    expect(calls.find(call => call.method === 'PUT')!.body).toEqual({ merge_method: 'rebase', sha: SHA, merge_action: 'direct_merge' })
  })

  it('sends the merge commit message without approving', async () => {
    const { merge, calls } = forge({ [`PUT ${ASYNC}`]: { status: 200, body: merged } })

    expect(await merge({ method: 'squash', message: 'Release widgets', approve: false })).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ merge_method: 'squash', merge_action: 'direct_merge', commit_message: 'Release widgets' })
  })

  it('resolves without polling when the pull request is already merged', async () => {
    const { merge, calls } = forge({ [`PUT ${ASYNC}`]: { status: 200, body: merged } })

    expect(await merge({ method: 'merge', approve: false })).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('rejects a failed result with the reported message and does not resubmit', async () => {
    const { merge, calls } = forge({
      [`PUT ${ASYNC}`]: { status: 202, body: pending() },
      [`GET ${POLL}`]: { status: 200, body: { status: 'failed', details: { message: 'Required status check "test" is failing' } } },
    })

    const error = await merge({ method: 'squash', approve: false })
    expect(error).toBeInstanceOf(MergeBlockedError)
    expect(error).toMatchObject({ message: 'Required status check "test" is failing', status: 200, method: 'GET' })
    expect(calls.map(call => call.method)).toEqual(['PUT', 'GET'])
  })

  it('rejects a failed result returned with HTTP 200 from the merge request', async () => {
    const { merge, calls } = forge({ [`PUT ${ASYNC}`]: { status: 200, body: { status: 'failed', details: { message: 'Head branch was modified' } } } })

    const error = await merge({ method: 'squash', approve: false })
    expect(error).toBeInstanceOf(MergeBlockedError)
    expect(error).toMatchObject({ message: 'Head branch was modified', status: 200, method: 'PUT' })
    expect(calls).toHaveLength(1)
  })

  it('treats a merge queue entry as not merged', async () => {
    const { merge } = forge({ [`PUT ${ASYNC}`]: { status: 200, body: { status: 'enqueued', details: { message: 'Pull request is in the merge queue' } } } })

    expect(await merge({ method: 'squash', approve: false })).toBeInstanceOf(MergeBlockedError)
  })

  it('times out within the provider timeout, naming the pending request', async () => {
    const { merge, calls } = forge({
      [`PUT ${ASYNC}`]: { status: 202, body: pending() },
      [`GET ${POLL}`]: { status: 200, body: pending() },
    }, { timeout: 5000 })

    const error = await merge({ method: 'squash', approve: false })
    expect(error).toBeInstanceOf(ForgeTimeoutError)
    expect((error as ForgeTimeoutError).timeout).toBe(5000)
    expect(Date.now()).toBe(5000)
    expect((error as Error).message).toContain(UUID)
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(3)
  })

  it('counts the merge request against the timeout', async () => {
    const { merge, calls, aborted } = forge({
      [`PUT ${ASYNC}`]: { status: 202, body: pending(), delay: 4800 },
      [`GET ${POLL}`]: { status: 200, body: merged },
    }, { timeout: 5000 })

    const error = await merge({ method: 'squash', approve: false })
    expect(error).toBeInstanceOf(ForgeTimeoutError)
    expect((error as Error).message).toContain(UUID)
    expect(calls.map(call => call.method)).toEqual(['PUT'])
    expect(aborted).toEqual([])
    expect(Date.now()).toBe(5000)
  })

  it('cuts a slow merge request short at the timeout', async () => {
    const { merge, calls, aborted } = forge({
      [`PUT ${ASYNC}`]: { status: 202, body: pending(), delay: 20_000 },
      [`GET ${POLL}`]: { status: 200, body: merged },
    }, { timeout: 5000 })

    const error = await merge({ method: 'squash', approve: false })
    expect(error).toBeInstanceOf(ForgeTimeoutError)
    expect(error).toMatchObject({ timeout: 5000, method: 'PUT', url: `https://api.github.com${ASYNC}` })
    expect((error as Error).message).toContain('may still complete')
    expect((error as Error).message).not.toContain(UUID)
    expect((error as Error).cause).toMatchObject({ name: 'TimeoutError' })
    expect(aborted).toEqual([`PUT ${ASYNC}`])
    expect(Date.now()).toBe(5000)
    expect(calls.map(call => call.method)).toEqual(['PUT'])
  })

  it('cuts a slow poll short at the timeout', async () => {
    const { merge, calls, aborted } = forge({
      [`PUT ${ASYNC}`]: { status: 202, body: pending() },
      [`GET ${POLL}`]: { status: 200, body: merged, delay: 20_000 },
    }, { timeout: 5000 })

    const error = await merge({ method: 'squash', approve: false })
    expect(error).toBeInstanceOf(ForgeTimeoutError)
    expect((error as Error).message).toContain(UUID)
    expect(aborted).toEqual([`GET ${POLL}`])
    expect(Date.now()).toBe(5000)
    expect(calls.map(call => call.method)).toEqual(['PUT', 'GET'])
  })

  it('rejects a pending result that carries no request id', async () => {
    const { merge, calls } = forge({ [`PUT ${ASYNC}`]: { status: 202, body: { status: 'pending', details: { message: 'Accepted' } } } })

    const error = await merge({ method: 'squash', approve: false })
    expect(error).toBeInstanceOf(ForgeApiError)
    expect(error).toMatchObject({ status: 202 })
    expect(calls).toHaveLength(1)
  })

  it('waits on an existing pending request with the same options', async () => {
    const { merge, calls } = forge({
      [`PUT ${ASYNC}`]: { status: 409, body: pending() },
      [`GET ${POLL}`]: { status: 200, body: merged },
    })

    expect(await merge({ method: 'squash', sha: SHA, approve: false })).toBeUndefined()
    expect(calls.map(call => call.method)).toEqual(['PUT', 'GET'])
  })

  it.each(['Release widgets', ''])('refuses to adopt a pending request when a commit message is supplied (%j)', async (message) => {
    const { merge, calls } = forge({ [`PUT ${ASYNC}`]: { status: 409, body: pending() } })

    expect(await merge({ method: 'squash', sha: SHA, message, approve: false })).toBeInstanceOf(MergeBlockedError)
    expect(calls.map(call => call.method)).toEqual(['PUT'])
  })

  it('waits on an existing pending request for any head when no sha is given', async () => {
    const { merge } = forge({
      [`PUT ${ASYNC}`]: { status: 409, body: pending({ expected_head_sha: 'f'.repeat(40) }) },
      [`GET ${POLL}`]: { status: 200, body: merged },
    })

    expect(await merge({ method: 'squash', approve: false })).toBeUndefined()
  })

  it.each([
    ['merge method', { merge_method: 'merge' }],
    ['merge action', { merge_action: 'merge_queue' }],
    ['default merge action', { merge_action: 'default' }],
    ['expected head sha', { expected_head_sha: 'f'.repeat(40) }],
    ['rule bypass', { bypass_rules: true }],
  ])('refuses to adopt an existing pending request with a different %s', async (_, details) => {
    const { merge, calls } = forge({ [`PUT ${ASYNC}`]: { status: 409, body: pending(details) } })

    const error = await merge({ method: 'squash', sha: SHA, approve: false })
    expect(error).toBeInstanceOf(MergeBlockedError)
    expect(error).toMatchObject({ status: 409 })
    expect(calls).toHaveLength(1)
  })

  it('maps a 400 for a closed or draft pull request to MergeBlockedError', async () => {
    const { merge } = forge({ [`PUT ${ASYNC}`]: { status: 400, body: { message: 'Pull request is in draft state' } } })
    const error = await merge({ method: 'squash', approve: false })

    expect(error).toBeInstanceOf(MergeBlockedError)
    expect((error as Error).cause).toBeInstanceOf(ForgeApiError)
  })

  it('rejects options GitHub cannot honour before any request', async () => {
    const { merge, calls } = forge({})

    expect(await merge({ whenChecksPass: true })).toBeInstanceOf(UnsupportedOperationError)
    expect(await merge({ method: 'fast_forward_only' })).toBeInstanceOf(UnsupportedOperationError)
    expect(calls).toHaveLength(0)
  })

  describe('github enterprise server', () => {
    const baseUrl = 'https://ghe.example.com/api/v3'

    it('falls back to the synchronous merge endpoint when the asynchronous one is missing', async () => {
      const { merge, calls } = forge({
        ...review,
        [`PUT ${ASYNC}`]: { status: 404, body: { message: 'Not Found' } },
        [`PUT ${PULL}/merge`]: { status: 200, body: { sha: SHA, merged: true, message: 'Pull Request successfully merged' } },
      }, { baseUrl })

      expect(await merge({ method: 'squash', sha: SHA, message: 'Release widgets' })).toBeUndefined()
      expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `POST ${PULL}/reviews`,
        `PUT ${ASYNC}`,
        `PUT ${PULL}/merge`,
      ])
      expect(calls[2]!.body).toEqual({ merge_method: 'squash', sha: SHA, commit_message: 'Release widgets' })
    })

    it('keeps typed errors from the synchronous merge endpoint', async () => {
      const { merge } = forge({
        [`PUT ${ASYNC}`]: { status: 404, body: { message: 'Not Found' } },
        [`PUT ${PULL}/merge`]: { status: 409, body: { message: 'Head branch was modified' } },
      }, { baseUrl })

      expect(await merge({ method: 'squash', sha: SHA, approve: false })).toBeInstanceOf(MergeConflictError)
    })

    it('surfaces a 404 from both endpoints', async () => {
      const { merge, calls } = forge({
        [`PUT ${ASYNC}`]: { status: 404, body: { message: 'Not Found' } },
        [`PUT ${PULL}/merge`]: { status: 404, body: { message: 'Not Found' } },
      }, { baseUrl })

      const error = await merge({ method: 'squash', approve: false })
      expect(error).toBeInstanceOf(ForgeApiError)
      expect(error).toMatchObject({ status: 404, url: `${baseUrl}${PULL}/merge` })
      expect(calls).toHaveLength(2)
    })

    it('cuts a slow synchronous merge short at the timeout', async () => {
      const { merge, calls, aborted } = forge({
        [`PUT ${ASYNC}`]: { status: 404, body: { message: 'Not Found' }, delay: 1000 },
        [`PUT ${PULL}/merge`]: { status: 200, body: { sha: SHA, merged: true, message: 'Pull Request successfully merged' }, delay: 20_000 },
      }, { baseUrl, timeout: 5000 })

      const error = await merge({ method: 'squash', approve: false })
      expect(error).toBeInstanceOf(ForgeTimeoutError)
      expect(error).toMatchObject({ timeout: 5000, method: 'PUT', url: `${baseUrl}${PULL}/merge` })
      expect((error as Error).message).toContain('may still complete')
      expect(aborted).toEqual([`PUT ${PULL}/merge`])
      expect(Date.now()).toBe(5000)
      expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([`PUT ${ASYNC}`, `PUT ${PULL}/merge`])
    })

    it('does not fall back on a permission error', async () => {
      const { merge, calls } = forge({ [`PUT ${ASYNC}`]: { status: 403, body: { message: 'Resource not accessible by integration' } } }, { baseUrl })

      expect(await merge({ method: 'squash', approve: false })).toBeInstanceOf(InsufficientScopeError)
      expect(calls).toHaveLength(1)
    })

    it('does not fall back once the merge request was accepted', async () => {
      const { merge, calls } = forge({
        [`PUT ${ASYNC}`]: { status: 202, body: pending() },
        [`GET ${POLL}`]: { status: 404, body: { message: 'Not Found' } },
      }, { baseUrl })

      const error = await merge({ method: 'squash', approve: false })
      expect(error).toBeInstanceOf(ForgeApiError)
      expect(error).toMatchObject({ status: 404 })
      expect(calls.map(call => call.method)).toEqual(['PUT', 'GET'])
    })
  })

  it.each([
    ['github.com', undefined],
    ['ghe.com', 'https://api.acme.ghe.com'],
  ])('does not fall back on %s', async (_, baseUrl) => {
    const { merge, calls } = forge({ [`PUT ${ASYNC}`]: { status: 404, body: { message: 'Not Found' } } }, { baseUrl })

    const error = await merge({ method: 'squash', approve: false })
    expect(error).toBeInstanceOf(ForgeApiError)
    expect(error).toMatchObject({ status: 404 })
    expect(calls).toHaveLength(1)
  })
})
