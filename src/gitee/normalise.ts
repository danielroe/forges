import type { Actor, Branch, ChangedFile, Check, Comment, Commit, ForgeEventInput, Notification, Release, Repo, RepoRef, ResolvedThreadRef, Tag, Thread, ThreadRef, TreeEntry, Webhook } from '../model.ts'
import type { GiteeBranch, GiteeCheckRun, GiteeComment, GiteeCommit, GiteeCommitFile, GiteeHook, GiteeIssue, GiteeNotification, GiteeOperateLog, GiteePullRequest, GiteeRelease, GiteeRepository, GiteeTag, GiteeTreeEntry, GiteeUser } from './types.ts'
import { checkRunState, toDate, toFileStatus } from '../utils.ts'
import { eventKindsOf } from '../webhooks.ts'
import { GITEE_NATIVE_EVENTS } from './webhook-events.ts'

export const FORGE = 'gitee' as const

export function toActor(instance: string, user: GiteeUser | undefined | null): Actor | undefined {
  if (!user) {
    return undefined
  }
  return {
    forge: FORGE,
    instance,
    login: user.login,
    id: String(user.id),
    name: user.name,
    avatarUrl: user.avatar_url,
    url: user.html_url,
    typeRaw: user.type,
    isBotHint: user.type === 'Bot' || /\[bot\]$|-bot$/i.test(user.login),
  }
}

export function toRepoRef(instance: string, repo: GiteeRepository): RepoRef {
  const [owner = repo.namespace?.path ?? '', name = repo.path] = repo.full_name.split('/')
  return { forge: FORGE, instance, owner, name, externalId: String(repo.id) }
}

export function toRepo(instance: string, raw: GiteeRepository): Repo {
  return {
    ref: toRepoRef(instance, raw),
    description: raw.description ?? undefined,
    defaultBranch: raw.default_branch,
    visibility: raw.private ? 'private' : raw.internal ? 'internal' : 'public',
    isFork: raw.fork ?? false,
    isArchived: false,
    parent: raw.parent ? toRepoRef(instance, raw.parent) : undefined,
    topics: [],
    url: raw.html_url,
    cloneUrls: { https: raw.html_url ? `${raw.html_url}.git` : undefined, ssh: raw.ssh_url },
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    pushedAt: toDate(raw.pushed_at),
    openIssueCount: raw.open_issues_count,
    owner: toActor(instance, raw.owner),
    language: raw.language ?? undefined,
    homepage: raw.homepage || undefined,
    licence: raw.license ?? undefined,
    stars: raw.stargazers_count,
    forks: raw.forks_count,
    watchers: raw.watchers_count,
    raw,
  }
}

/** Gitee issues are `open`, `progressing`, `closed` or `rejected`; progressing work is still open. */
function issueState(state: string): Thread['state'] {
  return state === 'open' || state === 'progressing' ? 'open' : state === 'closed' || state === 'rejected' ? 'closed' : 'unknown'
}

export function toIssueThread(ref: ResolvedThreadRef, raw: GiteeIssue): Thread {
  const instance = ref.instance
  return {
    ref: { ...ref, kind: 'issue', number: raw.number, externalId: String(raw.id) },
    kind: 'issue',
    title: raw.title,
    body: raw.body ?? undefined,
    state: issueState(raw.state),
    stateRaw: raw.state,
    stateReason: raw.state === 'rejected' ? 'not_planned' : undefined,
    isDraft: false,
    author: toActor(instance, raw.user),
    assignees: raw.assignee ? [toActor(instance, raw.assignee)!] : [],
    reviewers: [],
    labels: (raw.labels ?? []).map(label => ({ name: label.name, colour: label.color })),
    url: raw.html_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    closedAt: toDate(raw.finished_at),
    lastActivityAt: toDate(raw.updated_at),
    commentCount: raw.comments,
    raw,
  }
}

export function toPullThread(ref: ResolvedThreadRef, raw: GiteePullRequest): Thread {
  const instance = ref.instance
  const state = raw.merged_at || raw.state === 'merged' ? 'merged' : raw.state === 'open' ? 'open' : raw.state === 'closed' ? 'closed' : 'unknown'
  return {
    ref: { ...ref, kind: 'pull_request', number: String(raw.number), externalId: String(raw.id) },
    kind: 'pull_request',
    title: raw.title,
    body: raw.body ?? undefined,
    state,
    stateRaw: raw.state,
    isDraft: raw.draft ?? false,
    author: toActor(instance, raw.user),
    assignees: [],
    reviewers: (raw.assignees ?? []).map(reviewer => ({ actor: toActor(instance, reviewer)!, state: reviewer.accept ? 'approved' : 'pending', stateRaw: reviewer.accept ? 'accepted' : 'requested' })),
    labels: (raw.labels ?? []).map(label => ({ name: label.name, colour: label.color })),
    url: raw.html_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    closedAt: toDate(raw.closed_at),
    lastActivityAt: toDate(raw.updated_at),
    locked: raw.locked,
    branches: raw.head && raw.base
      ? { head: { ref: raw.head.ref, sha: raw.head.sha, repo: raw.head.repo ? toRepoRef(instance, raw.head.repo) : undefined }, base: { ref: raw.base.ref, sha: raw.base.sha } }
      : undefined,
    raw,
  }
}

/** Inline review comments are `diff_comment`s; everything else is conversation. */
export function isConversationComment(raw: GiteeComment): boolean {
  return raw.comment_type !== 'diff_comment' && !raw.path
}

export function toComment(thread: ThreadRef, raw: GiteeComment): Comment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(raw.id) },
    body: raw.body,
    author: toActor(thread.instance, raw.user),
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    url: raw.html_url,
    raw,
  }
}

export function toCommentEvent(thread: ThreadRef, raw: GiteeComment): ForgeEventInput {
  const actor = toActor(thread.instance, raw.user)
  const inline = !isConversationComment(raw)
  return {
    forge: FORGE,
    instance: thread.instance,
    id: `comment:${raw.id}`,
    kind: inline ? 'review_comment' : 'comment',
    kindRaw: raw.comment_type ?? 'comment',
    summary: `${actor?.login ?? 'someone'} ${inline ? 'commented on the diff' : 'commented'}`,
    occurredAt: toDate(raw.created_at) ?? new Date(0),
    actor,
    repo: thread.repo,
    thread,
    source: 'poll',
    payload: raw,
  }
}

const LOG_KINDS: Record<string, ForgeEventInput['kind']> = {
  label: 'label',
  add_label: 'label',
  remove_label: 'label',
  assign: 'assignment',
  set_assignee: 'assignment',
  change_issue_state: 'state_change',
  closed: 'state_change',
  reopened: 'state_change',
  merged: 'state_change',
  review: 'review',
  approve: 'review',
}

export function toLogEvent(thread: ThreadRef, raw: GiteeOperateLog): ForgeEventInput {
  const actor = toActor(thread.instance, raw.user)
  return {
    forge: FORGE,
    instance: thread.instance,
    id: `log:${raw.id}`,
    kind: LOG_KINDS[raw.action_type ?? ''] ?? 'other',
    kindRaw: raw.action_type,
    summary: `${actor?.login ?? 'someone'} ${raw.content ?? raw.action_type ?? 'changed the thread'}`.trim(),
    occurredAt: toDate(raw.created_at) ?? new Date(0),
    actor,
    repo: thread.repo,
    thread,
    source: 'poll',
    payload: raw,
  }
}

function threadFromUrl(instance: string, repo: RepoRef | undefined, url: string | undefined): ThreadRef | undefined {
  const match = /\/(issues|pulls)\/([^/?#]+)/.exec(url ?? '')
  return repo && match ? { forge: FORGE, instance, repo, kind: match[1] === 'pulls' ? 'pull_request' : 'issue', number: match[2]! } : undefined
}

export function toNotification(instance: string, raw: GiteeNotification): Notification {
  const repo = raw.repository ? toRepoRef(instance, raw.repository) : undefined
  const type = raw.subject?.type ?? raw.type ?? 'unknown'
  const thread = threadFromUrl(instance, repo, raw.subject?.url ?? raw.html_url)
  return {
    ref: { forge: FORGE, instance, id: String(raw.id) },
    subject: thread
      ? { type: 'thread', thread: { ...thread, typeRaw: type } }
      : repo ? { type: 'repo', repo } : { type: 'other', typeRaw: type, id: String(raw.id), url: raw.html_url },
    subjectTypeRaw: type,
    reason: raw.type === 'referer' ? 'mention' : 'unknown',
    reasonRaw: raw.type,
    unread: raw.unread,
    title: raw.subject?.title ?? raw.content ?? type,
    subjectState: 'unknown',
    updatedAt: toDate(raw.updated_at) ?? new Date(0),
    raw,
  }
}

export function toCheck(repo: RepoRef, raw: GiteeCheckRun): Check {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.id), type: 'check_run' },
    name: raw.name,
    state: checkRunState(raw.status, raw.conclusion),
    stateRaw: raw.status,
    conclusionRaw: raw.conclusion ?? undefined,
    url: raw.html_url ?? raw.details_url,
    startedAt: toDate(raw.started_at),
    completedAt: toDate(raw.completed_at),
    raw,
  }
}

/** Gitee releases have no draft state or separate publish time. */
export function toRelease(repo: RepoRef, raw: GiteeRelease): Release {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.id), tag: raw.tag_name },
    name: raw.name || undefined,
    tag: raw.tag_name,
    body: raw.body || undefined,
    isDraft: false,
    isPrerelease: raw.prerelease,
    author: toActor(repo.instance, raw.author),
    publishedAt: toDate(raw.created_at),
    createdAt: toDate(raw.created_at),
    assets: raw.assets?.map(asset => ({ name: asset.name ?? asset.browser_download_url.split('/').pop() ?? '', url: asset.browser_download_url })),
    raw,
  }
}

export function toChangedFile(raw: GiteeCommitFile): ChangedFile {
  return {
    path: raw.filename,
    status: toFileStatus(raw.status),
    statusRaw: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
    patch: typeof raw.patch === 'string' ? raw.patch : raw.patch?.diff,
    sha: raw.sha,
  }
}

export function toCommit(repo: RepoRef, raw: GiteeCommit): Commit {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, sha: raw.sha },
    sha: raw.sha,
    message: raw.commit?.message ?? '',
    author: {
      actor: toActor(repo.instance, raw.author),
      name: raw.commit?.author?.name,
      email: raw.commit?.author?.email,
      date: toDate(raw.commit?.author?.date),
    },
    committer: {
      actor: toActor(repo.instance, raw.committer),
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

export function toBranch(raw: GiteeBranch): Branch {
  return { name: raw.name, sha: raw.commit?.sha ?? '', isProtected: raw.protected, raw }
}

export function toTag(raw: GiteeTag): Tag {
  return { name: raw.name, sha: raw.commit?.sha ?? '', raw }
}

export function toTreeEntry(raw: GiteeTreeEntry): TreeEntry {
  return {
    path: raw.path,
    type: raw.mode === '120000' ? 'symlink' : raw.type === 'tree' ? 'directory' : raw.type === 'commit' ? 'submodule' : 'file',
    sha: raw.sha,
    size: raw.size,
    mode: raw.mode,
  }
}

export function toWebhook(target: RepoRef, raw: GiteeHook): Webhook {
  const nativeEvents = Object.entries(raw).filter(([key, value]) => key.endsWith('_events') && value === true).map(([key]) => key)
  return {
    ref: { forge: FORGE, instance: target.instance, target, id: String(raw.id) },
    url: raw.url,
    events: eventKindsOf(GITEE_NATIVE_EVENTS, nativeEvents),
    nativeEvents,
    active: true,
    createdAt: toDate(raw.created_at),
    raw,
  }
}
