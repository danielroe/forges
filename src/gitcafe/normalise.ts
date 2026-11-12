import type { Actor, Branch, ChangedFile, Check, CiRun, Collaborator, Comment, Commit, ForgeOrigin, Label, Milestone, Reaction, ReactionContent, ReactionSummary, Repo, RepoRef, RepoRole, ResolvedThreadRef, Review, ReviewComment, Reviewer, ReviewState, ReviewThread, Tag, Thread, TreeEntry, User, Webhook, WebhookDeliveryRecord, WebhookRef } from '../model.ts'
import type { GitCafeActor, GitCafeChangedFile, GitCafeCheck, GitCafeCollaborator, GitCafeCommit, GitCafeDelivery, GitCafeIssue, GitCafeIssueComment, GitCafeLabel, GitCafeMember, GitCafeMilestone, GitCafeProfile, GitCafePull, GitCafePullComment, GitCafeReactionCounts, GitCafeReactionGroup, GitCafeRef, GitCafeRepository, GitCafeReview, GitCafeRun, GitCafeStatus, GitCafeTreeEntry, GitCafeWebhook } from './types.ts'
import { checkRunState, toDate, toFileStatus, toPullStats } from '../utils.ts'
import { eventKindsOf } from '../webhooks.ts'
import { GITCAFE_NATIVE_EVENTS } from './webhook-events.ts'

export const FORGE = 'gitcafe'

/** Where an object comes from, and the root of the website that its links start at. */
export interface Site extends ForgeOrigin {
  url: string
}

/** GitCafe stores reactions as emoji, so the shared names map onto the emoji that GitHub draws for them. */
export const REACTION_EMOJI: Record<ReactionContent, string> = {
  '+1': '👍',
  '-1': '👎',
  'laugh': '😄',
  'confused': '😕',
  'heart': '❤️',
  'hooray': '🎉',
  'rocket': '🚀',
  'eyes': '👀',
}

const REACTION_NAMES = new Map<string, ReactionContent>(Object.entries(REACTION_EMOJI).map(([name, emoji]) => [
  stripVariation(emoji),
  name as ReactionContent,
]))

const ROLES: Record<GitCafeCollaborator['role'], RepoRole> = {
  'repo-admin': 'admin',
  'repo-maintainer': 'maintain',
  'repo-writer': 'write',
  'repo-triager': 'triage',
  'repo-reader': 'read',
}

const REVIEW_STATES: Record<GitCafeReview['verdict'], ReviewState> = {
  approve: 'approved',
  request_changes: 'changes_requested',
  comment: 'commented',
}

/** A heart arrives with or without its variation selector, and both are the same reaction. */
function stripVariation(emoji: string): string {
  return emoji.replaceAll('️', '')
}

function absolute(site: Site, path: string | null | undefined): string | undefined {
  return path
    ? new URL(path, `${site.url}/`).href
    : undefined
}

function origin({ forge, instance }: ForgeOrigin): ForgeOrigin {
  return { forge, instance }
}

export function toActor(site: Site, raw: GitCafeActor | null | undefined): Actor | undefined {
  if (!raw || raw.kind === 'unavailable') {
    return undefined
  }
  if (raw.kind === 'github') {
    return {
      ...origin(site),
      login: raw.login,
      id: raw.actorId,
      avatarUrl: absolute(site, raw.avatarUrl),
      typeRaw: `github:${raw.accountType}`,
      isBotHint: raw.accountType === 'bot',
    }
  }
  return {
    ...origin(site),
    login: raw.handle,
    id: raw.actorId,
    name: raw.displayName ?? undefined,
    avatarUrl: absolute(site, raw.avatarUrl),
    url: `${site.url}/${encodeURIComponent(raw.handle)}`,
    typeRaw: raw.kind,
    isBotHint: raw.bot === true,
  }
}

/** An account that a listing names by handle beside its ids. */
export function toHandleActor(site: Site, raw: { actorId: string, handle: string, displayName: string | null, avatarUrl: string | null }): Actor {
  return toActor(site, { kind: 'local', ...raw })!
}

export function toUser(site: Site, raw: GitCafeProfile): User {
  return {
    ...toHandleActor(site, raw),
    bio: raw.bio ?? undefined,
    company: raw.company ?? undefined,
    location: raw.location ?? undefined,
    websiteUrl: raw.websiteUrl ?? undefined,
    raw,
  }
}

function toMemberActor(site: Site, raw: GitCafeMember): Actor | undefined {
  return toActor(site, raw.actor) ?? (raw.handle
    ? toHandleActor(site, {
        actorId: raw.id,
        handle: raw.handle,
        displayName: raw.displayName,
        avatarUrl: raw.avatarUrl,
      })
    : undefined)
}

export function toMembers(site: Site, raw: GitCafeMember[] | undefined): Actor[] {
  return (raw ?? []).flatMap(member => toMemberActor(site, member) ?? [])
}

export function toReviewers(site: Site, raw: GitCafeMember[] | undefined): Reviewer[] {
  return (raw ?? []).flatMap((member) => {
    const actor = toMemberActor(site, member)
    const verdict = member.latestReview?.verdict as GitCafeReview['verdict'] | undefined
    return actor
      ? [
          {
            actor,
            state: verdict
              ? REVIEW_STATES[verdict] ?? 'unknown'
              : 'pending',
            stateRaw: verdict,
            requestedAt: toDate(member.requestedAt),
          },
        ]
      : []
  })
}

export function toCollaborator(site: Site, raw: GitCafeCollaborator): Collaborator {
  return {
    actor: toHandleActor(site, raw),
    role: ROLES[raw.role] ?? 'none',
    roleRaw: raw.role,
    raw,
  }
}

export function toRepoRef(site: Site, raw: Pick<GitCafeRepository, 'id' | 'owner' | 'name'>): RepoRef {
  return {
    ...origin(site),
    owner: raw.owner,
    name: raw.name,
    externalId: raw.id,
  }
}

export function toRepo(site: Site, raw: GitCafeRepository): Repo {
  const url = `${site.url}/${encodeURIComponent(raw.owner)}/${encodeURIComponent(raw.name)}`
  return {
    ref: toRepoRef(site, raw),
    description: raw.description ?? undefined,
    defaultBranch: raw.defaultBranch,
    visibility: raw.visibility,
    visibilityRaw: raw.visibility,
    isFork: Boolean(raw.parent),
    isArchived: Boolean(raw.archivedAt),
    parent: raw.parent
      ? {
          ...origin(site),
          owner: raw.parent.owner,
          name: raw.parent.repo,
        }
      : undefined,
    topics: raw.topics,
    url,
    cloneUrls: { https: `${url}.git` },
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    homepage: raw.homepage || undefined,
    raw,
  }
}

export function toLabel(raw: GitCafeLabel): Label {
  const colour = raw.color.replace(/^#/, '')
  return {
    name: raw.name,
    colour: /^[0-9a-f]{6}$/i.test(colour)
      ? colour
      : undefined,
    description: raw.description ?? undefined,
  }
}

export function toMilestone(raw: GitCafeMilestone): Milestone {
  return {
    id: raw.id,
    title: raw.title,
    state: raw.state,
    description: raw.description ?? undefined,
    dueOn: toDate(raw.dueDate),
    raw,
  }
}

function toReactionSummary(raw: GitCafeReactionCounts | undefined): ReactionSummary | undefined {
  if (!raw) {
    return undefined
  }
  const counts: ReactionSummary['counts'] = {}
  let total = 0
  for (const item of raw.items) {
    total += item.count
    const name = item.emojiKind === 'unicode'
      ? REACTION_NAMES.get(stripVariation(item.emojiValue))
      : undefined
    if (name) {
      counts[name] = (counts[name] ?? 0) + item.count
    }
  }
  return { total, counts }
}

export function toReactions(site: Site, raw: GitCafeReactionGroup): Reaction[] {
  const contentRaw = raw.emoji.kind === 'unicode'
    ? raw.emoji.value
    : raw.emoji.id
  const content = raw.emoji.kind === 'unicode'
    ? REACTION_NAMES.get(stripVariation(raw.emoji.value)) ?? 'other'
    : 'other'
  return raw.reactors.flatMap((reactor) => {
    const actor = toActor(site, reactor)
    return actor
      ? [
          { content, contentRaw, actor, raw },
        ]
      : []
  })
}

export function toIssueThread(site: Site, ref: ResolvedThreadRef, raw: GitCafeIssue): Thread {
  const closed = raw.stateType === 'completed' || raw.stateType === 'canceled'
  return {
    ref: { ...ref, kind: 'issue', externalId: raw.id },
    kind: 'issue',
    title: raw.title,
    body: raw.description ?? undefined,
    state: closed
      ? 'closed'
      : 'open',
    stateRaw: raw.stateType,
    stateReason: raw.closedReason ?? undefined,
    isDraft: false,
    author: toActor(site, raw.author),
    assignees: toMembers(site, raw.assignees),
    reviewers: [],
    labels: (raw.labels ?? []).map(toLabel),
    url: `${site.url}/${encodeURIComponent(ref.repo.owner)}/${encodeURIComponent(ref.repo.name)}/issues/${raw.number}`,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    closedAt: toDate(raw.closedAt),
    lastActivityAt: toDate(raw.updatedAt),
    locked: Boolean(raw.lockedAt),
    milestone: raw.milestone
      ? toMilestone(raw.milestone)
      : undefined,
    reactions: toReactionSummary(raw.reactionCounts),
    raw,
  }
}

export function toPullThread(site: Site, ref: ResolvedThreadRef, raw: GitCafePull): Thread {
  return {
    ref: { ...ref, kind: 'pull_request', externalId: raw.id },
    kind: 'pull_request',
    title: raw.title,
    body: raw.description || undefined,
    state: raw.state,
    stateRaw: raw.state,
    isDraft: raw.draft,
    author: toActor(site, raw.author),
    assignees: toMembers(site, raw.assignees),
    reviewers: toReviewers(site, raw.reviewers),
    labels: (raw.labels ?? []).map(toLabel),
    url: `${site.url}/${encodeURIComponent(ref.repo.owner)}/${encodeURIComponent(ref.repo.name)}/pull/${raw.number}`,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    closedAt: toDate(raw.closedAt ?? raw.mergedAt),
    mergedAt: toDate(raw.mergedAt),
    lastActivityAt: toDate(raw.updatedAt),
    locked: raw.lockedAt === undefined
      ? undefined
      : Boolean(raw.lockedAt),
    milestone: raw.milestone
      ? toMilestone(raw.milestone)
      : undefined,
    branches: {
      head: {
        ref: raw.sourceBranch,
        sha: raw.headOid ?? undefined,
        repo: raw.sourceRepo
          ? {
              ...origin(site),
              owner: raw.sourceRepo.owner,
              name: raw.sourceRepo.name,
            }
          : undefined,
      },
      base: { ref: raw.targetBranch, sha: raw.observedBaseOid ?? undefined },
      mergeCommitSha: raw.mergeResultOid ?? undefined,
    },
    stats: toPullStats({ additions: raw.additions, deletions: raw.deletions, changedFileCount: raw.changedFiles }),
    raw,
  }
}

export function toIssueComment(site: Site, thread: ResolvedThreadRef, raw: GitCafeIssueComment): Comment {
  return {
    ref: {
      ...origin(site),
      thread,
      id: raw.id,
    },
    body: raw.body,
    author: toActor(site, raw.author),
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    raw,
  }
}

export function toPullComment(site: Site, thread: ResolvedThreadRef, raw: GitCafePullComment): Comment {
  return {
    ref: {
      ...origin(site),
      thread,
      id: raw.id,
    },
    body: raw.body ?? '',
    author: toActor(site, raw.author),
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    thread: raw.path
      ? {
          id: raw.threadId,
          resolved: Boolean(raw.resolvedAt),
        }
      : undefined,
    raw,
  }
}

export function toReviewComment(site: Site, thread: ResolvedThreadRef, raw: GitCafePullComment): ReviewComment {
  return {
    ref: {
      ...origin(site),
      thread,
      id: raw.id,
    },
    body: raw.body ?? '',
    author: toActor(site, raw.author),
    path: raw.path ?? undefined,
    line: raw.line ?? undefined,
    side: raw.side ?? undefined,
    inReplyTo: raw.threadId === raw.id
      ? undefined
      : raw.threadId,
    thread: {
      id: raw.threadId,
      resolved: Boolean(raw.resolvedAt),
    },
    createdAt: toDate(raw.createdAt),
    raw,
  }
}

/** Groups inline comments into their conversations, in the order each conversation started. */
export function toReviewThreads(site: Site, thread: ResolvedThreadRef, raw: GitCafePullComment[]): ReviewThread[] {
  const grouped = new Map<string, GitCafePullComment[]>()
  for (const comment of raw) {
    grouped.set(comment.threadId, [
      ...grouped.get(comment.threadId) ?? [],
      comment,
    ])
  }
  return [...grouped].map(([id, comments]) => {
    const first = comments[0]!
    return {
      id,
      resolved: comments.some(comment => comment.resolvedAt),
      path: first.path ?? undefined,
      line: first.line ?? undefined,
      startLine: first.startLine ?? undefined,
      side: first.side ?? undefined,
      comments: comments.map(comment => toReviewComment(site, thread, comment)),
      raw: comments,
    }
  })
}

export function toReview(site: Site, thread: ResolvedThreadRef, raw: GitCafeReview, comments: ReviewComment[]): Review {
  return {
    ref: {
      ...origin(site),
      thread,
      id: raw.id,
    },
    author: toActor(site, raw.author),
    state: raw.dismissedAt
      ? 'dismissed'
      : REVIEW_STATES[raw.verdict] ?? 'unknown',
    stateRaw: raw.verdict,
    body: raw.body || undefined,
    submittedAt: toDate(raw.createdAt),
    comments,
    raw,
  }
}

export function toCommit(site: Site, repo: RepoRef, raw: GitCafeCommit): Commit {
  return {
    ref: {
      ...origin(site),
      repo,
      sha: raw.oid,
    },
    sha: raw.oid,
    message: raw.message,
    author: {
      name: raw.author.name,
      email: raw.author.email,
      date: toDate(raw.author.timestamp * 1000),
    },
    committer: {
      name: raw.committer.name,
      email: raw.committer.email,
      date: toDate(raw.committer.timestamp * 1000),
    },
    parents: raw.parents,
    url: `${site.url}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commit/${raw.oid}`,
    raw,
  }
}

export function toBranch(raw: GitCafeRef): Branch {
  return {
    name: raw.name,
    sha: raw.targetCommit.oid,
    isDefault: raw.isHead,
    raw,
  }
}

export function toTag(raw: GitCafeRef): Tag {
  return {
    name: raw.name,
    sha: raw.targetCommit.oid,
    raw,
  }
}

const ENTRY_TYPES: Record<GitCafeTreeEntry['kind'], TreeEntry['type']> = {
  blob: 'file',
  tree: 'directory',
  commit: 'submodule',
  symlink: 'symlink',
}

export function toTreeEntry(raw: GitCafeTreeEntry): TreeEntry {
  return {
    path: raw.path,
    type: ENTRY_TYPES[raw.kind] ?? 'file',
    sha: raw.oid,
    mode: typeof raw.mode === 'number'
      ? raw.mode.toString(8)
      : raw.mode,
  }
}

export function toChangedFile(raw: GitCafeChangedFile): ChangedFile {
  return {
    path: raw.path,
    previousPath: raw.oldPath ?? undefined,
    status: toFileStatus(raw.status),
    statusRaw: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
    isBinary: raw.binary,
  }
}

export function toCheck(site: Site, repo: RepoRef, raw: GitCafeCheck): Check {
  return {
    // A commit status shows up among the checks under its own id.
    ref: {
      ...origin(site),
      repo,
      id: raw.id,
      type: raw.id.startsWith('cstatus_')
        ? 'status'
        : 'check_run',
    },
    name: raw.name,
    state: checkRunState(raw.status, raw.conclusion),
    stateRaw: raw.status,
    conclusionRaw: raw.conclusion ?? undefined,
    url: raw.detailsUrl ?? undefined,
    run: raw.runId
      ? {
          ...origin(site),
          repo,
          id: raw.runId,
        }
      : undefined,
    raw,
  }
}

export function toStatusCheck(site: Site, repo: RepoRef, raw: GitCafeStatus): Check {
  return {
    ref: {
      ...origin(site),
      repo,
      id: raw.id,
      type: 'status',
    },
    name: raw.context,
    state: raw.state === 'error'
      ? 'failure'
      : raw.state,
    stateRaw: raw.state,
    url: raw.targetUrl ?? undefined,
    raw,
  }
}

/** GitCafe says `running` where the shared mapping expects GitHub's `in_progress`; neither is `completed`, so both stay pending. */
export function toRun(site: Site, repo: RepoRef, raw: GitCafeRun): CiRun {
  return {
    ref: {
      ...origin(site),
      repo,
      id: raw.id,
    },
    name: raw.workflowName,
    state: checkRunState(raw.status, raw.conclusion),
    stateRaw: raw.status,
    number: String(raw.runNumber),
    eventRaw: raw.event,
    branch: raw.ref.replace(/^refs\/heads\//, ''),
    sha: raw.headOid,
    createdAt: toDate(raw.createdAt),
    startedAt: toDate(raw.startedAt),
    completedAt: toDate(raw.completedAt),
    raw,
  }
}

export function toWebhook(target: RepoRef, raw: GitCafeWebhook): Webhook {
  const ref: WebhookRef = {
    forge: target.forge,
    instance: target.instance,
    target,
    id: raw.id,
  }
  return {
    ref,
    url: raw.url,
    events: eventKindsOf(GITCAFE_NATIVE_EVENTS, raw.events),
    nativeEvents: raw.events,
    active: raw.active,
    contentType: 'json',
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    raw,
  }
}

export function toDelivery(hook: WebhookRef, raw: GitCafeDelivery): WebhookDeliveryRecord {
  return {
    ref: {
      forge: hook.forge,
      instance: hook.instance,
      hook,
      id: raw.id,
    },
    event: raw.eventType,
    status: raw.lastHttpStatus ?? 0,
    ok: raw.state === 'succeeded',
    deliveredAt: toDate(raw.deliveredAt),
    raw,
  }
}
