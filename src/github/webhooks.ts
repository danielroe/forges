import type { WebhookHandlers } from '../define.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GitHubOptions } from './index.ts'
import { verifyHmacSignature } from '../webhooks.ts'
import { GITHUB_WEBHOOK_EVENTS } from './webhook-events.ts'

export const SIGNATURE_HEADER = 'x-hub-signature-256'

export function verifyGitHubSignature(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: SIGNATURE_HEADER, prefix: 'sha256=' })
}

export const githubWebhooks: WebhookHandlers<GitHubOptions> = ({ options, instance }) => ({
  events: GITHUB_WEBHOOK_EVENTS,
  verify: delivery => verifyGitHubSignature(delivery, options.webhookSecret),
  translate: async delivery => (await import('./events.ts')).translateGitHubWebhook(instance, delivery),
})
