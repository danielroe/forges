import type { Actor, ChangedFile, Comment, Commit, CommitSignature, ForgeOrigin, Label, ReactionContent, ReactionSummary, Repo, RepoRef, ResolvedThreadRef, Review, ReviewComment, ReviewState, Thread, ThreadState, TreeEntry } from '../model.ts'
import type { RadicleAuthor, RadicleComment, RadicleCommit, RadicleFileDiff, RadicleIssue, RadiclePatch, RadicleReaction, RadicleRepository, RadicleRevision, RadicleTreeEntry } from './types.ts'
import { radicleRepoRef, ridOf } from './web.ts'

export const FORGE = 'radicle'

/** The emoji that each shared reaction name stands for. */
const REACTION_NAMES: Record<string, ReactionContent> = {
  '👍': '+1',
  '👎': '-1',
  '😄': 'laugh',
  '😆': 'laugh',
  '🎉': 'hooray',
  '😕': 'confused',
  '❤️': 'heart',
  '❤': 'heart',
  '🚀': 'rocket',
  '👀': 'eyes',
}

const VERDICTS: Record<string, ReviewState> = {
  accept: 'approved',
  reject: 'changes_requested',
}

/** An account is its DID, and the node's alias only a name. */
export function toActor(origin: ForgeOrigin, author: RadicleAuthor): Actor {
  return {
    ...origin,
    login: author.id,
    id: author.id,
    ...author.alias
      ? { name: author.alias }
      : {},
    isBotHint: false,
  }
}

function fromSeconds(seconds: number | undefined): Date | undefined {
  return typeof seconds === 'number'
    ? new Date(seconds * 1000)
    : undefined
}

function toReactions(raw: RadicleReaction[]): ReactionSummary | undefined {
  if (!raw.length) {
    return undefined
  }
  const counts: Partial<Record<ReactionContent, number>> = {}
  let total = 0
  for (const reaction of raw) {
    total += reaction.authors.length
    const name = REACTION_NAMES[reaction.emoji]
    if (name) {
      counts[name] = (counts[name] ?? 0) + reaction.authors.length
    }
  }
  return { total, counts }
}

const branchName = (ref: string) => ref.replace(/^refs\/heads\//, '')

export function toRepo(origin: ForgeOrigin, raw: RadicleRepository, webUrl: string): Repo {
  const project = raw.payloads['xyz.radicle.project']
  const issues = raw.cobs?.issues ?? project?.meta?.issues
  const patches = raw.cobs?.patches ?? project?.meta?.patches
  const ref = radicleRepoRef(origin, raw.rid)
  return {
    ref,
    displayName: project?.data.name,
    description: project?.data.description || undefined,
    defaultBranch: raw.defaultBranch
      ? branchName(raw.defaultBranch)
      : project?.data.defaultBranch,
    visibility: raw.visibility.type === 'private'
      ? 'private'
      : 'public',
    visibilityRaw: raw.visibility.type,
    isFork: false,
    isArchived: false,
    topics: [],
    url: `${webUrl}/${ridOf(ref)}`,
    cloneUrls: { https: `https://${origin.instance}/${ref.name}.git` },
    ...issues
      ? { openIssueCount: issues.open }
      : {},
    ...patches
      ? { openPullCount: patches.open + patches.draft }
      : {},
    watchers: raw.seeding,
    raw,
  }
}

export function toThreadRef(origin: ForgeOrigin, repo: RepoRef, kind: 'issue' | 'pull_request', id: string): ResolvedThreadRef {
  return { ...origin, repo, kind, number: id }
}

function threadUrl(webUrl: string, ref: ResolvedThreadRef): string {
  return `${webUrl}/${ridOf(ref.repo)}/${ref.kind === 'issue'
    ? 'issues'
    : 'patches'}/${ref.number}`
}

const toLabels = (labels: string[]): Label[] => labels.map(name => ({ name }))

/** Participants in order of first appearance, from the author on. */
function participants(origin: ForgeOrigin, authors: RadicleAuthor[]): Actor[] {
  const seen = new Map<string, RadicleAuthor>()
  for (const author of authors) {
    if (!seen.has(author.id)) {
      seen.set(author.id, author)
    }
  }
  return [
    ...seen.values(),
  ].map(author => toActor(origin, author))
}

function lastTimestamp(comments: RadicleComment[]): number | undefined {
  return comments.reduce<number | undefined>((latest, comment) => Math.max(latest ?? 0, comment.timestamp, ...comment.edits.map(edit => edit.timestamp)), undefined)
}

export function toIssue(origin: ForgeOrigin, repo: RepoRef, raw: RadicleIssue, webUrl: string): Thread {
  const ref = toThreadRef(origin, repo, 'issue', raw.id)
  const [opening, ...replies] = raw.discussion
  const closed = raw.state.status === 'closed'
  return {
    ref,
    kind: 'issue',
    title: raw.title,
    body: opening?.edits.at(-1)?.body ?? opening?.body,
    state: closed
      ? 'closed'
      : 'open',
    stateRaw: raw.state.status,
    ...raw.state.status === 'closed'
      ? {
          stateReason: raw.state.reason === 'solved'
            ? 'completed'
            : raw.state.reason,
        }
      : {},
    isDraft: false,
    author: toActor(origin, raw.author),
    assignees: raw.assignees.map(assignee => toActor(origin, assignee)),
    reviewers: [],
    labels: toLabels(raw.labels),
    url: threadUrl(webUrl, ref),
    createdAt: fromSeconds(opening?.timestamp),
    lastActivityAt: fromSeconds(lastTimestamp(raw.discussion)),
    commentCount: replies.length,
    participants: participants(origin, raw.discussion.map(comment => comment.author)),
    reactions: toReactions(opening?.reactions ?? []),
    raw,
  }
}

const PATCH_STATES: Record<RadiclePatch['state']['status'], ThreadState> = {
  draft: 'open',
  open: 'open',
  archived: 'closed',
  merged: 'merged',
}

/** The revision a patch is judged by: the merged one, or else the latest. */
export function currentRevision(raw: RadiclePatch): RadicleRevision | undefined {
  return raw.state.status === 'merged'
    ? raw.revisions.find(revision => revision.id === (raw.state as { revision: string }).revision) ?? raw.revisions.at(-1)
    : raw.revisions.at(-1)
}

export function toPatch(origin: ForgeOrigin, repo: RepoRef, raw: RadiclePatch, webUrl: string, defaultBranch?: string): Thread {
  const ref = toThreadRef(origin, repo, 'pull_request', raw.id)
  const [first] = raw.revisions
  const revision = currentRevision(raw)
  const merge = raw.state.status === 'merged'
    ? raw.merges.find(entry => entry.commit === (raw.state as { commit: string }).commit) ?? raw.merges[0]
    : undefined
  const comments = raw.revisions.flatMap(entry => entry.discussions)
  const reviewers = participants(origin, raw.revisions.flatMap(entry => entry.reviews.map(review => review.author)))
  return {
    ref,
    kind: 'pull_request',
    title: raw.title,
    body: first?.description || undefined,
    state: PATCH_STATES[raw.state.status],
    stateRaw: raw.state.status,
    isDraft: raw.state.status === 'draft',
    author: toActor(origin, raw.author),
    assignees: raw.assignees.map(assignee => toActor(origin, assignee)),
    reviewers: reviewers.map(actor => ({
      actor,
      ...latestVerdict(raw, actor.id),
    })),
    labels: toLabels(raw.labels),
    url: threadUrl(webUrl, ref),
    createdAt: fromSeconds(first?.timestamp),
    lastActivityAt: fromSeconds(Math.max(
      ...raw.revisions.flatMap(entry => [
        entry.timestamp,
        ...entry.reviews.map(review => review.timestamp),
      ]),
      lastTimestamp(raw.revisions.flatMap(entry => entry.reviews.flatMap(review => review.comments))) ?? 0,
      ...raw.merges.map(entry => entry.timestamp),
      lastTimestamp(comments) ?? 0,
    )),
    mergedAt: fromSeconds(merge?.timestamp),
    ...merge
      ? {
          mergedBy: toActor(origin, merge.author),
        }
      : {},
    commentCount: comments.length,
    participants: participants(origin, [
      raw.author,
      ...comments.map(comment => comment.author),
    ]),
    reactions: toReactions(first?.reactions ?? []),
    ...revision
      ? {
          branches: {
            head: {
              ref: revision.refs[0]
                ? branchName(revision.refs[0])
                : `patches/${raw.id}`,
              sha: revision.oid,
            },
            base: { ref: defaultBranch ?? raw.target, sha: revision.base },
            ...merge
              ? { mergeCommitSha: merge.commit }
              : {},
          },
        }
      : {},
    raw,
  }
}

/** What the reviewer's latest review said. */
function latestVerdict(raw: RadiclePatch, did: string): { state: ReviewState, stateRaw?: string } {
  const review = raw.revisions.flatMap(revision => revision.reviews).filter(entry => entry.author.id === did).at(-1)
  return review?.verdict
    ? { state: VERDICTS[review.verdict]!, stateRaw: review.verdict }
    : { state: 'commented' }
}

export function toComment(origin: ForgeOrigin, thread: ResolvedThreadRef, raw: RadicleComment, webUrl: string): Comment {
  return {
    ref: { ...origin, thread, id: raw.id },
    body: raw.edits.at(-1)?.body ?? raw.body,
    author: toActor(origin, raw.author),
    createdAt: fromSeconds(raw.timestamp),
    ...raw.edits.length > 1
      ? {
          updatedAt: fromSeconds(raw.edits.at(-1)!.timestamp),
        }
      : {},
    url: threadUrl(webUrl, thread),
    reactions: toReactions(raw.reactions),
    raw,
  }
}

function toReviewComment(origin: ForgeOrigin, thread: ResolvedThreadRef, raw: RadicleComment): ReviewComment {
  const range = raw.location?.new ?? raw.location?.old
  const line = range && (range.type === 'lines'
    ? range.range.end
    : range.line)
  return {
    ref: { ...origin, thread, id: raw.id },
    body: raw.edits.at(-1)?.body ?? raw.body,
    author: toActor(origin, raw.author),
    ...raw.location
      ? { path: raw.location.path }
      : {},
    ...line
      ? {
          line,
          side: raw.location?.new
            ? 'right'
            : 'left',
        }
      : {},
    ...raw.replyTo
      ? { inReplyTo: raw.replyTo }
      : {},
    createdAt: fromSeconds(raw.timestamp),
    raw,
  }
}

export function toReviews(origin: ForgeOrigin, thread: ResolvedThreadRef, raw: RadiclePatch): Review[] {
  return raw.revisions.flatMap(revision => revision.reviews.map((review): Review => ({
    ref: { ...origin, thread, id: review.id },
    author: toActor(origin, review.author),
    state: review.verdict
      ? VERDICTS[review.verdict]!
      : 'commented',
    stateRaw: review.verdict ?? undefined,
    body: review.summary ?? undefined,
    submittedAt: fromSeconds(review.timestamp),
    comments: review.comments.map(comment => toReviewComment(origin, thread, comment)),
    raw: review,
  })))
}

function signature(person: { name: string, email: string }, seconds?: number): CommitSignature {
  return {
    name: person.name,
    email: person.email,
    ...seconds === undefined
      ? {}
      : {
          date: fromSeconds(seconds),
        },
  }
}

export function toCommit(origin: ForgeOrigin, repo: RepoRef, raw: RadicleCommit, webUrl: string, files?: ChangedFile[]): Commit {
  return {
    ref: { ...origin, repo, sha: raw.id },
    sha: raw.id,
    message: raw.description
      ? `${raw.summary}\n\n${raw.description}`
      : raw.summary,
    author: signature(raw.author),
    committer: signature(raw.committer, raw.committer.time),
    parents: raw.parents,
    url: `${webUrl}/${ridOf(repo)}/commits/${raw.id}`,
    ...files
      ? { files }
      : {},
    raw,
  }
}

export function toChangedFile(raw: RadicleFileDiff): ChangedFile {
  const stats = raw.diff?.type === 'plain'
    ? raw.diff.stats
    : undefined
  const counts = stats
    ? { additions: stats.additions, deletions: stats.deletions }
    : {}
  switch (raw.status) {
    case 'added':
      return {
        path: raw.path,
        status: 'added',
        statusRaw: raw.status,
        sha: raw.new.oid,
        isBinary: raw.diff.type === 'binary',
        ...counts,
      }
    case 'deleted':
      return {
        path: raw.path,
        status: 'removed',
        statusRaw: raw.status,
        isBinary: raw.diff.type === 'binary',
        ...counts,
      }
    case 'modified':
      return {
        path: raw.path,
        status: raw.old.oid === raw.new.oid
          ? 'changed'
          : 'modified',
        statusRaw: raw.status,
        sha: raw.new.oid,
        isBinary: raw.diff.type === 'binary',
        ...counts,
      }
    default:
      return {
        path: raw.newPath,
        previousPath: raw.oldPath,
        status: raw.status === 'moved'
          ? 'renamed'
          : 'copied',
        statusRaw: raw.status,
        sha: (raw.new ?? raw.current)?.oid,
        ...counts,
      }
  }
}

export function toTreeEntry(raw: RadicleTreeEntry): TreeEntry {
  return {
    path: raw.path,
    type: raw.kind === 'tree'
      ? 'directory'
      : raw.kind === 'submodule'
        ? 'submodule'
        : 'file',
    sha: raw.oid,
  }
}
