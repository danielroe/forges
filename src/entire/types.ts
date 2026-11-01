export interface EntireIdentityHandle {
  provider: string
  handle: string
  is_primary?: boolean
}

export interface EntireIdentity {
  kind: string
  account_id?: string | null
  display_name?: string | null
  avatar_url?: string | null
  username?: string
  handles?: EntireIdentityHandle[]
  automation?: { kind?: string, name?: string, slug?: string } | null
}

/** A person as project trails report them. */
export interface EntirePerson {
  accountId?: string
  login: string
  displayName?: string
  avatarUrl?: string
  username?: string
  identity?: EntireIdentity
}

/** A person as repository trails report them. */
export interface EntireAuthor {
  id?: string
  login: string
  identity?: EntireIdentity
}

export interface EntireProject {
  id: string
  name: string
  ownerType?: string
  ownerName?: string
  region?: string
  createdAt?: string
  primaryProcessingCell?: string
  apiUrl?: string
}

export interface EntireResolvedProject {
  project: EntireProject
  reference?: { host: string, project: string }
}

/** A repository as the control plane lists it. */
export interface EntireCoreRepo {
  id: string
  name: string
  full_name?: string
  org?: string
  provider?: string
  visibility?: string
  permission?: string
  path?: string
  owningProjectId?: string
  lastPushedAt?: string
  placements?: Array<{ id: string, apiBaseUrl?: string, mirror?: boolean, status?: string }>
  capabilities?: { canManage?: boolean, canPush?: boolean, canPull?: boolean }
}

/** Where the control plane places a repository. */
export interface EntireRepoResolution {
  requestedFullName: string
  status: string
  repoId?: string
  placements?: EntireCoreRepo['placements']
}

/** A repository as a cell reports it. */
export interface EntireRepo {
  id: string
  owning_project_id?: string
  name: string
  full_name: string
  description?: string | null
  private: boolean
  archived: boolean
  updated_at?: string
  default_branch?: string
  language?: string | null
  stargazers_count?: number
  permission?: string
  trails_enabled?: boolean
  open_pr_count?: number
}

export interface EntireCollaborator {
  accountId: string
  username: string
  handle?: string
  role: string
}

export interface EntireMe {
  global: {
    accountId: string
    handle?: string
    username?: string
    displayName?: string
    avatarUrl?: string
    createdAt?: string
    homeJurisdiction?: string
  }
  regional?: {
    displayName?: string
    bio?: string
    location?: string
  }
}

export interface EntireBranch {
  name: string
  commitSHA: string
}

export interface EntireRef {
  name: string
  oid: string
  symrefTarget?: string
  peeled?: string
}

export interface EntireSignature {
  name?: string
  email?: string
  date?: string
}

export interface EntireCommit {
  sha: string
  parents: string[]
  message: string
  author?: EntireSignature
  committer?: EntireSignature
  stats?: { additions: number, deletions: number, filesChanged?: number, truncated?: boolean } | null
}

export interface EntireCommitDetail {
  commit_sha: string
  commit: {
    commitSha: string
    fileStats?: Array<{ filename: string, previousFilename?: string | null, status: string, additions?: number, deletions?: number, patch?: string | null }>
  }
}

export interface EntireCompareStatus {
  commitsAhead: number
  commitsBehind: number
  mergeBaseSHA?: string
  resolvedBaseSHA?: string
  resolvedHeadSHA?: string
}

export interface EntireCompareFile {
  path: string
  oldPath?: string
  status: string
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface EntireTreeEntry {
  path: string
  mode: string
  type: string
  sha: string
  size?: number
}

/** A project trail: what the provider reads as an issue. */
export interface EntireProjectTrail {
  id: string
  projectId: string
  number: number
  url?: string
  title: string
  body?: string
  status: 'open' | 'closed'
  phase?: string
  type?: string
  priority?: string
  author?: EntirePerson
  assigneeProfiles?: EntirePerson[]
  assignees?: string[]
  repoIds?: string[]
  createdAt?: string
  metadataUpdatedAt?: string
  closedAt?: string | null
  lastActivityAt?: string
  changes?: Array<{ id: string, repositoryId: string, repository: string, number: number, branch: string, base: string, status: string, title: string }>
}

/** A repository trail, which the trail docs call a change: what the provider reads as a pull request. */
export interface EntireChange {
  id: string
  number: number
  url?: string
  title: string
  status: string
  branch: string
  original_branch?: string
  base: string
  type?: string
  priority?: string
  author?: EntireAuthor
  assignees?: string[]
  assignee_identities?: Array<{ login: string, identity?: EntireIdentity }>
  reviewers?: Array<{ login: string, state?: string, status?: string, identity?: EntireIdentity, actor_account_id?: string }>
  ready_for_review?: boolean
  comment_count?: number
  created_at?: string
  updated_at?: string
  merged_at?: string | null
  last_activity_at?: string
  phase?: string | null
  parent?: { id: string, number: number, host: string, project: string, url?: string }
  head_sha?: string | null
  base_sha?: string | null
  merge_base_sha?: string | null
  body_document?: { text_snapshot?: string } | null
}

export interface EntireDiscussionCreated {
  discussion: EntireDiscussion
  message: EntireMessage
}

/** A code review, with its summary and findings. */
export interface EntireReviewSnapshot {
  review: { id: string, summary?: string | null, actor_id?: string | null, started_at?: string }
  comments?: EntireReviewComment[]
}

export interface EntireReviewPublished {
  review?: EntireReviewSnapshot['review']
  results: Array<{ client_id: string, status: string, comment?: EntireReviewComment, error?: { code: string, message: string } }>
}

export interface EntireMerged {
  ok: boolean
  mergeCommitSha?: string
  branchDeleted?: boolean
}

export interface EntireMessage {
  id: string
  author: string
  identity?: EntireIdentity
  body: string
  created_at: string
  updated_at?: string
  replies?: EntireMessage[]
}

export interface EntireReviewComment {
  id: string
  review_id: string
  discussion_id?: string | null
  actor_id?: string | null
  actor_display_name?: string | null
  actor_identity?: EntireIdentity
  body?: string | null
  severity?: string | null
  status: string
  stale_outcome?: string
  created_at: string
  updated_at?: string
  location: {
    granularity: string
    file_path?: string | null
    start_line?: number | null
    end_line?: number | null
  }
}

export interface EntireDiscussion {
  id: string
  trail_id: string
  title?: string
  kind: string
  resolved: boolean
  created_by?: string | null
  created_by_identity?: EntireIdentity
  created_at: string
  updated_at?: string
  message_count: number
  messages?: EntireMessage[]
  review_comment_id?: string | null
  review_comment?: EntireReviewComment | null
}

export interface EntireApproval {
  id: string
  author: string
  event: string
  body?: string | null
  commit_sha?: string
  created_at: string
}

export interface EntireTimelineItem {
  id: string
  kind: string
  actor?: { login: string, identity?: EntireIdentity } | null
  occurredAt?: string
  occurred_at?: string
  commentId?: string
  comment_id?: string
  discussionId?: string
  discussion_id?: string
  approvalStatus?: string
  body?: string
  title?: string
  commitSha?: string
  findingCount?: number
}
