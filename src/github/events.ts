import type { Actor, EventAction, EventDetail, EventKind, ForgeEventInput, RepoRef, SourceKind, ThreadKind, ThreadRef } from '../model.ts'
import type { GitHubRepository, GitHubUser } from './types.ts'
import { eventAction, reviewState } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE, toActor, toRepoRef } from './normalise.ts'

export interface GitHubEventPayload {
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
  ref?: string | null
  ref_type?: string
  before?: string
  after?: string
  /** The pushed sha, in an activity feed's `PushEvent`. */
  head?: string
  /** The number of commits pushed, in older activity feed `PushEvent`s. */
  size?: number
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

/** Where an event came from and what identifies it, beside what its payload says. */
export interface GitHubEventContext {
  id: string
  kindRaw: string
  actionRaw?: string
  source: SourceKind
  actor?: Actor
  repo?: RepoRef
  /** When the event happened, where the source reports it apart from the payload. */
  occurredAt?: Date
  installationId?: string
  /** The unnormalised event, when it is more than the payload. */
  payload?: unknown
}

type RepoLevel = Pick<ForgeEventInput, 'kind' | 'action' | 'detail' | 'summary'> & { occurredAt?: Date }

function repoLevel(instance: string, event: string, payload: GitHubEventPayload, who: string, repo: RepoRef | undefined): RepoLevel | undefined {
  switch (event) {
    case 'push':
      return {
        ...refEvent(who, {
          ref: payload.ref ?? '',
          before: payload.before,
          after: payload.after ?? payload.head,
          deleted: payload.deleted,
          forced: payload.forced,
          commits: payload.commits?.map(commit => ({ sha: commit.id, message: commit.message, author: commit.author?.username ?? commit.author?.name, url: commit.url })),
          commitCount: payload.size,
        }),
        occurredAt: payload.deleted ? undefined : toDate(payload.head_commit?.timestamp),
      }
    case 'create':
    case 'delete':
      if (payload.ref_type === 'repository') {
        return { kind: 'repo', action: event === 'create' ? 'created' : 'deleted', summary: `${who} ${event === 'create' ? 'created' : 'deleted'} the repository` }
      }
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
      if (payload.action !== 'published' || !payload.release || !repo) {
        return undefined
      }
      return {
        kind: 'release',
        action: 'published',
        detail: {
          type: 'release',
          release: { forge: FORGE, instance, repo, id: String(payload.release.id), tag: payload.release.tag_name },
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

function threadOf(payload: GitHubEventPayload, repo: RepoRef | undefined, instance: string): ThreadRef | undefined {
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

function eventKindFor(event: string, payload: GitHubEventPayload): EventKind {
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
      case 'merged':
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

function summarise(event: string, payload: GitHubEventPayload, actor: string): string {
  switch (event) {
    case 'issue_comment':
    case 'discussion_comment':
    case 'commit_comment':
      return `${actor} ${payload.action ?? 'created'} a comment`
    case 'pull_request_review':
      return `${actor} ${payload.action ?? 'submitted'} a review (${payload.review?.state ?? 'commented'})`
    case 'pull_request_review_comment':
      return `${actor} ${payload.action ?? 'created'} a review comment`
    case 'label':
      return `${actor} ${payload.action ?? 'changed'} label ${payload.label?.name ?? ''}`.trim()
    default:
      return `${actor} ${payload.action ? `${payload.action} ` : ''}${event}`.trim()
  }
}

function actionOf(event: string, payload: GitHubEventPayload): EventAction | undefined {
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged) {
    return 'merged'
  }
  return eventAction(payload.action)
}

function detailOf(kind: EventKind, thread: ThreadRef | undefined, instance: string, payload: GitHubEventPayload): EventDetail | undefined {
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
      const state = pull?.merged || payload.action === 'merged' ? 'merged' : payload.action === 'closed' ? 'closed' : 'open'
      return { type: 'state_change', state, draft: pull?.draft }
    }
    default:
      return undefined
  }
}

/** Normalises a GitHub event, named as a webhook names it, from a webhook delivery or an activity feed. */
export function toGitHubEvent(instance: string, event: string, payload: GitHubEventPayload, context: GitHubEventContext): ForgeEventInput {
  const { actor, repo } = context
  const level = repoLevel(instance, event, payload, actor?.login ?? 'someone', repo)
  if (level) {
    return {
      forge: FORGE,
      instance,
      id: context.id,
      kind: level.kind,
      action: level.action,
      kindRaw: context.kindRaw,
      summary: level.summary,
      occurredAt: context.occurredAt ?? level.occurredAt ?? new Date(),
      actor,
      repo,
      detail: level.detail,
      installationId: context.installationId,
      source: context.source,
      payload: context.payload ?? payload,
    }
  }
  const thread = threadOf(payload, repo, instance)
  const kind = eventKindFor(event, payload)
  return {
    forge: FORGE,
    instance,
    id: context.id,
    kind,
    kindRaw: context.kindRaw,
    action: actionOf(event, payload),
    actionRaw: context.actionRaw,
    detail: detailOf(kind, thread, instance, payload),
    summary: summarise(event, payload, actor?.login ?? 'someone'),
    occurredAt: context.occurredAt ?? toDate(payload.comment?.created_at ?? payload.review?.submitted_at ?? payload.head_commit?.timestamp) ?? new Date(),
    actor,
    repo,
    thread,
    installationId: context.installationId,
    source: context.source,
    payload: context.payload ?? payload,
  }
}
