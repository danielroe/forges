import type { WebhookHandlers } from '../define.ts'
import type { WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GitHubOptions } from './definition.ts'
import { verifyHmacSignature } from '../webhooks.ts'

export const SIGNATURE_HEADER = 'x-hub-signature-256'

export function verifyGitHubSignature(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: SIGNATURE_HEADER, prefix: 'sha256=' })
}

export function githubWebhooks(events: WebhookEventType[]): WebhookHandlers<GitHubOptions> {
  return ({ options, origin }) => ({
    events,
    verify: delivery => verifyGitHubSignature(delivery, options.webhookSecret),
    translate: async delivery => (await import('./events.ts')).translateGitHubWebhook(origin, delivery),
  })
}
