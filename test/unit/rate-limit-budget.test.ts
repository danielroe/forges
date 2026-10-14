import type { RateLimit } from '../../src/model.ts'
import type { Fixture } from '../../src/testing/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { ForbiddenError, RateLimitedError } from '../../src/errors.ts'
import { createFetcher } from '../../src/fetch.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { github } from '../../src/github/index.ts'
import { fixtureFetch } from '../../src/testing/index.ts'

const reset = Math.floor(Date.now() / 1000) + 3600

function budget(resource: string, remaining: number, limit = 5000): Record<string, string> {
  return { 'x-ratelimit-resource': resource, 'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset) }
}

function get(url: string, headers: Record<string, string>, body: unknown = {}, status = 200): Fixture {
  return { request: { method: 'GET', url }, response: { status, headers, body } }
}

const repo = { id: 1, name: 'forges', full_name: 'danielroe/forges', owner: { login: 'danielroe', id: 1, type: 'User' }, private: false, html_url: 'https://github.com/danielroe/forges', default_branch: 'main' }

describe('rate limit resets', () => {
  const limited = (status: number, headers: Record<string, string>) => createFetcher({
    baseUrl: 'https://api.github.com',
    fetch: async () => new Response('{"message":"You have exceeded a secondary rate limit."}', { status, headers }),
  }).json('/user').catch((error: unknown) => error) as Promise<RateLimitedError>

  it('prefers `retry-after` to the reset of the budget', async () => {
    const error = await limited(403, { ...budget('core', 4000), 'retry-after': '120' })

    expect(error).toMatchObject({ secondary: true })
    expect(Math.round((error.resetAt!.getTime() - Date.now()) / 1000)).toBe(120)
  })

  it('names no reset for a limit that names no wait while the budget has requests left', async () => {
    expect((await limited(429, budget('core', 4000))).resetAt).toBeUndefined()
  })

  it('names the reset of a used-up budget', async () => {
    expect((await limited(429, budget('core', 0))).resetAt).toEqual(new Date(reset * 1000))
  })
})

describe('secondary rate limits', () => {
  const SECONDARY = JSON.stringify({
    message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again. If you reach out to GitHub Support for help, please include the request ID C2A4:3B1E:1A2B3C:4D5E6F:6704F3A1.',
    documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
  })
  const issueRef = { forge: 'github', instance: 'github.com', repo: { forge: 'github', instance: 'github.com', owner: 'danielroe', name: 'forges' }, kind: 'issue', number: '1' } as const

  function provider(...responses: Array<{ status: number, headers?: Record<string, string>, body: string }>) {
    const onRetry = vi.fn()
    let sent = 0
    const instance = github({
      auth: { type: 'token', token: 't' },
      onRetry,
      fetch: async () => {
        const { status, headers, body } = responses[Math.min(sent++, responses.length - 1)]!
        return new Response(body, { status, headers })
      },
    }).create()
    return { instance, onRetry, sent: () => sent }
  }

  const failure = (promise: Promise<unknown>) => promise.catch((error: unknown) => error)

  it('rejects a 403 secondary limit without `retry-after` with RateLimitedError, without retrying', async () => {
    const { instance, onRetry, sent } = provider({ status: 403, headers: budget('core', 4321), body: SECONDARY })
    const error = await failure(instance.threads.comment(issueRef, 'Hello'))

    expect(error).toBeInstanceOf(RateLimitedError)
    expect(error).toMatchObject({ status: 403, secondary: true, resetAt: undefined })
    expect(sent()).toBe(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('rejects a 429 secondary limit without `retry-after` as secondary', async () => {
    const { instance } = provider({ status: 429, headers: budget('core', 4321), body: SECONDARY })

    expect(await failure(instance.repos.get(issueRef.repo))).toMatchObject({ name: 'RateLimitedError', status: 429, secondary: true, resetAt: undefined })
  })

  it('retries a secondary limit with a short `retry-after` once, then rejects with its reset', async () => {
    const { instance, onRetry, sent } = provider({ status: 403, headers: { ...budget('core', 4321), 'retry-after': '0' }, body: SECONDARY })
    const error = await failure(instance.repos.get(issueRef.repo)) as RateLimitedError

    expect(error).toMatchObject({ name: 'RateLimitedError', secondary: true })
    expect(Math.abs(error.resetAt!.getTime() - Date.now())).toBeLessThan(1000)
    expect(sent()).toBe(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('rejects a secondary limit with a long `retry-after` without retrying', async () => {
    const { instance, sent } = provider({ status: 403, headers: { ...budget('core', 4321), 'retry-after': '120' }, body: SECONDARY })
    const error = await failure(instance.repos.get(issueRef.repo)) as RateLimitedError

    expect(error.secondary).toBe(true)
    expect(Math.round((error.resetAt!.getTime() - Date.now()) / 1000)).toBe(120)
    expect(sent()).toBe(1)
  })

  it('rejects a content creation limit that arrives as a 422 with RateLimitedError', async () => {
    const { instance } = provider({ status: 422, body: '{"message":"Validation Failed","errors":[{"resource":"Issue","code":"custom","field":"title","message":"was submitted too quickly"}]}' })

    expect(await failure(instance.threads.create(issueRef.repo, { kind: 'issue', title: 'Bug' }))).toMatchObject({ name: 'RateLimitedError', status: 422, secondary: true })
  })

  it('marks a used-up budget as a primary limit', async () => {
    const { instance } = provider({ status: 403, headers: budget('core', 0), body: '{"message":"API rate limit exceeded for user ID 1."}' })

    expect(await failure(instance.repos.get(issueRef.repo))).toMatchObject({ name: 'RateLimitedError', secondary: false, resetAt: new Date(reset * 1000) })
  })

  it('keeps a 403 that names another policy as ForbiddenError', async () => {
    const { instance } = provider({ status: 403, headers: budget('core', 4321), body: '{"message":"Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization."}' })
    const error = await failure(instance.repos.get(issueRef.repo))

    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ reason: 'sso_required' })
  })

  it('keeps a 422 that echoes the phrase outside its messages as a validation error', async () => {
    const { instance } = provider({ status: 422, body: '{"message":"Validation Failed","errors":[{"resource":"Label","code":"invalid","field":"name","value":"submitted too quickly"}]}' })
    const error = await failure(instance.threads.create(issueRef.repo, { kind: 'issue', title: 'Bug' }))

    expect(error).not.toBeInstanceOf(RateLimitedError)
    expect(error).toMatchObject({ status: 422 })
  })

  it('keeps a 403 that names a secondary limit outside its messages as ForbiddenError', async () => {
    const { instance } = provider({ status: 403, headers: budget('core', 4321), body: '{"message":"Resource protected by organization SAML enforcement.","note":"not a secondary rate limit"}' })

    expect(await failure(instance.repos.get(issueRef.repo))).toBeInstanceOf(ForbiddenError)
  })

  it('reads a secondary limit message past the excerpt of the body', async () => {
    const { instance } = provider({ status: 403, headers: budget('core', 4321), body: JSON.stringify({ request_id: 'x'.repeat(600), message: 'You have exceeded a secondary rate limit.' }) })

    expect(await failure(instance.repos.get(issueRef.repo))).toMatchObject({ name: 'RateLimitedError', secondary: true })
  })

  it('rejects a listing whose batched read of checks is rate limited', async () => {
    const pull = { number: 7, title: 'Fix', state: 'open', pull_request: {}, user: { login: 'ada', id: 1 }, labels: [], created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }
    const { instance } = provider(
      { status: 200, headers: budget('core', 4321), body: JSON.stringify([pull]) },
      { status: 200, headers: budget('graphql', 0), body: '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 1."}]}' },
    )

    await expect(instance.threads.listPage(issueRef.repo)).rejects.toBeInstanceOf(RateLimitedError)
  })

  describe('when one half of the read of checks is rate limited', () => {
    const pullRef = { ...issueRef, kind: 'pull_request', number: '7' } as const
    const limited = () => github({
      auth: { type: 'token', token: 't' },
      fetch: async (input) => {
        const { pathname } = new URL(input)
        if (pathname.endsWith('/check-runs')) {
          return new Response('{"message":"API rate limit exceeded for user ID 1."}', { status: 403, headers: budget('core', 0) })
        }
        if (pathname.endsWith('/status')) {
          return new Response('{"statuses":[]}', { headers: budget('core', 0) })
        }
        return new Response(JSON.stringify({ number: 7, title: 'Fix', state: 'open', head: { sha: 'abc' }, user: { login: 'ada', id: 1 }, labels: [] }), { headers: budget('core', 1) })
      },
    }).create()

    it('rejects checks.list()', async () => {
      await expect(limited().checks.list(issueRef.repo, 'abc')).rejects.toBeInstanceOf(RateLimitedError)
    })

    it('rejects threads.get()', async () => {
      await expect(limited().threads.get(pullRef)).rejects.toBeInstanceOf(RateLimitedError)
    })
  })

  it('rejects a used-up GraphQL budget, which GitHub reports with a 200, with RateLimitedError', async () => {
    const { instance } = provider({ status: 200, headers: budget('graphql', 0), body: '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 1."}]}' })

    await expect(instance.threads.getMany([issueRef])).rejects.toMatchObject({ name: 'RateLimitedError', status: 200, secondary: false, resetAt: new Date(reset * 1000) })
    expect(instance.rateLimits()).toMatchObject([{ resource: 'graphql', remaining: 0 }])
  })

  it('names the reset of the GraphQL budget for a query that costs more than the requests left', async () => {
    const { instance } = provider({ status: 200, headers: budget('graphql', 3), body: '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded for user ID 1."}]}' })

    await expect(instance.threads.getMany([issueRef])).rejects.toMatchObject({ name: 'RateLimitedError', secondary: false, resetAt: new Date(reset * 1000) })
  })

  it('rejects a GraphQL secondary limit with RateLimitedError', async () => {
    const { instance } = provider({ status: 200, headers: budget('graphql', 4321), body: '{"errors":[{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}]}' })

    await expect(instance.threads.get({ ...issueRef, kind: 'discussion' })).rejects.toMatchObject({ name: 'RateLimitedError', secondary: true, resetAt: undefined })
  })
})

describe('last-seen budget', () => {
  it('reports the budget of a single read without sending a request', async () => {
    const { fetch, calls } = fixtureFetch([get('https://api.github.com/repos/danielroe/forges', budget('core', 4990), repo)])
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()

    expect(provider.rateLimits()).toEqual([])

    await provider.repos.get({ forge: 'github', instance: 'github.com', owner: 'danielroe', name: 'forges' })
    const sent = calls.length

    expect(provider.rateLimits()).toEqual([{ resource: 'core', limit: 5000, remaining: 4990, resetAt: new Date(reset * 1000) }])
    expect(calls).toHaveLength(sent)
  })

  it('keeps one budget per GitHub resource, and the latest of each', async () => {
    const { fetch } = fixtureFetch([], {
      'GET https://api.github.com/repos/danielroe/forges': { status: 200, headers: budget('core', 4990), body: repo },
      'GET https://api.github.com/search/issues?q=forges': { status: 200, headers: budget('search', 29, 30), body: { items: [] } },
      'GET https://api.github.com/rate_limit': { status: 200, headers: budget('core', 4989), body: {} },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    await provider.repos.get({ forge: 'github', instance: 'github.com', owner: 'danielroe', name: 'forges' })
    await provider.request('GET', '/search/issues', { query: { q: 'forges' } })
    await provider.request('GET', '/rate_limit')

    expect(provider.rateLimits()).toEqual([
      { resource: 'core', limit: 5000, remaining: 4989, resetAt: new Date(reset * 1000) },
      { resource: 'search', limit: 30, remaining: 29, resetAt: new Date(reset * 1000) },
    ])
  })

  it('keeps the fewer requests left when an earlier response arrives late', async () => {
    let release!: () => void
    const late = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetch = async (input: string) => {
      if (input.endsWith('/first')) {
        await late
        return new Response('{}', { headers: budget('core', 10) })
      }
      return new Response('{}', { headers: budget('core', 9) })
    }
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    const first = provider.request('GET', '/first')
    await provider.request('GET', '/second')
    release()
    await first

    expect(provider.rateLimits()).toMatchObject([{ resource: 'core', remaining: 9 }])
  })

  it('ignores a late response from an older window, and takes one from a newer window', async () => {
    const responses = [
      { ...budget('core', 4000), 'x-ratelimit-reset': String(reset + 3600) },
      budget('core', 0),
      { ...budget('core', 4999), 'x-ratelimit-reset': String(reset + 7200) },
    ]
    const fetch = async () => new Response('{}', { headers: responses.shift() })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    await provider.request('GET', '/rate_limit')
    await provider.request('GET', '/rate_limit')

    expect(provider.rateLimits()).toMatchObject([{ remaining: 4000 }])

    await provider.request('GET', '/rate_limit')

    expect(provider.rateLimits()).toMatchObject([{ remaining: 4999 }])
  })

  it('treats resets in seconds from now that are a second apart as one window', async () => {
    const responses = ['"baseline";r=10;t=600', '"baseline";r=11;t=599']
    const fetch = async () => new Response('{}', { headers: { 'ratelimit-policy': '"baseline";q=2000;w=600', 'ratelimit': responses.shift()! } })
    const provider = forgejo({ auth: { type: 'token', token: 't' }, fetch }).create()
    await provider.request('GET', '/rate_limit')
    await provider.request('GET', '/rate_limit')

    expect(provider.rateLimits()).toMatchObject([{ remaining: 10 }])
  })

  it('records the budget of a rate-limited response', async () => {
    const { fetch } = fixtureFetch([get('https://api.github.com/repos/danielroe/forges', budget('core', 0), { message: 'API rate limit exceeded' }, 403)])
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()

    await expect(provider.repos.get({ forge: 'github', instance: 'github.com', owner: 'danielroe', name: 'forges' })).rejects.toBeInstanceOf(RateLimitedError)
    expect(provider.rateLimits()).toMatchObject([{ resource: 'core', remaining: 0 }])
  })

  it('reads the structured budget of a Forgejo instance', async () => {
    const { fetch } = fixtureFetch([], {
      'GET https://codeberg.org/api/v1/rate_limit': { status: 200, headers: { 'ratelimit-policy': '"baseline";q=2000;w=600', 'ratelimit': '"baseline";r=1994;t=600' }, body: {} },
    })
    const provider = forgejo({ auth: { type: 'token', token: 't' }, fetch }).create()
    await provider.request('GET', '/rate_limit')
    const [rateLimit, ...rest] = provider.rateLimits()

    expect(rest).toEqual([])
    expect(rateLimit).toMatchObject({ resource: 'baseline', limit: 2000, remaining: 1994 })
  })

  it('leaves out a budget whose reset has passed', async () => {
    const { fetch } = fixtureFetch([], {
      'GET https://api.github.com/rate_limit': { status: 200, headers: { ...budget('core', 12), 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 1) }, body: {} },
    })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    await provider.request('GET', '/rate_limit')

    expect(provider.rateLimits()).toEqual([])
  })

  it('keeps the budgets of two providers apart', async () => {
    const first = fixtureFetch([], { 'GET https://api.github.com/rate_limit': { status: 200, headers: budget('core', 100), body: {} } })
    const second = fixtureFetch([], { 'GET https://api.github.com/rate_limit': { status: 200, headers: budget('core', 4000), body: {} } })
    const one = github({ auth: { type: 'token', token: 'a' }, fetch: first.fetch }).create()
    const two = github({ auth: { type: 'token', token: 'b' }, fetch: second.fetch }).create()
    await one.request('GET', '/rate_limit')

    expect(two.rateLimits()).toEqual([])

    await two.request('GET', '/rate_limit')

    expect(one.rateLimits()).toMatchObject([{ remaining: 100 }])
    expect(two.rateLimits()).toMatchObject([{ remaining: 4000 }])
  })

  it('reports only the budget of the API origin', async () => {
    const seen: RateLimit[] = []
    const fetcher = createFetcher({
      baseUrl: 'https://api.github.com',
      onRateLimit: ({ rateLimit }) => seen.push(rateLimit),
      fetch: async () => new Response('{}', { status: 200, headers: budget('core', 10) }),
    })
    await fetcher.json('https://elsewhere.example/thing')

    expect(seen).toEqual([])

    await fetcher.json('/thing')

    expect(seen).toMatchObject([{ remaining: 10 }])
  })
})

describe('hand-built pages', () => {
  it('carry the budget of a GitHub notifications page', async () => {
    const { fetch } = fixtureFetch([get('https://api.github.com/notifications?all=false', budget('core', 4321), [])])
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()

    expect((await provider.notifications.listPage()).rateLimit).toEqual({ resource: 'core', limit: 5000, remaining: 4321, resetAt: new Date(reset * 1000) })
  })
})
