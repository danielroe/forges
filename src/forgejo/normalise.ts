import type {
  Actor,
  Branch,
  ChangedFile,
  Check,
  CheckState,
  Comment,
  Commit,
  EventDetail,
  EventKind,
  ForgeEventInput,
  ForgeOrigin,
  Label,
  Milestone,
  Notification,
  NotificationSubject,
  Release,
  Repo,
  RepoRef,
  RepoRole,
  Review,
  ReviewComment,
  SourceKind,
  Tag,
  Thread,
  ThreadKind,
  ThreadRef,
  ThreadState,
  TreeEntry,
  TreeEntryType,
  Webhook,
} from '../model.ts'
import type {
  ForgejoBranch,
  ForgejoChangedFile,
  ForgejoCombinedStatus,
  ForgejoComment,
  ForgejoCommit,
  ForgejoCommitFile,
  ForgejoCommitStatus,
  ForgejoHook,
  ForgejoIssue,
  ForgejoLabel,
  ForgejoMilestone,
  ForgejoNotification,
  ForgejoRelease,
  ForgejoRepository,
  ForgejoRepositoryDetail,
  ForgejoReview,
  ForgejoReviewComment,
  ForgejoTag,
  ForgejoTimelineEntry,
  ForgejoTreeEntry,
  ForgejoUser,
} from './types.ts'
import { reviewState } from '../events.ts'
import { toDate, toFileStatus } from '../utils.ts'
import { eventKindsOf } from '../webhooks.ts'
import { FORGEJO_NATIVE_EVENTS } from './webhook-events.ts'

/** Normalisers take the origin because they serve both Forgejo and Gitea. */
export function toActor(origin: ForgeOrigin, user: ForgejoUser | undefined | null): Actor | undefined {
  if (!user) {
    return undefined
  }
  return {
    ...origin,
    login: user.login,
    id: String(user.id ?? user.login),
    name: user.full_name || undefined,
    avatarUrl: user.avatar_url,
    url: user.html_url,
    typeRaw: user.is_bot === undefined ? undefined : user.is_bot ? 'bot' : 'user',
    isBotHint: user.is_bot === true || user.login.endsWith('[bot]'),
  }
}

export function toRepoRef(origin: ForgeOrigin, repo: ForgejoRepository): RepoRef {
  const [owner, name] = repo.full_name.split('/')
  return {
    ...origin,
    owner: repo.owner?.login ?? owner ?? '',
    name: repo.name ?? name ?? '',
    externalId: repo.id === undefined ? undefined : String(repo.id),
  }
}

export function toRepo(origin: ForgeOrigin, raw: ForgejoRepositoryDetail): Repo {
  return {
    ref: toRepoRef(origin, raw),
    description: raw.description || undefined,
    defaultBranch: raw.default_branch,
    visibility: raw.internal ? 'internal' : raw.private ? 'private' : 'public',
    visibilityRaw: raw.internal ? 'internal' : raw.private ? 'private' : 'public',
    isFork: raw.fork ?? false,
    isArchived: raw.archived ?? false,
    parent: raw.parent ? toRepoRef(origin, raw.parent) : undefined,
    topics: raw.topics ?? [],
    url: raw.html_url,
    cloneUrls: raw.clone_url || raw.ssh_url ? { https: raw.clone_url, ssh: raw.ssh_url } : undefined,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    openIssueCount: raw.open_issues_count,
    openPullCount: raw.open_pr_counter,
    mergeMethods: raw.allow_merge_commits === undefined
      ? undefined
      : [
          ...raw.allow_merge_commits ? ['merge' as const] : [],
          ...raw.allow_squash_merge ? ['squash' as const] : [],
          ...raw.allow_rebase ? ['rebase' as const] : [],
          ...raw.allow_rebase_explicit ? ['rebase_merge' as const] : [],
          ...raw.allow_fast_forward_only_merge ? ['fast_forward_only' as const] : [],
        ],
    features: raw.has_issues === undefined
      ? undefined
      : {
          issues: raw.has_issues,
          pullRequests: raw.has_pull_requests ?? true,
          discussions: false,
          wiki: raw.has_wiki ?? false,
          projects: raw.has_projects ?? false,
          releases: raw.has_releases ?? true,
        },
    permissions: raw.permissions
      ? {
          admin: raw.permissions.admin,
          maintain: raw.permissions.admin,
          push: raw.permissions.push,
          triage: raw.permissions.push,
          pull: raw.permissions.pull,
        }
      : undefined,
    raw,
  }
}

/** Forgejo and Gitea report `owner`, `admin`, `write`, `read` or `none`; there is no triage or maintain role. */
export function toRole(raw: string | undefined): RepoRole {
  switch (raw) {
    case 'owner':
    case 'admin':
      return 'admin'
    case 'write':
      return 'write'
    case 'read':
      return 'read'
    default:
      return 'none'
  }
}

export function toLabel(raw: ForgejoLabel): Label {
  return { name: raw.name, colour: raw.color || undefined, description: raw.description || undefined }
}

export function toMilestone(raw: ForgejoMilestone | null | undefined): Milestone | undefined {
  return raw
    ? {
        id: String(raw.id),
        title: raw.title,
        state: raw.state === 'closed' ? 'closed' : 'open',
        description: raw.description || undefined,
        dueOn: toDate(raw.due_on),
        raw,
      }
    : undefined
}

export function toThreadKind(subjectType: string): ThreadKind {
  switch (subjectType) {
    case 'Pull':
    case 'PullRequest':
      return 'pull_request'
    case 'Commit':
      return 'commit'
    case 'Issue':
      return 'issue'
    default:
      return 'other'
  }
}

export function toSubjectState(state: string | undefined): ThreadState {
  switch (state) {
    case 'open':
    case 'closed':
    case 'merged':
      return state
    default:
      return 'unknown'
  }
}

export function numberFromUrl(url: string | null | undefined): string | undefined {
  return /\/(?:issues|pulls|commits|git\/commits)\/([^/?#]+)/.exec(url ?? '')?.[1]
}

export function toSubject(origin: ForgeOrigin, raw: ForgejoNotification): NotificationSubject {
  const repo = toRepoRef(origin, raw.repository)
  const kind = toThreadKind(raw.subject.type)
  if (kind !== 'other') {
    return { type: 'thread', thread: { ...origin, repo, kind, typeRaw: raw.subject.type, number: numberFromUrl(raw.subject.url) } }
  }
  if (raw.subject.type === 'Repository') {
    return { type: 'repo', repo }
  }
  return { type: 'other', typeRaw: raw.subject.type, repo, url: raw.subject.url ?? undefined }
}

export function toNotification(origin: ForgeOrigin, raw: ForgejoNotification): Notification {
  return {
    ref: { ...origin, id: String(raw.id) },
    subject: toSubject(origin, raw),
    subjectTypeRaw: raw.subject.type,
    reason: 'unknown',
    unread: raw.unread,
    title: raw.subject.title,
    subjectState: toSubjectState(raw.subject.state),
    subjectStateRaw: raw.subject.state,
    updatedAt: toDate(raw.updated_at) ?? new Date(0),
    url: raw.subject.url ?? raw.url,
    raw,
  }
}

export function toThread(ref: ThreadRef, raw: ForgejoIssue): Thread {
  const origin = { forge: ref.forge, instance: ref.instance }
  const isPull = Boolean(raw.pull_request) || Boolean(raw.head)
  const kind = isPull && ref.kind === 'issue' ? 'pull_request' : ref.kind
  const state: ThreadState = raw.merged || raw.pull_request?.merged
    ? 'merged'
    : raw.state === 'open' || raw.state === 'closed' ? raw.state : 'unknown'
  return {
    ref: { ...ref, kind, externalId: raw.id === undefined ? ref.externalId : String(raw.id) },
    kind,
    title: raw.title,
    body: raw.body ?? undefined,
    state,
    stateRaw: raw.state,
    isDraft: raw.draft ?? raw.pull_request?.draft ?? false,
    author: toActor(origin, raw.user),
    assignees: (raw.assignees ?? []).flatMap(user => toActor(origin, user) ?? []),
    reviewers: (raw.requested_reviewers ?? []).flatMap((user) => {
      const actor = toActor(origin, user)
      return actor ? [{ actor, state: 'pending' as const, stateRaw: 'requested' }] : []
    }),
    labels: (raw.labels ?? []).map(label => ({
      name: label.name,
      colour: label.color,
      description: label.description || undefined,
    })),
    url: raw.html_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    closedAt: toDate(raw.closed_at),
    lastActivityAt: toDate(raw.updated_at),
    locked: raw.is_locked,
    commentCount: raw.comments,
    milestone: toMilestone(raw.milestone),
    branches: raw.head && raw.base
      ? {
          head: { ref: raw.head.ref, sha: raw.head.sha, repo: raw.head.repo ? toRepoRef(origin, raw.head.repo) : undefined },
          base: { ref: raw.base.ref, sha: raw.base.sha },
          mergeCommitSha: raw.merge_commit_sha ?? undefined,
        }
      : undefined,
    raw,
  }
}

export function toComment(thread: ThreadRef, raw: ForgejoComment): Comment {
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id: String(raw.id) },
    body: raw.body ?? '',
    author: toActor({ forge: thread.forge, instance: thread.instance }, raw.user),
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    url: raw.html_url,
    raw,
  }
}

const EVENT_KINDS: Record<string, EventKind> = {
  comment: 'comment',
  review: 'review',
  code_comment: 'review_comment',
  commit_ref: 'commit',
  issue_ref: 'referenced',
  pull_ref: 'referenced',
  change_issue_ref: 'referenced',
  pull_push: 'commit',
  label: 'label',
  close: 'state_change',
  reopen: 'state_change',
  merge_pull: 'state_change',
  pull_request_ready_for_review: 'state_change',
  assignees: 'assignment',
}

export function toEventKind(type: string | undefined): EventKind {
  return EVENT_KINDS[type ?? ''] ?? 'other'
}

function summarise(entry: ForgejoTimelineEntry, kind: EventKind, actor?: Actor): string {
  const who = actor?.login ?? 'someone'
  switch (kind) {
    case 'comment':
      return `${who} commented`
    case 'review':
      return `${who} reviewed`
    case 'review_comment':
      return `${who} commented on a line`
    case 'commit':
      return `${who} referenced ${entry.ref_commit_sha?.slice(0, 7) || 'a commit'}`
    case 'referenced':
      return `${who} referenced this${entry.ref_issue ? ` from #${entry.ref_issue.number}` : ''}`
    case 'label':
      return `${who} changed label ${entry.label?.name ?? ''}`.trim()
    case 'state_change':
      return `${who} ${entry.type ?? 'changed state'}`
    case 'assignment':
      return `${who} assigned ${entry.assignee?.login ?? ''}`.trim()
    default:
      return `${who} ${entry.type ?? 'acted'}`
  }
}

/** `issue_ref`, `pull_ref` and `change_issue_ref` name the thread that mentioned this one. */
function crossReference(thread: ThreadRef, entry: ForgejoTimelineEntry): EventDetail | undefined {
  const source = entry.ref_issue
  if (!source) {
    return { type: 'referenced' }
  }
  const [owner = '', name = ''] = source.repository?.full_name.split('/') ?? []
  const repo = name
    ? { forge: thread.forge, instance: thread.instance, owner, name, externalId: source.repository?.id === undefined ? undefined : String(source.repository.id) }
    : thread.repo
  return {
    type: 'referenced',
    from: { forge: thread.forge, instance: thread.instance, repo, kind: source.pull_request ? 'pull_request' : 'issue', number: String(source.number) },
    fromRepo: repo,
  }
}

export function toEvent(
  thread: ThreadRef,
  entry: ForgejoTimelineEntry,
  source: SourceKind = 'poll',
): ForgeEventInput {
  const origin = { forge: thread.forge, instance: thread.instance }
  const kind = toEventKind(entry.type)
  const actor = toActor(origin, entry.user)
  return {
    ...origin,
    id: String(entry.id ?? `${thread.number ?? ''}-${entry.type}-${entry.created_at}`),
    kind,
    kindRaw: entry.type,
    summary: summarise(entry, kind, actor),
    occurredAt: toDate(entry.created_at) ?? new Date(0),
    actor,
    repo: thread.repo,
    thread,
    ...kind === 'referenced' ? { detail: crossReference(thread, entry) } : {},
    source,
    payload: entry,
  }
}

/** Commit status values. `warning` is informational and neither passes nor fails. */
export function statusState(status: string): CheckState {
  switch (status) {
    case 'success':
      return 'success'
    case 'failure':
    case 'error':
      return 'failure'
    case 'pending':
      return 'pending'
    case 'warning':
      return 'neutral'
    default:
      return 'unknown'
  }
}

export function toStatusCheck(repo: RepoRef, raw: ForgejoCommitStatus): Check {
  const state = statusState(raw.status)
  return {
    ref: { forge: repo.forge, instance: repo.instance, repo, id: String(raw.id), type: 'status' },
    name: raw.context,
    state,
    stateRaw: raw.status,
    url: raw.target_url || undefined,
    startedAt: toDate(raw.created_at),
    completedAt: state === 'pending' ? undefined : toDate(raw.updated_at),
    raw,
  }
}

export function toStatusChecks(repo: RepoRef, raw: ForgejoCombinedStatus): Check[] {
  return (raw.statuses ?? []).map(status => toStatusCheck(repo, status))
}

export function toRelease(repo: RepoRef, raw: ForgejoRelease): Release {
  const origin = { forge: repo.forge, instance: repo.instance }
  const ref = { ...origin, repo, id: String(raw.id), tag: raw.tag_name }
  return {
    ref,
    name: raw.name || undefined,
    tag: raw.tag_name,
    body: raw.body || undefined,
    isDraft: raw.draft,
    isPrerelease: raw.prerelease,
    author: raw.author ? toActor(repo, raw.author) : undefined,
    publishedAt: raw.draft ? undefined : toDate(raw.published_at),
    createdAt: toDate(raw.created_at),
    url: raw.html_url,
    assets: raw.assets?.map(asset => ({
      ...asset.id === undefined ? {} : { ref: { ...origin, repo, release: ref, id: String(asset.id) } },
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      downloadCount: asset.download_count,
    })),
    raw,
  }
}

export function toReviewComment(thread: ThreadRef, raw: ForgejoReviewComment): ReviewComment {
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id: String(raw.id) },
    body: raw.body ?? '',
    author: toActor(thread, raw.user),
    path: raw.path,
    line: raw.position ?? raw.original_position,
    side: raw.position ? 'right' : raw.original_position ? 'left' : undefined,
    createdAt: toDate(raw.created_at),
    url: raw.html_url,
    raw,
  }
}

export function toReview(thread: ThreadRef, raw: ForgejoReview, comments: ReviewComment[] | false): Review {
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id: String(raw.id) },
    author: toActor(thread, raw.user),
    state: reviewState(raw.state?.toLowerCase() === 'request_changes' ? 'changes_requested' : raw.state),
    stateRaw: raw.state,
    body: raw.body || undefined,
    submittedAt: toDate(raw.submitted_at),
    comments,
    url: raw.html_url,
    raw,
  }
}

export function toChangedFile(raw: ForgejoChangedFile | ForgejoCommitFile): ChangedFile {
  return {
    path: raw.filename,
    previousPath: raw.previous_filename,
    status: toFileStatus(raw.status),
    statusRaw: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
  }
}

export function toCommit(repo: RepoRef, raw: ForgejoCommit): Commit {
  const origin = { forge: repo.forge, instance: repo.instance }
  return {
    ref: { ...origin, repo, sha: raw.sha },
    sha: raw.sha,
    message: raw.commit?.message ?? '',
    author: {
      actor: toActor(origin, raw.author),
      name: raw.commit?.author?.name,
      email: raw.commit?.author?.email,
      date: toDate(raw.commit?.author?.date),
    },
    committer: {
      actor: toActor(origin, raw.committer),
      name: raw.commit?.committer?.name,
      email: raw.commit?.committer?.email,
      date: toDate(raw.commit?.committer?.date),
    },
    parents: raw.parents?.flatMap(parent => parent.sha ? [parent.sha] : []) ?? [],
    url: raw.html_url,
    ...raw.stats ? { stats: { additions: raw.stats.additions ?? 0, deletions: raw.stats.deletions ?? 0, total: raw.stats.total } } : {},
    ...raw.files ? { files: raw.files.map(toChangedFile) } : {},
    raw,
  }
}

export function toBranch(raw: ForgejoBranch): Branch {
  return { name: raw.name, sha: raw.commit?.id ?? '', isProtected: raw.protected, raw }
}

export function toTag(raw: ForgejoTag): Tag {
  return { name: raw.name, sha: raw.commit?.sha ?? raw.id ?? '', raw }
}

const TREE_TYPES: Record<string, TreeEntryType> = { blob: 'file', tree: 'directory', commit: 'submodule' }

export function toTreeEntry(raw: ForgejoTreeEntry): TreeEntry {
  return {
    path: raw.path,
    type: raw.mode === '120000' ? 'symlink' : TREE_TYPES[raw.type ?? ''] ?? 'file',
    sha: raw.sha,
    size: raw.size,
    mode: raw.mode,
  }
}

export function toWebhook(target: RepoRef, raw: ForgejoHook): Webhook {
  const nativeEvents = raw.events ?? []
  return {
    ref: { forge: target.forge, instance: target.instance, target, id: String(raw.id) },
    url: raw.config?.url ?? '',
    events: eventKindsOf(FORGEJO_NATIVE_EVENTS, nativeEvents),
    nativeEvents,
    active: raw.active ?? true,
    contentType: raw.config?.content_type === 'form' ? 'form' : 'json',
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    raw,
  }
}
