/** An account as GitCafe embeds it: its own, one imported from GitHub, or one the caller may not see. */
export type GitCafeActor
  = | {
    kind: 'local'
    actorId: string
    handle: string
    displayName: string | null
    avatarUrl: string | null
    bot?: true
    via?: { app: string, iconUrl: string | null }
  }
  | {
    kind: 'github'
    actorId: string
    authority: string
    providerId: number
    login: string
    accountType: 'user' | 'organization' | 'bot'
    avatarUrl: string | null
  }
  | { kind: 'unavailable', actorId: string }

/** An assignee, a reviewer or a candidate for either. */
export interface GitCafeMember {
  id: string
  actor: GitCafeActor
  handle: string | null
  displayName: string | null
  avatarUrl: string | null
  requestedAt?: string
  latestReview?: { verdict?: string } | null
}

export interface GitCafeProfile {
  actorId: string
  handle: string
  displayName: string | null
  bio: string | null
  location: string | null
  company: string | null
  websiteUrl: string | null
  avatarUrl: string | null
}

export interface GitCafeRepository {
  id: string
  owner: string
  name: string
  description: string | null
  homepage: string | null
  topics: string[]
  visibility: 'public' | 'private'
  defaultBranch: string
  archivedAt: string | null
  createdAt?: string
  updatedAt: string
  parent?: { owner: string, repo: string, defaultBranch: string } | null
}

export interface GitCafeLabel {
  id: string
  name: string
  color: string
  description?: string | null
}

export interface GitCafeMilestone {
  id: string
  number: number
  title: string
  state: 'open' | 'closed'
  description?: string | null
  dueDate?: string | null
}

export interface GitCafeReactionCounts {
  items: Array<{ emojiKind: 'unicode' | 'custom', emojiValue: string, count: number }>
  truncated: boolean
}

export interface GitCafeIssue {
  id: string
  number: number
  title: string
  description: string | null
  version: number
  stateType: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
  author: GitCafeActor
  closedAt: string | null
  closedReason: string | null
  lockedAt: string | null
  createdAt: string
  updatedAt: string
  labels?: GitCafeLabel[]
  assignees?: GitCafeMember[]
  milestone?: GitCafeMilestone | null
  reactionCounts?: GitCafeReactionCounts
}

export interface GitCafePull {
  id: string
  number: number
  title: string
  description?: string | null
  version: number
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: GitCafeActor
  sourceBranch: string
  targetBranch: string
  headOid: string | null
  observedBaseOid?: string | null
  mergeResultOid?: string | null
  sourceRepo?: { owner: string, name: string } | null
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  createdAt: string
  updatedAt: string
  closedAt?: string | null
  mergedAt?: string | null
  lockedAt?: string | null
  milestoneId?: string | null
  /** The listing embeds these; a single read leaves them to their own endpoints. */
  labels?: GitCafeLabel[]
  assignees?: GitCafeMember[]
  reviewers?: GitCafeMember[]
  milestone?: GitCafeMilestone | null
}

export interface GitCafeIssueComment {
  id: string
  author: GitCafeActor
  body: string
  version: number
  createdAt: string
  updatedAt: string
  hiddenAt: string | null
}

export interface GitCafePullComment {
  id: string
  threadId: string
  reviewId: string | null
  author: GitCafeActor
  body: string | null
  version: number
  createdAt: string
  updatedAt: string
  path: string | null
  line: number | null
  side: 'left' | 'right' | null
  startLine?: number | null
  resolvedAt: string | null
  hiddenAt: string | null
  deletedAt: string | null
}

export interface GitCafeReview {
  id: string
  author: GitCafeActor
  commitOid: string
  verdict: 'approve' | 'request_changes' | 'comment'
  body?: string | null
  dismissedAt?: string | null
  createdAt?: string
}

export interface GitCafeReactionGroup {
  emoji: { kind: 'unicode', value: string } | { kind: 'custom', id: string }
  count: number
  viewerReactionId: string | null
  reactors: GitCafeActor[]
}

export interface GitCafeSignature {
  name: string
  email: string
  timestamp: number
}

export interface GitCafeCommit {
  oid: string
  parents: string[]
  message: string
  author: GitCafeSignature
  committer: GitCafeSignature
}

export interface GitCafeRef {
  name: string
  oid: string
  isHead: boolean
  targetCommit: { oid: string }
}

export interface GitCafeTreeEntry {
  name: string
  path: string
  oid: string
  mode?: string | number
  kind: 'blob' | 'tree' | 'commit' | 'symlink'
}

export interface GitCafeBlob {
  commit: string
  oid: string
  path: string
  size: number
  binary: boolean
  content: string | null
}

export interface GitCafeChangedFile {
  path: string
  oldPath?: string | null
  status?: 'added' | 'deleted' | 'modified' | 'typeChanged' | 'conflicted' | 'renamed' | 'copied'
  binary?: boolean
  additions?: number
  deletions?: number
}

export interface GitCafeCheck {
  id: string
  provider: string
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  detailsUrl: string | null
  runId: string | null
}

export interface GitCafeStatus {
  id: string
  context: string
  state: 'error' | 'failure' | 'pending' | 'success'
  description: string | null
  targetUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface GitCafePullStatus {
  version: number
  headOid: string | null
  baseOid: string | null
  merge: { strategies: string[] }
}

export interface GitCafeCollaborator {
  actorId: string
  role: 'repo-reader' | 'repo-triager' | 'repo-writer' | 'repo-maintainer' | 'repo-admin'
  handle: string
  displayName: string | null
  avatarUrl: string | null
}

export interface GitCafeRun {
  id: string
  runNumber: number
  workflowName: string
  event: string
  ref: string
  headOid: string
  status: 'queued' | 'running' | 'completed'
  conclusion: string | null
  actor: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface GitCafeWebhook {
  id: string
  url: string
  events: string[]
  active: boolean
  version: number
  createdAt?: string
  updatedAt?: string
}

export interface GitCafeDelivery {
  id: string
  eventId: string
  eventCreatedAt: string
  eventType: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_lettered' | 'cancelled'
  lastHttpStatus: number | null
  deliveredAt: string | null
}

/** A merge that GitCafe runs as an operation: finished in the response, or still going. */
export interface GitCafeMergeOperation {
  id: string
  state: string
  resultOid: string | null
}
