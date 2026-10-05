export interface GitHubUser {
  login: string
  id: number
  node_id?: string
  type?: string
  avatar_url?: string
  html_url?: string
  name?: string | null
}

export interface GitHubUserDetail extends GitHubUser {
  bio?: string | null
  company?: string | null
  location?: string | null
  blog?: string | null
  created_at?: string
  followers?: number
  following?: number
  public_repos?: number
}

export interface GitHubRepository {
  id?: number
  node_id?: string
  name: string
  full_name: string
  owner?: GitHubUser | null
}

export interface GitHubRepositoryDetail extends GitHubRepository {
  description?: string | null
  default_branch?: string
  visibility?: string
  private?: boolean
  fork?: boolean
  archived?: boolean
  parent?: GitHubRepository
  topics?: string[]
  html_url?: string
  clone_url?: string
  ssh_url?: string
  created_at?: string | null
  updated_at?: string | null
  pushed_at?: string | null
  permissions?: { admin: boolean, maintain?: boolean, push: boolean, triage?: boolean, pull: boolean }
  allow_merge_commit?: boolean
  allow_squash_merge?: boolean
  allow_rebase_merge?: boolean
  has_issues?: boolean
  has_discussions?: boolean
  has_wiki?: boolean
  has_projects?: boolean
}

export interface GitHubCollaborator extends GitHubUser {
  role_name?: string
  permissions?: { admin?: boolean, maintain?: boolean, push?: boolean, triage?: boolean, pull?: boolean }
}

export interface GitHubReactions {
  'total_count'?: number
  '+1'?: number
  '-1'?: number
  'laugh'?: number
  'confused'?: number
  'heart'?: number
  'hooray'?: number
  'rocket'?: number
  'eyes'?: number
}

export interface GitHubReaction {
  created_at?: string
  id: number
  content: string
  user?: GitHubUser | null
}

export interface GitHubMilestone {
  id?: number
  number?: number
  title: string
  state?: string
  description?: string | null
  due_on?: string | null
  html_url?: string
}

export interface GitHubLabel {
  name: string
  color?: string | null
  description?: string | null
}

export interface GitHubNotification {
  id: string
  unread: boolean
  reason: string
  updated_at: string
  last_read_at: string | null
  url: string
  subject: {
    title: string
    url: string | null
    latest_comment_url: string | null
    type: string
  }
  repository: GitHubRepository
}

export interface GitHubIssue {
  number: number
  /** Only on search results, which carry no nested repository. */
  repository_url?: string
  node_id?: string
  title: string
  body?: string | null
  state: string
  state_reason?: string | null
  draft?: boolean
  merged?: boolean
  locked?: boolean
  comments?: number
  html_url?: string
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  user?: GitHubUser
  labels?: Array<string | { name?: string, color?: string | null, description?: string | null }>
  assignees?: GitHubUser[] | null
  requested_reviewers?: GitHubUser[] | null
  requested_teams?: Array<{ id: number, slug: string, name?: string, html_url?: string }> | null
  head?: { ref: string, sha: string, repo?: GitHubRepository | null }
  base?: { ref: string, sha: string }
  merge_commit_sha?: string | null
  pull_request?: { url?: string, merged_at?: string | null }
  milestone?: GitHubMilestone | null
  reactions?: GitHubReactions
}

export interface GitHubComment {
  id: number
  node_id?: string
  body?: string
  user?: GitHubUser | null
  created_at?: string
  updated_at?: string
  html_url?: string
  reactions?: GitHubReactions
}

export interface GitHubTimelineEntry {
  id?: number | string
  node_id?: string
  event?: string
  created_at?: string
  submitted_at?: string
  actor?: GitHubUser
  user?: GitHubUser
  body?: string | null
  state?: string
  label?: { name: string }
  assignee?: GitHubUser
  requested_reviewer?: GitHubUser
  sha?: string
  message?: string
  author?: { name?: string, email?: string, date?: string }
  committer?: { name?: string, email?: string, date?: string }
  commit_id?: string | null
  /** Only on `cross-referenced` entries. */
  source?: { type?: string, issue?: { number: number, pull_request?: unknown, repository?: GitHubRepository, html_url?: string } }
}

export interface GitHubInstallationToken {
  token: string
  expires_at: string
  permissions?: Record<string, string>
  repository_selection?: string
}

export interface GitHubInstallation {
  id: number
  account?: GitHubUser | null
  target_type?: string
  repository_selection?: string
}

export interface GitHubCheckRun {
  id: number
  name: string
  status: string
  conclusion?: string | null
  html_url?: string | null
  details_url?: string | null
  started_at?: string | null
  completed_at?: string | null
}

export interface GitHubCommitStatus {
  id: number
  context: string
  state: string
  target_url?: string | null
  description?: string | null
  created_at?: string
  updated_at?: string
}

export interface GitHubCombinedStatus {
  state: string
  total_count: number
  statuses: GitHubCommitStatus[]
}

export interface GitHubRelease {
  id: number
  tag_name: string
  name?: string | null
  body?: string | null
  draft: boolean
  prerelease: boolean
  author?: GitHubUser | null
  created_at?: string | null
  published_at?: string | null
  html_url?: string
  assets?: Array<{ id?: number, name: string, browser_download_url: string, size?: number, download_count?: number, content_type?: string }>
}

export interface GitHubDependabotAlert {
  number: number
  state: string
  dependency?: { package?: { ecosystem: string, name: string }, manifest_path?: string }
  security_advisory?: { ghsa_id?: string, summary?: string, severity?: string }
  security_vulnerability?: { severity?: string, vulnerable_version_range?: string, first_patched_version?: { identifier: string } | null }
  html_url?: string
  created_at?: string
  updated_at?: string
  dismissed_at?: string | null
}

export interface GitHubCodeScanningAlert {
  number: number
  state: string
  rule?: { id?: string, name?: string, description?: string, severity?: string | null, security_severity_level?: string | null }
  tool?: { name?: string }
  html_url?: string
  created_at?: string
  updated_at?: string | null
  dismissed_at?: string | null
}

export interface GitHubSecretScanningAlert {
  number: number
  state: string
  resolution?: string | null
  secret_type?: string
  secret_type_display_name?: string
  html_url?: string
  created_at?: string
  updated_at?: string | null
  resolved_at?: string | null
}

export interface GitHubReview {
  id: number
  node_id?: string
  user?: GitHubUser | null
  body?: string | null
  state?: string
  html_url?: string
  submitted_at?: string | null
  commit_id?: string | null
}

export interface GitHubReviewComment {
  id: number
  pull_request_review_id?: number | null
  user?: GitHubUser | null
  body?: string
  path?: string
  line?: number | null
  original_line?: number | null
  side?: string | null
  in_reply_to_id?: number | null
  created_at?: string
  html_url?: string
}

export interface GitHubWorkflowRun {
  id: number
  name?: string | null
  display_title?: string
  run_number?: number
  event?: string
  status?: string | null
  conclusion?: string | null
  head_branch?: string | null
  head_sha?: string
  html_url?: string
  actor?: GitHubUser | null
  created_at?: string
  run_started_at?: string
  updated_at?: string
}

export interface GitHubWorkflowJob {
  id: number
  run_id?: number
  name: string
  status?: string
  conclusion?: string | null
  html_url?: string | null
  started_at?: string | null
  completed_at?: string | null
}

export interface GitHubContentFile {
  type: string
  name: string
  path: string
  sha: string
  size?: number
  encoding?: string
  content?: string
  html_url?: string | null
  download_url?: string | null
}

export interface GitHubBlob {
  sha: string
  size?: number
  encoding: string
  content: string
}

export interface GitHubTreeEntry {
  path: string
  mode?: string
  type?: string
  sha?: string
  size?: number
  url?: string
}

export interface GitHubTree {
  sha: string
  tree: GitHubTreeEntry[]
  truncated?: boolean
}

export interface GitHubBranch {
  name: string
  commit: { sha: string, url?: string }
  protected?: boolean
}

export interface GitHubTag {
  name: string
  commit: { sha: string, url?: string }
}

export interface GitHubCommitFile {
  filename: string
  previous_filename?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
  sha?: string
}

export interface GitHubCommit {
  sha: string
  html_url?: string
  commit: {
    message: string
    author?: { name?: string, email?: string, date?: string } | null
    committer?: { name?: string, email?: string, date?: string } | null
  }
  author?: GitHubUser | null
  committer?: GitHubUser | null
  parents?: Array<{ sha: string }>
  stats?: { additions?: number, deletions?: number, total?: number }
  files?: GitHubCommitFile[]
}

/** A commit search result, which carries the repository the commit is in. */
export interface GitHubCommitSearchItem extends GitHubCommit {
  repository?: GitHubRepository
}

export interface GitHubComparison {
  ahead_by?: number
  behind_by?: number
  merge_base_commit?: { sha: string }
  commits?: GitHubCommit[]
  files?: GitHubCommitFile[]
}

export interface GitHubAsyncMerge {
  status: 'pending' | 'merged' | 'enqueued' | 'failed'
  details?: {
    message?: string
    uuid?: string
    merge_method?: string
    merge_action?: string
    expected_head_sha?: string
    bypass_rules?: boolean
    sha?: string
  }
}

export interface GitHubHook {
  id: number
  name?: string
  active?: boolean
  events?: string[]
  config?: { url?: string, content_type?: string, insecure_ssl?: string | number, secret?: string }
  created_at?: string
  updated_at?: string
}

export interface GitHubHookDelivery {
  id: number
  guid?: string
  delivered_at?: string
  duration?: number
  status?: string
  status_code?: number
  event?: string
  action?: string | null
  redelivery?: boolean
}
