import type {
  Actor,
  Branch,
  ChangedFile,
  Check,
  ChecksSummary,
  CheckState,
  CiJob,
  CiRun,
  CiRunRef,
  Comment,
  Commit,
  EventDetail,
  EventKind,
  ForgeEventInput,
  Label,
  Milestone,
  Notification,
  NotificationReason,
  NotificationSubject,
  ReactionSummary,
  Release,
  Repo,
  RepoRef,
  RepoRole,
  ResolvedThreadRef,
  Reviewer,
  SecurityAlert,
  SecuritySeverity,
  Tag,
  Thread,
  ThreadKind,
  ThreadRef,
  ThreadState,
  TreeEntry,
  Webhook,
  WebhookDeliveryRecord,
  WebhookRef,
} from '../model.ts'
import type { GitLabBranch, GitLabCommit, GitLabCommitComment, GitLabCommitDetail, GitLabCommitStatus, GitLabDiff, GitLabHook, GitLabHookEvent, GitLabIssue, GitLabJob, GitLabLabel, GitLabMilestone, GitLabNote, GitLabNoteDetail, GitLabPipeline, GitLabProjectDetail, GitLabRelease, GitLabTag, GitLabTodo, GitLabTreeEntry, GitLabUser, GitLabVulnerability } from './types.ts'
import { toDate } from '../utils.ts'
import { eventKindsOf } from '../webhooks.ts'
import { GITLAB_NATIVE_EVENTS } from './webhook-events.ts'

export const FORGE = 'gitlab' as const

export function toActor(instance: string, user: GitLabUser | undefined | null): Actor | undefined {
  if (!user) {
    return undefined
  }
  return {
    forge: FORGE,
    instance,
    login: user.username,
    id: String(user.id),
    name: user.name,
    avatarUrl: user.avatar_url ?? undefined,
    url: user.web_url,
    typeRaw: user.bot === undefined ? undefined : user.bot ? 'bot' : 'user',
    isBotHint: user.bot === true || /^(?:project|group)_\d+_bot(?:_|$)/.test(user.username),
  }
}

/** Splits a full project path into the namespace (which may contain slashes) and the project name. */
export function toRepoRef(instance: string, pathWithNamespace: string, id?: number | string): RepoRef {
  const index = pathWithNamespace.lastIndexOf('/')
  return {
    forge: FORGE,
    instance,
    owner: pathWithNamespace.slice(0, index),
    name: pathWithNamespace.slice(index + 1),
    externalId: id === undefined ? undefined : String(id),
  }
}

/** Reads the project path out of a `/-/`-style web URL, which cross-project listings carry instead of a project path. */
export function repoRefFromWebUrl(instance: string, webUrl: string | undefined, id?: number | string): RepoRef | undefined {
  const path = webUrl?.match(/^https?:\/\/[^/]+\/(.+?)\/-\//)?.[1]
  return path ? toRepoRef(instance, path, id) : undefined
}

export function toNamespaceRef(instance: string, fullPath: string, id?: number): RepoRef {
  return {
    forge: FORGE,
    instance,
    kind: 'namespace',
    owner: fullPath,
    name: '',
    externalId: id === undefined ? undefined : String(id),
  }
}

/** Project id accepted by every `/projects/:id` route. */
export function projectId(repo: RepoRef): string {
  return encodeURIComponent(`${repo.owner}/${repo.name}`)
}

export function toThreadKind(targetType: string): ThreadKind {
  switch (targetType) {
    case 'Issue':
      return 'issue'
    case 'MergeRequest':
      return 'pull_request'
    case 'Commit':
      return 'commit'
    default:
      return 'other'
  }
}

const REASONS: Record<string, NotificationReason> = {
  added_approver: 'approval_requested',
  approval_required: 'approval_requested',
  assigned: 'assigned',
  build_failed: 'ci_activity',
  directly_addressed: 'mention',
  marked: 'manual',
  member_access_requested: 'access_requested',
  mentioned: 'mention',
  merge_train_removed: 'merge_blocked',
  review_requested: 'review_requested',
  review_submitted: 'review_submitted',
  unmergeable: 'merge_blocked',
}

export function toReason(action: string): NotificationReason {
  return REASONS[action] ?? 'unknown'
}

export function toState(state: string | undefined): ThreadState {
  switch (state) {
    case 'opened':
      return 'open'
    case 'closed':
    case 'locked':
      return 'closed'
    case 'merged':
      return 'merged'
    default:
      return 'unknown'
  }
}

export function toNotification(instance: string, raw: GitLabTodo): Notification {
  const repo = raw.project
    ? toRepoRef(instance, raw.project.path_with_namespace, raw.project.id)
    : toNamespaceRef(instance, raw.group?.full_path ?? '', raw.group?.id)
  const kind = toThreadKind(raw.target_type)
  const target = raw.target ?? undefined
  const number = kind === 'commit' || target?.iid === undefined
    ? target?.id === undefined ? undefined : String(target.id)
    : String(target.iid)
  let subject: NotificationSubject
  if (raw.target_type === 'Vulnerability') {
    subject = { type: 'security_alert', alert: { forge: FORGE, instance, repo, id: number ?? String(raw.id) } }
  }
  else if (raw.target_type === 'Project' || raw.target_type === 'Namespace') {
    subject = { type: 'repo', repo }
  }
  else if (kind === 'other' && !raw.target?.iid) {
    subject = { type: 'other', typeRaw: raw.target_type, repo, id: number, url: raw.target_url }
  }
  else {
    subject = { type: 'thread', thread: { forge: FORGE, instance, repo, kind, typeRaw: raw.target_type, number } }
  }
  return {
    ref: { forge: FORGE, instance, id: String(raw.id) },
    subject,
    subjectTypeRaw: raw.target_type,
    reason: toReason(raw.action_name),
    reasonRaw: raw.action_name,
    unread: raw.state === 'pending',
    title: target?.title ?? raw.body ?? '',
    subjectState: toState(target?.state),
    subjectStateRaw: target?.state,
    updatedAt: toDate(raw.updated_at ?? raw.created_at) ?? new Date(0),
    url: raw.target_url,
    raw,
  }
}

const ACCESS_LEVELS = { admin: 50, maintain: 40, push: 30, triage: 20, pull: 10 } as const

/** GitLab access levels: 50 owner, 40 maintainer, 30 developer, 20 reporter, 10 guest. */
export function toRole(level: number): RepoRole {
  return level >= 50 ? 'admin' : level >= 40 ? 'maintain' : level >= 30 ? 'write' : level >= 20 ? 'triage' : level >= 10 ? 'read' : 'none'
}

export function toLabel(raw: GitLabLabel): Label {
  return { name: raw.name, colour: raw.color?.replace(/^#/, ''), description: raw.description ?? undefined }
}

export function toMilestone(raw: GitLabMilestone | null | undefined): Milestone | undefined {
  return raw
    ? {
        id: String(raw.id),
        title: raw.title,
        state: raw.state === 'closed' ? 'closed' : 'open',
        description: raw.description ?? undefined,
        dueOn: toDate(raw.due_date),
        url: raw.web_url,
        raw,
      }
    : undefined
}

/** GitLab counts only thumbs up and down on a thread read; the full set needs the award emoji listing. */
export function toVoteReactions(raw: { upvotes?: number, downvotes?: number }): ReactionSummary | undefined {
  if (raw.upvotes === undefined && raw.downvotes === undefined) {
    return undefined
  }
  return {
    total: (raw.upvotes ?? 0) + (raw.downvotes ?? 0),
    counts: { ...raw.upvotes ? { '+1': raw.upvotes } : {}, ...raw.downvotes ? { '-1': raw.downvotes } : {} },
  }
}

export function toRepo(instance: string, raw: GitLabProjectDetail): Repo {
  const level = Math.max(raw.permissions?.project_access?.access_level ?? 0, raw.permissions?.group_access?.access_level ?? 0)
  const visibility = raw.visibility === 'internal' ? 'internal' : raw.visibility === 'private' ? 'private' : 'public'
  return {
    ref: toRepoRef(instance, raw.path_with_namespace, raw.id),
    description: raw.description ?? undefined,
    defaultBranch: raw.default_branch ?? undefined,
    visibility,
    visibilityRaw: raw.visibility,
    isFork: Boolean(raw.forked_from_project),
    isArchived: raw.archived ?? false,
    parent: raw.forked_from_project ? toRepoRef(instance, raw.forked_from_project.path_with_namespace, raw.forked_from_project.id) : undefined,
    topics: raw.topics ?? [],
    url: raw.web_url,
    cloneUrls: raw.http_url_to_repo || raw.ssh_url_to_repo ? { https: raw.http_url_to_repo, ssh: raw.ssh_url_to_repo } : undefined,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.last_activity_at),
    openIssueCount: raw.open_issues_count,
    owner: toActor(instance, raw.owner),
    stars: raw.star_count,
    forks: raw.forks_count,
    mergeMethods: raw.merge_method === undefined
      ? undefined
      : [
          ...raw.merge_method === 'merge' ? ['merge' as const] : [],
          ...raw.merge_method === 'rebase_merge' ? ['rebase_merge' as const] : [],
          ...raw.merge_method === 'ff' ? ['fast_forward_only' as const] : [],
          ...raw.squash_option && raw.squash_option !== 'never' ? ['squash' as const] : [],
        ],
    features: raw.issues_access_level === undefined && raw.issues_enabled === undefined
      ? undefined
      : {
          issues: raw.issues_enabled ?? raw.issues_access_level !== 'disabled',
          pullRequests: raw.merge_requests_enabled ?? raw.merge_requests_access_level !== 'disabled',
          discussions: false,
          wiki: raw.wiki_enabled ?? raw.wiki_access_level !== 'disabled',
          projects: false,
          releases: raw.releases_access_level !== 'disabled',
        },
    permissions: raw.permissions
      ? {
          admin: level >= ACCESS_LEVELS.admin,
          maintain: level >= ACCESS_LEVELS.maintain,
          push: level >= ACCESS_LEVELS.push,
          triage: level >= ACCESS_LEVELS.triage,
          pull: level >= ACCESS_LEVELS.pull,
        }
      : undefined,
    raw,
  }
}

export function toThread(ref: ResolvedThreadRef, raw: GitLabIssue): Thread {
  const isMerge = ref.kind === 'pull_request'
  const reviewers: Reviewer[] = (raw.reviewers ?? []).flatMap((user) => {
    const actor = toActor(ref.instance, user)
    return actor ? [{ actor, state: 'unknown' as const }] : []
  })
  return {
    ref: { ...ref, externalId: raw.id === undefined ? ref.externalId : String(raw.id) },
    kind: ref.kind,
    title: raw.title,
    body: raw.description ?? undefined,
    state: toState(raw.state),
    stateRaw: raw.state,
    isDraft: raw.draft ?? false,
    assignees: (raw.assignees ?? []).flatMap(user => toActor(ref.instance, user) ?? []),
    reviewers,
    lastActivityAt: toDate(raw.updated_at),
    branches: isMerge && raw.source_branch && raw.target_branch
      ? {
          head: {
            ref: raw.source_branch,
            sha: raw.diff_refs?.head_sha ?? raw.sha,
            repo: raw.source_project_id !== undefined && raw.source_project_id === raw.target_project_id ? ref.repo : undefined,
          },
          base: { ref: raw.target_branch, sha: raw.diff_refs?.base_sha },
          mergeCommitSha: raw.merge_commit_sha ?? raw.squash_commit_sha ?? undefined,
        }
      : undefined,
    author: toActor(ref.instance, raw.author),
    url: raw.web_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    closedAt: toDate(raw.closed_at),
    labels: (raw.labels ?? []).map(label => typeof label === 'string'
      ? { name: label }
      : { name: label.name, colour: label.color, description: label.description ?? undefined }),
    locked: raw.discussion_locked ?? undefined,
    commentCount: raw.user_notes_count,
    milestone: toMilestone(raw.milestone),
    reactions: toVoteReactions(raw),
    raw,
  }
}

export function toCommitThread(ref: ResolvedThreadRef, raw: GitLabCommit): Thread {
  return {
    ref,
    kind: 'commit',
    title: raw.title,
    body: raw.message,
    state: 'unknown',
    isDraft: false,
    assignees: [],
    reviewers: [],
    url: raw.web_url,
    createdAt: toDate(raw.created_at),
    lastActivityAt: toDate(raw.created_at),
    labels: [],
    raw,
  }
}

/** System notes are the only record of label, state and assignment changes in the notes API. */
const SYSTEM_NOTE_KINDS: Array<[RegExp, EventKind]> = [
  [/^approved this merge request/i, 'review'],
  [/^added \d+ (?:new )?commits?/i, 'commit'],
  [/^(?:added|removed) .*label/i, 'label'],
  [/^(?:closed|reopened|merged|marked this merge request as|status changed to)/i, 'state_change'],
  [/^(?:assigned to|reassigned to|unassigned|requested review from)/i, 'assignment'],
  [/^mentioned in /i, 'referenced'],
]

export function toNoteKind(note: GitLabNote): EventKind {
  if (!note.system) {
    return note.type === 'DiffNote' ? 'review_comment' : 'comment'
  }
  return SYSTEM_NOTE_KINDS.find(([pattern]) => pattern.test(note.body))?.[1] ?? 'other'
}

/**
 * A "mentioned in" system note names the subject that mentioned this thread:
 * `!5` or `acme/widgets!5` for a merge request, `#5` for an issue, or a sha
 * for a commit. The reference is read from that wording, since the note
 * carries no structured source.
 */
function crossReference(ref: ResolvedThreadRef, body: string): EventDetail {
  const match = body.match(/^mentioned in (?:merge request|issue|commit) (\S+)/i)
  const text = match?.[1]
  if (!text) {
    return { type: 'referenced', text: body }
  }
  const thread = text.match(/^(?:([^!#]+)([!#]))?[!#]?(\d+)$/)
  if (thread) {
    const repo = thread[1] ? toRepoRef(ref.instance, thread[1]) : ref.repo
    return {
      type: 'referenced',
      from: { forge: FORGE, instance: ref.instance, repo, kind: text.includes('!') ? 'pull_request' : 'issue', number: thread[3]! },
      fromRepo: repo,
      text,
    }
  }
  return /^[0-9a-f]{7,40}$/i.test(text)
    ? { type: 'referenced', from: { forge: FORGE, instance: ref.instance, repo: ref.repo, sha: text }, fromRepo: ref.repo, text }
    : { type: 'referenced', text }
}

export function toNoteEvent(ref: ResolvedThreadRef, note: GitLabNote): ForgeEventInput {
  const actor = toActor(ref.instance, note.author)
  const kind = toNoteKind(note)
  const who = actor?.login ?? 'someone'
  return {
    forge: FORGE,
    instance: ref.instance,
    id: String(note.id),
    kind,
    kindRaw: note.system ? 'system' : note.type ?? 'Note',
    summary: note.system
      ? `${who} ${note.body.split('\n')[0]}`
      : `${who} ${kind === 'review_comment' ? 'commented on a line' : 'commented'}`,
    occurredAt: toDate(note.created_at) ?? new Date(0),
    actor,
    repo: ref.repo,
    thread: ref,
    ...kind === 'referenced' ? { detail: crossReference(ref, note.body) } : {},
    source: 'poll',
    payload: note,
  }
}

export function toCommitCommentEvent(ref: ResolvedThreadRef, comment: GitLabCommitComment, index: number): ForgeEventInput {
  const actor = toActor(ref.instance, comment.author)
  return {
    forge: FORGE,
    instance: ref.instance,
    id: `${ref.number}:${index}`,
    kind: comment.line_type ? 'review_comment' : 'comment',
    kindRaw: 'CommitComment',
    summary: `${actor?.login ?? 'someone'} commented`,
    occurredAt: toDate(comment.created_at) ?? new Date(0),
    actor,
    repo: ref.repo,
    thread: ref,
    source: 'poll',
    payload: comment,
  }
}

export function toNoteComment(thread: ThreadRef, note: GitLabNoteDetail): Comment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(note.id) },
    body: note.body,
    author: toActor(thread.instance, note.author),
    createdAt: toDate(note.created_at),
    updatedAt: toDate(note.updated_at),
    raw: note,
  }
}

/** GitLab commit comments carry no id, so they are keyed by creation time and author. */
export function toCommitComment(thread: ThreadRef, comment: GitLabCommitComment): Comment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: `${comment.created_at ?? ''}:${comment.author?.id ?? ''}` },
    body: comment.note,
    author: toActor(thread.instance, comment.author),
    createdAt: toDate(comment.created_at),
    raw: comment,
  }
}

/** Pipeline and job statuses. `manual` jobs wait for a person, so they neither pass nor fail. */
export function pipelineState(status: string): CheckState {
  switch (status) {
    case 'success':
      return 'success'
    case 'failed':
    case 'canceled':
      return 'failure'
    case 'skipped':
    case 'manual':
      return 'neutral'
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'scheduled':
      return 'pending'
    default:
      return 'unknown'
  }
}

/** The merge request's head pipeline, which GitLab reports as one combined status. */
export function toPipelineSummary(pipeline: GitLabPipeline): ChecksSummary {
  const state = pipelineState(pipeline.status)
  return { state: state === 'neutral' ? 'pending' : state, stateRaw: pipeline.status, ...pipeline.web_url ? { url: pipeline.web_url } : {} }
}

export function toJobCheck(repo: RepoRef, job: GitLabJob): Check {
  const state = pipelineState(job.status)
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(job.id), type: 'job' },
    name: job.stage ? `${job.stage}: ${job.name}` : job.name,
    state: state === 'failure' && job.allow_failure ? 'neutral' : state,
    stateRaw: job.status,
    url: job.web_url,
    startedAt: toDate(job.started_at),
    completedAt: toDate(job.finished_at),
    raw: job,
  }
}

/** GitLab keys releases by tag and has no drafts or prereleases. */
export function toRelease(repo: RepoRef, raw: GitLabRelease): Release {
  const ref = { forge: FORGE, instance: repo.instance, repo, id: raw.tag_name, tag: raw.tag_name }
  return {
    ref,
    name: raw.name ?? undefined,
    tag: raw.tag_name,
    body: raw.description ?? undefined,
    isDraft: false,
    isPrerelease: false,
    author: toActor(repo.instance, raw.author),
    publishedAt: raw.upcoming_release ? undefined : toDate(raw.released_at),
    createdAt: toDate(raw.created_at),
    url: raw._links?.self,
    assets: raw.assets?.links?.map(link => ({ name: link.name, url: link.direct_asset_url ?? link.url })),
    raw,
  }
}

const REPORT_KINDS: Record<string, SecurityAlert['kind']> = {
  DEPENDENCY_SCANNING: 'dependency',
  CONTAINER_SCANNING: 'dependency',
  CLUSTER_IMAGE_SCANNING: 'dependency',
  SAST: 'code_scanning',
  SECRET_DETECTION: 'secret',
}

export const REPORT_TYPES: Record<Exclude<SecurityAlert['kind'], 'other'>, string[]> = {
  dependency: ['DEPENDENCY_SCANNING', 'CONTAINER_SCANNING', 'CLUSTER_IMAGE_SCANNING'],
  code_scanning: ['SAST'],
  secret: ['SECRET_DETECTION'],
  advisory: [],
}

/** `INFO` findings are informational and carry no severity. */
function toSeverity(raw: string): SecuritySeverity {
  const severity = raw.toLowerCase()
  return severity === 'critical' || severity === 'high' || severity === 'medium' || severity === 'low' ? severity : 'unknown'
}

export function toVulnerability(repo: RepoRef, raw: GitLabVulnerability): SecurityAlert {
  const kind = REPORT_KINDS[raw.reportType] ?? 'other'
  const state = raw.state === 'DETECTED' || raw.state === 'CONFIRMED' ? 'open' : raw.state === 'RESOLVED' ? 'fixed' : raw.state === 'DISMISSED' ? 'dismissed' : 'unknown'
  const id = raw.id.replace(/^gid:\/\/gitlab\/Vulnerability\//, '')
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id, kind, severityRaw: raw.severity.toLowerCase() },
    kind,
    kindRaw: raw.reportType.toLowerCase(),
    severity: toSeverity(raw.severity),
    severityRaw: raw.severity.toLowerCase(),
    state,
    stateRaw: raw.state.toLowerCase(),
    title: raw.title,
    url: raw.webUrl ?? undefined,
    createdAt: toDate(raw.detectedAt),
    updatedAt: toDate(raw.updatedAt),
    dismissedAt: toDate(raw.dismissedAt),
    raw,
  }
}

export function toStatusCheck(repo: RepoRef, raw: GitLabCommitStatus): Check {
  const state = pipelineState(raw.status)
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.id), type: 'status' },
    name: raw.name ?? String(raw.id),
    state: state === 'failure' && raw.allow_failure ? 'neutral' : state,
    stateRaw: raw.status,
    url: raw.target_url ?? undefined,
    startedAt: toDate(raw.created_at),
    completedAt: toDate(raw.finished_at),
    raw,
  }
}

export function toPipeline(repo: RepoRef, raw: GitLabPipeline): CiRun {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.id) },
    name: raw.name || raw.source || `pipeline ${raw.id}`,
    state: pipelineState(raw.status),
    stateRaw: raw.status,
    number: raw.iid === undefined ? undefined : String(raw.iid),
    eventRaw: raw.source,
    branch: raw.ref,
    sha: raw.sha,
    url: raw.web_url,
    actor: toActor(repo.instance, raw.user),
    createdAt: toDate(raw.created_at),
    startedAt: toDate(raw.started_at),
    completedAt: toDate(raw.finished_at),
    raw,
  }
}

export function toCiJob(run: CiRunRef, raw: GitLabJob): CiJob {
  const state = pipelineState(raw.status)
  return {
    ref: { forge: FORGE, instance: run.instance, repo: run.repo, id: String(raw.id), run },
    name: raw.name,
    state: state === 'failure' && raw.allow_failure ? 'neutral' : state,
    stateRaw: raw.status,
    stage: raw.stage,
    url: raw.web_url,
    startedAt: toDate(raw.started_at),
    completedAt: toDate(raw.finished_at),
    raw,
  }
}

export function toCommit(repo: RepoRef, raw: GitLabCommitDetail, files?: ChangedFile[]): Commit {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, sha: raw.id },
    sha: raw.id,
    message: raw.message ?? raw.title,
    author: { name: raw.author_name, email: raw.author_email, date: toDate(raw.authored_date ?? raw.created_at) },
    committer: { name: raw.committer_name, email: raw.committer_email, date: toDate(raw.committed_date) },
    parents: raw.parent_ids ?? [],
    url: raw.web_url,
    ...raw.stats ? { stats: { additions: raw.stats.additions ?? 0, deletions: raw.stats.deletions ?? 0, total: raw.stats.total } } : {},
    ...files ? { files } : {},
    raw,
  }
}

/** GitLab reports a change by three booleans and a unified diff, with no counts. */
export function toChangedFile(raw: GitLabDiff): ChangedFile {
  const path = raw.new_path ?? raw.old_path ?? ''
  const status = raw.new_file ? 'added' : raw.deleted_file ? 'removed' : raw.renamed_file ? 'renamed' : 'modified'
  return {
    path,
    previousPath: raw.renamed_file ? raw.old_path : undefined,
    status,
    statusRaw: status,
    patch: raw.diff,
  }
}

export function toBranch(raw: GitLabBranch): Branch {
  return {
    name: raw.name,
    sha: raw.commit?.id ?? '',
    isDefault: raw.default,
    isProtected: raw.protected,
    url: raw.web_url,
    raw,
  }
}

export function toTag(raw: GitLabTag): Tag {
  return { name: raw.name, sha: raw.commit?.id ?? raw.target ?? '', raw }
}

export function toTreeEntry(raw: GitLabTreeEntry): TreeEntry {
  return {
    path: raw.path,
    type: raw.mode === '120000' ? 'symlink' : raw.type === 'tree' ? 'directory' : raw.type === 'commit' ? 'submodule' : 'file',
    sha: raw.id,
    mode: raw.mode,
  }
}

export function toWebhook(target: RepoRef, raw: GitLabHook): Webhook {
  const nativeEvents = Object.entries(raw).filter(([key, value]) => key.endsWith('_events') && value === true).map(([key]) => key)
  return {
    ref: { forge: FORGE, instance: target.instance, target, id: String(raw.id) },
    url: raw.url,
    events: eventKindsOf(GITLAB_NATIVE_EVENTS, nativeEvents),
    nativeEvents,
    active: !raw.disabled_until,
    createdAt: toDate(raw.created_at),
    raw,
  }
}

export function toWebhookDelivery(hook: WebhookRef, raw: GitLabHookEvent): WebhookDeliveryRecord {
  const status = Number(raw.response_status) || 0
  return {
    ref: { forge: FORGE, instance: hook.instance, hook, id: String(raw.id) },
    event: raw.trigger ?? '',
    status,
    ok: status >= 200 && status < 300,
    deliveredAt: toDate(raw.created_at),
    duration: raw.execution_duration === undefined ? undefined : Math.round(raw.execution_duration * 1000),
    raw,
  }
}
