import type { WebhookHandlers } from '../define.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { BitbucketOptions } from './index.ts'
import { verifyHmacSignature } from '../webhooks.ts'
import { BITBUCKET_WEBHOOK_EVENTS } from './webhook-events.ts'

export const SIGNATURE_HEADER = 'x-hub-signature'

/** Bitbucket signs with `X-Hub-Signature: sha256=<hex>` only when the webhook has a secret. */
export function verifyBitbucketSignature(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: SIGNATURE_HEADER, prefix: 'sha256=' })
}

export const bitbucketWebhooks: WebhookHandlers<BitbucketOptions> = ({ options, instance }) => ({
  events: BITBUCKET_WEBHOOK_EVENTS,
  verify: delivery => verifyBitbucketSignature(delivery, options.webhookSecret),
  translate: async delivery => (await import('./events.ts')).translateBitbucketWebhook(instance, delivery),
})
