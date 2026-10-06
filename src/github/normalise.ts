import type {
  Actor,
  Branch,
  ChangedFile,
  Check,
  CheckState,
  CiJob,
  CiRun,
  CiRunRef,
  Collaborator,
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
  Review,
  ReviewComment,
  Reviewer,
  SecurityAlert,
  SecuritySeverity,
  SourceKind,
  Tag,
  Thread,
  ThreadKind,
  ThreadRef,
  ThreadState,
  TreeEntry,
  TreeEntryType,
  User,
  Webhook,
  WebhookDeliveryRecord,
  WebhookRef,
} from '../model.ts'
import type {
  GitHubBranch,
  GitHubCheckRun,
  GitHubCodeScanningAlert,
  GitHubCollaborator,
  GitHubComment,
  GitHubCommit,
  GitHubCommitFile,
  GitHubCommitStatus,
  GitHubDependabotAlert,
  GitHubHook,
  GitHubHookDelivery,
  GitHubIssue,
  GitHubLabel,
  GitHubMilestone,
  GitHubNotification,
  GitHubReactions,
  GitHubRelease,
  GitHubRepository,
  GitHubRepositoryDetail,
  GitHubReview,
  GitHubReviewComment,
  GitHubSecretScanningAlert,
  GitHubTag,
  GitHubTimelineEntry,
  GitHubTreeEntry,
  GitHubUser,
  GitHubUserDetail,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
} from './types.ts'
import { reviewState } from '../events.ts'
import { REACTION_CONTENTS } from '../model.ts'
import { checkRunState, toDate, toFileStatus } from '../utils.ts'
import { eventKindsOf } from '../webhooks.ts'
import { GITHUB_NATIVE_EVENTS } from './webhook-events.ts'

export const FORGE = 'github' as const

export function toActor(instance: string, user: GitHubUser | undefined | null): Actor | undefined {
  if (!user) {
    return undefined
  }
  return {
    forge: FORGE,
    instance,
    login: user.login,
    id: String(user.id ?? user.login),
    name: user.name ?? undefined,
    avatarUrl: user.avatar_url,
    url: user.html_url,
    typeRaw: user.type,
    isBotHint: user.type === 'Bot' || user.login.endsWith('[bot]'),
    ...user.type === 'Bot' && user.login.endsWith('[bot]') ? { app: { slug: user.login.slice(0, -'[bot]'.length) } } : {},
  }
}

export function toUser(instance: string, user: GitHubUserDetail): User {
  return {
    ...toActor(instance, user)!,
    bio: user.bio ?? undefined,
    company: user.company ?? undefined,
    location: user.location ?? undefined,
    websiteUrl: user.blog || undefined,
    createdAt: toDate(user.created_at),
    followers: user.followers,
    following: user.following,
    publicRepos: user.public_repos,
    raw: user,
  }
}

export function toRepoRef(instance: string, repo: GitHubRepository): RepoRef {
  const [owner, name] = repo.full_name.split('/')
  return {
    forge: FORGE,
    instance,
    owner: repo.owner?.login ?? owner ?? '',
    name: repo.name ?? name ?? '',
    externalId: repo.id === undefined ? undefined : String(repo.id),
  }
}

/** Reads `owner` and `name` out of an API repository URL, which search results carry instead of a nested repository. */
export function repoRefFromApiUrl(instance: string, url: string | undefined): RepoRef | undefined {
  const [, owner, name] = url?.match(/\/repos\/([^/]+)\/([^/]+)$/) ?? []
  return owner && name ? { forge: FORGE, instance, owner, name } : undefined
}

export function toRepo(instance: string, raw: GitHubRepositoryDetail): Repo {
  const visibility = raw.visibility === 'internal' ? 'internal' : raw.private || raw.visibility === 'private' ? 'private' : 'public'
  return {
    ref: toRepoRef(instance, raw),
    description: raw.description ?? undefined,
    defaultBranch: raw.default_branch,
    visibility,
    visibilityRaw: raw.visibility ?? (raw.private === undefined ? undefined : raw.private ? 'private' : 'public'),
    isFork: raw.fork ?? false,
    isArchived: raw.archived ?? false,
    parent: raw.parent ? toRepoRef(instance, raw.parent) : undefined,
    topics: raw.topics ?? [],
    url: raw.html_url,
    cloneUrls: raw.clone_url || raw.ssh_url ? { https: raw.clone_url, ssh: raw.ssh_url } : undefined,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    pushedAt: toDate(raw.pushed_at),
    mergeMethods: raw.allow_merge_commit === undefined && raw.allow_squash_merge === undefined && raw.allow_rebase_merge === undefined
      ? undefined
      : [
          ...raw.allow_merge_commit ? ['merge' as const] : [],
          ...raw.allow_squash_merge ? ['squash' as const] : [],
          ...raw.allow_rebase_merge ? ['rebase' as const] : [],
        ],
    features: raw.has_issues === undefined
      ? undefined
      : {
          issues: raw.has_issues,
          pullRequests: true,
          discussions: raw.has_discussions ?? false,
          wiki: raw.has_wiki ?? false,
          projects: raw.has_projects ?? false,
          releases: true,
        },
    permissions: raw.permissions
      ? {
          admin: raw.permissions.admin,
          maintain: raw.permissions.maintain ?? raw.permissions.admin,
          push: raw.permissions.push,
          triage: raw.permissions.triage ?? raw.permissions.push,
          pull: raw.permissions.pull,
        }
      : undefined,
    raw,
  }
}

export function toReactions(raw: GitHubReactions | undefined): ReactionSummary | undefined {
  if (!raw) {
    return undefined
  }
  const counts = Object.fromEntries(REACTION_CONTENTS.flatMap(name => raw[name] ? [[name, raw[name]!]] : []))
  return { total: raw.total_count ?? Object.values(counts).reduce((sum, count) => sum + count, 0), counts }
}

export function toMilestone(raw: GitHubMilestone | null | undefined): Milestone | undefined {
  return raw
    ? {
        id: String(raw.number ?? raw.id ?? ''),
        title: raw.title,
        state: raw.state === 'closed' ? 'closed' : 'open',
        description: raw.description ?? undefined,
        dueOn: toDate(raw.due_on),
        url: raw.html_url,
        raw,
      }
    : undefined
}

/** GitHub's `role_name`, or the permission block when a listing reports only that. */
export function toRole(raw: { role_name?: string, permissions?: { admin?: boolean, maintain?: boolean, push?: boolean, triage?: boolean, pull?: boolean } }): RepoRole {
  switch (raw.role_name) {
    case 'admin':
    case 'maintain':
    case 'write':
    case 'triage':
    case 'read':
      return raw.role_name
  }
  const permissions = raw.permissions
  if (!permissions) {
    return 'none'
  }
  return permissions.admin ? 'admin' : permissions.maintain ? 'maintain' : permissions.push ? 'write' : permissions.triage ? 'triage' : permissions.pull ? 'read' : 'none'
}

export function toCollaborator(instance: string, raw: GitHubCollaborator): Collaborator {
  return { actor: toActor(instance, raw)!, role: toRole(raw), roleRaw: raw.role_name, raw }
}

export function toThreadKind(subjectType: string): ThreadKind {
  switch (subjectType) {
    case 'PullRequest':
      return 'pull_request'
    case 'Discussion':
      return 'discussion'
    case 'Commit':
      return 'commit'
    case 'Issue':
      return 'issue'
    default:
      return 'other'
  }
}

export function toThreadState(issue: Pick<GitHubIssue, 'state' | 'merged' | 'pull_request'>): ThreadState {
  if (issue.merged || issue.pull_request?.merged_at) {
    return 'merged'
  }
  if (issue.state === 'open' || issue.state === 'closed') {
    return issue.state
  }
  return 'unknown'
}

export function numberFromUrl(url: string | null | undefined): string | undefined {
  return /\/(?:issues|pulls|commits|discussions)\/([^/?#]+)/.exec(url ?? '')?.[1]
}

const REASONS: Record<string, NotificationReason> = {
  approval_requested: 'approval_requested',
  assign: 'assigned',
  author: 'author',
  ci_activity: 'ci_activity',
  comment: 'comment',
  invitation: 'invitation',
  manual: 'manual',
  mention: 'mention',
  review_requested: 'review_requested',
  security_alert: 'security_alert',
  security_advisory_credit: 'security_alert',
  state_change: 'state_change',
  subscribed: 'subscribed',
  team_mention: 'team_mention',
}

export function toReason(reason: string): NotificationReason {
  return REASONS[reason] ?? 'unknown'
}

const SECURITY_SUBJECTS = new Set([
  'RepositoryVulnerabilityAlert',
  'RepositoryDependabotAlertsThread',
  'SecretScanningAlert',
  'RepositoryAdvisory',
])

const SECURITY_SUBJECTS_KIND: Record<string, SecurityAlert['kind']> = {
  RepositoryVulnerabilityAlert: 'dependency',
  RepositoryDependabotAlertsThread: 'dependency',
  SecretScanningAlert: 'secret',
  RepositoryAdvisory: 'advisory',
}

function lastSegment(url: string | null | undefined): string | undefined {
  return /\/([^/?#]+)\/?$/.exec(url ?? '')?.[1]
}

export function toSubject(instance: string, raw: GitHubNotification): NotificationSubject {
  const repo = toRepoRef(instance, raw.repository)
  const type = raw.subject.type
  const kind = toThreadKind(type)
  if (kind !== 'other') {
    return { type: 'thread', thread: { forge: FORGE, instance, repo, kind, typeRaw: type, number: numberFromUrl(raw.subject.url) } }
  }
  if (type === 'Release') {
    return { type: 'release', release: { forge: FORGE, instance, repo, id: lastSegment(raw.subject.url) ?? raw.id } }
  }
  if (SECURITY_SUBJECTS.has(type)) {
    const kind = SECURITY_SUBJECTS_KIND[type]
    return { type: 'security_alert', alert: { forge: FORGE, instance, repo, id: lastSegment(raw.subject.url) ?? raw.id, ...kind ? { kind } : {} } }
  }
  if (type === 'RepositoryInvitation') {
    return { type: 'repo', repo }
  }
  return { type: 'other', typeRaw: type, repo, id: lastSegment(raw.subject.url), url: raw.subject.url ?? undefined }
}

export function toNotification(instance: string, raw: GitHubNotification): Notification {
  return {
    ref: { forge: FORGE, instance, id: raw.id },
    subject: toSubject(instance, raw),
    subjectTypeRaw: raw.subject.type,
    reason: toReason(raw.reason),
    reasonRaw: raw.reason,
    unread: raw.unread,
    title: raw.subject.title,
    subjectState: 'unknown',
    updatedAt: toDate(raw.updated_at) ?? new Date(0),
    lastReadAt: toDate(raw.last_read_at),
    url: raw.subject.url ?? raw.url,
    raw,
  }
}

export function toLabel(raw: GitHubLabel): Label {
  return { name: raw.name, colour: raw.color ?? undefined, description: raw.description ?? undefined }
}

export function toLabels(labels: GitHubIssue['labels']): Label[] {
  return (labels ?? []).flatMap((label) => {
    if (typeof label === 'string') {
      return [{ name: label }]
    }
    return label.name ? [{ name: label.name, colour: label.color ?? undefined, description: label.description ?? undefined }] : []
  })
}

function toReviewers(instance: string, raw: GitHubIssue): Reviewer[] {
  const users = (raw.requested_reviewers ?? []).flatMap((user) => {
    const actor = toActor(instance, user)
    return actor ? [{ actor, state: 'pending' as const, stateRaw: 'requested' }] : []
  })
  const teams = (raw.requested_teams ?? []).map(team => ({
    actor: { forge: FORGE, instance, login: team.slug, id: String(team.id), name: team.name, url: team.html_url, typeRaw: 'Team', isBotHint: false },
    state: 'pending' as const,
    stateRaw: 'requested',
    isTeam: true,
  }))
  return [...users, ...teams]
}

/** Builds a thread from an issue, a pull request, or a pull request as returned by the issues API. */
export function toThread(ref: ThreadRef, raw: GitHubIssue): Thread {
  const kind = raw.pull_request || raw.head ? 'pull_request' : ref.kind
  return {
    ref: { ...ref, kind, externalId: raw.node_id ?? ref.externalId },
    kind,
    title: raw.title,
    body: raw.body ?? undefined,
    state: toThreadState(raw),
    stateRaw: raw.state,
    stateReason: raw.state_reason ?? undefined,
    isDraft: raw.draft ?? false,
    author: toActor(ref.instance, raw.user),
    assignees: (raw.assignees ?? []).flatMap(user => toActor(ref.instance, user) ?? []),
    reviewers: toReviewers(ref.instance, raw),
    labels: toLabels(raw.labels),
    url: raw.html_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    closedAt: toDate(raw.closed_at),
    lastActivityAt: toDate(raw.updated_at),
    locked: raw.locked,
    commentCount: raw.comments,
    milestone: toMilestone(raw.milestone),
    reactions: toReactions(raw.reactions),
    branches: raw.head && raw.base
      ? {
          head: { ref: raw.head.ref, sha: raw.head.sha, repo: raw.head.repo ? toRepoRef(ref.instance, raw.head.repo) : undefined },
          base: { ref: raw.base.ref, sha: raw.base.sha },
          mergeCommitSha: raw.merge_commit_sha ?? undefined,
        }
      : undefined,
    raw,
  }
}

export function toComment(thread: ThreadRef, raw: GitHubComment): Comment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(raw.id) },
    body: raw.body ?? '',
    author: toActor(thread.instance, raw.user),
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    url: raw.html_url,
    reactions: toReactions(raw.reactions),
    raw,
  }
}

const EVENT_KINDS: Record<string, EventKind> = {
  'commented': 'comment',
  'reviewed': 'review',
  'line_commented': 'review_comment',
  'review_requested': 'assignment',
  'review_request_removed': 'assignment',
  'committed': 'commit',
  'labeled': 'label',
  'unlabeled': 'label',
  'closed': 'state_change',
  'reopened': 'state_change',
  'merged': 'state_change',
  'convert_to_draft': 'state_change',
  'ready_for_review': 'state_change',
  'assigned': 'assignment',
  'unassigned': 'assignment',
  'mentioned': 'mention',
  'cross-referenced': 'referenced',
  'referenced': 'referenced',
  'reaction': 'reaction',
}

export function toEventKind(event: string | undefined): EventKind {
  return EVENT_KINDS[event ?? ''] ?? 'other'
}

function summarise(entry: GitHubTimelineEntry, kind: EventKind, actor?: Actor): string {
  const who = actor?.login ?? 'someone'
  switch (kind) {
    case 'comment':
      return `${who} commented`
    case 'review':
      return `${who} reviewed (${entry.state ?? 'commented'})`
    case 'review_comment':
      return `${who} commented on a line`
    case 'commit':
      return `${entry.author?.name ?? who} committed ${entry.sha?.slice(0, 7) ?? 'a commit'}`
    case 'label':
      return `${who} ${entry.event === 'unlabeled' ? 'removed' : 'added'} label ${entry.label?.name ?? ''}`.trim()
    case 'state_change':
      return `${who} ${entry.event ?? 'changed state'}`
    case 'referenced':
      return `${who} referenced this`
    case 'assignment':
      if (entry.event === 'review_requested' || entry.event === 'review_request_removed') {
        return `${who} ${entry.event === 'review_requested' ? 'requested review from' : 'removed the review request for'} ${entry.requested_reviewer?.login ?? ''}`.trim()
      }
      return `${who} ${entry.event === 'unassigned' ? 'unassigned' : 'assigned'} ${entry.assignee?.login ?? ''}`.trim()
    default:
      return `${who} ${entry.event ?? 'acted'}`
  }
}

/** A `cross-referenced` entry names the thread that mentioned this one; a `referenced` entry names a commit. */
function crossReference(instance: string, thread: ThreadRef, entry: GitHubTimelineEntry): EventDetail {
  const source = entry.source?.issue
  if (source) {
    const repo = source.repository ? toRepoRef(instance, source.repository) : thread.repo
    return {
      type: 'referenced',
      from: { forge: FORGE, instance, repo, kind: source.pull_request ? 'pull_request' : 'issue', number: String(source.number) },
      fromRepo: repo,
    }
  }
  return entry.commit_id
    ? { type: 'referenced', from: { forge: FORGE, instance, repo: thread.repo, sha: entry.commit_id }, fromRepo: thread.repo }
    : { type: 'referenced' }
}

function timelineDetail(instance: string, thread: ThreadRef, entry: GitHubTimelineEntry, kind: EventKind): EventDetail | undefined {
  switch (kind) {
    case 'comment':
      return { type: 'comment', comment: entry.id !== undefined ? { forge: FORGE, instance, thread, id: String(entry.id) } : undefined, body: entry.body ?? undefined }
    case 'review':
      return { type: 'review', state: reviewState(entry.state), stateRaw: entry.state, body: entry.body ?? undefined }
    case 'label':
      return entry.label ? { type: 'label', label: entry.label.name } : undefined
    case 'assignment':
      return { type: 'assignment', assignee: toActor(instance, entry.assignee ?? entry.requested_reviewer) }
    case 'referenced':
      return crossReference(instance, thread, entry)
    case 'state_change':
      return entry.event === 'convert_to_draft' || entry.event === 'ready_for_review'
        ? { type: 'state_change', state: 'open', draft: entry.event === 'convert_to_draft' }
        : { type: 'state_change', state: entry.event === 'merged' ? 'merged' : entry.event === 'closed' ? 'closed' : 'open' }
    default:
      return undefined
  }
}

export function toEvent(
  instance: string,
  thread: ThreadRef,
  entry: GitHubTimelineEntry,
  source: SourceKind = 'poll',
): ForgeEventInput {
  const kind = toEventKind(entry.event)
  const actor = toActor(instance, entry.actor ?? entry.user)
  return {
    forge: FORGE,
    instance,
    id: String(entry.node_id ?? entry.id ?? entry.sha ?? `${thread.number ?? ''}-${entry.event}-${entry.created_at}`),
    kind,
    kindRaw: entry.event,
    detail: timelineDetail(instance, thread, entry, kind),
    summary: summarise(entry, kind, actor),
    occurredAt: toDate(entry.created_at ?? entry.submitted_at ?? entry.author?.date ?? entry.committer?.date)
      ?? new Date(0),
    actor,
    repo: thread.repo,
    thread,
    source,
    payload: entry,
  }
}

export function statusState(state: string): CheckState {
  return state === 'success' ? 'success' : state === 'pending' ? 'pending' : state === 'failure' || state === 'error' ? 'failure' : 'unknown'
}

export function toCheckRun(repo: RepoRef, raw: GitHubCheckRun): Check {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.id), type: 'check_run' },
    name: raw.name,
    state: checkRunState(raw.status, raw.conclusion),
    stateRaw: raw.status,
    conclusionRaw: raw.conclusion ?? undefined,
    url: raw.html_url ?? raw.details_url ?? undefined,
    startedAt: toDate(raw.started_at),
    completedAt: toDate(raw.completed_at),
    raw,
  }
}

export function toStatusCheck(repo: RepoRef, raw: GitHubCommitStatus): Check {
  const state = statusState(raw.state)
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.id), type: 'status' },
    name: raw.context,
    state,
    stateRaw: raw.state,
    url: raw.target_url ?? undefined,
    startedAt: toDate(raw.created_at),
    completedAt: state === 'pending' ? undefined : toDate(raw.updated_at),
    raw,
  }
}

export function toRelease(repo: RepoRef, raw: GitHubRelease): Release {
  const ref = { forge: FORGE, instance: repo.instance, repo, id: String(raw.id), tag: raw.tag_name }
  return {
    ref,
    name: raw.name ?? undefined,
    tag: raw.tag_name,
    body: raw.body ?? undefined,
    isDraft: raw.draft,
    isPrerelease: raw.prerelease,
    author: toActor(repo.instance, raw.author),
    publishedAt: toDate(raw.published_at),
    createdAt: toDate(raw.created_at),
    url: raw.html_url,
    assets: raw.assets?.map(asset => ({
      ...asset.id === undefined ? {} : { ref: { forge: FORGE, instance: repo.instance, repo, release: ref, id: String(asset.id) } },
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      downloadCount: asset.download_count,
      contentType: asset.content_type,
    })),
    raw,
  }
}

export function toSeverity(raw: string | null | undefined): SecuritySeverity {
  switch (raw?.toLowerCase()) {
    case 'critical':
      return 'critical'
    case 'high':
    case 'error':
      return 'high'
    case 'medium':
    case 'moderate':
    case 'warning':
      return 'medium'
    case 'low':
    case 'note':
      return 'low'
    default:
      return 'unknown'
  }
}

function alertState(raw: string): SecurityAlert['state'] {
  return raw === 'open' ? 'open' : raw === 'fixed' ? 'fixed' : raw === 'dismissed' || raw === 'auto_dismissed' ? 'dismissed' : 'unknown'
}

export function toDependabotAlert(repo: RepoRef, raw: GitHubDependabotAlert): SecurityAlert {
  const severityRaw = raw.security_vulnerability?.severity ?? raw.security_advisory?.severity
  const pkg = raw.dependency?.package
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.number), kind: 'dependency', severityRaw },
    kind: 'dependency',
    kindRaw: 'dependabot',
    severity: toSeverity(severityRaw),
    severityRaw,
    state: alertState(raw.state),
    stateRaw: raw.state,
    title: raw.security_advisory?.summary ?? `Vulnerable dependency ${pkg?.name ?? ''}`.trim(),
    ...pkg
      ? {
          package: {
            ecosystem: pkg.ecosystem,
            name: pkg.name,
            vulnerableRange: raw.security_vulnerability?.vulnerable_version_range,
            fixedIn: raw.security_vulnerability?.first_patched_version?.identifier,
          },
        }
      : {},
    url: raw.html_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    dismissedAt: toDate(raw.dismissed_at),
    raw,
  }
}

export function toCodeScanningAlert(repo: RepoRef, raw: GitHubCodeScanningAlert): SecurityAlert {
  const severityRaw = raw.rule?.security_severity_level ?? raw.rule?.severity ?? undefined
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.number), kind: 'code_scanning', severityRaw },
    kind: 'code_scanning',
    kindRaw: raw.tool?.name ?? 'code_scanning',
    severity: toSeverity(severityRaw),
    severityRaw,
    state: alertState(raw.state),
    stateRaw: raw.state,
    title: raw.rule?.description ?? raw.rule?.name ?? raw.rule?.id ?? 'Code scanning alert',
    url: raw.html_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    dismissedAt: toDate(raw.dismissed_at),
    raw,
  }
}

/** Secret scanning reports no severity. A revoked secret is fixed; any other resolution dismisses the alert. */
export function toSecretScanningAlert(repo: RepoRef, raw: GitHubSecretScanningAlert): SecurityAlert {
  const state = raw.state === 'open' ? 'open' : raw.state === 'resolved' ? (raw.resolution === 'revoked' ? 'fixed' : 'dismissed') : 'unknown'
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.number), kind: 'secret' },
    kind: 'secret',
    kindRaw: raw.secret_type ?? 'secret_scanning',
    severity: 'unknown',
    state,
    stateRaw: raw.resolution ? `${raw.state}:${raw.resolution}` : raw.state,
    title: raw.secret_type_display_name ?? raw.secret_type ?? 'Secret scanning alert',
    url: raw.html_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    dismissedAt: state === 'dismissed' ? toDate(raw.resolved_at) : undefined,
    raw,
  }
}

export function toReviewComment(thread: ThreadRef, raw: GitHubReviewComment, reviewThread?: { id: string, resolved: boolean }): ReviewComment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(raw.id) },
    body: raw.body ?? '',
    author: toActor(thread.instance, raw.user),
    path: raw.path,
    line: raw.line ?? raw.original_line ?? undefined,
    side: raw.side?.toLowerCase() === 'left' ? 'left' : raw.side ? 'right' : undefined,
    inReplyTo: raw.in_reply_to_id === null || raw.in_reply_to_id === undefined ? undefined : String(raw.in_reply_to_id),
    thread: reviewThread,
    createdAt: toDate(raw.created_at),
    url: raw.html_url,
    raw,
  }
}

export function toReview(thread: ThreadRef, raw: GitHubReview, comments: ReviewComment[]): Review {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(raw.id) },
    author: toActor(thread.instance, raw.user),
    state: reviewState(raw.state),
    stateRaw: raw.state,
    body: raw.body || undefined,
    submittedAt: toDate(raw.submitted_at ?? undefined),
    comments,
    url: raw.html_url,
    raw,
  }
}

export function toWorkflowRun(repo: RepoRef, raw: GitHubWorkflowRun): CiRun {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.id) },
    name: raw.name || raw.display_title || String(raw.id),
    state: checkRunState(raw.status ?? 'queued', raw.conclusion),
    stateRaw: raw.status ?? 'unknown',
    number: raw.run_number === undefined ? undefined : String(raw.run_number),
    eventRaw: raw.event,
    branch: raw.head_branch ?? undefined,
    sha: raw.head_sha,
    url: raw.html_url,
    actor: toActor(repo.instance, raw.actor),
    createdAt: toDate(raw.created_at),
    startedAt: toDate(raw.run_started_at),
    completedAt: raw.status === 'completed' ? toDate(raw.updated_at) : undefined,
    raw,
  }
}

export function toWorkflowJob(run: CiRunRef, raw: GitHubWorkflowJob): CiJob {
  return {
    ref: { forge: FORGE, instance: run.instance, repo: run.repo, id: String(raw.id), run },
    name: raw.name,
    state: checkRunState(raw.status ?? 'queued', raw.conclusion),
    stateRaw: raw.status ?? 'unknown',
    url: raw.html_url ?? undefined,
    startedAt: toDate(raw.started_at),
    completedAt: toDate(raw.completed_at),
    raw,
  }
}

export function toChangedFile(raw: GitHubCommitFile): ChangedFile {
  return {
    path: raw.filename,
    previousPath: raw.previous_filename,
    status: toFileStatus(raw.status),
    statusRaw: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
    patch: raw.patch,
    sha: raw.sha,
  }
}

export function toCommit(repo: RepoRef, raw: GitHubCommit): Commit {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, sha: raw.sha },
    sha: raw.sha,
    message: raw.commit.message,
    author: {
      actor: toActor(repo.instance, raw.author),
      name: raw.commit.author?.name,
      email: raw.commit.author?.email,
      date: toDate(raw.commit.author?.date),
    },
    committer: {
      actor: toActor(repo.instance, raw.committer),
      name: raw.commit.committer?.name,
      email: raw.commit.committer?.email,
      date: toDate(raw.commit.committer?.date),
    },
    parents: raw.parents?.map(parent => parent.sha) ?? [],
    url: raw.html_url,
    ...raw.stats ? { stats: { additions: raw.stats.additions ?? 0, deletions: raw.stats.deletions ?? 0, total: raw.stats.total } } : {},
    ...raw.files ? { files: raw.files.map(toChangedFile) } : {},
    raw,
  }
}

export function toBranch(raw: GitHubBranch, defaultBranch?: string): Branch {
  return {
    name: raw.name,
    sha: raw.commit.sha,
    isDefault: defaultBranch === undefined ? undefined : raw.name === defaultBranch,
    isProtected: raw.protected,
    raw,
  }
}

export function toTag(raw: GitHubTag): Tag {
  return { name: raw.name, sha: raw.commit.sha, raw }
}

const TREE_TYPES: Record<string, TreeEntryType> = { blob: 'file', tree: 'directory', commit: 'submodule' }

export function toTreeEntry(raw: GitHubTreeEntry): TreeEntry {
  return {
    path: raw.path,
    type: raw.mode === '120000' ? 'symlink' : TREE_TYPES[raw.type ?? ''] ?? 'file',
    sha: raw.sha,
    size: raw.size,
    mode: raw.mode,
  }
}

export function toWebhook(target: RepoRef, raw: GitHubHook): Webhook {
  const nativeEvents = raw.events ?? []
  return {
    ref: { forge: FORGE, instance: target.instance, target, id: String(raw.id) },
    url: raw.config?.url ?? '',
    events: eventKindsOf(GITHUB_NATIVE_EVENTS, nativeEvents),
    nativeEvents,
    active: raw.active ?? true,
    contentType: raw.config?.content_type === 'form' ? 'form' : 'json',
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    raw,
  }
}

export function toWebhookDelivery(hook: WebhookRef, raw: GitHubHookDelivery): WebhookDeliveryRecord {
  const status = raw.status_code ?? 0
  return {
    ref: { forge: FORGE, instance: hook.instance, hook, id: String(raw.id), guid: raw.guid },
    event: raw.action ? `${raw.event}.${raw.action}` : raw.event ?? '',
    status,
    ok: status >= 200 && status < 300,
    deliveredAt: toDate(raw.delivered_at),
    duration: raw.duration,
    raw,
  }
}
