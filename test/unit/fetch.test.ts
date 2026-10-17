import type { ForgeRawRequestOptions, RawResponse } from '../../src/fetch.ts'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { AuthenticationRequiredError, ForbiddenError, ForgeApiError, ForgeNetworkError, InsufficientScopeError, RateLimitedError, ReadOnlyError } from '../../src/errors.ts'
import { createFetcher, createRequest, parseLinkHeader, rateLimitOf } from '../../src/fetch.ts'
import { github } from '../../src/github/index.ts'

describe('parseLinkHeader', () => {
  it('parses multiple relations', () => {
    const links = parseLinkHeader('<https://api.example/x?page=2>; rel="next", <https://api.example/x?page=9>; rel="last"')

    expect(links).toEqual({
      next: 'https://api.example/x?page=2',
      last: 'https://api.example/x?page=9',
    })
  })

  it('returns an empty map for a missing header', () => {
    expect(parseLinkHeader(null)).toEqual({})
  })

  it('parses an unterminated header in linear time', () => {
    const start = performance.now()

    expect(parseLinkHeader('<='.repeat(50_000))).toEqual({})
    expect(performance.now() - start).toBeLessThan(100)
  })
})

describe('createFetcher', () => {
  it('merges base, auth and per-request headers', async () => {
    const seen: Headers[] = []
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      headers: { 'user-agent': 'forges' },
      authHeaders: () => ({ authorization: 'Bearer secret' }),
      fetch: async (_url, init) => {
        seen.push(init!.headers as Headers)
        return new Response('{}', { status: 200 })
      },
    })

    await fetcher.json('/thing', { headers: { accept: 'application/json' } })

    expect(seen[0]!.get('user-agent')).toBe('forges')
    expect(seen[0]!.get('authorization')).toBe('Bearer secret')
    expect(seen[0]!.get('accept')).toBe('application/json')
  })

  it('serialises query parameters and drops undefined ones', async () => {
    const urls: string[] = []
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async (url) => {
        urls.push(url)
        return new Response('{}', { status: 200 })
      },
    })

    await fetcher.json('/thing', { query: { all: false, page: 2, since: undefined } })

    expect(urls[0]).toBe('https://api.example/thing?all=false&page=2')
  })

  it('reports a 304 as not modified rather than an error', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async (_url, init) => {
        expect((init!.headers as Headers).get('if-none-match')).toBe('W/"abc"')
        return new Response(null, { status: 304, headers: { etag: 'W/"abc"' } })
      },
    })

    const result = await fetcher.json('/notifications', { etag: 'W/"abc"' })

    expect(result.notModified).toBe(true)
    expect(result.cursor?.etag).toBe('W/"abc"')
  })

  it('follows link headers through items', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async (url) => {
        if (url.includes('page=2')) {
          return new Response(JSON.stringify([3]), { status: 200 })
        }
        return new Response(JSON.stringify([1, 2]), {
          status: 200,
          headers: { link: '<https://api.example/items?page=2>; rel="next"' },
        })
      },
    })

    expect(await Array.fromAsync(fetcher.items<number>('/items'))).toEqual([1, 2, 3])
  })

  it('reports the total that a link header last page implies', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify([1, 2, 3]), {
        status: 200,
        headers: { link: '<https://api.example/items?per_page=3&page=2>; rel="next", <https://api.example/items?per_page=3&page=11>; rel="last"' },
      }),
    })

    const result = await fetcher.page<number>('/items', { query: { per_page: 3 } })

    expect(result.total).toBe(33)
  })

  it('takes the total page size from the request when the last page omits it', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify([1, 2, 3]), {
        status: 200,
        headers: { link: '<https://api.example/items?page=11>; rel="last"' },
      }),
    })

    const result = await fetcher.page<number>('/items', { query: { limit: 3 } })

    expect(result.total).toBe(33)
  })

  it('takes a single-page link total from the items on the page', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify([1, 2]), {
        status: 200,
        headers: { link: '<https://api.example/items?per_page=50&page=1>; rel="last"' },
      }),
    })

    const result = await fetcher.page<number>('/items', { query: { per_page: 50 } })

    expect(result.total).toBe(2)
  })

  it('prefers a total that the selector reports over the link header', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify({ items: [1], total_count: 7 }), {
        status: 200,
        headers: { link: '<https://api.example/items?per_page=1&page=99>; rel="last"' },
      }),
    })

    const result = await fetcher.page<number>('/items', {
      select: body => ({ items: (body as { items: number[] }).items, total: (body as { total_count: number }).total_count }),
    })

    expect(result.total).toBe(7)
  })

  it('leaves the total undefined when the response reports none', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify([1])),
    })

    const result = await fetcher.page<number>('/items')

    expect(result.total).toBeUndefined()
  })

  it('prefers the exact x-total header over the link estimate', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify([1, 2, 3]), {
        status: 200,
        headers: {
          'x-total': '262',
          'link': '<https://api.example/items?per_page=3&page=88>; rel="last"',
        },
      }),
    })

    const result = await fetcher.page<number>('/items', { query: { per_page: 3 } })

    expect(result.total).toBe(262)
  })

  it('reads an x-total-count header even when it matches the page, except on a timeline', async () => {
    const counted = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify([1, 2, 3]), { status: 200, headers: { 'x-total-count': '35' } }),
    })
    expect((await counted.page<number>('/items')).total).toBe(35)

    // A one-page listing still reports its exact total.
    const onePage = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify([1, 2, 3]), { status: 200, headers: { 'x-total-count': '3' } }),
    })
    expect((await onePage.page<number>('/items')).total).toBe(3)

    // A Forgejo or Gitea timeline reports the page's own length there.
    const timeline = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify([1, 2, 3]), { status: 200, headers: { 'x-total-count': '3' } }),
    })
    expect((await timeline.page<number>('/issues/1/timeline')).total).toBeUndefined()
  })

  it('follows a next URL from the body when given a selector', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async url => new Response(JSON.stringify(url.includes('page=2')
        ? { values: [3] }
        : { values: [1, 2], next: 'https://api.example/items?page=2' })),
    })
    const items = fetcher.items<number>('/items', {
      select: (body) => {
        const { values, next } = body as { values: number[], next?: string }
        return { items: values, next }
      },
    })

    expect(await Array.fromAsync(items)).toEqual([1, 2, 3])
  })

  it('retries a secondary rate limit once and reports the retry', async () => {
    const onRetry = vi.fn()
    let attempts = 0
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      onRetry,
      fetch: async () => {
        attempts++
        if (attempts === 1) {
          return new Response('{"message":"slow down"}', { status: 403, headers: { 'retry-after': '0' } })
        }
        return new Response('{"ok":true}', { status: 200 })
      },
    })

    await expect(fetcher.json('/thing')).resolves.toMatchObject({ data: { ok: true } })
    expect(attempts).toBe(2)
    expect(onRetry).toHaveBeenCalledWith({ url: 'https://api.example/thing', method: 'GET', wait: 0 })
  })

  it('reports the rate limit of every response from the API origin', async () => {
    const onRateLimit = vi.fn()
    const budget = (remaining: string) => ({ 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': '1700000000', 'x-ratelimit-resource': 'search' })
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      onRateLimit,
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.origin !== 'https://api.example') {
          return new Response('bytes', { status: 200, headers: budget('1') })
        }
        switch (url.pathname) {
          case '/search':
            return Response.json([], { headers: budget('29') })
          case '/cached':
            return new Response(null, { status: 304, headers: budget('28') })
          case '/download':
            return new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } })
          case '/limited':
            return new Response('{}', { status: 403, headers: budget('0') })
          default:
            return Response.json({})
        }
      },
    })

    const { response } = await fetcher.page<unknown>('/search')
    await fetcher.json('/cached', { etag: '"e"' })
    await fetcher.json('/plain')
    await (await fetcher.stream('/download')).body.cancel()
    await expect(fetcher.json('/limited', { method: 'POST' })).rejects.toBeInstanceOf(RateLimitedError)

    const resetAt = new Date(1_700_000_000_000)
    expect(rateLimitOf(response)).toEqual({ limit: 30, remaining: 29, resetAt, resource: 'search' })
    expect(onRateLimit.mock.calls.map(([event]) => event)).toEqual([
      { url: 'https://api.example/search', method: 'GET', rateLimit: { limit: 30, remaining: 29, resetAt, resource: 'search' } },
      { url: 'https://api.example/cached', method: 'GET', rateLimit: { limit: 30, remaining: 28, resetAt, resource: 'search' } },
      { url: 'https://api.example/limited', method: 'POST', rateLimit: { limit: 30, remaining: 0, resetAt, resource: 'search' } },
    ])
  })

  it('gives up on a primary rate limit without retrying', async () => {
    let attempts = 0
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => {
        attempts++
        return new Response('{"message":"limit"}', {
          status: 429,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
        })
      },
    })

    const error = await fetcher.json('/thing').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(RateLimitedError)
    expect((error as RateLimitedError).resetAt).toEqual(new Date(1_800_000_000_000))
    expect(attempts).toBe(1)
  })

  it('treats a zero request budget as missing access rather than a rate limit', async () => {
    const fetch = async () => new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: { 'x-ratelimit-limit': '0', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
    })
    const anonymous = createFetcher({ baseUrl: 'https://api.example', fetch })
    const authenticated = createFetcher({ baseUrl: 'https://api.example', fetch, authHeaders: () => ({ authorization: 'Bearer t' }) })

    const missing = await anonymous.json('/graphql', { method: 'POST' }).catch((error: unknown) => error)
    const insufficient = await authenticated.json('/graphql', { method: 'POST' }).catch((error: unknown) => error)

    expect(missing).toBeInstanceOf(AuthenticationRequiredError)
    expect((missing as AuthenticationRequiredError).body).toContain('rate limit exceeded')
    expect(insufficient).toBeInstanceOf(InsufficientScopeError)
    expect(insufficient).not.toBeInstanceOf(RateLimitedError)
  })

  it('wraps other failures with status and a body excerpt', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response('{"message":"Not Found"}', { status: 404 }),
    })

    const error = await fetcher.json('/missing').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ForgeApiError)
    expect((error as ForgeApiError).status).toBe(404)
    expect((error as ForgeApiError).body).toContain('Not Found')
  })

  it('names the code of a failed connection', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
      },
    })

    const error = await fetcher.json('/thing').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ForgeNetworkError)
    expect((error as Error).message).toBe('Request to https://api.example/thing failed: fetch failed (ECONNRESET)')
  })

  it('names the reason of a failed connection without a code', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('bad port') })
      },
    })

    await expect(fetcher.json('/thing')).rejects.toThrow('Request to https://api.example/thing failed: fetch failed (bad port)')
  })

  it('keeps the digits of an integer beyond the safe range, leaving other numbers as numbers', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async () => new Response('{"id":3847328607500238881,"scale":1.5e300}'),
    })

    expect((await fetcher.json('/numbers')).data).toEqual({ id: '3847328607500238881', scale: 1.5e300 })
  })
})

describe('streaming transport', () => {
  function cdnFetcher() {
    const calls: Array<{ url: string, authorization: string | null }> = []
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      authHeaders: () => ({ authorization: 'Bearer secret' }),
      fetch: async (url, init) => {
        calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
        if (url.startsWith('https://api.example')) {
          return new Response(null, { status: 302, headers: { location: 'https://cdn.example/asset.bin' } })
        }
        return new Response(new Blob([new Uint8Array([1, 2, 3])]).stream(), { status: 200 })
      },
    })
    return { fetcher, calls }
  }

  it('follows a redirect to another host without forwarding the credential', async () => {
    const { fetcher, calls } = cdnFetcher()

    const result = await fetcher.stream('/releases/assets/9')

    expect(result.status).toBe(200)
    expect([...new Uint8Array(await new Response(result.body).arrayBuffer())]).toEqual([1, 2, 3])
    expect(calls.map(call => call.authorization)).toEqual(['Bearer secret', null])
    expect(calls[1]!.url).toBe('https://cdn.example/asset.bin')
  })

  it('maps a failed download from another host to a forge error', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async url => url.startsWith('https://api.example')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/asset.bin' } })
        : new Response('gone', { status: 410 }),
    })

    await expect(fetcher.stream('/releases/assets/9')).rejects.toMatchObject({ status: 410 })
  })

  it('lets the runtime follow a redirect it hides', async () => {
    const modes: Array<RequestRedirect | undefined> = []
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async (_url, init) => {
        modes.push(init?.redirect)
        if (init?.redirect === 'manual') {
          return { ...Response.error(), type: 'opaqueredirect', ok: false, status: 0, clone: () => new Response('') } as unknown as Response
        }
        return new Response('asset', { status: 200 })
      },
    })

    expect(await new Response((await fetcher.stream('/releases/assets/9')).body).text()).toBe('asset')
    expect(modes).toEqual(['manual', 'follow'])
  })

  it('answers `request()` with the stream when `raw` is set', async () => {
    const { fetcher } = cdnFetcher()
    const request = createRequest(fetcher)

    const result = await request('GET', '/releases/assets/9', { raw: true })

    expect(result.status).toBe(200)
    expect(result.body).toBeInstanceOf(ReadableStream)
  })
})

describe('403 classification', () => {
  const forbidden = (body: string, headers: Record<string, string> = {}) => createFetcher({
    baseUrl: 'https://api.example',
    fetch: async () => new Response(body, { status: 403, headers }),
  })

  it('maps an organisation restriction to ForbiddenError with a reason', async () => {
    const error = await forbidden('{"message":"Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions"}')
      .json('/thing')
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ForbiddenError)
    expect((error as ForbiddenError).reason).toBe('org_restriction')
    expect((error as ForbiddenError).reasonRaw).toBeTruthy()
  })

  it('maps an SSO requirement to ForbiddenError', async () => {
    const error = await forbidden('{"message":"Resource protected by organization SAML enforcement"}').json('/thing').catch((error: unknown) => error)

    expect((error as ForbiddenError).reason).toBe('sso_required')
  })

  it('maps a contributor list that is too large to ForbiddenError', async () => {
    const error = await forbidden('{"message":"The history or contributor list is too large to list contributors for this repository via the API.","status":"403"}').json('/thing').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ForbiddenError)
    expect((error as ForbiddenError).reason).toBe('unknown')
    expect((error as ForbiddenError).reasonRaw).toBe('contributor list is too large to list contributors for this repository via the API')
  })

  it('maps a 403 whose body reports a rate limit to RateLimitedError', async () => {
    const error = await forbidden('403 Forbidden (Rate Limit Exceeded)').json('/thing').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(RateLimitedError)
  })

  it('keeps a 403 that only quotes a rate limit as InsufficientScopeError', async () => {
    const error = await forbidden('{"message":"The issue says: rate limit exceeded after 3 tries"}').json('/thing').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(InsufficientScopeError)
    expect(error).not.toBeInstanceOf(RateLimitedError)
  })

  it('keeps a scope mismatch as InsufficientScopeError, with the scopes the forge named', async () => {
    const error = await forbidden('{"message":"nope"}', { 'x-accepted-oauth-scopes': 'repo, public_repo', 'x-oauth-scopes': 'read:user, gist' })
      .json('/thing')
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(InsufficientScopeError)
    expect(error).not.toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ acceptedScopes: ['repo', 'public_repo'], grantedScopes: ['read:user', 'gist'] })
  })

  it('reports the fine-grained permissions a refused request needs', async () => {
    const error = await forbidden('{"message":"Resource not accessible by personal access token"}', { 'x-accepted-github-permissions': 'issues=write; pull_requests=write' })
      .json('/thing')
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(InsufficientScopeError)
    expect(error).toMatchObject({ acceptedPermissionsRaw: 'issues=write; pull_requests=write' })
    expect((error as InsufficientScopeError).acceptedScopes).toBeUndefined()
  })

  it('reads where to authorise SSO from the X-GitHub-SSO header', async () => {
    const url = 'https://github.com/orgs/acme/sso?authorization_request=A1B2'
    const error = await forbidden('{"message":"Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization."}', { 'x-github-sso': `required; url=${url}` })
      .json('/thing')
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ reason: 'sso_required', ssoUrl: url })
  })

  it('keeps an unrecognised 403 as InsufficientScopeError', async () => {
    const error = await forbidden('{"message":"nope"}').json('/thing').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(InsufficientScopeError)
  })
})

describe('default query', () => {
  it('adds parameters every request lacks, and leaves a request\'s own value alone', async () => {
    const seen: string[] = []
    const fetcher = createFetcher({
      baseUrl: 'https://forge.example',
      query: { 'api-version': '7.1' },
      fetch: async (url) => {
        seen.push(url)
        return new Response('{}', { status: 200 })
      },
    })
    await fetcher.json('/a')
    await fetcher.json('/b', { query: { 'api-version': '7.1-preview.4' } })

    expect(seen).toEqual(['https://forge.example/a?api-version=7.1', 'https://forge.example/b?api-version=7.1-preview.4'])
  })
})

describe('cancellation and rate-limit resets', () => {
  it('rethrows the caller\'s abort reason rather than a timeout', async () => {
    const controller = new AbortController()
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: (_url, init) => new Promise((_, reject) => {
        const signal = init!.signal!
        signal.aborted ? reject(signal.reason) : signal.addEventListener('abort', () => reject(signal.reason))
      }),
    })
    const reason = new Error('cancelled')
    const pending = fetcher.json('/slow', { signal: controller.signal })
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('reads `ratelimit-reset` as seconds from now', async () => {
    const fetcher = createFetcher({ baseUrl: 'https://api.example', fetch: async () => new Response('', { status: 429, headers: { 'ratelimit-reset': '30' } }) })
    const error = await fetcher.json('/a').catch((error: unknown) => error) as RateLimitedError

    expect(error).toBeInstanceOf(RateLimitedError)
    expect(Math.round((error.resetAt!.getTime() - Date.now()) / 1000)).toBe(30)
  })

  it('reads the leading number of a limit list and an `x-ratelimit-reset` in seconds from now', () => {
    const response = new Response(null, { headers: { 'x-ratelimit-limit': '60, 60;w=3600', 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '3476' } })

    expect(rateLimitOf(response, 1_800_000_000_000)).toEqual({ limit: 60, remaining: 59, resetAt: new Date(1_800_003_476_000) })
  })

  it('reads the IETF `ratelimit` field for the policy with the fewest requests left', () => {
    const now = 1_800_000_000_000
    const codeberg = new Response(null, { headers: { 'ratelimit-policy': '"baseline";q=2000;w=600', 'ratelimit': '"baseline";r=1900;t=600' } })
    const several = new Response(null, { headers: { 'ratelimit-policy': '"burst";q=100;w=60, "day";q=1000;w=86400', 'ratelimit': '"burst";r=90;t=30, "day";r=5;t=3600' } })
    const unnamed = new Response(null, { headers: { ratelimit: '"other";r=7' } })

    expect(rateLimitOf(codeberg, now)).toEqual({ limit: 2000, remaining: 1900, resetAt: new Date(now + 600_000), resource: 'baseline' })
    expect(rateLimitOf(several, now)).toEqual({ limit: 1000, remaining: 5, resetAt: new Date(now + 3_600_000), resource: 'day' })
    expect(rateLimitOf(unnamed, now)).toEqual({ remaining: 7, resource: 'other' })
    expect(rateLimitOf(new Response(null, { headers: { 'ratelimit-policy': '3000;w=300' } }), now)).toBeUndefined()
  })

  it('reads an exhausted IETF `ratelimit` field as a rate limit', async () => {
    const fetcher = createFetcher({ baseUrl: 'https://api.example', fetch: async () => new Response('', { status: 403, headers: { 'ratelimit-policy': '"baseline";q=2000;w=600', 'ratelimit': '"baseline";r=0;t=30' } }) })
    const error = await fetcher.json('/a').catch((error: unknown) => error) as RateLimitedError

    expect(error).toBeInstanceOf(RateLimitedError)
    expect(Math.round((error.resetAt!.getTime() - Date.now()) / 1000)).toBe(30)
  })

  it('reads a Unix time in `ratelimit-reset`', async () => {
    const fetcher = createFetcher({ baseUrl: 'https://api.example', fetch: async () => new Response('', { status: 429, headers: { 'ratelimit-reset': '2000000000' } }) })
    const error = await fetcher.json('/a').catch((error: unknown) => error) as RateLimitedError

    expect(error.resetAt).toEqual(new Date(2_000_000_000_000))
  })
})

describe('credential scope', () => {
  function recordingFetcher() {
    const calls: Array<{ url: string, authorization: string | null }> = []
    const fetcher = createFetcher({
      baseUrl: 'https://api.example/v1',
      authHeaders: () => ({ authorization: 'Bearer secret' }),
      query: { 'api-version': '7.1' },
      fetch: async (url, init) => {
        calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
        return new Response('[]', { status: 200 })
      },
    })
    return { fetcher, calls }
  }

  it('rejects a cursor on another origin before fetching', async () => {
    const { fetcher, calls } = recordingFetcher()

    await expect(fetcher.page('/items', { cursor: { nextUrl: 'https://other.example/items' } })).rejects.toThrow(TypeError)

    expect(calls).toEqual([])
  })

  it('does not send the credential to another origin through `request()`', async () => {
    const { fetcher, calls } = recordingFetcher()

    await createRequest(fetcher)('GET', 'https://evil.example/x')

    expect(calls).toEqual([{ url: 'https://evil.example/x', authorization: null }])
  })

  it('still authenticates an absolute URL on its own origin', async () => {
    const { fetcher, calls } = recordingFetcher()

    await fetcher.page('/items', { cursor: { nextUrl: 'https://api.example/v1/items?page=2' } })

    expect(calls).toEqual([{ url: 'https://api.example/v1/items?page=2&api-version=7.1', authorization: 'Bearer secret' }])
  })
})

describe('path safety', () => {
  const fetcher = createFetcher({ baseUrl: 'https://api.example', fetch: async () => new Response('{}', { status: 200 }) })

  it.each([
    '/repos/a/b/issues/1/../../../../user/keys',
    '/repos/a/b/issues/%2e%2E/x',
    '/repos/a/b/issues/.%2e/x',
    '/repos/a/b/issues/1\\..\\x',
    '/repos/a/b/issues/1#/comments',
  ])('refuses %s', async (path) => {
    await expect(fetcher.json(path)).rejects.toThrow(TypeError)
  })

  it('allows dots inside a segment and dot segments in the query', async () => {
    await expect(fetcher.json('/repos/a/b.c/contents/.github/x..y?path=../z')).resolves.toMatchObject({ data: {} })
  })
})

describe('streaming timeout', () => {
  function slowBodyFetch(chunks: number) {
    return async (_url: string, init?: RequestInit) => {
      const signal = init!.signal!
      let sent = 0
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 20))
          if (signal.aborted) {
            controller.error(signal.reason)
            return
          }
          controller.enqueue(new Uint8Array([sent++]))
          if (sent === chunks) {
            controller.close()
          }
        },
      }), { status: 200 })
    }
  }

  it('times out while waiting for stream headers', async () => {
    const fetcher = createFetcher({ baseUrl: 'https://api.example', timeout: 10, fetch: (_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }) })

    await expect(fetcher.stream('/logs')).rejects.toMatchObject({ name: 'ForgeTimeoutError' })
  })

  it('preserves caller cancellation after stream headers', async () => {
    const controller = new AbortController()
    const fetcher = createFetcher({ baseUrl: 'https://api.example', timeout: 50, fetch: slowBodyFetch(8) })
    const result = await fetcher.stream('/logs', { signal: controller.signal })
    const reason = new Error('cancelled')
    controller.abort(reason)

    await expect(new Response(result.body).arrayBuffer()).rejects.toBe(reason)
  })

  it('lets a streamed body outlive the request timeout', async () => {
    const fetcher = createFetcher({ baseUrl: 'https://api.example', timeout: 50, fetch: slowBodyFetch(8) })

    const result = await fetcher.stream('/logs')

    expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toHaveLength(8)
  })

  it('still times out a JSON body that takes too long', async () => {
    const fetcher = createFetcher({ baseUrl: 'https://api.example', timeout: 50, fetch: slowBodyFetch(8) })

    await expect(fetcher.json('/slow')).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

describe('retry wait', () => {
  it('rejects with the caller\'s abort reason while waiting to retry', async () => {
    const controller = new AbortController()
    const fetcher = createFetcher({ baseUrl: 'https://api.example', fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }) })
    const reason = new Error('cancelled')
    const pending = fetcher.json('/a', { signal: controller.signal })
    setTimeout(() => controller.abort(reason), 10)

    await expect(pending).rejects.toBe(reason)
  })
})

describe('request()', () => {
  function bodyFetcher() {
    const sent: Array<{ body: unknown, contentType: string | null, method?: string }> = []
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      fetch: async (_url, init) => {
        sent.push({ body: init?.body, contentType: new Headers(init?.headers).get('content-type'), method: init?.method })
        return new Response('{}', { status: 200 })
      },
    })
    return { fetcher, sent }
  }

  it('sends bytes as they are', async () => {
    const { fetcher, sent } = bodyFetcher()
    const bytes = new Uint8Array([1, 2, 3])

    await createRequest(fetcher)('POST', '/upload', { body: bytes, headers: { 'content-type': 'application/octet-stream' } })

    expect(sent).toEqual([{ body: bytes, contentType: 'application/octet-stream', method: 'POST' }])
  })

  it.each([
    new Blob(['content']),
    new FormData(),
    new URLSearchParams({ a: '1' }),
    new ArrayBuffer(2),
    new DataView(new ArrayBuffer(2)),
    new ReadableStream(),
  ])('preserves native fetch bodies: %s', async (body) => {
    const { fetcher, sent } = bodyFetcher()

    await createRequest(fetcher)('POST', '/x', { body })

    expect(sent[0]!.body).toBe(body)
    expect(sent[0]!.contentType).toBeNull()
  })

  it('preserves JSON serialization of dates and custom objects', async () => {
    const { fetcher, sent } = bodyFetcher()
    class Value {
      toJSON() {
        return { value: 1 }
      }
    }

    await createRequest(fetcher)('POST', '/x', { body: new Date(0) })
    await createRequest(fetcher)('POST', '/x', { body: new Value() })

    expect(sent.map(({ body, contentType }) => [body, contentType])).toEqual([
      ['"1970-01-01T00:00:00.000Z"', 'application/json'],
      ['{"value":1}', 'application/json'],
    ])
  })

  it('sends plain objects and arrays as JSON', async () => {
    const { fetcher, sent } = bodyFetcher()

    await createRequest(fetcher)('POST', '/x', { body: { a: 1 } })
    await createRequest(fetcher)('POST', '/x', { body: [1] })

    expect(sent.map(({ body, contentType }) => [body, contentType])).toEqual([['{"a":1}', 'application/json'], ['[1]', 'application/json']])
  })

  it('types a raw request passed as a variable as a stream', async () => {
    const { fetcher } = bodyFetcher()
    const options: ForgeRawRequestOptions = { raw: true }

    const result = await createRequest(fetcher)('GET', '/x', options)

    expectTypeOf(result).toEqualTypeOf<RawResponse>()
    expect(result.body).toBeInstanceOf(ReadableStream)
  })

  it('rejects a mutating request on a read-only provider unless it says it only reads', async () => {
    const { fetcher, sent } = bodyFetcher()
    const request = createRequest(fetcher, { readOnly: method => new ReadOnlyError(`${method} is a write`) })

    await expect(request('DELETE', '/x')).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(request('POST', '/x', { raw: true })).rejects.toBeInstanceOf(ReadOnlyError)
    expect(sent).toEqual([])
    await expect(request('get', '/x')).resolves.toMatchObject({ status: 200 })
    await expect(request('HEAD', '/x', { raw: true })).resolves.toMatchObject({ status: 200 })
    await expect(request('OPTIONS', '/x')).resolves.toMatchObject({ status: 200 })
    await expect(request('POST', '/graphql', { body: { query: '{ viewer { login } }' }, mutates: false })).resolves.toMatchObject({ status: 200 })
    await expect(request('GET', '/x', { mutates: true })).rejects.toBeInstanceOf(ReadOnlyError)
    expect(sent.map(call => call.method)).toEqual(['GET', 'HEAD', 'OPTIONS', 'POST'])
  })
})

describe('user agent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function sentUserAgent(userAgent?: string): Promise<string | null> {
    let seen: string | null = null
    const forge = github({
      userAgent,
      fetch: async (_url, init) => {
        seen = new Headers(init?.headers).get('user-agent')
        return new Response('{}', { status: 200 })
      },
    })
    await forge.request('GET', '/rate_limit')
    return seen
  }

  it('identifies the library outside a browser', async () => {
    expect(await sentUserAgent()).toBe('forges')
  })

  it('leaves the user agent to a browser, unless the caller sets one', async () => {
    vi.stubGlobal('document', {})

    expect(await sentUserAgent()).toBeNull()
    expect(await sentUserAgent('my-app')).toBe('my-app')
  })
})
