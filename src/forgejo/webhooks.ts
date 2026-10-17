import type { WebhookHandlers } from '../define.ts'
import type { EventDetail, EventKind, ForgeEventInput, ForgeOrigin, ResolvedThreadRef, ThreadRef } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { ForgejoOptions, ForgejoProfile } from './index.ts'
import type { ForgejoIssue, ForgejoRepository, ForgejoUser } from './types.ts'
import type { WebhookHeaderNames } from './webhook-events.ts'
import { bodyText } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventAction, eventTime, reviewState, snapshotOfThread } from '../events.ts'
import { toDate } from '../utils.ts'
import { firstHeader, refEvent, verifyHmacSignature } from '../webhooks.ts'
import { toActor, toRepoRef, toThread } from './normalise.ts'
import { FORGEJO_HEADERS, FORGEJO_WEBHOOK_EVENTS } from './webhook-events.ts'

export function verifyForgejoSignature(delivery: WebhookDelivery, secret: string | undefined, names: WebhookHeaderNames = FORGEJO_HEADERS): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: names.signature })
}

interface ForgejoWebhookPayload {
  action?: string
  sender?: ForgejoUser
  repository?: ForgejoRepository & { created_at?: string }
  issue?: ForgejoIssue
  is_pull?: boolean
  pull_request?: ForgejoIssue
  comment?: { id?: number, body?: string, created_at?: string, updated_at?: string, user?: ForgejoUser, path?: string, line?: number }
  assignee?: ForgejoUser
  review?: { type?: string, content?: string }
  label?: { name?: string }
  ref?: string
  ref_type?: string
  before?: string
  after?: string
  total_commits?: number
  commits?: Array<{ id: string, message: string, timestamp?: string, url?: string, author?: { name?: string, username?: string } }>
  head_commit?: { id: string, timestamp?: string } | null
  /** On `fork`, the repository that was forked; `repository` is the new fork. */
  forkee?: ForgejoRepository
  /** On `wiki`, the page's name. */
  page?: string
  release?: { id: number, tag_name?: string, name?: string, body?: string, prerelease?: boolean, draft?: boolean, html_url?: string, published_at?: string }
}

const EVENT_KINDS: Record<string, EventKind> = {
  issue_comment: 'comment',
  pull_request_comment: 'comment',
  pull_request_review_comment: 'review_comment',
  pull_request_review_approved: 'review',
  pull_request_review_rejected: 'review',
  pull_request_review_comment_created: 'review_comment',
  pull_request_label: 'label',
  issue_label: 'label',
  issue_assign: 'assignment',
  pull_request_assign: 'assignment',
}

function eventKindFor(event: string, payload: ForgejoWebhookPayload): EventKind {
  const mapped = EVENT_KINDS[event]
  if (mapped) {
    return mapped
  }
  if (event === 'issues' || event === 'pull_request') {
    switch (payload.action) {
      case 'label_updated':
      case 'label_cleared':
        return 'label'
      case 'assigned':
      case 'unassigned':
        return 'assignment'
      case 'opened':
      case 'closed':
      case 'reopened':
      case 'merged':
        return 'state_change'
      default:
        return 'other'
    }
  }
  return 'other'
}

const ZERO_SHA = /^0+$/

function repoLevel(origin: ForgeOrigin, event: string, payload: ForgejoWebhookPayload, who: string): Pick<ForgeEventInput, 'kind' | 'action' | 'detail' | 'summary'> | undefined {
  switch (event) {
    case 'push':
      return refEvent(who, {
        ref: payload.ref ?? '',
        before: payload.before,
        after: payload.after,
        deleted: Boolean(payload.after && ZERO_SHA.test(payload.after)),
        commits: (payload.commits ?? []).map(commit => ({ sha: commit.id, message: commit.message, author: commit.author?.username ?? commit.author?.name, url: commit.url })),
        commitCount: payload.total_commits,
      })
    case 'create':
    case 'delete':
      return {
        kind: 'ref',
        action: event === 'create' ? 'created' : 'deleted',
        detail: { type: 'ref', ref: payload.ref ?? '', refType: payload.ref_type ?? 'branch' },
        summary: `${who} ${event === 'create' ? 'created' : 'deleted'} ${payload.ref_type ?? 'ref'} ${payload.ref ?? ''}`.trim(),
      }
    case 'fork':
      return {
        kind: 'fork',
        action: 'created',
        detail: { type: 'fork', fork: payload.repository ? toRepoRef(origin, payload.repository) : undefined },
        summary: `${who} forked the repository${payload.repository ? ` to ${payload.repository.full_name}` : ''}`,
      }
    case 'wiki': {
      const action = eventAction(payload.action) ?? 'other'
      return { kind: 'wiki', action, detail: { type: 'wiki', title: payload.page }, summary: `${who} ${payload.action ?? 'edited'} wiki page ${payload.page ?? ''}`.trim() }
    }
    case 'release':
      if (!payload.release || !payload.repository) {
        return undefined
      }
      return {
        kind: 'release',
        action: eventAction(payload.action) ?? 'other',
        detail: {
          type: 'release',
          release: { ...origin, repo: toRepoRef(origin, payload.repository), id: String(payload.release.id), tag: payload.release.tag_name },
          tag: payload.release.tag_name,
          name: payload.release.name,
          body: payload.release.body || undefined,
          isPrerelease: payload.release.prerelease,
          isDraft: payload.release.draft,
          url: payload.release.html_url,
        },
        summary: `${who} ${payload.action ?? 'published'} ${payload.release.name || payload.release.tag_name || 'a release'}`,
      }
    default:
      return undefined
  }
}

function detailOf(kind: EventKind, event: string, thread: ThreadRef | undefined, origin: ForgeOrigin, payload: ForgejoWebhookPayload): EventDetail | undefined {
  const comment = payload.comment
  const commentRef = comment?.id !== undefined && thread ? { ...origin, thread, id: String(comment.id) } : undefined
  switch (kind) {
    case 'comment':
      return { type: 'comment', comment: commentRef, body: comment?.body }
    case 'review_comment':
      return { type: 'review_comment', comment: commentRef, body: comment?.body, path: comment?.path, line: comment?.line }
    case 'review': {
      const stateRaw = event.replace('pull_request_review_', '')
      return { type: 'review', state: reviewState(stateRaw === 'rejected' ? 'changes_requested' : stateRaw), stateRaw, body: payload.review?.content }
    }
    case 'label':
      return payload.label?.name ? { type: 'label', label: payload.label.name } : undefined
    case 'assignment':
      return { type: 'assignment', assignee: toActor(origin, payload.assignee) }
    case 'state_change':
      return { type: 'state_change', state: payload.pull_request?.merged ? 'merged' : payload.action === 'closed' ? 'closed' : 'open', draft: payload.pull_request?.draft }
    default:
      return undefined
  }
}

/** The time of the change a thread event reports, else the time its thread last changed, unless the event is a deletion. */
function threadTime({ action, comment, pull_request: pull }: ForgejoWebhookPayload, subject: ForgejoIssue | undefined): Date | undefined {
  if (action === 'deleted') {
    return undefined
  }
  let own: string | null | undefined
  if (comment) {
    own = action === 'edited' ? comment.updated_at : comment.created_at
  }
  else if (action === 'opened') {
    own = subject?.created_at
  }
  else if (action === 'closed' || action === 'merged') {
    own = pull?.merged_at ?? subject?.closed_at
  }
  return toDate(own ?? subject?.updated_at)
}

export function translateForgejoWebhook(origin: ForgeOrigin, delivery: WebhookDelivery, names: WebhookHeaderNames = FORGEJO_HEADERS): ForgeEventInput[] {
  const event = firstHeader(delivery, names.event)
  if (!event) {
    throw new WebhookVerificationError(`Missing ${names.event[0]} header`, origin)
  }
  const deliveryId = firstHeader(delivery, names.delivery) ?? crypto.randomUUID()
  const payload = JSON.parse(bodyText(delivery.body)) as ForgejoWebhookPayload
  const source = event === 'fork' ? payload.forkee : payload.repository
  const repo = source ? toRepoRef(origin, source) : undefined
  const actor = toActor(origin, payload.sender)
  const who = actor?.login ?? 'someone'
  const level = repoLevel(origin, event, payload, who)
  if (level) {
    return [{
      ...origin,
      id: deliveryId,
      kind: level.kind,
      action: level.action,
      kindRaw: payload.action ? `${event}.${payload.action}` : event,
      summary: level.summary,
      ...eventTime(toDate(payload.head_commit?.timestamp ?? payload.commits?.at(-1)?.timestamp ?? (payload.action === 'published' ? payload.release?.published_at : undefined) ?? (event === 'fork' ? payload.repository?.created_at : undefined))),
      actor,
      repo,
      detail: level.detail,
      source: 'webhook',
      payload,
    }]
  }
  const subject = payload.pull_request ?? payload.issue
  const isPull = Boolean(payload.pull_request || payload.is_pull || payload.issue?.pull_request)
  const thread: ResolvedThreadRef | undefined = repo && subject
    ? { ...origin, repo, kind: isPull ? 'pull_request' : 'issue', number: String(subject.number) }
    : undefined
  const normalised = thread && subject && toThread(thread, subject)
  const kind = eventKindFor(event, payload)
  return [{
    ...origin,
    id: deliveryId,
    kind,
    kindRaw: payload.action ? `${event}.${payload.action}` : event,
    action: payload.action === 'closed' && payload.pull_request?.merged ? 'merged' : eventAction(payload.action),
    actionRaw: payload.action,
    detail: detailOf(kind, event, thread, origin, payload),
    summary: `${who} ${payload.action ? `${payload.action} ` : ''}${event}`.trim(),
    ...eventTime(threadTime(payload, subject)),
    actor,
    repo,
    thread,
    threadSnapshot: normalised && snapshotOfThread({
      ...normalised,
      isDraft: isPull ? subject?.draft ?? subject?.pull_request?.draft : false,
      labels: subject?.labels && normalised.labels,
    }),
    source: 'webhook',
    payload,
  }]
}

/** Handlers for one deployment family; Gitea differs from Forgejo only in its header names. */
export function forgejoWebhooks(profile: ForgejoProfile): WebhookHandlers<ForgejoOptions> {
  return ({ options, origin }) => ({
    events: FORGEJO_WEBHOOK_EVENTS,
    verify: delivery => verifyForgejoSignature(delivery, options.webhookSecret, profile.headers),
    translate: delivery => translateForgejoWebhook(origin, delivery, profile.headers),
  })
}
