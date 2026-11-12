import type { EventAction, EventDetail, EventKind, ForgeEventInput, RepoRef, ResolvedThreadRef, ThreadSnapshot } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventTime, reviewState, threadSnapshot } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE } from './normalise.ts'

interface GitCafeWebhookPayload {
  id: string
  type: string
  createdAt?: string
  repository?: { id: string, owner?: string, name?: string }
  installation?: { id: string }
  issue?: { id: string, number: number, title: string, description?: string | null, state?: string, closedReason?: string | null }
  pull?: { id: string, number: number, title: string, description?: string | null, state?: 'open' | 'closed' | 'merged', draft?: boolean, sourceBranch?: string, targetBranch?: string, headOid?: string | null }
  commentId?: string
  comment?: { id: string, body: string | null, path?: string | null, line?: number | null }
  review?: { id: string, verdict: string, body?: string | null }
  git?: { refUpdates: Array<{ ref: string, beforeOid: string, afterOid: string, created: boolean, deleted: boolean, forced: boolean }> }
}

/** The verbs that change what a thread is, as opposed to what hangs off it. */
const STATE_ACTIONS: Record<string, EventAction> = {
  created: 'opened',
  updated: 'edited',
  closed: 'closed',
  reopened: 'reopened',
  merged: 'merged',
  drafted: 'converted_to_draft',
  ready: 'ready_for_review',
  synchronized: 'synchronised',
}

const COMMENT_ACTIONS: Record<string, EventAction> = {
  comment_created: 'created',
  comment_updated: 'edited',
  comment_deleted: 'deleted',
}

const KINDS: Record<string, { kind: EventKind, action?: EventAction }> = {
  labels_updated: { kind: 'label', action: 'edited' },
  assignees_updated: { kind: 'assignment' },
  reviewers_updated: { kind: 'assignment' },
  reaction_added: { kind: 'reaction', action: 'added' },
  reaction_removed: { kind: 'reaction', action: 'removed' },
  review_submitted: { kind: 'review', action: 'submitted' },
  review_dismissed: { kind: 'review' },
}

function snapshot(payload: GitCafeWebhookPayload): ThreadSnapshot | undefined {
  const { issue, pull } = payload
  if (pull) {
    return threadSnapshot({
      title: pull.title,
      body: pull.description ?? undefined,
      state: pull.state,
      stateRaw: pull.state,
      isDraft: pull.draft,
      branches: pull.sourceBranch && pull.targetBranch
        ? {
            head: { ref: pull.sourceBranch, sha: pull.headOid ?? undefined },
            base: { ref: pull.targetBranch },
          }
        : undefined,
    })
  }
  return issue && threadSnapshot({
    title: issue.title,
    body: issue.description ?? undefined,
    state: issue.state === undefined
      ? undefined
      : issue.state === 'completed' || issue.state === 'canceled'
        ? 'closed'
        : 'open',
    stateRaw: issue.state,
    stateReason: issue.closedReason ?? undefined,
    isDraft: false,
  })
}

function classify(verb: string, payload: GitCafeWebhookPayload, thread: ResolvedThreadRef | undefined): { kind: EventKind, action?: EventAction, detail?: EventDetail } {
  const state = STATE_ACTIONS[verb]
  if (state && thread) {
    const current = snapshot(payload)
    return {
      kind: 'state_change',
      action: state,
      detail: {
        type: 'state_change',
        state: current?.state,
        draft: current?.isDraft,
        reason: current?.stateReason,
      },
    }
  }
  const commented = COMMENT_ACTIONS[verb]
  if (commented && thread) {
    const id = payload.comment?.id ?? payload.commentId
    const comment = id
      ? {
          forge: FORGE,
          instance: thread.instance,
          thread,
          id,
        }
      : undefined
    const body = payload.comment?.body ?? undefined
    return payload.comment?.path
      ? {
          kind: 'review_comment',
          action: commented,
          detail: {
            type: 'review_comment',
            comment,
            body,
            path: payload.comment.path,
            line: payload.comment.line ?? undefined,
          },
        }
      : {
          kind: 'comment',
          action: commented,
          detail: { type: 'comment', comment, body },
        }
  }
  const known = KINDS[verb]
  if (known?.kind === 'review' && thread && payload.review) {
    return {
      ...known,
      detail: {
        type: 'review',
        state: verb === 'review_dismissed'
          ? 'dismissed'
          : reviewState(payload.review.verdict),
        stateRaw: payload.review.verdict,
        body: payload.review.body ?? undefined,
        review: {
          forge: FORGE,
          instance: thread.instance,
          thread,
          id: payload.review.id,
        },
      },
    }
  }
  return known ?? { kind: 'other' }
}

/**
 * Translates one verified GitCafe delivery. A push becomes one event per ref
 * it moved; everything else becomes a single event. Payloads name accounts by
 * id alone, so events carry no `actor`.
 */
export function translateGitCafeWebhook({ instance, baseUrl }: { instance: string, baseUrl: string }, delivery: WebhookDelivery): ForgeEventInput[] {
  const origin = { forge: FORGE, instance }
  const payload = JSON.parse(bodyText(delivery.body)) as GitCafeWebhookPayload
  const type = headerValue(delivery.headers, 'x-gitcafe-event') ?? payload.type
  if (!type) {
    throw new WebhookVerificationError('Missing X-GitCafe-Event header', origin)
  }
  if (type === 'webhook.ping') {
    return []
  }
  const id = payload.id ?? headerValue(delivery.headers, 'x-gitcafe-delivery') ?? crypto.randomUUID()
  const [subject = '', verb = ''] = type.split('.')
  const repo: RepoRef | undefined = payload.repository?.owner && payload.repository.name
    ? {
        ...origin,
        owner: payload.repository.owner,
        name: payload.repository.name,
        externalId: payload.repository.id,
      }
    : undefined
  const common = {
    ...origin,
    kindRaw: type,
    actionRaw: verb,
    ...eventTime(toDate(payload.createdAt)),
    repo,
    installationId: payload.installation?.id,
    source: 'webhook' as const,
    payload,
  }
  if (subject === 'git' && payload.git) {
    return payload.git.refUpdates.map((update, index) => ({
      ...common,
      id: `${id}:${index}`,
      ...refEvent('someone', {
        ref: update.ref,
        before: update.beforeOid,
        after: update.afterOid,
        created: update.created,
        deleted: update.deleted,
        forced: update.forced,
      }),
    }))
  }
  const target = payload.pull ?? payload.issue
  const thread: ResolvedThreadRef | undefined = repo && target
    ? {
        ...origin,
        repo,
        kind: payload.pull ? 'pull_request' : 'issue',
        number: String(target.number),
        externalId: target.id,
      }
    : undefined
  const web = baseUrl.replace(/\/api$/, '')
  const current = snapshot(payload)
  return [
    {
      ...common,
      id,
      ...classify(verb, payload, thread),
      summary: target
        ? `${type} on #${target.number}`
        : type,
      thread,
      threadSnapshot: current && thread && repo
        ? { ...current, url: `${web}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${payload.pull ? 'pull' : 'issues'}/${thread.number}` }
        : current,
    },
  ]
}
