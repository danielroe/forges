import type { FetchLike } from '../fetch.ts'
import type { ForgeKind } from '../model.ts'
import { hmacSha256Hex, sha256Hex, toBase64 } from '../crypto.ts'

/** One recorded or hand-authored request and its response. */
export interface Fixture {
  /** `true` when the fixture was written from documentation, not recorded. */
  handAuthored?: boolean
  /** GraphQL requests share one URL, so they are matched on `operationName` and, when recorded, `variables` too. */
  request: { method: string, url: string, operationName?: string, variables?: Record<string, unknown> }
  /** A JSON body, or the text of a response that is not JSON. */
  response: { status: number, headers?: Record<string, string>, body?: unknown }
}

export interface FixtureCall {
  method: string
  url: string
  body?: string
  operationName?: string
  variables?: Record<string, unknown>
  authorization?: string
  headers: Headers
}

export interface FixtureFetch {
  fetch: FetchLike
  /** Every request made, in order, including ones no fixture matched. */
  calls: FixtureCall[]
}

function fixtureKey(method: string, url: string, operationName?: string, variables?: Record<string, unknown>): string {
  const parsed = new URL(url)
  parsed.searchParams.sort()
  const base = `${method.toUpperCase()} ${parsed.origin}${parsed.pathname}${parsed.search}`
  const operation = operationName ? `${base} ${operationName}` : base
  return variables ? `${operation} ${JSON.stringify(variables, Object.keys(variables).sort())}` : operation
}

function operationOf(url: string, body: string | undefined): { operationName?: string, variables?: Record<string, unknown> } {
  if (!body || !url.endsWith('/graphql')) {
    return {}
  }
  try {
    const { operationName, variables } = JSON.parse(body) as { operationName?: string, variables?: Record<string, unknown> }
    return { operationName, variables }
  }
  catch {
    return {}
  }
}

function callOf(input: string, init: RequestInit | undefined): FixtureCall {
  const body = typeof init?.body === 'string' ? init.body : undefined
  const headers = new Headers(init?.headers)
  return {
    method: (init?.method ?? 'GET').toUpperCase(),
    url: input,
    body,
    ...operationOf(input, body),
    authorization: headers.get('authorization') ?? undefined,
    headers,
  }
}

/**
 * A `fetch` that serves `fixtures` and records every call. Requests match on
 * method, URL (query order ignored), GraphQL `operationName` and, where the
 * fixture has them, `variables`. `overrides`
 * replace or add responses, keyed `METHOD url [operationName]`. An unmatched
 * request throws.
 */
export function fixtureFetch(fixtures: Iterable<Fixture>, overrides: Record<string, Fixture['response']> = {}): FixtureFetch {
  const responses = new Map<string, Fixture['response']>()
  for (const fixture of fixtures) {
    responses.set(fixtureKey(fixture.request.method, fixture.request.url, fixture.request.operationName, fixture.request.variables), fixture.response)
  }
  for (const [override, response] of Object.entries(overrides)) {
    const [method = 'GET', url = '', operationName] = override.split(' ')
    responses.set(fixtureKey(method, url, operationName), response)
  }
  const calls: FixtureCall[] = []
  const fetch: FetchLike = async (input, init) => {
    const call = callOf(input, init)
    calls.push(call)
    const response = responses.get(fixtureKey(call.method, input, call.operationName, call.variables)) ?? responses.get(fixtureKey(call.method, input, call.operationName))
    if (!response) {
      throw new Error(`No fixture for ${call.method} ${input}${call.operationName ? ` (${call.operationName})` : ''}`)
    }
    const headers = new Headers(response.headers)
    const body = response.body === undefined ? null : typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
    if (body !== null && !headers.has('content-type')) {
      headers.set('content-type', typeof response.body === 'string' ? 'text/plain' : 'application/json')
    }
    const result = new Response(body, { status: response.status, headers })
    Object.defineProperty(result, 'url', { value: input })
    return result
  }
  return { fetch, calls }
}

export interface RecordingFetch {
  fetch: FetchLike
  /** One fixture per response, in order; pass them to {@link fixtureFetch} to replay. */
  fixtures: Fixture[]
}

const RECORDED_HEADERS = ['link', 'etag', 'location', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-remaining', 'ratelimit-reset', 'x-total', 'x-total-pages', 'x-next-page', 'x-page', 'x-per-page', 'total_page', 'total_count']

/**
 * Wraps `fetch` (the global one by default) and records every response as a
 * {@link Fixture}. Request headers are never recorded, but URLs and response
 * bodies are, and either can hold a secret (an installation token, a query
 * token). Use `redact` to rewrite each fixture before it is kept.
 */
export function recordingFetch(fetch: FetchLike = globalThis.fetch, redact: (fixture: Fixture) => Fixture = fixture => fixture): RecordingFetch {
  const fixtures: Fixture[] = []
  const recording: FetchLike = async (input, init) => {
    const call = callOf(input, init)
    const response = await fetch(input, init)
    const text = await response.clone().text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    }
    catch {
      body = text
    }
    const headers = Object.fromEntries(RECORDED_HEADERS.flatMap(name => response.headers.has(name) ? [[name, response.headers.get(name)!]] : []))
    fixtures.push(redact({
      request: { method: call.method, url: input, ...call.operationName ? { operationName: call.operationName, variables: call.variables } : {} },
      response: { status: response.status, headers, ...body === undefined ? {} : { body } },
    }))
    return response
  }
  return { fetch: recording, fixtures }
}

/**
 * Reads every `*.json` fixture in `directory`, skipping `manifest.json` and
 * files without a `request`. Node, Bun and Deno only.
 */
export async function loadFixtures(directory: string | URL): Promise<Fixture[]> {
  const { readdir, readFile } = await import('node:fs/promises')
  const base = typeof directory === 'string' ? directory.replace(/\/?$/, '/') : new URL(directory.href.replace(/\/?$/, '/'))
  const files = (await readdir(base)).filter(file => file.endsWith('.json') && file !== 'manifest.json').sort()
  const parsed = await Promise.all(files.map(async file => JSON.parse(await readFile(typeof base === 'string' ? `${base}${file}` : new URL(file, base), 'utf8')) as Partial<Fixture>))
  return parsed.filter((fixture): fixture is Fixture => fixture.request !== undefined)
}

async function signStandardWebhook(id: string, body: string, privateKeyBase64: string): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const digest = await sha256Hex(`${id}.${timestamp}.${body}`)
  const der = Uint8Array.from(atob(privateKeyBase64), char => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(digest)))
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1ed,${toBase64(signature)}` }
}

const SIGNERS: Partial<Record<ForgeKind, (body: string, secret: string) => Promise<Record<string, string>>>> = {
  'github': async (body, secret) => ({ 'x-hub-signature-256': `sha256=${await hmacSha256Hex(secret, body)}` }),
  'gitlab': async (_body, secret) => ({ 'x-gitlab-token': secret }),
  'forgejo': async (body, secret) => ({ 'x-forgejo-signature': await hmacSha256Hex(secret, body) }),
  'gitea': async (body, secret) => ({ 'x-gitea-signature': await hmacSha256Hex(secret, body) }),
  'bitbucket': async (body, secret) => ({ 'x-hub-signature': `sha256=${await hmacSha256Hex(secret, body)}` }),
  'tangled': async (body, secret) => ({ 'x-tangled-signature-256': `sha256=${await hmacSha256Hex(secret, body)}` }),
  'gitee': async (_body, secret) => ({ 'x-gitee-token': secret }),
  'azure-devops': async (_body, secret) => ({ authorization: `Basic ${btoa(secret)}` }),
  'cursor-origin': (body, secret) => signStandardWebhook(crypto.randomUUID(), body, secret),
  'fake': async (body, secret) => ({ 'x-fake-signature': await hmacSha256Hex(secret, body) }),
}

/**
 * Builds the headers a forge would sign `body` with, merged over `headers`
 * (the event name and delivery id, which only the caller knows). `secret` is
 * the webhook secret, or for Cursor Origin the base64 PKCS#8 Ed25519 private
 * key matching the provider's verification key.
 */
export async function signDelivery(forge: ForgeKind, body: string, secret: string, headers: Record<string, string> = {}): Promise<Record<string, string>> {
  const sign = SIGNERS[forge]
  if (!sign) {
    throw new Error(`No webhook signer for ${forge}`)
  }
  return { ...headers, ...await sign(body, secret) }
}
