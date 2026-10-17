import type { WebhookHandlers } from '../define.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GiteeOptions } from './index.ts'
import { headerValue, hmacSha256Base64, timingSafeEqual } from '../crypto.ts'
import { verifySharedToken } from '../webhooks.ts'
import { GITEE_WEBHOOK_EVENTS } from './webhook-events.ts'

/** Gitee rejects signatures more than an hour from the request time. */
const TOLERANCE_MS = 3_600_000

/**
 * Gitee sends either the hook password, or a signature, in `X-Gitee-Token`.
 * The signature is the URL-encoded base64 HMAC-SHA256 of
 * `<X-Gitee-Timestamp>\n<secret>` under the secret, with the timestamp in
 * milliseconds; it signs the timestamp, not the body.
 */
export async function verifyGiteeToken(delivery: WebhookDelivery, secret: string | undefined, now: number = Date.now()): Promise<boolean> {
  const token = headerValue(delivery.headers, 'x-gitee-token')
  const key = delivery.secret ?? secret
  if (!key || !token) {
    return false
  }
  if (verifySharedToken(delivery, secret, 'x-gitee-token')) {
    return true
  }
  const timestamp = headerValue(delivery.headers, 'x-gitee-timestamp')
  if (!timestamp || !(Math.abs(now - Number(timestamp)) <= TOLERANCE_MS)) {
    return false
  }
  const expected = await hmacSha256Base64(key, `${timestamp}\n${key}`)
  let received = token
  try {
    received = decodeURIComponent(token)
  }
  catch {}
  return timingSafeEqual(received, expected)
}

export const giteeWebhooks: WebhookHandlers<GiteeOptions> = ({ options, instance }) => ({
  events: GITEE_WEBHOOK_EVENTS,
  verify: delivery => verifyGiteeToken(delivery, options.webhookSecret),
  translate: async delivery => (await import('./events.ts')).translateGiteeWebhook(instance, delivery),
})
