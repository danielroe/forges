import type { WebhookHandlers } from '../define.ts'
import type { EventAction, EventDetail, EventKind, ForgeEventInput, ResolvedThreadRef, ReviewState, ThreadRef } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { BitbucketOptions } from './index.ts'
import type { BitbucketComment, BitbucketPullRequest, BitbucketRepository, BitbucketUser } from './types.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventTime, snapshotOfThread } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent, verifyHmacSignature } from '../webhooks.ts'
import { commentDetail, FORGE, participantReview, toActor, toPullState, toPullThread, toRepoRef } from './normalise.ts'
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
  /** On `repo:fork`, the new fork; `repository` is the repository that was forked. */
  fork?: BitbucketRepository
}

interface PullEvent {
  kind: EventKind
  action: EventAction
  review?: ReviewState
}

const PULL_EVENTS: Record<string, PullEvent> = {
  'pullrequest:created': { kind: 'state_change', action: 'opened' },
  'pullrequest:fulfilled': { kind: 'state_change', action: 'merged' },
  'pullrequest:rejected': { kind: 'state_change', action: 'closed' },
  'pullrequest:approved': { kind: 'review', action: 'submitted', review: 'approved' },
  'pullrequest:unapproved': { kind: 'review', action: 'other', review: 'dismissed' },
  'pullrequest:changes_request_created': { kind: 'review', action: 'submitted', review: 'changes_requested' },
  'pullrequest:changes_request_removed': { kind: 'review', action: 'other', review: 'dismissed' },
  'pullrequest:comment_created': { kind: 'comment', action: 'created' },
  'pullrequest:comment_updated': { kind: 'comment', action: 'edited' },
  'pullrequest:comment_deleted': { kind: 'comment', action: 'deleted' },
}

function pullDetail(event: string, pull: PullEvent, payload: BitbucketWebhookPayload, thread: ThreadRef | undefined): EventDetail | undefined {
  if (!thread) {
    return undefined
  }
  if (pull.review) {
    return participantReview(thread, (payload.approval ?? payload.changes_request)?.user ?? payload.actor, pull.review, event)
  }
  if (pull.kind === 'comment') {
    return payload.comment && commentDetail(thread, payload.comment)
  }
  return pull.kind === 'state_change' && payload.pullrequest
    ? { type: 'state_change', state: toPullState(payload.pullrequest.state), draft: payload.pullrequest.draft, reason: payload.pullrequest.reason || undefined }
    : undefined
}

/** The time of the change a pull request delivery reports, else the time the pull request last changed. */
function pullTime(event: string, payload: BitbucketWebhookPayload): string | undefined {
  const { comment, pullrequest: pull } = payload
  switch (event) {
    case 'pullrequest:created':
      return pull?.created_on
    case 'pullrequest:comment_created':
      return comment?.created_on
    case 'pullrequest:comment_updated':
      return comment?.updated_on
    case 'pullrequest:approved':
    case 'pullrequest:unapproved':
      return payload.approval?.date
    case 'pullrequest:changes_request_created':
    case 'pullrequest:changes_request_removed':
      return payload.changes_request?.date
    default:
      return undefined
  }
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
  const thread: ResolvedThreadRef | undefined = repo && payload.pullrequest
    ? { forge: FORGE, instance, repo, kind: 'pull_request', number: String(payload.pullrequest.id) }
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
        ...eventTime(toDate(change.commits?.[0]?.date)),
      }
    })
  }

  if (event === 'repo:updated' && payload.changes?.name) {
    return [{ forge: FORGE, instance, id: deliveryId, kind: 'repo', action: 'renamed', kindRaw: event, summary: `${who} renamed the repository`, occurredAt: new Date(), undated: true, actor, repo, detail: { type: 'repo_renamed', from: payload.changes.name.old, to: payload.changes.name.new }, source: 'webhook', payload }]
  }

  if (event === 'repo:fork') {
    const fork = payload.fork && toRepoRef(instance, payload.fork)
    return [{ forge: FORGE, instance, id: deliveryId, kind: 'fork', action: 'created', kindRaw: event, summary: `${who} forked the repository${fork ? ` to ${fork.owner}/${fork.name}` : ''}`, occurredAt: new Date(), undated: true, actor, repo, detail: { type: 'fork', fork }, source: 'webhook', payload }]
  }

  if (event === 'repo:transfer') {
    return [{ forge: FORGE, instance, id: deliveryId, kind: 'repo', action: 'transferred', kindRaw: event, summary: `${who} transferred the repository`, occurredAt: new Date(), undated: true, actor, repo, detail: { type: 'repo_transferred', fromOwner: payload.previous_workspace?.slug, toOwner: repo?.owner }, source: 'webhook', payload }]
  }

  const pull = PULL_EVENTS[event]
  const detail = pull && pullDetail(event, pull, payload, thread)
  return [{
    forge: FORGE,
    instance,
    id: deliveryId,
    kind: detail?.type === 'review_comment' ? 'review_comment' : pull?.kind ?? 'other',
    ...pull ? { action: pull.action } : {},
    ...detail ? { detail } : {},
    kindRaw: event,
    summary: `${who} ${event.split(':')[1]?.replaceAll('_', ' ') ?? event}`,
    ...eventTime(pull?.action === 'deleted' ? undefined : toDate(pullTime(event, payload) ?? payload.pullrequest?.updated_on)),
    actor,
    repo,
    thread,
    threadSnapshot: thread && payload.pullrequest && snapshotOfThread({ ...toPullThread(thread, payload.pullrequest), isDraft: payload.pullrequest.draft, labels: undefined }),
    source: 'webhook',
    payload,
  }]
}

export const bitbucketWebhooks: WebhookHandlers<BitbucketOptions> = ({ options, instance }) => ({
  events: BITBUCKET_WEBHOOK_EVENTS,
  verify: delivery => verifyBitbucketSignature(delivery, options.webhookSecret),
  translate: delivery => translateBitbucketWebhook(instance, delivery),
})
