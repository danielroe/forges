import type { Actor, Branch, ChangedFile, Check, CheckState, Comment, Commit, EventKind, ForgeEventInput, MergeMethod, Repo, RepoRef, ResolvedThreadRef, Reviewer, Tag, Thread, ThreadRef, ThreadState, TreeEntry, Webhook } from '../model.ts'
import type {
  BitbucketActivity,
  BitbucketComment,
  BitbucketCommit,
  BitbucketCommitDetail,
  BitbucketCommitStatus,
  BitbucketDiffStat,
  BitbucketHook,
  BitbucketPullRequest,
  BitbucketRef,
  BitbucketRepository,
  BitbucketRepositoryDetail,
  BitbucketSrcEntry,
  BitbucketUser,
} from './types.ts'
import { toDate, toFileStatus } from '../utils.ts'
import { eventKindsOf } from '../webhooks.ts'
import { BITBUCKET_NATIVE_EVENTS } from './webhook-events.ts'

export const FORGE = 'bitbucket' as const

export function toActor(instance: string, user: BitbucketUser | undefined | null): Actor | undefined {
  if (!user) {
    return undefined
  }
  const login = user.nickname ?? user.username ?? user.display_name ?? user.uuid ?? 'unknown'
  return {
    forge: FORGE,
    instance,
    login,
    id: user.uuid ?? user.account_id ?? login,
    name: user.display_name,
    avatarUrl: user.links?.avatar?.href,
    url: user.links?.html?.href,
    typeRaw: user.type,
    isBotHint: user.type === 'app_user',
  }
}

export function toRepoRef(instance: string, repo: BitbucketRepository): RepoRef {
  const [workspace = '', slug = ''] = repo.full_name.split('/')
  return {
    forge: FORGE,
    instance,
    owner: repo.workspace?.slug ?? workspace,
    name: repo.slug ?? slug,
    externalId: repo.uuid,
  }
}

export function toRepo(instance: string, raw: BitbucketRepositoryDetail): Repo {
  const clone = (name: string) => raw.links?.clone?.find(link => link.name === name)?.href
  return {
    ref: toRepoRef(instance, raw),
    description: raw.description || undefined,
    defaultBranch: raw.mainbranch?.name,
    visibility: raw.is_private ? 'private' : 'public',
    visibilityRaw: raw.is_private === undefined ? undefined : raw.is_private ? 'private' : 'public',
    isFork: Boolean(raw.parent),
    isArchived: false,
    parent: raw.parent ? toRepoRef(instance, raw.parent) : undefined,
    topics: [],
    url: raw.links?.html?.href,
    cloneUrls: clone('https') || clone('ssh') ? { https: clone('https'), ssh: clone('ssh') } : undefined,
    createdAt: toDate(raw.created_on),
    updatedAt: toDate(raw.updated_on),
    owner: toActor(instance, raw.owner),
    language: raw.language || undefined,
    homepage: raw.website || undefined,
    features: raw.has_issues === undefined
      ? undefined
      : { issues: raw.has_issues, pullRequests: true, discussions: false, wiki: raw.has_wiki ?? false, projects: false, releases: false },
    raw,
  }
}

export function toPullState(state: string): ThreadState {
  switch (state) {
    case 'OPEN':
      return 'open'
    case 'MERGED':
      return 'merged'
    case 'DECLINED':
    case 'SUPERSEDED':
      return 'closed'
    default:
      return 'unknown'
  }
}

const STRATEGIES: Record<string, MergeMethod> = {
  merge_commit: 'merge',
  squash: 'squash',
  fast_forward: 'fast_forward_only',
  rebase_merge: 'rebase_merge',
  rebase_fast_forward: 'rebase',
}

export function toMergeMethod(strategy: string): MergeMethod | undefined {
  return STRATEGIES[strategy]
}

export function toStrategy(method: MergeMethod): string {
  return Object.entries(STRATEGIES).find(([, value]) => value === method)![0]
}

function toReviewers(instance: string, raw: BitbucketPullRequest): Reviewer[] {
  const participants = new Map((raw.participants ?? []).map(participant => [participant.user?.uuid, participant]))
  return (raw.reviewers ?? []).flatMap((user) => {
    const actor = toActor(instance, user)
    if (!actor) {
      return []
    }
    const participant = participants.get(user.uuid)
    const stateRaw = participant?.state ?? (participant?.approved ? 'approved' : undefined)
    const state = stateRaw === 'approved' ? 'approved' : stateRaw === 'changes_requested' ? 'changes_requested' : 'pending'
    return [{ actor, state, stateRaw: stateRaw ?? undefined }]
  })
}

export function toPullThread(ref: ResolvedThreadRef, raw: BitbucketPullRequest): Thread {
  const repo = raw.destination?.repository
  const threadRepo = repo ? { ...ref.repo, externalId: repo.uuid ?? ref.repo.externalId } : ref.repo
  return {
    ref: { ...ref, repo: threadRepo },
    kind: 'pull_request',
    title: raw.title,
    body: raw.description ?? raw.summary?.raw,
    state: toPullState(raw.state),
    stateRaw: raw.state,
    isDraft: raw.draft ?? false,
    assignees: [],
    reviewers: toReviewers(ref.instance, raw),
    lastActivityAt: toDate(raw.updated_on),
    branches: raw.source?.branch && raw.destination?.branch
      ? {
          head: {
            ref: raw.source.branch.name,
            sha: raw.source.commit?.hash,
            repo: raw.source.repository ? toRepoRef(ref.instance, raw.source.repository) : undefined,
          },
          base: { ref: raw.destination.branch.name, sha: raw.destination.commit?.hash },
          mergeCommitSha: raw.merge_commit?.hash,
        }
      : undefined,
    author: toActor(ref.instance, raw.author),
    url: raw.links?.html?.href,
    createdAt: toDate(raw.created_on),
    updatedAt: toDate(raw.updated_on),
    closedAt: raw.state === 'OPEN' ? undefined : toDate(raw.updated_on),
    labels: [],
    commentCount: raw.comment_count,
    raw,
  }
}

export function toCommitThread(ref: ResolvedThreadRef, raw: BitbucketCommit): Thread {
  return {
    ref,
    kind: 'commit',
    title: raw.message?.split('\n')[0] ?? raw.hash,
    body: raw.message,
    state: 'unknown',
    isDraft: false,
    assignees: [],
    reviewers: [],
    lastActivityAt: toDate(raw.date),
    author: toActor(ref.instance, raw.author?.user),
    url: raw.links?.html?.href,
    createdAt: toDate(raw.date),
    labels: [],
    raw,
  }
}

function event(
  thread: ResolvedThreadRef,
  id: string,
  kind: EventKind,
  kindRaw: string,
  actor: Actor | undefined,
  summary: string,
  at: string | undefined,
  payload: unknown,
): ForgeEventInput {
  return {
    forge: FORGE,
    instance: thread.instance,
    id,
    kind,
    kindRaw,
    summary: `${actor?.login ?? 'someone'} ${summary}`,
    occurredAt: toDate(at) ?? new Date(0),
    actor,
    repo: thread.repo,
    thread,
    source: 'poll',
    payload,
  }
}

export function toCommentEvent(thread: ResolvedThreadRef, comment: BitbucketComment): ForgeEventInput {
  const inline = Boolean(comment.inline)
  return event(
    thread,
    `comment:${comment.id}`,
    inline ? 'review_comment' : 'comment',
    inline ? 'comment.inline' : 'comment',
    toActor(thread.instance, comment.user),
    inline ? 'commented on a line' : 'commented',
    comment.created_on,
    comment,
  )
}

/** Pull request activity entries are a union keyed by their single property. */
export function toActivityEvent(thread: ResolvedThreadRef, entry: BitbucketActivity, index: number): ForgeEventInput {
  if (entry.comment) {
    return toCommentEvent(thread, entry.comment)
  }
  if (entry.approval) {
    return event(thread, `approval:${entry.approval.user?.uuid ?? index}:${entry.approval.date}`, 'review', 'approval', toActor(thread.instance, entry.approval.user), 'approved', entry.approval.date, entry)
  }
  if (entry.changes_requested) {
    return event(thread, `changes_requested:${entry.changes_requested.user?.uuid ?? index}:${entry.changes_requested.date}`, 'review', 'changes_requested', toActor(thread.instance, entry.changes_requested.user), 'requested changes', entry.changes_requested.date, entry)
  }
  const update = entry.update
  const terminal = update?.state && update.state !== 'OPEN'
  return event(
    thread,
    `update:${update?.date ?? index}`,
    terminal ? 'state_change' : 'other',
    terminal ? `update.${update!.state}` : 'update',
    toActor(thread.instance, update?.author),
    terminal ? update!.state!.toLowerCase() : 'updated the pull request',
    update?.date,
    entry,
  )
}

export function toComment(thread: ThreadRef, raw: BitbucketComment): Comment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(raw.id) },
    body: raw.content?.raw ?? '',
    author: toActor(thread.instance, raw.user),
    createdAt: toDate(raw.created_on),
    updatedAt: toDate(raw.updated_on),
    url: raw.links?.html?.href,
    raw,
  }
}

/** Bitbucket renders Markdown without HTML, so collapsible blocks become a bold heading and their content. */
export function normaliseMarkdown(body: string): string {
  return body
    .replace(/<summary>([\s\S]*?)<\/summary>/gi, (_, summary: string) => `**${summary.trim()}**\n`)
    .replace(/<\/?details[^>]*>/gi, '')
}

/** `STOPPED` builds were cancelled, which counts as a failure. */
export function statusState(state: string): CheckState {
  return state === 'SUCCESSFUL' ? 'success' : state === 'FAILED' || state === 'STOPPED' ? 'failure' : state === 'INPROGRESS' ? 'pending' : 'unknown'
}

export function toStatusCheck(repo: RepoRef, raw: BitbucketCommitStatus): Check {
  const state = statusState(raw.state)
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: raw.uuid ?? raw.key, type: 'status' },
    name: raw.name ?? raw.key,
    state,
    stateRaw: raw.state,
    url: raw.url,
    startedAt: toDate(raw.created_on),
    completedAt: state === 'pending' ? undefined : toDate(raw.updated_on),
    raw,
  }
}

export function toCommit(repo: RepoRef, raw: BitbucketCommitDetail, files?: ChangedFile[]): Commit {
  const authored = raw.author?.raw
  const match = authored ? /^(?<name>[^<]*)<(?<email>[^>]*)>$/.exec(authored) : undefined
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, sha: raw.hash },
    sha: raw.hash,
    message: raw.message ?? raw.summary?.raw ?? '',
    author: {
      actor: toActor(repo.instance, raw.author?.user),
      name: match?.groups?.name?.trim() || authored,
      email: match?.groups?.email,
      date: toDate(raw.date),
    },
    parents: raw.parents?.flatMap(parent => parent.hash ? [parent.hash] : []) ?? [],
    url: raw.links?.html?.href,
    ...files ? { files } : {},
    raw,
  }
}

/** Bitbucket reports changes as a diffstat, with the old and new paths rather than a rename flag. */
export function toChangedFile(raw: BitbucketDiffStat): ChangedFile {
  const path = raw.new?.path ?? raw.old?.path ?? ''
  return {
    path,
    previousPath: raw.status === 'renamed' ? raw.old?.path : undefined,
    status: toFileStatus(raw.status),
    statusRaw: raw.status,
    additions: raw.lines_added,
    deletions: raw.lines_removed,
  }
}

export function toBranch(raw: BitbucketRef, defaultBranch?: string): Branch {
  return {
    name: raw.name,
    sha: raw.target?.hash ?? '',
    isDefault: defaultBranch === undefined ? undefined : raw.name === defaultBranch,
    url: raw.links?.html?.href,
    raw,
  }
}

export function toTag(raw: BitbucketRef): Tag {
  return { name: raw.name, sha: raw.target?.hash ?? '', url: raw.links?.html?.href, raw }
}

export function toTreeEntry(raw: BitbucketSrcEntry): TreeEntry {
  return {
    path: raw.path,
    type: raw.type === 'commit_directory' ? 'directory' : raw.attributes?.includes('link') ? 'symlink' : 'file',
    size: raw.size,
    sha: raw.commit?.hash,
  }
}

export function toWebhook(target: RepoRef, raw: BitbucketHook): Webhook {
  const nativeEvents = raw.events ?? []
  return {
    ref: { forge: FORGE, instance: target.instance, target, id: raw.uuid },
    url: raw.url,
    events: eventKindsOf(BITBUCKET_NATIVE_EVENTS, nativeEvents),
    nativeEvents,
    active: raw.active ?? true,
    createdAt: toDate(raw.created_at),
    raw,
  }
}
