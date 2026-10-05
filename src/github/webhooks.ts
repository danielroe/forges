import type { WebhookHandlers } from '../define.ts'
import type { EventAction, EventDetail, EventKind, ForgeEventInput, RepoRef, ThreadKind, ThreadRef } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GitHubOptions } from './index.ts'
import type { GitHubRepository, GitHubUser } from './types.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventAction, reviewState } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent, verifyHmacSignature } from '../webhooks.ts'
import { FORGE, toActor, toRepoRef } from './normalise.ts'
import { GITHUB_WEBHOOK_EVENTS } from './webhook-events.ts'

export const SIGNATURE_HEADER = 'x-hub-signature-256'
export const EVENT_HEADER = 'x-github-event'
export const DELIVERY_HEADER = 'x-github-delivery'

export function verifyGitHubSignature(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: SIGNATURE_HEADER, prefix: 'sha256=' })
}

export interface GitHubWebhookPayload {
  action?: string
  sender?: GitHubUser
  repository?: GitHubRepository
  issue?: { number: number, title?: string, node_id?: string, pull_request?: unknown }
  pull_request?: { number: number, title?: string, node_id?: string, merged?: boolean | null, draft?: boolean, state?: string }
  discussion?: { number: number, title?: string, node_id?: string }
  comment?: { id?: number, body?: string, created_at?: string, user?: GitHubUser | null, path?: string, line?: number | null }
  review?: { id?: number, state?: string, body?: string | null, submitted_at?: string | null, user?: GitHubUser | null }
  assignee?: GitHubUser | null
  requested_reviewer?: GitHubUser | null
  label?: { name?: string }
  commits?: Array<{ id: string, message: string, timestamp?: string, url?: string, author?: { name?: string, username?: string } }>
  head_commit?: { id: string, timestamp?: string } | null
  ref?: string
  ref_type?: string
  before?: string
  after?: string
  created?: boolean
  deleted?: boolean
  forced?: boolean
  installation?: { id: number }
  repositories_added?: GitHubRepository[]
  repositories_removed?: GitHubRepository[]
  repositories?: GitHubRepository[]
  member?: GitHubUser | null
  membership?: { user?: GitHubUser }
  changes?: { repository?: { name?: { from: string } }, owner?: { from?: { user?: GitHubUser, organization?: GitHubUser } }, [key: string]: unknown }
  release?: { id: number, tag_name?: string, name?: string | null, published_at?: string | null }
}

type RepoLevel = Pick<ForgeEventInput, 'kind' | 'action' | 'detail' | 'summary'> & { occurredAt?: Date }

function repoLevel(instance: string, event: string, payload: GitHubWebhookPayload, who: string): RepoLevel | undefined {
  switch (event) {
    case 'push':
      return {
        ...refEvent(who, {
          ref: payload.ref ?? '',
          before: payload.before,
          after: payload.after,
          deleted: payload.deleted,
          forced: payload.forced,
          commits: (payload.commits ?? []).map(commit => ({ sha: commit.id, message: commit.message, author: commit.author?.username ?? commit.author?.name, url: commit.url })),
        }),
        occurredAt: payload.deleted ? undefined : toDate(payload.head_commit?.timestamp),
      }
    case 'create':
    case 'delete':
      return {
        kind: 'ref',
        action: event === 'create' ? 'created' : 'deleted',
        detail: { type: 'ref', ref: payload.ref ?? '', refType: payload.ref_type ?? 'branch' },
        summary: `${who} ${event === 'create' ? 'created' : 'deleted'} ${payload.ref_type ?? 'ref'} ${payload.ref ?? ''}`.trim(),
      }
    case 'repository':
      if (payload.action === 'renamed') {
        return { kind: 'repo', action: 'renamed', detail: { type: 'repo_renamed', from: payload.changes?.repository?.name?.from ?? '', to: payload.repository?.name ?? '' }, summary: `${who} renamed the repository` }
      }
      if (payload.action === 'transferred') {
        const from = payload.changes?.owner?.from
        return { kind: 'repo', action: 'transferred', detail: { type: 'repo_transferred', fromOwner: (from?.organization ?? from?.user)?.login, toOwner: payload.repository?.owner?.login }, summary: `${who} transferred the repository` }
      }
      if (payload.action === 'archived' || payload.action === 'unarchived') {
        return { kind: 'repo', action: payload.action, detail: { type: 'repo_archived', archived: payload.action === 'archived' }, summary: `${who} ${payload.action} the repository` }
      }
      return undefined
    case 'installation':
    case 'installation_repositories':
      return {
        kind: 'installation',
        detail: {
          type: 'installation',
          actionRaw: payload.action ?? event,
          installationId: payload.installation ? String(payload.installation.id) : undefined,
          added: (payload.repositories_added ?? (payload.action === 'created' ? payload.repositories : undefined) ?? []).map(repo => toRepoRef(instance, repo)),
          removed: (payload.repositories_removed ?? []).map(repo => toRepoRef(instance, repo)),
        },
        summary: `${who} ${payload.action ?? 'changed'} the installation`,
      }
    case 'member':
    case 'membership':
      return {
        kind: 'membership',
        detail: { type: 'membership', actionRaw: payload.action ?? event, member: toActor(instance, payload.member ?? payload.membership?.user) },
        summary: `${who} ${payload.action ?? 'changed'} a member`,
      }
    case 'release':
      if (payload.action !== 'published' || !payload.release || !payload.repository) {
        return undefined
      }
      return {
        kind: 'release',
        action: 'published',
        detail: {
          type: 'release',
          release: { forge: FORGE, instance, repo: toRepoRef(instance, payload.repository), id: String(payload.release.id), tag: payload.release.tag_name },
          name: payload.release.name ?? undefined,
        },
        summary: `${who} published ${payload.release.name ?? payload.release.tag_name ?? 'a release'}`,
        occurredAt: toDate(payload.release.published_at),
      }
    default:
      return undefined
  }
}

const THREAD_EVENT_KIND: Record<string, EventKind> = {
  issue_comment: 'comment',
  discussion_comment: 'comment',
  commit_comment: 'comment',
  pull_request_review: 'review',
  pull_request_review_comment: 'review_comment',
}

function threadOf(payload: GitHubWebhookPayload, repo: RepoRef | undefined, instance: string): ThreadRef | undefined {
  if (!repo) {
    return undefined
  }
  const candidates: Array<[ThreadKind, { number: number, node_id?: string } | undefined]> = [
    ['pull_request', payload.pull_request],
    ['discussion', payload.discussion],
    [payload.issue?.pull_request ? 'pull_request' : 'issue', payload.issue],
  ]
  for (const [kind, subject] of candidates) {
    if (subject) {
      return { forge: FORGE, instance, repo, kind, number: String(subject.number), externalId: subject.node_id }
    }
  }
  return undefined
}

function eventKindFor(event: string, payload: GitHubWebhookPayload): EventKind {
  const mapped = THREAD_EVENT_KIND[event]
  if (mapped) {
    return mapped
  }
  if (event === 'issues' || event === 'pull_request' || event === 'discussion') {
    switch (payload.action) {
      case 'labeled':
      case 'unlabeled':
        return 'label'
      case 'assigned':
      case 'unassigned':
        return 'assignment'
      case 'closed':
      case 'reopened':
      case 'opened':
      case 'ready_for_review':
      case 'converted_to_draft':
        return 'state_change'
      case 'synchronize':
        return 'commit'
      case 'review_requested':
      case 'review_request_removed':
        return 'assignment'
      default:
        return 'other'
    }
  }
  if (event.endsWith('reaction')) {
    return 'reaction'
  }
  return 'other'
}

function summarise(event: string, payload: GitHubWebhookPayload, actor: string): string {
  switch (event) {
    case 'issue_comment':
    case 'discussion_comment':
    case 'commit_comment':
      return `${actor} ${payload.action ?? 'created'} a comment`
    case 'pull_request_review':
      return `${actor} ${payload.action ?? 'submitted'} a review (${payload.review?.state ?? 'commented'})`
    case 'pull_request_review_comment':
      return `${actor} ${payload.action ?? 'created'} a review comment`
    case 'push':
      return `${actor} pushed ${payload.commits?.length ?? 0} commit(s)`
    case 'label':
      return `${actor} ${payload.action ?? 'changed'} label ${payload.label?.name ?? ''}`.trim()
    default:
      return `${actor} ${payload.action ? `${payload.action} ` : ''}${event}`.trim()
  }
}

function actionOf(event: string, payload: GitHubWebhookPayload): EventAction | undefined {
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged) {
    return 'merged'
  }
  return eventAction(payload.action)
}

function detailOf(kind: EventKind, thread: ThreadRef | undefined, instance: string, payload: GitHubWebhookPayload): EventDetail | undefined {
  const comment = payload.comment
  const commentRef = comment?.id !== undefined && thread ? { forge: FORGE, instance, thread, id: String(comment.id) } : undefined
  switch (kind) {
    case 'comment':
      return { type: 'comment', comment: commentRef, body: comment?.body }
    case 'review_comment':
      return { type: 'review_comment', comment: commentRef, body: comment?.body, path: comment?.path, line: comment?.line ?? undefined }
    case 'review':
      return { type: 'review', state: reviewState(payload.review?.state), stateRaw: payload.review?.state, body: payload.review?.body ?? undefined }
    case 'label':
      return payload.label?.name ? { type: 'label', label: payload.label.name } : undefined
    case 'assignment':
      return { type: 'assignment', assignee: toActor(instance, payload.assignee ?? payload.requested_reviewer ?? undefined) }
    case 'state_change': {
      const pull = payload.pull_request
      const state = pull?.merged ? 'merged' : payload.action === 'closed' ? 'closed' : 'open'
      return { type: 'state_change', state, draft: pull?.draft }
    }
    default:
      return undefined
  }
}

export function translateGitHubWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const event = headerValue(delivery.headers, EVENT_HEADER)
  if (!event) {
    throw new WebhookVerificationError(`Missing ${EVENT_HEADER} header`, { forge: FORGE, instance })
  }
  const deliveryId = headerValue(delivery.headers, DELIVERY_HEADER) ?? crypto.randomUUID()
  const payload = JSON.parse(bodyText(delivery.body)) as GitHubWebhookPayload
  const repo = payload.repository ? toRepoRef(instance, payload.repository) : undefined
  const thread = threadOf(payload, repo, instance)
  const actor = toActor(instance, payload.sender)
  const occurredAt = toDate(
    payload.comment?.created_at ?? payload.review?.submitted_at ?? payload.head_commit?.timestamp,
  ) ?? new Date()

  const installationId = payload.installation ? String(payload.installation.id) : undefined
  const level = repoLevel(instance, event, payload, actor?.login ?? 'someone')
  if (level) {
    return [{
      forge: FORGE,
      instance,
      id: deliveryId,
      kind: level.kind,
      action: level.action,
      kindRaw: payload.action ? `${event}.${payload.action}` : event,
      summary: level.summary,
      occurredAt: level.occurredAt ?? new Date(),
      actor,
      repo,
      detail: level.detail,
      installationId,
      source: 'webhook',
      payload,
    }]
  }

  const kind = eventKindFor(event, payload)
  return [{
    forge: FORGE,
    instance,
    id: deliveryId,
    kind,
    kindRaw: payload.action ? `${event}.${payload.action}` : event,
    action: actionOf(event, payload),
    actionRaw: payload.action,
    detail: detailOf(kind, thread, instance, payload),
    summary: summarise(event, payload, actor?.login ?? 'someone'),
    occurredAt,
    actor,
    repo,
    thread,
    installationId,
    source: 'webhook',
    payload,
  }]
}

export const githubWebhooks: WebhookHandlers<GitHubOptions> = ({ options, instance }) => ({
  events: GITHUB_WEBHOOK_EVENTS,
  verify: delivery => verifyGitHubSignature(delivery, options.webhookSecret),
  translate: delivery => translateGitHubWebhook(instance, delivery),
})
