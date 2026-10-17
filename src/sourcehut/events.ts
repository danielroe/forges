import type { ForgeEventInput } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import { bodyText } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventTime } from '../events.ts'
import { toDate } from '../utils.ts'
import { FORGE } from './normalise.ts'

interface ShWebhookNode {
  uuid?: string
  event?: string
  date?: string
  repository?: { name?: string, owner?: { canonicalName?: string }, rid?: string }
  pusher?: { canonicalName?: string }
  updates?: Array<{ ref?: { name?: string }, old?: { id?: string }, new?: { id?: string } }>
}

function webhookNode(body: string): ShWebhookNode | undefined {
  try {
    const parsed = JSON.parse(body) as { data?: { webhook?: unknown } }
    const node: unknown = parsed?.data?.webhook ?? parsed
    // A primitive or array is not a delivery; treating it as one would fabricate an event.
    return typeof node === 'object' && node !== null && !Array.isArray(node) ? node as ShWebhookNode : undefined
  }
  catch {
    return undefined
  }
}

function repoOwner(node: ShWebhookNode): string {
  return node.repository?.owner?.canonicalName ?? ''
}

export function translateSourcehutWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const origin = { forge: FORGE, instance }
  const node = webhookNode(bodyText(delivery.body))
  if (!node) {
    throw new WebhookVerificationError('Sourcehut delivery is not a GraphQL result', origin)
  }
  const repo = node.repository ? { ...origin, owner: repoOwner(node), name: node.repository.name ?? '' } : undefined
  const base = { ...origin, ...eventTime(toDate(node.date)), source: 'webhook' as const, payload: node }
  if (node.event === 'GIT_POST_RECEIVE') {
    return (node.updates ?? []).map((update, index): ForgeEventInput => ({
      ...base,
      id: `${node.uuid ?? 'delivery'}-${index}`,
      kind: 'push',
      kindRaw: node.event,
      actionRaw: 'created',
      summary: `${node.pusher?.canonicalName ?? 'someone'} pushed to ${update.ref?.name ?? 'a ref'}`,
      actor: node.pusher ? { ...origin, login: node.pusher.canonicalName ?? '', id: '', isBotHint: false } : undefined,
      repo,
      detail: { type: 'push', ref: update.ref?.name ?? '', before: update.old?.id, after: update.new?.id, forced: false, commits: [] },
    }))
  }
  if (node.event === 'REPO_CREATED' || node.event === 'REPO_UPDATE' || node.event === 'REPO_DELETED') {
    const action = node.event === 'REPO_CREATED' ? 'created' : node.event === 'REPO_DELETED' ? 'deleted' : 'edited'
    return [{
      ...base,
      id: node.uuid ?? 'delivery',
      kind: 'repo',
      kindRaw: node.event,
      actionRaw: action,
      summary: `${node.event} on ${repo ? `${repo.owner}/${repo.name}` : 'a repository'}`,
      repo,
    }]
  }
  // A git pre-receive, or an event from a service whose payload we do not map: report it rather than call it a repo edit.
  return [{
    ...base,
    id: node.uuid ?? 'delivery',
    kind: 'other',
    kindRaw: node.event ?? 'delivery',
    actionRaw: 'other',
    summary: `${node.event ?? 'delivery'} on ${repo ? `${repo.owner}/${repo.name}` : 'a repository'}`,
    repo,
  }]
}
