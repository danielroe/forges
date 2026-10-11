export interface OriginUser {
  id: string
  email?: string
  displayName?: string
  handle?: string
  performedVia?: { app?: OriginApp }
}

export interface OriginApp {
  id: string
  displayName?: string
}

export interface OriginActor {
  user?: OriginUser
  app?: OriginApp
  serviceAccount?: { id: string }
}

export interface OriginOwner {
  slug: string
  id?: string
  type?: 'team' | 'user'
}

export interface OriginRepo {
  id: string
  name: string
  fullName?: string
  owner: OriginOwner
  defaultBranch?: string
  createdAt?: string
  updatedAt?: string
  pushedAt?: string
  cloneUrl?: string
  mirror?: { source?: string, sourceId?: string, status?: string }
  visibility?: 'internal' | 'private'
  allowMergeCommit?: boolean
  allowSquashMerge?: boolean
}

export interface OriginRepositoryReference {
  id: string
  name: string
  owner: OriginOwner
}

export interface OriginPullRequestReference {
  id: string
  number: string
  repository?: OriginRepositoryReference
}

export interface OriginLabel {
  id?: string
  name: string
  color?: string
  description?: string
}

export interface OriginPullRequest {
  id: string
  number: string
  state: string
  draft?: boolean
  merged?: boolean
  title: string
  body?: string
  head?: { ref: string, sha?: string }
  base?: { ref: string, sha?: string }
  author?: OriginActor
  createdAt?: string
  updatedAt?: string
  closedAt?: string
  mergedAt?: string
  mergeCommitSha?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  labels?: OriginLabel[]
  stack?: { id: string, parentPullRequest?: OriginPullRequestReference }
  version?: { number: string, headSha?: string, baseSha?: string }
}

export interface OriginCommentThread {
  id: string
  path?: string
  side?: 'left' | 'right'
  startLine?: number
  endLine?: number
  resolvedAt?: string
}

export interface OriginComment {
  id: string
  thread?: OriginCommentThread
  body: string
  author?: OriginActor
  createdAt?: string
  updatedAt?: string
}

export interface OriginReview {
  id: string
  author?: OriginActor
  verdict: 'approve' | 'request_changes' | 'comment'
  body?: string
  submittedAt?: string
  dismissal?: unknown
}

export interface OriginCheckRun {
  id: string
  sha?: string
  key?: string
  name: string
  status: string
  conclusion?: string
  detailsUrl?: string
  startedAt?: string
  completedAt?: string
}

export interface OriginInstallation {
  id: string
  appId: string
  target?: OriginOwner
  repoSelectionMode?: 'all' | 'selected'
  scopes?: string[]
  createdAt?: string
  suspendedAt?: string
}

export interface OriginWebhookEnvelope {
  deliveryId?: string
  appId?: string
  installationId?: string
  event: { id: string, type: string, eventTime?: string, payload: OriginWebhookPayload }
}

export interface OriginWebhookPayload {
  pullRequest?: OriginPullRequest
  repository?: OriginRepositoryReference & Partial<OriginRepo>
  comment?: OriginComment
  review?: OriginReview
  label?: OriginLabel
  actor?: OriginActor
  reviewer?: { user?: OriginUser, group?: { id: string, slug?: string } }
  createdBy?: OriginActor
  refUpdates?: Array<{ ref: string, before?: string, after?: string, created?: boolean, deleted?: boolean, forced?: boolean, headCommit?: { sha?: string, message?: string } }>
  refUpdatesCount?: number
  pusher?: OriginActor
  installation?: { id: string, repositories?: OriginRepositoryReference[] }
  checkRun?: OriginCheckRun
}

export interface OriginContent {
  type?: string
  encoding?: string
  size?: string
  name?: string
  path: string
  sha?: string
  content?: string
  entries?: OriginContent[]
}

export interface OriginBlob {
  sha: string
  size?: number
  encoding?: string
  content: string
}

export interface OriginTreeEntry {
  path: string
  mode?: string
  type?: string
  sha?: string
  size?: number
}

export interface OriginTree {
  sha?: string
  tree?: OriginTreeEntry[]
  truncated?: boolean
}

export interface OriginBranch {
  name: string
  commit?: { sha?: string }
}

export interface OriginGitRef {
  ref: string
  object?: { sha?: string, type?: string }
}

export interface OriginCommitFile {
  filename: string
  status?: string
  additions?: number
  deletions?: number
  changes?: number
  patch?: string
  previousFilename?: string
}

export interface OriginCommit {
  sha: string
  commit?: {
    message?: string
    author?: { name?: string, email?: string, date?: string }
    committer?: { name?: string, email?: string, date?: string }
  }
  parents?: Array<{ sha?: string }>
  stats?: { additions?: number, deletions?: number, total?: number }
}

export interface OriginComparison {
  status?: string
  aheadBy?: number
  behindBy?: number
  mergeBaseCommit?: OriginCommit
}
