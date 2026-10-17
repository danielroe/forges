import type { WebhookHandlers } from '../define.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { ForgejoOptions, ForgejoProfile } from './index.ts'
import type { WebhookHeaderNames } from './webhook-events.ts'
import { verifyHmacSignature } from '../webhooks.ts'
import { FORGEJO_HEADERS, FORGEJO_WEBHOOK_EVENTS } from './webhook-events.ts'

export function verifyForgejoSignature(delivery: WebhookDelivery, secret: string | undefined, names: WebhookHeaderNames = FORGEJO_HEADERS): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: names.signature })
}

/** Handlers for one deployment family; Gitea differs from Forgejo only in its header names. */
export function forgejoWebhooks(profile: ForgejoProfile): WebhookHandlers<ForgejoOptions> {
  return ({ options, origin }) => ({
    events: FORGEJO_WEBHOOK_EVENTS,
    verify: delivery => verifyForgejoSignature(delivery, options.webhookSecret, profile.headers),
    translate: async delivery => (await import('./events.ts')).translateForgejoWebhook(origin, delivery, profile.headers),
  })
}
