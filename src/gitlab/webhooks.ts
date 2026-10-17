import type { WebhookHandlers } from '../define.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GitLabOptions } from './index.ts'
import { verifySharedToken } from '../webhooks.ts'
import { GITLAB_WEBHOOK_EVENTS } from './webhook-events.ts'

export const TOKEN_HEADER = 'x-gitlab-token'

/**
 * GitLab sends the configured secret verbatim in `X-Gitlab-Token`; there is no
 * body signature to compute.
 */
export async function verifyGitLabToken(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifySharedToken(delivery, secret, TOKEN_HEADER)
}

export const gitlabWebhooks: WebhookHandlers<GitLabOptions> = ({ options, instance }) => ({
  events: GITLAB_WEBHOOK_EVENTS,
  verify: delivery => verifyGitLabToken(delivery, options.webhookSecret),
  translate: async delivery => (await import('./events.ts')).translateGitLabWebhook(instance, delivery),
})
