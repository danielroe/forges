import type { WebhookHandlers } from '../define.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GitCafeOptions } from './index.ts'
import { headerValue, hmacSha256Hex, timingSafeEqual } from '../crypto.ts'
import { GITCAFE_WEBHOOK_EVENTS } from './webhook-events.ts'

/** How far a delivery's timestamp may be from now, so a captured request can't be replayed days later. */
const TOLERANCE_MS = 300_000

const encoder = new TextEncoder()

/**
 * GitCafe signs `<X-GitCafe-Timestamp>.<body>` with HMAC-SHA256 and sends the
 * hex digest as `X-GitCafe-Signature: sha256=…`. The timestamp is in seconds.
 */
export async function verifyGitCafeSignature(delivery: WebhookDelivery, secret: string | undefined, now: number = Date.now()): Promise<boolean> {
  const signature = headerValue(delivery.headers, 'x-gitcafe-signature')
  const timestamp = headerValue(delivery.headers, 'x-gitcafe-timestamp')
  const key = delivery.secret ?? secret
  if (!key || !signature || !timestamp || !/^\d+$/.test(timestamp)) {
    return false
  }
  if (Math.abs(now - Number(timestamp) * 1000) > TOLERANCE_MS) {
    return false
  }
  const prefix = encoder.encode(`${timestamp}.`)
  const body = typeof delivery.body === 'string'
    ? encoder.encode(delivery.body)
    : delivery.body
  const signed = new Uint8Array(prefix.length + body.length)
  signed.set(prefix)
  signed.set(body, prefix.length)
  return timingSafeEqual(signature.toLowerCase(), `sha256=${await hmacSha256Hex(key, signed)}`)
}

export const gitcafeWebhooks: WebhookHandlers<GitCafeOptions> = ({ options, instance, baseUrl }) => ({
  events: GITCAFE_WEBHOOK_EVENTS,
  verify: delivery => verifyGitCafeSignature(delivery, options.webhookSecret),
  translate: async delivery => (await import('./events.ts')).translateGitCafeWebhook({ instance, baseUrl }, delivery),
})
