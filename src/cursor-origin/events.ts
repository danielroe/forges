import type { EventAction, EventDetail, EventKind, ForgeEventInput, RepoRef, ResolvedThreadRef } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { OriginWebhookEnvelope } from './types.ts'
import { bodyText } from '../crypto.ts'
import { eventTime, snapshotOfThread } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { commentDetail, FORGE, threadState, toActor, toRepoRef, toReviewEvent, toThread } from './normalise.ts'

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

const STATE_ACTIONS: Record<string, EventAction> = { 'pull_request.created': 'opened' }

export function translateOriginWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const envelope = JSON.parse(bodyText(delivery.body)) as OriginWebhookEnvelope
  const { event } = envelope
  const payload = event.payload ?? {}
  const repo: RepoRef | undefined = payload.repository ? toRepoRef(instance, payload.repository) : undefined
  const pull = payload.pullRequest
  const thread: ResolvedThreadRef | undefined = pull && repo
    ? { forge: FORGE, instance, repo, kind: 'pull_request', number: pull.number, externalId: pull.id }
    : undefined
  const normalised = thread && pull && toThread(thread, pull)
  const base = {
    forge: FORGE,
    instance,
    id: envelope.deliveryId ?? event.id,
    kindRaw: event.type,
    ...eventTime(toDate(event.eventTime ?? payload.review?.submittedAt)),
    repo,
    thread,
    threadSnapshot: normalised && snapshotOfThread({ ...normalised, isDraft: pull?.draft, labels: pull?.labels && normalised.labels }),
    installationId: envelope.installationId,
    source: 'webhook' as const,
    payload: envelope,
  }

  if (event.type.startsWith('pull_request.review.') && payload.review && thread) {
    const { undated: _undated, ...review } = toReviewEvent(thread, payload.review, 'webhook')
    return [{ ...review, ...base }]
  }
  if (thread) {
    const actor = toActor(instance, payload.comment?.author ?? payload.actor ?? payload.createdBy ?? pull?.author)
    const kind: EventKind = payload.comment?.thread?.path ? 'review_comment' : PULL_KINDS[event.type] ?? 'other'
    const detail: EventDetail | undefined = payload.comment && (kind === 'comment' || kind === 'review_comment')
      ? commentDetail(thread, payload.comment)
      : kind === 'state_change' && pull
        ? { type: 'state_change', state: threadState(pull), draft: pull.draft }
        : kind === 'label' && payload.label ? { type: 'label', label: payload.label.name } : undefined
    return [{ ...base, kind, ...STATE_ACTIONS[event.type] ? { action: STATE_ACTIONS[event.type] } : {}, ...detail ? { detail } : {}, actor, summary: `${actor?.login ?? 'someone'}: ${event.type.replace(/^pull_request\./, '').replaceAll('.', ' ')} on #${thread.number}` }]
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
