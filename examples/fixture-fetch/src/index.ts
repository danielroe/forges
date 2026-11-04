import type { FetchLike } from 'forges'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface FixtureResponse {
  status: number
  headers?: Record<string, string>
  body?: unknown
}

interface Fixture {
  request: { method: string, url: string, operationName?: string }
  response: FixtureResponse
}

export interface FixtureCall {
  method: string
  url: string
  body?: string
  operationName?: string
}

export interface FixtureFetch {
  fetch: FetchLike
  calls: FixtureCall[]
}

function key(method: string, url: string, operationName?: string): string {
  const parsed = new URL(url)
  parsed.searchParams.sort()
  const base = `${method.toUpperCase()} ${parsed.origin}${parsed.pathname}${parsed.search}`
  return operationName
    ? `${base} ${operationName}`
    : base
}

function operationOf(body: string | undefined): string | undefined {
  if (!body) {
    return undefined
  }
  try {
    return (JSON.parse(body) as { operationName?: string }).operationName
  }
  catch {
    return undefined
  }
}

function load(forge: string): Fixture[] {
  const directory = fileURLToPath(new URL(`../../../test/fixtures/${forge}/`, import.meta.url))
  return readdirSync(directory)
    .filter(file => file.endsWith('.json') && file !== 'manifest.json')
    .map(file => JSON.parse(readFileSync(`${directory}${file}`, 'utf8')) as Fixture)
    .filter(fixture => fixture.request !== undefined)
}

/**
 * Builds a `fetch` serving the recorded fixtures of each named forge.
 * `extra` adds or replaces a response, keyed `METHOD url [operationName]`.
 */
export function fixtureFetch(
  forges: readonly string[],
  extra: Record<string, FixtureResponse> = {},
): FixtureFetch {
  const responses = new Map<string, FixtureResponse>()
  for (const forge of forges) {
    for (const fixture of load(forge)) {
      responses.set(key(fixture.request.method, fixture.request.url, fixture.request.operationName), fixture.response)
    }
  }
  for (const [entry, response] of Object.entries(extra)) {
    const [method = 'GET', url = '', operationName] = entry.split(' ')
    responses.set(key(method, url, operationName), response)
  }

  const calls: FixtureCall[] = []
  const fetch: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string'
      ? init.body
      : undefined
    const operationName = input.endsWith('/graphql')
      ? operationOf(body)
      : undefined
    calls.push({
      method,
      url: input,
      body,
      operationName,
    })

    const response = responses.get(key(method, input, operationName))
    if (!response) {
      throw new Error(`No fixture for ${method} ${input}${operationName
        ? ` (${operationName})`
        : ''}`)
    }
    const headers = new Headers(response.headers)
    if (response.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    const result = new Response(response.body === undefined
      ? null
      : JSON.stringify(response.body), {
      status: response.status,
      headers,
    })
    Object.defineProperty(result, 'url', { value: input })
    return result
  }

  return { fetch, calls }
}
