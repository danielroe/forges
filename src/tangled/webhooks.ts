import type { WebhookHandlers } from '../define.ts'
import type { WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { TangledOptions } from './index.ts'
import { verifyHmacSignature } from '../webhooks.ts'

export const SIGNATURE_HEADER = 'x-tangled-signature-256'

export function verifyTangledSignature(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: SIGNATURE_HEADER, prefix: 'sha256=' })
}

const TANGLED_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'push' },
]

export const tangledWebhooks: WebhookHandlers<TangledOptions> = ({ options, instance, baseUrl }) => ({
  events: TANGLED_WEBHOOK_EVENTS,
  verify: delivery => verifyTangledSignature(delivery, options.webhookSecret),
  translate: async (delivery) => {
    const events = (await import('./events.ts')).translateTangledWebhook(instance, delivery, baseUrl)
    if (!options.resolveDisplayNumber) {
      return events
    }
    for (const event of events) {
      const thread = event.thread
      if (thread?.displayNumber && !thread.number) {
        const number = await options.resolveDisplayNumber(thread.repo, thread.kind, thread.displayNumber)
        if (number) {
          event.thread = { ...thread, number, externalId: number }
        }
      }
    }
    return events
  },
})
