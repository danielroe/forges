import { describe, expect, it, vi } from 'vitest'
import { createFetcher } from '../../src/fetch.ts'
import { github } from '../../src/github/index.ts'

const baseUrl = 'https://api.example/v1'

function recordingFetcher(respond: (url: string, init?: RequestInit) => Response = () => new Response('{}')) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => respond(url, init))
  const fetcher = createFetcher({ baseUrl, headers: { 'x-api-key': 'default-secret' }, authHeaders: () => ({ authorization: 'Bearer provider-secret' }), query: { version: '1' }, fetch })
  return { fetcher, fetch }
}

describe('transport security', () => {
  it.each(['/items\t', '/items\n', '/items\r', '/items\0', ' https://api.example/items', '//other.example/items', 'ftp://api.example/items', 'https://user:password@api.example/items'])('rejects invalid request input %j before fetching', async (path) => {
    const { fetcher, fetch } = recordingFetcher()
    await expect(fetcher.json(path)).rejects.toThrow(TypeError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves API base paths and parses absolute URLs', () => {
    const { fetcher } = recordingFetcher()
    expect(fetcher.resolve('/items')).toBe('https://api.example/v1/items')
    expect(fetcher.resolve('HTTPS://API.EXAMPLE/items')).toBe('https://api.example/items')
  })

  it('omits default headers and ambient credentials on other origins while retaining explicit headers', async () => {
    const { fetcher, fetch } = recordingFetcher()
    await fetcher.json('https://service.example/items', { headers: { authorization: 'Bearer service-secret' }, credentials: 'include' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://service.example/items')
    expect(new Headers(init?.headers).get('x-api-key')).toBeNull()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-secret')
    expect(init?.credentials).toBe('omit')
  })

  it('follows same-origin redirects with authentication and manual handling at every hop', async () => {
    const { fetcher, fetch } = recordingFetcher(url => url.includes('/v1/items') ? new Response(null, { status: 302, headers: { location: '/next' } }) : new Response('{}'))
    await fetcher.json('/items')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.example/v1/items?version=1', 'https://api.example/next?version=1'])
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret')
    }
  })

  it('rejects cross-origin API redirects before fetching the destination', async () => {
    const { fetcher, fetch } = recordingFetcher(() => new Response(null, { status: 302, headers: { location: 'https://service.example/items' } }))
    await expect(fetcher.json('/items')).rejects.toThrow(TypeError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('drops every header and credential across download origins, including a redirect back to the API', async () => {
    let count = 0
    const { fetcher, fetch } = recordingFetcher(() => {
      count++
      return count === 1 ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/asset' } }) : count === 2 ? new Response(null, { status: 302, headers: { location: 'https://api.example/asset' } }) : new Response('asset')
    })
    const result = await fetcher.stream('/asset', { headers: { 'x-custom-secret': 'secret', 'authorization': 'Bearer explicit' }, credentials: 'include' })
    expect(await new Response(result.body).text()).toBe('asset')
    for (const [url, init] of fetch.mock.calls.slice(1)) {
      expect([...new Headers(init?.headers)]).toEqual([])
      expect(init?.credentials).toBe('omit')
      expect(new URL(url).search).toBe('')
      expect(init?.redirect).toBe('manual')
    }
  })

  it.each(['http://api.example/asset', 'ftp://cdn.example/asset', 'https://user:password@cdn.example/asset'])('rejects unsafe download redirect %s', async (location) => {
    const { fetcher, fetch } = recordingFetcher(() => new Response(null, { status: 302, headers: { location } }))
    await expect(fetcher.stream('/asset')).rejects.toThrow(TypeError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds redirect chains', async () => {
    const { fetcher, fetch } = recordingFetcher(() => new Response(null, { status: 302, headers: { location: '/loop' } }))
    await expect(fetcher.json('/items')).rejects.toThrow('redirect refused')
    expect(fetch).toHaveBeenCalledTimes(21)
  })

  it('honours manual and error redirect modes', async () => {
    const { fetcher, fetch } = recordingFetcher(() => new Response(null, { status: 302, headers: { location: '/next' } }))
    expect((await fetcher.raw('/items', { redirect: 'manual' })).status).toBe(302)
    await expect(fetcher.raw('/items', { redirect: 'error' })).rejects.toThrow('redirect refused')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  describe('where fetch hides redirects', () => {
    function browserFetch(final: string, status = 200) {
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.redirect === 'manual') {
          const hidden = new Response(null, { status: 200 })
          Object.defineProperties(hidden, { type: { value: 'opaqueredirect' }, status: { value: 0 } })
          return hidden
        }
        const response = new Response('{"ok":true}', { status })
        Object.defineProperties(response, { url: { value: final }, redirected: { value: final !== url } })
        return response
      })
      return { fetcher: createFetcher({ baseUrl, authHeaders: () => ({ authorization: 'Bearer provider-secret' }), fetch }), fetch }
    }

    it('lets the runtime follow a same-origin redirect', async () => {
      const { fetcher, fetch } = browserFetch('https://api.example/repositories/1')

      await expect(fetcher.json('/repos/acme/old')).resolves.toMatchObject({ data: { ok: true } })
      expect(fetch.mock.calls.map(([, init]) => init?.redirect)).toEqual(['manual', 'follow'])
      expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer provider-secret')
    })

    it('rejects an API response that arrived from another origin', async () => {
      const { fetcher } = browserFetch('https://service.example/items')

      await expect(fetcher.json('/items')).rejects.toThrow('Unsafe request redirect')
    })

    it('accepts a download that arrived from another origin over HTTPS', async () => {
      const { fetcher } = browserFetch('https://cdn.example/asset')

      expect((await fetcher.stream('/asset')).status).toBe(200)
    })

    it('rejects a download that arrived over HTTP', async () => {
      const { fetcher } = browserFetch('http://cdn.example/asset')

      await expect(fetcher.stream('/asset')).rejects.toThrow('Unsafe request redirect')
    })

    it('does not send a request body again', async () => {
      const { fetcher, fetch } = browserFetch('https://api.example/next')

      await expect(fetcher.json('/items', { method: 'POST', json: { value: 1 } })).rejects.toThrow('Hidden redirect refused')
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  it('rewrites a POST redirected with 303 to a GET without its body', async () => {
    const { fetcher, fetch } = recordingFetcher(url => url.includes('/v1/items') ? new Response(null, { status: 303, headers: { location: '/next' } }) : new Response('{}'))
    await fetcher.json('/items', { method: 'POST', json: { value: 1 } })
    const [, init] = fetch.mock.calls[1]!
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('content-type')).toBeNull()
  })

  it('does not redirect request bodies to download origins', async () => {
    const { fetcher, fetch } = recordingFetcher(() => new Response(null, { status: 307, headers: { location: 'https://cdn.example/asset' } }))
    await expect(fetcher.stream('/asset', { method: 'POST', body: 'secret' })).rejects.toThrow(TypeError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-origin next links from response bodies', async () => {
    const { fetcher, fetch } = recordingFetcher(() => new Response('{"items":[1],"next":"https://service.example/items"}'))
    const iterable = fetcher.items('/items', { select: body => body as { items: unknown[], next?: string } })
    await expect(Array.fromAsync(iterable)).rejects.toThrow('Pagination URL')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('requires the configured web origin and no embedded credentials when parsing', () => {
    const provider = github({}).create()
    expect(provider.parseUrl('http://github.com/acme/widgets')).toBeUndefined()
    expect(provider.parseUrl('https://user:password@github.com/acme/widgets')).toBeUndefined()
    expect(provider.parseUrl('https://github.com/acme/widgets')?.repo.name).toBe('widgets')
  })
})
