import type { Actor, CommitRef, EventAction, EventDetail, EventKind, ForgeEventInput, RepoRef, SourceKind, ThreadKind, ThreadRef, ThreadSnapshot } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GitHubFeedEvent, GitHubIssue, GitHubRepository, GitHubUser } from './types.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventAction, eventTime, reviewState, threadSnapshot } from '../events.ts'
import { toDate, toPullStats } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE, toActor, toLabels, toRepoRef, toThreadState } from './normalise.ts'

const EVENT_HEADER = 'x-github-event'
const DELIVERY_HEADER = 'x-github-delivery'

interface GitHubEventSubject {
  number: number
  title?: string
  node_id?: string
  created_at?: string
  updated_at?: string
  closed_at?: string | null
}

export interface GitHubEventPayload {
  action?: string
  sender?: GitHubUser
  /** Push webhooks send `pushed_at` in seconds since the epoch. */
  repository?: GitHubRepository & { updated_at?: string | null, pushed_at?: string | number | null }
  issue?: GitHubEventThread
  pull_request?: GitHubEventThread
  discussion?: GitHubEventThread
  comment?: { id?: number, node_id?: string, body?: string, created_at?: string, updated_at?: string, user?: GitHubUser | null, path?: string, line?: number | null, commit_id?: string }
  review?: { id?: number, state?: string, body?: string | null, submitted_at?: string | null, user?: GitHubUser | null }
  assignee?: GitHubUser | null
  requested_reviewer?: GitHubUser | null
  label?: { name?: string }
  /** Webhooks name each commit by `id`, and the feeds that list commits by `sha`. */
  commits?: Array<{ id?: string, sha?: string, message: string, timestamp?: string, url?: string, author?: { name?: string, username?: string } }>
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
  forkee?: GitHubRepository & { created_at?: string | null }
  pages?: Array<{ page_name?: string, title?: string, action?: string, html_url?: string }>
  starred_at?: string | null
  release?: { id: number, tag_name?: string, name?: string | null, body?: string | null, prerelease?: boolean, draft?: boolean, html_url?: string, published_at?: string | null }
}

/** An issue, pull request or discussion as an event carries it. Activity feeds trim pull requests to the number and branches. */
interface GitHubEventThread extends GitHubEventSubject, Partial<Pick<GitHubIssue, 'state' | 'draft' | 'html_url' | 'base' | 'additions' | 'deletions' | 'changed_files' | 'commits' | 'merged_by' | 'pull_request'>> {
  body?: string | null
  state_reason?: string | null
  merged?: boolean | null
  merged_at?: string | null
  merge_commit_sha?: string | null
  user?: GitHubUser | null
  labels?: GitHubIssue['labels']
  head?: { ref: string, sha: string, repo?: (Partial<GitHubRepository> & { url?: string }) | null }
}

/** Where an event came from and what identifies it, beside what its payload says. */
interface GitHubEventContext {
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

function visibilityChange(isPublic: boolean, who: string, payload: GitHubEventPayload): RepoLevel {
  return { kind: 'repo', action: 'edited', detail: { type: 'repo_visibility', isPublic }, summary: `${who} made the repository ${isPublic ? 'public' : 'private'}`, occurredAt: toDate(payload.repository?.updated_at) }
}

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
          commits: payload.commits?.map(commit => ({ sha: commit.id ?? commit.sha ?? '', message: commit.message, author: commit.author?.username ?? commit.author?.name, url: commit.url })),
          commitCount: payload.size,
        }),
        occurredAt: payload.deleted ? undefined : pushedAt(payload.repository?.pushed_at) ?? toDate(payload.head_commit?.timestamp),
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
        return { kind: 'repo', action: 'renamed', detail: { type: 'repo_renamed', from: payload.changes?.repository?.name?.from ?? '', to: payload.repository?.name ?? '' }, summary: `${who} renamed the repository`, occurredAt: toDate(payload.repository?.updated_at) }
      }
      if (payload.action === 'transferred') {
        const from = payload.changes?.owner?.from
        return { kind: 'repo', action: 'transferred', detail: { type: 'repo_transferred', fromOwner: (from?.organization ?? from?.user)?.login, toOwner: payload.repository?.owner?.login }, summary: `${who} transferred the repository`, occurredAt: toDate(payload.repository?.updated_at) }
      }
      if (payload.action === 'archived' || payload.action === 'unarchived') {
        return { kind: 'repo', action: payload.action, detail: { type: 'repo_archived', archived: payload.action === 'archived' }, summary: `${who} ${payload.action} the repository`, occurredAt: toDate(payload.repository?.updated_at) }
      }
      if (payload.action === 'publicized' || payload.action === 'privatized') {
        return visibilityChange(payload.action === 'publicized', who, payload)
      }
      return undefined
    case 'public':
      return visibilityChange(true, who, payload)
    case 'star':
    case 'watch':
      return {
        kind: 'star',
        action: payload.action === 'deleted' ? 'deleted' : 'created',
        summary: `${who} ${payload.action === 'deleted' ? 'unstarred' : 'starred'} the repository`,
        occurredAt: toDate(payload.starred_at),
      }
    case 'fork':
      return {
        kind: 'fork',
        action: 'created',
        detail: { type: 'fork', fork: payload.forkee ? toRepoRef(instance, payload.forkee) : undefined },
        summary: `${who} forked the repository${payload.forkee ? ` to ${payload.forkee.full_name}` : ''}`,
        occurredAt: toDate(payload.forkee?.created_at),
      }
    case 'gollum': {
      const page = payload.pages?.[0]
      return {
        kind: 'wiki',
        action: eventAction(page?.action) ?? 'edited',
        detail: { type: 'wiki', title: page?.title ?? page?.page_name, url: page?.html_url },
        summary: `${who} ${page?.action ?? 'edited'} wiki page ${page?.title ?? page?.page_name ?? ''}`.trim(),
      }
    }
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
      if (!payload.release || !repo) {
        return undefined
      }
      return {
        kind: 'release',
        action: eventAction(payload.action) ?? 'other',
        detail: {
          type: 'release',
          release: { forge: FORGE, instance, repo, id: String(payload.release.id), tag: payload.release.tag_name },
          tag: payload.release.tag_name,
          name: payload.release.name ?? undefined,
          body: payload.release.body ?? undefined,
          isPrerelease: payload.release.prerelease,
          isDraft: payload.release.draft,
          url: payload.release.html_url,
        },
        summary: `${who} ${payload.action ?? 'published'} ${payload.release.name || payload.release.tag_name || 'a release'}`,
        occurredAt: payload.action === 'published' ? toDate(payload.release.published_at) : undefined,
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

/** The commit of a comment on a commit, which names no thread. */
function commitOf(payload: GitHubEventPayload, thread: ThreadRef | undefined, repo: RepoRef | undefined, instance: string): CommitRef | undefined {
  return !thread && repo && payload.comment?.commit_id ? { forge: FORGE, instance, repo, sha: payload.comment.commit_id } : undefined
}

/** The repository a pull request's head is on. Activity feeds name it by an API `url` alone. */
function headRepo(instance: string, repo: NonNullable<GitHubEventThread['head']>['repo']): RepoRef | undefined {
  if (repo?.full_name) {
    return toRepoRef(instance, repo as GitHubRepository)
  }
  const [, owner, name] = repo?.url?.match(/\/repos\/([^/]+)\/([^/]+)$/) ?? []
  return owner && name ? { forge: FORGE, instance, owner, name, externalId: repo?.id === undefined ? undefined : String(repo.id) } : undefined
}

function snapshotOf(instance: string, payload: GitHubEventPayload): ThreadSnapshot | undefined {
  const raw = payload.pull_request ?? payload.discussion ?? payload.issue
  return raw && threadSnapshot({
    title: raw.title,
    body: raw.body ?? undefined,
    state: raw.state === undefined ? undefined : toThreadState({ state: raw.state, merged: raw.merged ?? undefined, merged_at: raw.merged_at, pull_request: raw.pull_request }),
    stateRaw: raw.state,
    stateReason: raw.state_reason ?? undefined,
    isDraft: raw.draft,
    author: toActor(instance, raw.user),
    labels: raw.labels && toLabels(raw.labels),
    url: raw.html_url,
    branches: raw.head && raw.base
      ? {
          head: { ref: raw.head.ref, sha: raw.head.sha, repo: headRepo(instance, raw.head.repo) },
          base: { ref: raw.base.ref, sha: raw.base.sha },
          mergeCommitSha: raw.merge_commit_sha ?? undefined,
        }
      : undefined,
    stats: toPullStats({ additions: raw.additions, deletions: raw.deletions, changedFileCount: raw.changed_files, commitCount: raw.commits }),
    mergedBy: toActor(instance, raw.merged_by),
  })
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

function pushedAt(value: string | number | null | undefined): Date | undefined {
  return typeof value === 'number' ? new Date(value * 1000) : toDate(value)
}

/** The time of the change a thread event reports, else the time its thread last changed, unless the event is a deletion. */
function threadTime(payload: GitHubEventPayload): Date | undefined {
  if (payload.action === 'deleted') {
    return undefined
  }
  const subject = payload.pull_request ?? payload.discussion ?? payload.issue
  return toDate(ownTime(payload, subject) ?? subject?.updated_at)
}

function ownTime({ action, comment, review, pull_request: pull }: GitHubEventPayload, subject: GitHubEventSubject | undefined): string | null | undefined {
  if (comment) {
    return action === 'edited' ? comment.updated_at : comment.created_at
  }
  if (review) {
    return action === 'submitted' ? review.submitted_at : undefined
  }
  if (action === 'opened') {
    return subject?.created_at
  }
  return action === 'closed' ? pull?.merged_at ?? subject?.closed_at : undefined
}

function actionOf(event: string, payload: GitHubEventPayload): EventAction | undefined {
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged) {
    return 'merged'
  }
  return eventAction(payload.action)
}

function detailOf(kind: EventKind, thread: ThreadRef | undefined, commit: CommitRef | undefined, instance: string, payload: GitHubEventPayload): EventDetail | undefined {
  const comment = payload.comment
  const commentRef = comment?.id !== undefined && thread ? { forge: FORGE, instance, thread, id: thread.kind === 'discussion' && comment.node_id ? comment.node_id : String(comment.id) } : undefined
  switch (kind) {
    case 'comment':
      return { type: 'comment', comment: commentRef ?? (comment?.id !== undefined && commit ? { forge: FORGE, instance, commit, id: String(comment.id) } : undefined), body: comment?.body }
    case 'review_comment':
      return { type: 'review_comment', comment: commentRef, body: comment?.body, path: comment?.path, line: comment?.line ?? undefined }
    case 'review':
      return {
        type: 'review',
        state: reviewState(payload.review?.state),
        stateRaw: payload.review?.state,
        body: payload.review?.body ?? undefined,
        review: payload.review?.id !== undefined && thread ? { forge: FORGE, instance, thread, id: String(payload.review.id) } : undefined,
      }
    case 'label':
      return payload.label?.name ? { type: 'label', label: payload.label.name } : undefined
    case 'assignment':
      return { type: 'assignment', assignee: toActor(instance, payload.assignee ?? payload.requested_reviewer ?? undefined) }
    case 'state_change': {
      const pull = payload.pull_request
      const state = pull?.merged || payload.action === 'merged' ? 'merged' : payload.action === 'closed' ? 'closed' : 'open'
      const reason = payload.action === 'closed' || payload.action === 'reopened' ? payload.issue?.state_reason ?? undefined : undefined
      return { type: 'state_change', state, draft: pull?.draft, reason }
    }
    default:
      return undefined
  }
}

/** Normalises a GitHub event, named as a webhook names it, from a webhook delivery or an activity feed. */
function toGitHubEvent(instance: string, event: string, payload: GitHubEventPayload, context: GitHubEventContext): ForgeEventInput {
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
      actionRaw: context.actionRaw,
      summary: level.summary,
      ...eventTime(context.occurredAt ?? level.occurredAt),
      actor,
      repo,
      detail: level.detail,
      installationId: context.installationId,
      source: context.source,
      payload: context.payload ?? payload,
    }
  }
  const thread = threadOf(payload, repo, instance)
  const commit = commitOf(payload, thread, repo, instance)
  const kind = eventKindFor(event, payload)
  return {
    forge: FORGE,
    instance,
    id: context.id,
    kind,
    kindRaw: context.kindRaw,
    action: actionOf(event, payload),
    actionRaw: context.actionRaw,
    detail: detailOf(kind, thread, commit, instance, payload),
    summary: summarise(event, payload, actor?.login ?? 'someone'),
    ...eventTime(context.occurredAt ?? threadTime(payload)),
    actor,
    repo,
    thread,
    commit,
    threadSnapshot: snapshotOf(instance, payload),
    installationId: context.installationId,
    source: context.source,
    payload: context.payload ?? payload,
  }
}

export function translateGitHubWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const event = headerValue(delivery.headers, EVENT_HEADER)
  if (!event) {
    throw new WebhookVerificationError(`Missing ${EVENT_HEADER} header`, { forge: FORGE, instance })
  }
  const payload = JSON.parse(bodyText(delivery.body)) as GitHubEventPayload
  const id = headerValue(delivery.headers, DELIVERY_HEADER) ?? crypto.randomUUID()
  return perPage(event, payload).map(([page, suffix]) => toGitHubEvent(instance, event, page, {
    id: `${id}${suffix}`,
    kindRaw: verbOf(page) ? `${event}.${verbOf(page)}` : event,
    actionRaw: verbOf(page),
    source: 'webhook',
    actor: toActor(instance, payload.sender),
    repo: payload.repository ? toRepoRef(instance, payload.repository) : undefined,
    installationId: payload.installation ? String(payload.installation.id) : undefined,
  }))
}

/** The payload's verb; a wiki page's action is on the page. */
function verbOf(payload: GitHubEventPayload): string | undefined {
  return payload.action ?? payload.pages?.[0]?.action
}

/** A `gollum` event can cover several wiki pages; each page is an event of its own, with an id suffix when there are several. */
function perPage(event: string, payload: GitHubEventPayload): Array<[GitHubEventPayload, string]> {
  const pages = event === 'gollum' ? payload.pages ?? [] : []
  return pages.length > 1 ? pages.map((page, index) => [{ ...payload, pages: [page] }, `:${index}`]) : [[payload, '']]
}

/** Activity feed event types and the webhook events they correspond to. */
const FEED_EVENTS: Record<string, string> = {
  CommitCommentEvent: 'commit_comment',
  CreateEvent: 'create',
  DeleteEvent: 'delete',
  DiscussionEvent: 'discussion',
  IssueCommentEvent: 'issue_comment',
  IssuesEvent: 'issues',
  MemberEvent: 'member',
  PullRequestEvent: 'pull_request',
  PullRequestReviewCommentEvent: 'pull_request_review_comment',
  PullRequestReviewEvent: 'pull_request_review',
  PushEvent: 'push',
  ReleaseEvent: 'release',
  ForkEvent: 'fork',
  GollumEvent: 'gollum',
  PublicEvent: 'public',
  WatchEvent: 'watch',
}

/** Summaries of the feed event types that have no shared kind. */
const FEED_SUMMARIES: Record<string, string> = {
  SponsorshipEvent: 'changed a sponsorship',
}

/** Normalises an item of an activity feed into one event per wiki page, and one event otherwise. */
export function toFeedEvents(instance: string, raw: GitHubFeedEvent): ForgeEventInput[] {
  const pages = raw.type === 'GollumEvent' ? perPage('gollum', (raw.payload ?? {}) as GitHubEventPayload) : []
  return pages.length > 1
    ? pages.map(([payload, suffix]) => ({ ...toFeedEvent(instance, { ...raw, payload: payload as Record<string, unknown> }), id: `${raw.id}${suffix}`, payload: raw }))
    : [toFeedEvent(instance, raw)]
}

/** Normalises an item of a repository's or an account's activity feed. */
export function toFeedEvent(instance: string, raw: GitHubFeedEvent): ForgeEventInput {
  const type = raw.type ?? 'Event'
  const payload = (raw.payload ?? {}) as GitHubEventPayload
  const [owner = '', name = ''] = raw.repo?.name.split('/') ?? []
  const repo: RepoRef | undefined = raw.repo ? { forge: FORGE, instance, owner, name, externalId: String(raw.repo.id) } : undefined
  const actor = toActor(instance, raw.actor)
  const visibility = typeof raw.public === 'boolean' ? { isPublic: raw.public } : {}
  const context: GitHubEventContext = {
    id: raw.id,
    kindRaw: verbOf(payload) ? `${type}.${verbOf(payload)}` : type,
    actionRaw: verbOf(payload),
    source: 'poll',
    actor,
    repo,
    occurredAt: toDate(raw.created_at),
    payload: raw,
  }
  const event = FEED_EVENTS[type]
  if (!event) {
    return {
      forge: FORGE,
      instance,
      ...context,
      kind: 'other',
      summary: `${actor?.login ?? 'someone'} ${FEED_SUMMARIES[type] ?? type}`,
      ...eventTime(context.occurredAt),
      ...visibility,
      payload: raw,
    }
  }
  const reviewed = type === 'PullRequestReviewEvent' && payload.action === 'created'
  return { ...toGitHubEvent(instance, event, reviewed ? { ...payload, action: 'submitted' } : payload, context), ...visibility }
}
