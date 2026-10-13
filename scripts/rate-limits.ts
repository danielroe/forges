import type { FetchLike } from '../src/fetch.ts'

const LIMIT_MESSAGE = /\brate.?limit|\btoo many requests\b|\bsubmitted too quickly\b|\babuse detection\b/i

function header(response: Response, name: string): number | undefined {
  const value = response.headers.get(name)
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined
}

/**
 * How long a forge asks to wait before a rate-limited request is sent again,
 * in milliseconds: `NaN` for a limit that names no wait, and `undefined` for a
 * response that is not rate limited.
 */
export async function rateLimitWait(response: Response, now = Date.now()): Promise<number | undefined> {
  if (response.status < 400 || response.status >= 500 || response.status === 401 || response.status === 404) {
    return undefined
  }
  const retryAfter = response.headers.get('retry-after')
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('ratelimit-remaining') === '0'
  const limited = response.status === 429 || (response.status === 403 && (exhausted || retryAfter !== null)) || LIMIT_MESSAGE.test((await response.clone().text()).slice(0, 2000))
  if (!limited) {
    return undefined
  }
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    const date = Date.parse(retryAfter)
    return Number.isFinite(seconds) ? seconds * 1000 : Number.isNaN(date) ? Number.NaN : Math.max(0, date - now)
  }
  const epoch = header(response, 'x-ratelimit-reset')
  const reset = header(response, 'ratelimit-reset')
  if (exhausted && epoch !== undefined) {
    return Math.max(0, epoch * 1000 - now)
  }
  if (exhausted && reset !== undefined) {
    return reset > 1_000_000_000 ? Math.max(0, reset * 1000 - now) : reset * 1000
  }
  return Number.NaN
}

export interface PatientFetchOptions {
  /** The least time between the starts of two requests that are not `GET` or `HEAD`, in milliseconds. */
  writeGap?: number
  /** The longest wait a rate limit may ask for and still be waited out, in milliseconds. */
  maxWait?: number
  /** How long to wait, once per request, for a rate limit that names no wait, in milliseconds. */
  unnamedWait?: number
  /** How many times one request is sent at most. */
  attempts?: number
  /** How long each attempt may take, in milliseconds, apart from any signal the caller passes. */
  timeout?: number
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Wraps `fetch` so that writes are spaced out, and a request a forge rate
 * limits is sent again once the wait the forge names has passed, unless the
 * caller's signal has aborted. Only the last response reaches the caller. A
 * limit that asks for a longer wait than `maxWait`, or that persists, is
 * passed on, and `limited()` then names it.
 */
export function patientFetch(fetch: FetchLike, options: PatientFetchOptions = {}): { fetch: FetchLike, limited: () => string | undefined } {
  const { writeGap = 0, maxWait = 5 * 60_000, unnamedWait = 60_000, attempts = 3, timeout, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = options
  let nextWrite = 0
  let limited: string | undefined
  const patient: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (writeGap && method !== 'GET' && method !== 'HEAD') {
      const start = Math.max(now(), nextWrite)
      nextWrite = start + writeGap
      await sleep(start - now())
    }
    const resendable = init?.body === undefined || init.body === null || typeof init.body === 'string'
    let unnamed = false
    for (let attempt = 1; ; attempt++) {
      init?.signal?.throwIfAborted()
      const deadline = timeout === undefined ? undefined : AbortSignal.timeout(timeout)
      const signals = [init?.signal, deadline].filter(signal => !!signal)
      const response = await fetch(input, signals.length ? { ...init, signal: AbortSignal.any(signals) } : init).catch((error: unknown) => {
        if (deadline?.aborted && !init?.signal?.aborted) {
          log(`timed out after ${timeout}ms: ${method} ${input}`)
        }
        throw error
      })
      const wait = await rateLimitWait(response, now())
      if (wait === undefined) {
        return response
      }
      const named = !Number.isNaN(wait)
      if (resendable && attempt < attempts && (named ? wait <= maxWait : !unnamed)) {
        unnamed ||= !named
        const delay = named ? wait + 1000 : unnamedWait
        log(`rate limited ${response.status} ${method} ${input}; retrying in ${Math.ceil(delay / 1000)}s`)
        await sleep(delay)
        continue
      }
      limited ??= named ? `${method} ${input} was rate limited for ${Math.ceil(wait / 60_000)} minute(s)` : `${method} ${input} was rate limited with no wait named`
      return response
    }
  }
  return { fetch: patient, limited: () => limited }
}
