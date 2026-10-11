import type { WebhookHandlers } from '../define.ts'
import type { ForgeEventInput } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GitHubEventPayload } from './events.ts'
import type { GitHubOptions } from './index.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { verifyHmacSignature } from '../webhooks.ts'
import { toGitHubEvent } from './events.ts'
import { FORGE, toActor, toRepoRef } from './normalise.ts'
import { GITHUB_WEBHOOK_EVENTS } from './webhook-events.ts'

export const SIGNATURE_HEADER = 'x-hub-signature-256'
export const EVENT_HEADER = 'x-github-event'
export const DELIVERY_HEADER = 'x-github-delivery'

export function verifyGitHubSignature(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: SIGNATURE_HEADER, prefix: 'sha256=' })
}

export function translateGitHubWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const event = headerValue(delivery.headers, EVENT_HEADER)
  if (!event) {
    throw new WebhookVerificationError(`Missing ${EVENT_HEADER} header`, { forge: FORGE, instance })
  }
  const payload = JSON.parse(bodyText(delivery.body)) as GitHubEventPayload
  return [toGitHubEvent(instance, event, payload, {
    id: headerValue(delivery.headers, DELIVERY_HEADER) ?? crypto.randomUUID(),
    kindRaw: payload.action ? `${event}.${payload.action}` : event,
    actionRaw: payload.action,
    source: 'webhook',
    actor: toActor(instance, payload.sender),
    repo: payload.repository ? toRepoRef(instance, payload.repository) : undefined,
    installationId: payload.installation ? String(payload.installation.id) : undefined,
  })]
}

export const githubWebhooks: WebhookHandlers<GitHubOptions> = ({ options, instance }) => ({
  events: GITHUB_WEBHOOK_EVENTS,
  verify: delivery => verifyGitHubSignature(delivery, options.webhookSecret),
  translate: delivery => translateGitHubWebhook(instance, delivery),
})
