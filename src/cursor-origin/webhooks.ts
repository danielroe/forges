import type { Ed25519Jwk } from '../crypto.ts'
import type { WebhookHandlers } from '../define.ts'
import type { EventKind, ForgeEventInput, RepoRef, ThreadRef, WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { CursorOriginOptions } from './index.ts'
import type { OriginWebhookEnvelope } from './types.ts'
import { bodyText, headerValue, sha256Hex, verifyEd25519 } from '../crypto.ts'
import { memo, toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE, toActor, toRepoRef, toReviewEvent } from './normalise.ts'

/** Deliveries older or newer than this are refused, as Origin documents. */
const TOLERANCE_SECONDS = 300

const KEYS_TTL_MS = 600_000

/**
 * Verifies a delivery: an Ed25519 signature (`v1ed,<base64>`) over the UTF-8
 * hex SHA-256 of `<webhook-id>.<webhook-timestamp>.<body>`, against any
 * active key. Origin signatures carry no key id.
 */
export async function verifyOriginSignature(delivery: WebhookDelivery, keys: () => Promise<Ed25519Jwk[]>, now: number = Date.now()): Promise<boolean> {
  const id = headerValue(delivery.headers, 'webhook-id')
  const timestamp = Number(headerValue(delivery.headers, 'webhook-timestamp'))
  const signature = headerValue(delivery.headers, 'webhook-signature')?.split(/\s+/).find(value => value.startsWith('v1ed,'))
  if (!id || !signature || !Number.isInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > TOLERANCE_SECONDS) {
    return false
  }
  const digest = await sha256Hex(`${id}.${timestamp}.${bodyText(delivery.body)}`)
  for (const key of await keys()) {
    if (await verifyEd25519(key, digest, signature.slice('v1ed,'.length))) {
      return true
    }
  }
  return false
}

const PULL_KINDS: Record<string, EventKind> = {
  'pull_request.created': 'state_change',
  'pull_request.published': 'state_change',
  'pull_request.reopened': 'state_change',
  'pull_request.closed': 'state_change',
  'pull_request.merged': 'state_change',
  'pull_request.comment.created': 'comment',
  'pull_request.comment.reaction.added': 'reaction',
  'pull_request.comment.reaction.removed': 'reaction',
  'pull_request.label.added': 'label',
  'pull_request.label.removed': 'label',
  'pull_request.reviewer.added': 'assignment',
  'pull_request.reviewer.removed': 'assignment',
  'pull_request.reviewer.rerequested': 'assignment',
  'pull_request.head_ref.pushed': 'commit',
}

export function translateOriginWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const envelope = JSON.parse(bodyText(delivery.body)) as OriginWebhookEnvelope
  const { event } = envelope
  const payload = event.payload ?? {}
  const repo: RepoRef | undefined = payload.repository ? toRepoRef(instance, payload.repository) : undefined
  const pull = payload.pullRequest
  const thread: ThreadRef | undefined = pull && repo
    ? { forge: FORGE, instance, repo, kind: 'pull_request', number: pull.number, externalId: pull.id }
    : undefined
  const base = {
    forge: FORGE,
    instance,
    id: envelope.deliveryId ?? event.id,
    kindRaw: event.type,
    occurredAt: toDate(event.eventTime) ?? new Date(),
    repo,
    thread,
    installationId: envelope.installationId,
    source: 'webhook' as const,
    payload: envelope,
  }

  if (event.type.startsWith('pull_request.review.') && payload.review && thread) {
    return [{ ...toReviewEvent(thread, payload.review, 'webhook'), ...base }]
  }
  if (thread) {
    const actor = toActor(instance, payload.comment?.author ?? payload.actor ?? payload.createdBy ?? pull?.author)
    const kind: EventKind = payload.comment?.thread?.path ? 'review_comment' : PULL_KINDS[event.type] ?? 'other'
    return [{ ...base, kind, actor, summary: `${actor?.login ?? 'someone'}: ${event.type.replace(/^pull_request\./, '').replaceAll('.', ' ')} on #${thread.number}` }]
  }
  if (event.type === 'repository.pushed') {
    const pusher = toActor(instance, payload.pusher)
    const who = pusher?.login ?? 'someone'
    return (payload.refUpdates ?? []).map((update, index): ForgeEventInput => {
      const event = refEvent(who, {
        ref: update.ref,
        before: update.before,
        after: update.after,
        created: update.created,
        deleted: update.deleted,
        forced: update.forced,
        commits: update.headCommit?.sha ? [{ sha: update.headCommit.sha, message: update.headCommit.message ?? '' }] : [],
      })
      return {
        ...base,
        id: `${base.id}:${index}`,
        actor: pusher,
        ...event,
        ...event.kind === 'push' ? { summary: `${who} pushed to ${update.ref.replace(/^refs\/(?:heads|tags)\//, '')}` } : {},
      }
    })
  }
  if (event.type.startsWith('installation.')) {
    return [{
      ...base,
      kind: 'installation',
      installationId: payload.installation?.id ?? envelope.installationId,
      detail: { type: 'installation', actionRaw: event.type, installationId: payload.installation?.id ?? envelope.installationId, added: (payload.installation?.repositories ?? []).map(reference => toRepoRef(instance, reference)), removed: [] },
      summary: `Installation ${event.type.slice('installation.'.length)}`,
    }]
  }
  return [{ ...base, kind: 'other', summary: event.type }]
}

const ORIGIN_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'review', action: 'submitted' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'installation' },
]

export const cursorOriginWebhooks: WebhookHandlers<CursorOriginOptions> = ({ instance, baseUrl, createFetcher }) => {
  const keysFetcher = createFetcher({ baseUrl })
  const signingKeys = memo(async () => (await keysFetcher.json<{ keys: Ed25519Jwk[] }>('/keys')).data.keys ?? [], KEYS_TTL_MS)
  return {
    events: ORIGIN_WEBHOOK_EVENTS,
    verify: delivery => verifyOriginSignature(delivery, signingKeys),
    translate: delivery => translateOriginWebhook(instance, delivery),
  }
}
