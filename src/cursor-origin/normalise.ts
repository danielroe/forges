import type { Actor, Branch, ChangedFile, Check, Comment, Commit, EventDetail, ForgeEventInput, Label, Repo, RepoRef, ResolvedThreadRef, Review, ReviewState, Tag, Thread, ThreadRef, TreeEntry } from '../model.ts'
import type { OriginActor, OriginBranch, OriginCheckRun, OriginComment, OriginCommit, OriginCommitFile, OriginGitRef, OriginLabel, OriginPullRequest, OriginRepo, OriginRepositoryReference, OriginReview, OriginTreeEntry } from './types.ts'
import { eventTime } from '../events.ts'
import { checkRunState, toDate, toFileStatus, toPullStats } from '../utils.ts'

export const FORGE = 'cursor-origin' as const

export function toActor(instance: string, actor: OriginActor | undefined): Actor | undefined {
  if (actor?.user) {
    const user = actor.user
    return {
      forge: FORGE,
      instance,
      login: user.handle ?? user.email ?? user.id,
      id: user.id,
      name: user.displayName,
      typeRaw: user.performedVia?.app ? 'user_via_app' : 'user',
      isBotHint: Boolean(user.performedVia?.app),
    }
  }
  if (actor?.app) {
    return { forge: FORGE, instance, login: actor.app.displayName ?? actor.app.id, id: actor.app.id, name: actor.app.displayName, typeRaw: 'app', isBotHint: true }
  }
  if (actor?.serviceAccount) {
    return { forge: FORGE, instance, login: actor.serviceAccount.id, id: actor.serviceAccount.id, typeRaw: 'service_account', isBotHint: true }
  }
  return undefined
}

export function toRepoRef(instance: string, repo: OriginRepositoryReference): RepoRef {
  return { forge: FORGE, instance, owner: repo.owner.slug, name: repo.name, externalId: repo.id }
}

export function toRepo(instance: string, raw: OriginRepo): Repo {
  return {
    ref: toRepoRef(instance, raw),
    defaultBranch: raw.defaultBranch,
    visibility: raw.visibility ?? 'private',
    visibilityRaw: raw.visibility,
    isFork: false,
    isArchived: false,
    topics: [],
    cloneUrls: raw.cloneUrl ? { https: raw.cloneUrl } : undefined,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    pushedAt: toDate(raw.pushedAt),
    raw,
  }
}

function threadState(raw: OriginPullRequest): Thread['state'] {
  return raw.merged ? 'merged' : raw.state === 'open' ? 'open' : raw.state === 'closed' ? 'closed' : 'unknown'
}

export function toThread(ref: ResolvedThreadRef, raw: OriginPullRequest): Thread {
  const parent = raw.stack?.parentPullRequest
  return {
    ref: { ...ref, kind: 'pull_request', number: raw.number, externalId: raw.id },
    kind: 'pull_request',
    title: raw.title,
    body: raw.body || undefined,
    state: threadState(raw),
    stateRaw: raw.merged ? 'merged' : raw.state,
    isDraft: raw.draft ?? false,
    author: toActor(ref.instance, raw.author),
    assignees: [],
    reviewers: [],
    labels: (raw.labels ?? []).map(toLabel),
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    closedAt: toDate(raw.closedAt),
    mergedAt: toDate(raw.mergedAt),
    lastActivityAt: toDate(raw.updatedAt),
    branches: raw.head && raw.base
      ? { head: { ref: raw.head.ref, sha: raw.head.sha }, base: { ref: raw.base.ref, sha: raw.base.sha }, mergeCommitSha: raw.mergeCommitSha }
      : undefined,
    stats: toPullStats({ additions: raw.additions, deletions: raw.deletions, changedFileCount: raw.changedFiles }),
    ...raw.stack
      ? {
          stack: {
            id: raw.stack.id,
            ...parent
              ? { parent: { forge: FORGE, instance: ref.instance, repo: ref.repo, kind: 'pull_request' as const, number: parent.number, externalId: parent.id } }
              : {},
          },
        }
      : {},
    raw,
  }
}

export function toLabel(raw: OriginLabel): Label {
  return { name: raw.name, colour: raw.color, description: raw.description || undefined }
}

/** General-discussion comments have no diff anchor; anchored ones are review comments. */
export function isConversationComment(raw: OriginComment): boolean {
  return !raw.thread?.path
}

export function toComment(thread: ResolvedThreadRef, raw: OriginComment): Comment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: raw.id },
    body: raw.body,
    author: toActor(thread.instance, raw.author),
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    raw,
  }
}

export function commentDetail(thread: ThreadRef, raw: OriginComment): EventDetail {
  const comment = { forge: FORGE, instance: thread.instance, thread, id: raw.id }
  return isConversationComment(raw)
    ? { type: 'comment', comment, body: raw.body }
    : { type: 'review_comment', comment, body: raw.body, path: raw.thread?.path, line: raw.thread?.endLine ?? raw.thread?.startLine }
}

export function toCommentEvent(thread: ThreadRef, raw: OriginComment): ForgeEventInput {
  const anchored = !isConversationComment(raw)
  const actor = toActor(thread.instance, raw.author)
  return {
    forge: FORGE,
    instance: thread.instance,
    id: raw.id,
    kind: anchored ? 'review_comment' : 'comment',
    kindRaw: anchored ? 'pull_request.review_comment' : 'pull_request.comment',
    summary: `${actor?.login ?? 'someone'} ${anchored ? `commented on ${raw.thread!.path}` : 'commented'}`,
    ...eventTime(toDate(raw.createdAt), new Date(0)),
    actor,
    repo: thread.repo,
    thread,
    detail: commentDetail(thread, raw),
    source: 'poll',
    payload: raw,
  }
}

const VERDICTS: Record<OriginReview['verdict'], ReviewState> = {
  approve: 'approved',
  request_changes: 'changes_requested',
  comment: 'commented',
}

export function toReviewEvent(thread: ThreadRef, raw: OriginReview, source: ForgeEventInput['source'] = 'poll'): ForgeEventInput {
  const actor = toActor(thread.instance, raw.author)
  return {
    forge: FORGE,
    instance: thread.instance,
    id: raw.id,
    kind: 'review',
    kindRaw: raw.dismissal ? 'pull_request.review.dismissed' : `pull_request.review.${raw.verdict}`,
    summary: `${actor?.login ?? 'someone'} ${raw.dismissal ? 'dismissed a review' : `reviewed (${VERDICTS[raw.verdict] ?? raw.verdict})`}`,
    detail: { type: 'review', state: raw.dismissal ? 'dismissed' : VERDICTS[raw.verdict] ?? 'unknown', stateRaw: raw.verdict, body: raw.body || undefined, review: { forge: FORGE, instance: thread.instance, thread, id: raw.id } },
    ...eventTime(toDate(raw.submittedAt), new Date(0)),
    actor,
    repo: thread.repo,
    thread,
    source,
    payload: raw,
  }
}

export function toCheck(repo: RepoRef, raw: OriginCheckRun): Check {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: raw.id, type: 'check_run' },
    name: raw.name,
    state: checkRunState(raw.status, raw.conclusion),
    stateRaw: raw.status,
    conclusionRaw: raw.conclusion,
    url: raw.detailsUrl,
    startedAt: toDate(raw.startedAt),
    completedAt: toDate(raw.completedAt),
    raw,
  }
}

export function toReview(thread: ResolvedThreadRef, raw: OriginReview): Review {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: raw.id },
    author: toActor(thread.instance, raw.author),
    state: raw.dismissal ? 'dismissed' : VERDICTS[raw.verdict] ?? 'unknown',
    stateRaw: raw.verdict,
    body: raw.body || undefined,
    submittedAt: toDate(raw.submittedAt),
    comments: false,
    raw,
  }
}

export function toChangedFile(raw: OriginCommitFile): ChangedFile {
  return {
    path: raw.filename,
    previousPath: raw.previousFilename,
    status: toFileStatus(raw.status),
    statusRaw: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
    patch: raw.patch,
  }
}

export function toCommit(repo: RepoRef, raw: OriginCommit, files?: ChangedFile[]): Commit {
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, sha: raw.sha },
    sha: raw.sha,
    message: raw.commit?.message ?? '',
    author: { name: raw.commit?.author?.name, email: raw.commit?.author?.email, date: toDate(raw.commit?.author?.date) },
    committer: { name: raw.commit?.committer?.name, email: raw.commit?.committer?.email, date: toDate(raw.commit?.committer?.date) },
    parents: raw.parents?.flatMap(parent => parent.sha ? [parent.sha] : []) ?? [],
    ...raw.stats ? { stats: { additions: raw.stats.additions ?? 0, deletions: raw.stats.deletions ?? 0, total: raw.stats.total } } : {},
    ...files ? { files } : {},
    raw,
  }
}

export function toBranch(raw: OriginBranch): Branch {
  return { name: raw.name, sha: raw.commit?.sha ?? '', raw }
}

/** Origin lists tags as refs, so the name is the ref minus its `refs/tags/` prefix. */
export function toTag(raw: OriginGitRef): Tag {
  return { name: raw.ref.replace(/^refs\/tags\//, ''), sha: raw.object?.sha ?? '', raw }
}

export function toTreeEntry(raw: OriginTreeEntry): TreeEntry {
  return {
    path: raw.path,
    type: raw.mode === '120000' ? 'symlink' : raw.type === 'tree' ? 'directory' : raw.type === 'commit' ? 'submodule' : 'file',
    sha: raw.sha,
    size: raw.size,
    mode: raw.mode,
  }
}
