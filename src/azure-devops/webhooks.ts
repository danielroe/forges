import type { WebhookHandlers } from '../define.ts'
import type { WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { AzureDevOpsOptions } from './index.ts'
import { headerValue, timingSafeEqual } from '../crypto.ts'

/**
 * Service hooks carry no signature. A subscription can send basic
 * credentials, so `secret` is `username:password` and the delivery's
 * `Authorization: Basic` header must match it.
 */
export function verifyAzureBasicAuth(delivery: WebhookDelivery, secret: string | undefined): boolean {
  const key = delivery.secret ?? secret
  const header = headerValue(delivery.headers, 'authorization')
  if (!key || !header?.startsWith('Basic ')) {
    return false
  }
  return timingSafeEqual(header, `Basic ${btoa(key)}`)
}

const AZURE_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'review', action: 'submitted' },
  { kind: 'push' },
]

export const azureDevOpsWebhooks: WebhookHandlers<AzureDevOpsOptions> = ({ options, instance }) => ({
  events: AZURE_WEBHOOK_EVENTS,
  verify: async delivery => verifyAzureBasicAuth(delivery, options.webhookSecret),
  translate: async delivery => (await import('./events.ts')).translateAzureWebhook(instance, options.organization, delivery),
})
