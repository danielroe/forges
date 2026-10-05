import type { ForgeErrorContext } from './errors.ts'
import type { Cursor, RateLimit } from './model.ts'
import { ForbiddenError, forbiddenReason, ForgeApiError, ForgeNetworkError, ForgeTimeoutError, InsufficientScopeError, RateLimitedError, TokenRevokedError } from './errors.ts'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface FetcherOptions {
  baseUrl: string
  /** Injected for tests and for runtimes with a non-global fetch. */
  fetch?: FetchLike
  /** Timeout in milliseconds (headers only for streams). Defaults to 30000. */
  timeout?: number
  /** Default headers, sent only to the API origin. */
  headers?: Record<string, string>
  /** Credentials resolved before each API-origin request. */
  authHeaders?: () => Promise<Record<string, string>> | Record<string, string>
  /** API-origin query defaults; request parameters take precedence. */
  query?: Record<string, string>
  context?: ForgeErrorContext
  /**
   * Called before a request is retried. A secondary rate limit with a
   * `retry-after` of at most a minute is retried once, after that wait.
   */
  onRetry?: (retry: { url: string, method: string, wait: number }) => void
}

export interface RequestOptions extends Omit<RequestInit, 'signal'> {
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal
  /** Send `If-None-Match`, and resolve with `notModified` instead of throwing. */
  etag?: string
  /** Serialised as the JSON request body, with a matching `content-type`. */
  json?: unknown
  /** Rewrites a failure from this request, for endpoints whose statuses mean something specific. */
  mapError?: (error: unknown) => unknown
}

export interface PaginateOptions extends RequestOptions {
  /**
   * Reads items and the next page URL from a response body, for APIs that
   * paginate in the body (Bitbucket's `values` / `next`). Without it, the
   * body is the item array and the next page comes from the `Link` header.
   * `linkNext` is the `Link` header's next URL, for APIs that wrap items in
   * the body but still paginate with `Link`.
   */
  select?: (body: unknown, linkNext?: string) => { items: unknown[], next?: string }
}

export interface FetchResult<T> {
  data: T
  response: Response
  notModified: boolean
  cursor?: Cursor
}

/** A response whose body is read as it arrives rather than parsed. */
export interface RawResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array>
}

export interface Fetcher {
  raw: (path: string, options?: RequestOptions) => Promise<Response>
  /**
   * Bytes as they arrive, through the same timeout and error mapping as
   * {@link Fetcher.json}. HTTP(S) download redirects to another origin omit
   * all headers and credentials. HTTPS downloads cannot redirect to HTTP.
   */
  stream: (path: string, options?: RequestOptions) => Promise<RawResponse>
  json: <T>(path: string, options?: RequestOptions) => Promise<FetchResult<T>>
  /** One page: `path` with its query, or `cursor.nextUrl` when given. */
  page: <T>(path: string, options?: PaginateOptions & { cursor?: Cursor }) => Promise<FetchResult<T[]>>
  /** Every item across every page, in order. */
  items: <T>(path: string, options?: PaginateOptions) => AsyncGenerator<T>
  resolve: (path: string, query?: RequestOptions['query']) => string
}

const BODY_EXCERPT_LENGTH = 512

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i

/** Parses an RFC 5988 `Link` header into a map of rel to URL. */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const links: Record<string, string> = {}
  if (!header) {
    return links
  }
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*(.+)/.exec(part.trim())
    if (!match?.[1] || !match[2]) {
      continue
    }
    const rel = /rel\s*=\s*"?([^";]+)"?/.exec(match[2])?.[1]
    if (rel) {
      links[rel.trim()] = match[1]
    }
  }
  return links
}

function cursorFrom(response: Response): Cursor | undefined {
  const next = parseLinkHeader(response.headers.get('link')).next
  const etag = response.headers.get('etag') ?? undefined
  if (!next && !etag) {
    return undefined
  }
  return { nextUrl: next, etag }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (!header) {
    return undefined
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds)) {
    return seconds * 1000
  }
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

/**
 * `x-ratelimit-reset` is a Unix time in seconds. The IETF `ratelimit-reset`
 * is seconds from now, though some forges send a Unix time there too.
 */
function resetDate(response: Response): Date | undefined {
  const epoch = headerNumber(response, 'x-ratelimit-reset')
  if (epoch !== undefined) {
    return new Date(epoch * 1000)
  }
  const reset = headerNumber(response, 'ratelimit-reset')
  if (reset === undefined) {
    return undefined
  }
  return new Date(reset > 1_000_000_000 ? reset * 1000 : Date.now() + reset * 1000)
}

function rateLimitReset(response: Response): Date | undefined {
  const reset = resetDate(response)
  if (reset) {
    return reset
  }
  const after = retryAfterMs(response)
  return after === undefined ? undefined : new Date(Date.now() + after)
}

function headerNumber(response: Response, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = response.headers.get(name)
    if (value !== null && value !== '' && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

/** The request budget a response reports, from `x-ratelimit-*` or `ratelimit-*` headers. */
export function rateLimitOf(response: Response): RateLimit | undefined {
  const limit = headerNumber(response, 'x-ratelimit-limit', 'ratelimit-limit')
  const remaining = headerNumber(response, 'x-ratelimit-remaining', 'ratelimit-remaining')
  const reset = resetDate(response)
  if (limit === undefined && remaining === undefined && reset === undefined) {
    return undefined
  }
  return {
    ...limit === undefined ? {} : { limit },
    ...remaining === undefined ? {} : { remaining },
    ...reset === undefined ? {} : { resetAt: reset },
  }
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) {
    return true
  }
  if (response.status !== 403) {
    return false
  }
  return response.headers.get('x-ratelimit-remaining') === '0'
    || response.headers.get('ratelimit-remaining') === '0'
    || response.headers.has('retry-after')
}

/**
 * One signal that aborts when any of `signals` does. `AbortSignal.any` would
 * do this, but StarlingMonkey (the wasm runtime) does not implement it.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const aborted = signals.find(signal => signal.aborted)
  if (aborted) {
    return aborted
  }
  if (signals.length === 1) {
    return signals[0]!
  }
  const controller = new AbortController()
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  for (const signal of signals) {
    const listener = () => {
      controller.abort(signal.reason)
      for (const [other, removed] of listeners) {
        other.removeEventListener('abort', removed)
      }
    }
    listeners.push([signal, listener])
    signal.addEventListener('abort', listener, { once: true })
  }
  return controller.signal
}

function assertUrl(url: URL): URL {
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new TypeError('Invalid request URL')
  }
  return url
}

function assertInput(input: string): void {
  for (const char of input) {
    const code = char.charCodeAt(0)
    if (code <= 32 || code === 127) {
      throw new TypeError('Invalid request URL')
    }
  }
}

function assertRelativePath(path: string): string {
  const pathname = path.split('?', 1)[0]!
  if (path.includes('#') || pathname.includes('\\') || pathname.split('/').some(segment => DOT_SEGMENT_RE.test(segment))) {
    throw new TypeError(`Unsafe request path ${JSON.stringify(path)}. Check the refs passed to the provider.`)
  }
  return path
}

export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createFetcher(options: FetcherOptions): Fetcher {
  const timeout = options.timeout ?? 30_000
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  assertInput(options.baseUrl)
  const base = assertUrl(new URL(options.baseUrl))
  if (base.search || base.hash) {
    throw new TypeError('Invalid API base URL')
  }
  base.pathname = `${base.pathname.replace(/\/$/, '')}/`
  const baseOrigin = base.origin

  function resolve(path: string, query?: RequestOptions['query']): string {
    assertInput(path)
    let url: URL | undefined
    try {
      url = new URL(path)
    }
    catch {
      if (path.startsWith('//') || path.split('/', 1)[0]!.includes(':')) {
        throw new TypeError('Invalid request URL')
      }
    }
    url = assertUrl(url ?? new URL(assertRelativePath(path).replace(/^\//, ''), base))
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  function withDefaultQuery(url: string): string {
    if (!options.query) {
      return url
    }
    const target = new URL(url)
    for (const [key, value] of Object.entries(options.query)) {
      if (!target.searchParams.has(key)) {
        target.searchParams.set(key, value)
      }
    }
    return target.toString()
  }

  async function send(url: string, options_: RequestOptions, attempt: number, authenticated = true, download = false, redirects = 0, streaming = false): Promise<Response> {
    const target = assertUrl(new URL(url))
    const trusted = authenticated && target.origin === baseOrigin
    const controller = streaming ? new AbortController() : undefined
    const timer = controller ? setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout) : undefined
    const signals = [controller?.signal ?? AbortSignal.timeout(timeout)]
    if (options_.signal) {
      signals.push(options_.signal)
    }
    const headers = new Headers(trusted ? options.headers : undefined)
    for (const [key, value] of Object.entries(trusted ? await (options.authHeaders?.() ?? {}) : {})) {
      headers.set(key, value)
    }
    for (const [key, value] of new Headers(options_.headers as HeadersInit | undefined)) {
      headers.set(key, value)
    }
    if (options_.etag) {
      headers.set('if-none-match', options_.etag)
    }
    const { json: payload, mapError: _mapError, ...init } = options_
    if (payload !== undefined) {
      headers.set('content-type', 'application/json')
    }

    let response: Response
    try {
      response = await doFetch(trusted ? withDefaultQuery(url) : url, {
        ...init,
        redirect: 'manual',
        credentials: trusted ? init.credentials : 'omit',
        headers,
        body: payload === undefined ? init.body : JSON.stringify(payload),
        signal: anySignal(signals),
      })
    }
    catch (cause) {
      if (options_.signal?.aborted) {
        throw options_.signal.reason ?? cause
      }
      if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
        throw new ForgeTimeoutError(
          `Request to ${url} timed out after ${timeout}ms`,
          timeout,
          { ...options.context, url, method: options_.method ?? 'GET' },
          { cause },
        )
      }
      throw new ForgeNetworkError(
        `Request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { ...options.context, url, method: options_.method ?? 'GET' },
        { cause },
      )
    }
    finally {
      clearTimeout(timer)
    }

    if (response.type === 'opaqueredirect' && options_.redirect !== 'manual') {
      throw new TypeError('Hidden redirect refused')
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null
    if (location && options_.redirect !== 'manual') {
      await response.body?.cancel()
      if (options_.redirect === 'error' || redirects >= 20) {
        throw new TypeError('Request redirect refused')
      }
      assertInput(location)
      const next = assertUrl(new URL(location, target))
      const sameOrigin = next.origin === target.origin
      if ((!sameOrigin && !download) || (target.protocol === 'https:' && next.protocol !== 'https:')) {
        throw new TypeError('Unsafe request redirect')
      }
      const method = (options_.method ?? 'GET').toUpperCase()
      if (!sameOrigin && method !== 'GET' && method !== 'HEAD') {
        throw new TypeError('Unsafe request redirect')
      }
      let nextOptions = options_
      if (!sameOrigin) {
        nextOptions = { method, signal: options_.signal, credentials: 'omit' }
      }
      else if ((response.status === 303 && method !== 'HEAD') || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        const nextHeaders = new Headers(options_.headers)
        for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) {
          nextHeaders.delete(name)
        }
        nextOptions = { ...options_, method: 'GET', body: undefined, json: undefined, headers: nextHeaders }
      }
      return send(next.toString(), nextOptions, attempt, authenticated && sameOrigin, download, redirects + 1, streaming)
    }
    if (response.ok || response.status === 304 || (options_.redirect === 'manual' && (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)))) {
      return response
    }

    const body = (await response.text()).slice(0, BODY_EXCERPT_LENGTH)
    const context = { ...options.context, url, method: options_.method ?? 'GET' }

    if (response.status === 401) {
      throw new TokenRevokedError('Credentials were rejected by the forge', 401, body, context)
    }

    if (isRateLimited(response)) {
      const secondary = response.status === 403 || response.headers.has('retry-after')
      const wait = retryAfterMs(response)
      if (secondary && attempt === 0 && wait !== undefined && wait <= 60_000) {
        options.onRetry?.({ url, method: options_.method ?? 'GET', wait })
        await sleep(wait, options_.signal)
        return send(url, options_, attempt + 1, authenticated, download, redirects, streaming)
      }
      throw new RateLimitedError('Rate limited by the forge', response.status, body, {
        ...context,
        resetAt: rateLimitReset(response),
        secondary,
      })
    }

    if (response.status === 403) {
      const accepted = response.headers.get('x-accepted-oauth-scopes')
      const held = response.headers.get('x-oauth-scopes')
      const missingScope = accepted !== null && accepted !== ''
        && !accepted.split(',').some(scope => (held ?? '').split(',').map(value => value.trim()).includes(scope.trim()))
      const forbidden = missingScope ? undefined : forbiddenReason(body)
      if (!forbidden) {
        throw new InsufficientScopeError('Credentials lack the scope or permission for this request', 403, body, context)
      }
      throw new ForbiddenError(`Forge refused the request (${forbidden.reason})`, 403, body, forbidden.reason, { ...context, reasonRaw: forbidden.reasonRaw })
    }

    throw new ForgeApiError(
      `Forge responded with ${response.status} for ${options_.method ?? 'GET'} ${url}`,
      response.status,
      body,
      context,
    )
  }

  async function raw(path: string, options_: RequestOptions = {}): Promise<Response> {
    try {
      return await send(resolve(path, options_.query), options_, 0)
    }
    catch (error) {
      throw options_.mapError ? options_.mapError(error) : error
    }
  }

  async function json<T>(path: string, options_: RequestOptions = {}): Promise<FetchResult<T>> {
    const response = await raw(path, options_)
    if (response.status === 304 || response.status === 204) {
      return { data: undefined as T, response, notModified: response.status === 304, cursor: cursorFrom(response) }
    }
    const text = await response.text()
    return {
      data: (text ? JSON.parse(text) : undefined) as T,
      response,
      notModified: false,
      cursor: cursorFrom(response),
    }
  }

  async function page<T>(path: string, options_: PaginateOptions & { cursor?: Cursor } = {}): Promise<FetchResult<T[]>> {
    const { select, cursor, ...requestOptions } = options_
    const initial = resolve(path, requestOptions.query)
    const url = cursor?.nextUrl ? resolve(cursor.nextUrl) : initial
    if (new URL(url).origin !== new URL(initial).origin) {
      throw new TypeError('Pagination URL must remain on the requested origin')
    }
    const result: FetchResult<unknown> = await json<unknown>(url, { ...requestOptions, etag: cursor?.nextUrl ? undefined : requestOptions.etag, query: undefined })
    const next = result.notModified ? undefined : select ? select(result.data, result.cursor?.nextUrl) : undefined
    if (!next) {
      return { ...result, data: (result.data ?? []) as T[], cursor: result.cursor?.nextUrl ? result.cursor : undefined }
    }
    return { ...result, data: next.items as T[], cursor: next.next ? { ...result.cursor, nextUrl: next.next } : undefined }
  }

  async function* items<T>(path: string, options_: PaginateOptions = {}): AsyncGenerator<T> {
    let cursor: Cursor | undefined
    do {
      const result: FetchResult<T[]> = await page<T>(path, { ...options_, cursor })
      yield* result.data ?? []
      cursor = result.notModified ? undefined : result.cursor
    } while (cursor?.nextUrl)
  }

  async function stream(path: string, options_: RequestOptions = {}): Promise<RawResponse> {
    try {
      const response = await send(resolve(path, options_.query), options_, 0, true, true, 0, true)
      return { status: response.status, headers: response.headers, body: response.body ?? emptyStream() }
    }
    catch (error) {
      throw options_.mapError ? options_.mapError(error) : error
    }
  }

  return { raw, stream, json, page, items, resolve }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new Blob([]).stream()
}

export interface ForgeRequestOptions {
  query?: RequestOptions['query']
  /** Native fetch bodies and strings are sent as-is; other values are sent as JSON. */
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Caller-declared mutation. Defaults to `false` for GET/HEAD/OPTIONS, otherwise `true`. */
  mutates?: boolean
}

export interface ForgeResponse<T> {
  status: number
  data: T
  headers: Headers
  rateLimit?: RateLimit
}

/** `request()` with `raw`, for endpoints that respond with bytes rather than JSON. */
export interface ForgeRawRequestOptions extends ForgeRequestOptions {
  raw: true
}

export interface ForgeRequest {
  (method: string, path: string, options: ForgeRawRequestOptions): Promise<RawResponse>
  <T = unknown>(method: string, path: string, options?: ForgeRequestOptions): Promise<ForgeResponse<T>>
}

export interface CreateRequestOptions {
  /** Error for mutating requests. */
  readOnly?: (method: string, path: string) => Error
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Builds a provider's `request()` escape hatch on top of its fetcher. */
export function createRequest(fetcher: Fetcher, { readOnly }: CreateRequestOptions = {}): ForgeRequest {
  return (async <T>(method: string, path: string, options: ForgeRequestOptions | ForgeRawRequestOptions = {}): Promise<ForgeResponse<T> | RawResponse> => {
    const upperMethod = method.toUpperCase()
    if (readOnly && (options.mutates ?? !SAFE_METHODS.has(upperMethod))) {
      throw readOnly(upperMethod, path)
    }
    const json = options.body !== undefined && isJsonBody(options.body)
    const init: RequestOptions = {
      method: upperMethod,
      query: options.query,
      signal: options.signal,
      headers: { ...json ? { 'content-type': 'application/json' } : {}, ...options.headers },
      body: options.body === undefined ? undefined : json ? JSON.stringify(options.body) : options.body as BodyInit,
    }
    if ('raw' in options && options.raw) {
      return fetcher.stream(path, init)
    }
    const result = await fetcher.json<T>(path, init)
    const rateLimit = rateLimitOf(result.response)
    return { status: result.response.status, data: result.data, headers: result.response.headers, ...rateLimit ? { rateLimit } : {} }
  }) as ForgeRequest
}

function isJsonBody(value: unknown): boolean {
  return typeof value !== 'string'
    && !(value instanceof ArrayBuffer)
    && !ArrayBuffer.isView(value)
    && !(typeof Blob !== 'undefined' && value instanceof Blob)
    && !(typeof FormData !== 'undefined' && value instanceof FormData)
    && !(value instanceof URLSearchParams)
    && !(typeof ReadableStream !== 'undefined' && value instanceof ReadableStream)
}
