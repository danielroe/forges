import type { RateLimit } from '../../src/model.ts'
import type { Fixture } from '../../src/testing/index.ts'
import { describe, expect, it } from 'vitest'
import { RateLimitedError } from '../../src/errors.ts'
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
