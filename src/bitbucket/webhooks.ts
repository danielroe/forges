import type { WebhookHandlers } from '../define.ts'
import type { EventKind, ForgeEventInput, ThreadRef } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { BitbucketOptions } from './index.ts'
import type { BitbucketComment, BitbucketIssue, BitbucketPullRequest, BitbucketRepository, BitbucketUser } from './types.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { toDate } from '../utils.ts'
import { refEvent, verifyHmacSignature } from '../webhooks.ts'
import { FORGE, toActor, toRepoRef } from './normalise.ts'
import { BITBUCKET_WEBHOOK_EVENTS } from './webhook-events.ts'

export const SIGNATURE_HEADER = 'x-hub-signature'
export const EVENT_HEADER = 'x-event-key'
export const DELIVERY_HEADER = 'x-request-uuid'

/** Bitbucket signs with `X-Hub-Signature: sha256=<hex>` only when the webhook has a secret. */
export function verifyBitbucketSignature(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: SIGNATURE_HEADER, prefix: 'sha256=' })
}

interface BitbucketWebhookPayload {
  actor?: BitbucketUser
  repository?: BitbucketRepository
  pullrequest?: BitbucketPullRequest
  issue?: BitbucketIssue
  comment?: BitbucketComment
  approval?: { date: string, user?: BitbucketUser }
  changes_request?: { date: string, user?: BitbucketUser }
  push?: {
    changes: Array<{
      new?: { name: string, type: string, target?: { hash: string } } | null
      old?: { name: string, type: string, target?: { hash: string } } | null
      created?: boolean
      closed?: boolean
      forced?: boolean
      commits?: Array<{ hash: string, message?: string, date?: string, author?: { raw?: string }, links?: { html?: { href: string } } }>
    }>
  }
  changes?: { name?: { old: string, new: string }, full_name?: { old: string, new: string } }
  previous_workspace?: { slug: string }
}

const EVENT_KINDS: Record<string, EventKind> = {
  'pullrequest:created': 'state_change',
  'pullrequest:fulfilled': 'state_change',
  'pullrequest:rejected': 'state_change',
  'pullrequest:approved': 'review',
  'pullrequest:unapproved': 'review',
  'pullrequest:changes_request_created': 'review',
  'pullrequest:changes_request_removed': 'review',
  'pullrequest:comment_created': 'comment',
  'issue:created': 'state_change',
  'issue:comment_created': 'comment',
}

export function translateBitbucketWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const event = headerValue(delivery.headers, EVENT_HEADER)
  if (!event) {
    throw new WebhookVerificationError(`Missing ${EVENT_HEADER} header`, { forge: FORGE, instance })
  }
  const deliveryId = headerValue(delivery.headers, DELIVERY_HEADER) ?? crypto.randomUUID()
  const payload = JSON.parse(bodyText(delivery.body)) as BitbucketWebhookPayload
  const repo = payload.repository ? toRepoRef(instance, payload.repository) : undefined
  const actor = toActor(instance, payload.actor)
  const who = actor?.login ?? 'someone'
  const subject = payload.pullrequest
    ? { kind: 'pull_request' as const, id: payload.pullrequest.id }
    : payload.issue ? { kind: 'issue' as const, id: payload.issue.id } : undefined
  const thread: ThreadRef | undefined = repo && subject
    ? { forge: FORGE, instance, repo, kind: subject.kind, number: String(subject.id) }
    : undefined

  if (event === 'repo:push' && payload.push) {
    return payload.push.changes.map((change, index): ForgeEventInput => {
      const ref = change.new ?? change.old
      const refType = ref?.type === 'tag' ? 'tag' : 'branch'
      const name = ref?.name ?? ''
      const base = { forge: FORGE, instance, id: `${deliveryId}:${index}`, kindRaw: event, actor, repo, source: 'webhook' as const, payload: { ...payload, push: { changes: [change] } } }
      return {
        ...base,
        ...refEvent(who, {
          ref: name,
          refType,
          before: change.old?.target?.hash,
          after: change.new?.target?.hash,
          deleted: change.closed,
          created: change.created && !change.commits?.length,
          forced: change.forced,
          commits: (change.commits ?? []).map(commit => ({ sha: commit.hash, message: commit.message, author: commit.author?.raw, url: commit.links?.html?.href })),
        }),
        occurredAt: toDate(change.commits?.[0]?.date) ?? new Date(),
      }
    })
  }

  if (event === 'repo:updated' && payload.changes?.name) {
    return [{ forge: FORGE, instance, id: deliveryId, kind: 'repo', action: 'renamed', kindRaw: event, summary: `${who} renamed the repository`, occurredAt: new Date(), actor, repo, detail: { type: 'repo_renamed', from: payload.changes.name.old, to: payload.changes.name.new }, source: 'webhook', payload }]
  }

  if (event === 'repo:transfer') {
    return [{ forge: FORGE, instance, id: deliveryId, kind: 'repo', action: 'transferred', kindRaw: event, summary: `${who} transferred the repository`, occurredAt: new Date(), actor, repo, detail: { type: 'repo_transferred', fromOwner: payload.previous_workspace?.slug, toOwner: repo?.owner }, source: 'webhook', payload }]
  }

  if (event === 'issue:updated' && payload.issue) {
    return [{
      forge: FORGE,
      instance,
      id: deliveryId,
      kind: 'other',
      kindRaw: event,
      summary: `${who} updated issue #${payload.issue.id}`,
      occurredAt: toDate(payload.issue.updated_on) ?? new Date(),
      actor,
      repo,
      thread,
      source: 'webhook',
      payload,
    }]
  }

  const kind = EVENT_KINDS[event] ?? 'other'
  return [{
    forge: FORGE,
    instance,
    id: deliveryId,
    kind,
    kindRaw: event,
    summary: `${who} ${event.split(':')[1]?.replaceAll('_', ' ') ?? event}`,
    occurredAt: toDate(payload.comment?.created_on ?? payload.approval?.date ?? payload.pullrequest?.updated_on) ?? new Date(),
    actor,
    repo,
    thread,
    source: 'webhook',
    payload,
  }]
}

export const bitbucketWebhooks: WebhookHandlers<BitbucketOptions> = ({ options, instance }) => ({
  events: BITBUCKET_WEBHOOK_EVENTS,
  verify: delivery => verifyBitbucketSignature(delivery, options.webhookSecret),
  translate: delivery => translateBitbucketWebhook(instance, delivery),
})
