import type { EventKind, ForgeEventInput, PushCommit } from './model.ts'
import type { WebhookDelivery } from './provider.ts'
import { headerValue, hmacSha256Hex, timingSafeEqual } from './crypto.ts'

/** The first of `names` the delivery carries a non-empty value for. */
export function firstHeader(delivery: WebhookDelivery, names: string | readonly string[]): string | undefined {
  for (const name of typeof names === 'string' ? [names] : names) {
    const value = headerValue(delivery.headers, name)
    if (value) {
      return value
    }
  }
  return undefined
}

/**
 * Checks a hex HMAC-SHA256 of the raw body, sent in the first of `header`
 * present, after an optional `prefix` such as `sha256=`. The delivery's own
 * `secret` takes precedence over the provider's.
 */
export async function verifyHmacSignature(
  delivery: WebhookDelivery,
  secret: string | undefined,
  { header, prefix = '' }: { header: string | readonly string[], prefix?: string },
): Promise<boolean> {
  const signature = firstHeader(delivery, header)
  const key = delivery.secret ?? secret
  if (!key || !signature) {
    return false
  }
  return timingSafeEqual(signature.toLowerCase(), `${prefix}${await hmacSha256Hex(key, delivery.body)}`)
}

/** Checks a secret sent verbatim in `header`. */
export function verifySharedToken(delivery: WebhookDelivery, secret: string | undefined, header: string): boolean {
  const token = headerValue(delivery.headers, header)
  const key = delivery.secret ?? secret
  return Boolean(key && token && timingSafeEqual(token, key))
}

/** One ref update in a push delivery. */
export interface RefChange {
  /** A full ref such as `refs/heads/main`, or a bare name when `refType` is given. */
  ref: string
  /** Whether the ref is a branch or a tag. */
  refType?: 'branch' | 'tag'
  before?: string
  after?: string
  created?: boolean
  deleted?: boolean
  forced?: boolean
  commits?: PushCommit[]
  /** Commits pushed, when the forge reports more than it sends. */
  commitCount?: number
}

/** The kind, detail and summary of one ref update in a push: a deletion, a creation, or new commits. */
export function refEvent(who: string, change: RefChange): Pick<ForgeEventInput, 'kind' | 'action' | 'detail' | 'summary'> {
  const name = change.ref.replace(/^refs\/(?:heads|tags)\//, '')
  const refType = change.refType ?? (change.ref.startsWith('refs/tags/') ? 'tag' : 'branch')
  if (change.deleted || change.created) {
    return {
      kind: 'ref',
      action: change.deleted ? 'deleted' : 'created',
      detail: { type: 'ref', ref: change.ref, refType },
      summary: `${who} ${change.deleted ? 'deleted' : 'created'} ${name}`,
    }
  }
  const commits = change.commits ?? []
  const count = change.commitCount ?? commits.length
  return {
    kind: 'push',
    detail: { type: 'push', ref: change.ref, before: change.before, after: change.after, commitCount: count, forced: change.forced ?? false, commits },
    summary: `${who} pushed ${count} commit(s) to ${name}`,
  }
}

/** Native event names per normalised kind, as a forge names them in a hook subscription. */
export type NativeEventMap = Partial<Record<EventKind, readonly string[]>>

/** The forge's own event names for `events`, plus any `nativeEvents` passed through unchanged. */
export function nativeEventsFor(map: NativeEventMap, events: EventKind[] | undefined, nativeEvents: string[] | undefined): string[] {
  const names = new Set<string>(nativeEvents ?? [])
  for (const kind of events ?? []) {
    for (const name of map[kind] ?? []) {
      names.add(name)
    }
  }
  return [...names]
}

/** The normalised kinds a subscription to `nativeEvents` covers. */
export function eventKindsOf(map: NativeEventMap, nativeEvents: readonly string[]): EventKind[] {
  const kinds = new Set<EventKind>()
  for (const [kind, names] of Object.entries(map) as Array<[EventKind, readonly string[]]>) {
    if (nativeEvents.includes('*') || names.some(name => nativeEvents.includes(name))) {
      kinds.add(kind)
    }
  }
  return [...kinds]
}
