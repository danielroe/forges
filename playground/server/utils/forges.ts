import type { ForgeEvent, ForgeProvider, Forges } from 'forges'
import process from 'node:process'
import { createForges, ForgeApiError, ForgeError, RateLimitedError, UnsupportedOperationError, WebhookVerificationError } from 'forges'
import { providersFromEnv } from 'forges/env'

let forges: Forges | undefined
const demoRepos = new Map<ForgeProvider, { owner: string, name: string }>()

/** Providers from `FORGES_<KIND>_<FIELD>[_<SUFFIX>]` variables; see `providersFromEnv()`. */
export function useForges(): Forges {
  if (!forges) {
    const providers = providersFromEnv(process.env).flatMap((entry) => {
      if (!entry.factory) {
        return []
      }
      const provider = entry.factory.create()
      if (entry.demoRepo) {
        demoRepos.set(provider, entry.demoRepo)
      }
      return [provider]
    })
    forges = createForges(providers)
  }
  return forges
}

export function demoRepo(provider: ForgeProvider): { owner: string, name: string } | undefined {
  useForges()
  return demoRepos.get(provider)
}

/** Provider sets in the environment that could not be configured, by forge and reason only. */
export function skippedProviders(): Array<{ forge: string, suffix: string, reason: string }> {
  return providersFromEnv(process.env).flatMap(entry => entry.skipped ? [{ forge: entry.forge, suffix: entry.suffix, reason: entry.skipped }] : [])
}

const recent = new Map<string, ForgeEvent[]>()

/** Keeps the last few translated webhook events per provider, in memory. */
export function recordWebhookEvents(key: string, events: ForgeEvent[]): void {
  recent.set(key, [...events, ...recent.get(key) ?? []].slice(0, 10))
}

export function webhookEvents(key: string): ForgeEvent[] {
  return recent.get(key) ?? []
}

/** Replaces every `raw` field so forge payloads are only shown on request. */
export function redactRaw<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, item) => key === 'raw' && item !== undefined ? '[redacted]' : item) as T
}

export interface ErrorInfo {
  name: string
  message: string
  /** Status the forge responded with, for errors from the forge API. */
  status?: number
}

/** HTTP status and JSON body for an error, without leaking anything that is not a forge error. */
export function errorBody(error: unknown): { status: number, body: { error: ErrorInfo } } {
  if (!(error instanceof ForgeError)) {
    return { status: 500, body: { error: { name: 'InternalError', message: 'Internal error' } } }
  }
  const info: ErrorInfo = { name: error.name, message: error.message, ...error instanceof ForgeApiError ? { status: error.status } : {} }
  const status = error instanceof RateLimitedError
    ? 429
    : error instanceof WebhookVerificationError
      ? 401
      : error instanceof UnsupportedOperationError
        ? 501
        : error instanceof ForgeApiError && error.status >= 400 && error.status < 500 ? error.status : 502
  return { status, body: { error: info } }
}
