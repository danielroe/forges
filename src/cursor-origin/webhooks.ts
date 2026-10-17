import type { Ed25519Jwk } from '../crypto.ts'
import type { WebhookHandlers } from '../define.ts'
import type { WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { CursorOriginOptions } from './index.ts'
import { bodyText, headerValue, sha256Hex, verifyEd25519 } from '../crypto.ts'
import { memo } from '../utils.ts'

/** Deliveries older or newer than this are refused, as Origin documents. */
const TOLERANCE_SECONDS = 300

const KEYS_TTL_MS = 600_000

/**
 * Verifies a delivery: an Ed25519 signature (`v1ed,<base64>`) over the UTF-8
 * hex SHA-256 of `<webhook-id>.<webhook-timestamp>.<body>`, against any
 * active key. Origin signatures carry no key id.
 */
export async function verifyOriginSignature(delivery: WebhookDelivery, keys: () => Promise<Ed25519Jwk[]>, now: number = Date.now()): Promise<boolean> {
  const id = headerValue(delivery.headers, 'webhook-id')
  const timestamp = Number(headerValue(delivery.headers, 'webhook-timestamp'))
  const signature = headerValue(delivery.headers, 'webhook-signature')?.split(/\s+/).find(value => value.startsWith('v1ed,'))
  if (!id || !signature || !Number.isInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > TOLERANCE_SECONDS) {
    return false
  }
  const digest = await sha256Hex(`${id}.${timestamp}.${bodyText(delivery.body)}`)
  for (const key of await keys()) {
    if (await verifyEd25519(key, digest, signature.slice('v1ed,'.length))) {
      return true
    }
  }
  return false
}

const ORIGIN_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'review', action: 'submitted' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'installation' },
]

export const cursorOriginWebhooks: WebhookHandlers<CursorOriginOptions> = ({ instance, baseUrl, createFetcher }) => {
  const keysFetcher = createFetcher({ baseUrl })
  const signingKeys = memo(async () => (await keysFetcher.json<{ keys: Ed25519Jwk[] }>('/keys')).data.keys ?? [], KEYS_TTL_MS)
  return {
    events: ORIGIN_WEBHOOK_EVENTS,
    verify: delivery => verifyOriginSignature(delivery, signingKeys),
    translate: async delivery => (await import('./events.ts')).translateOriginWebhook(instance, delivery),
  }
}
