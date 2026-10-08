export interface ForgejoUser {
  id: number
  login: string
  full_name?: string
  avatar_url?: string
  html_url?: string
  is_bot?: boolean
  login_name?: string
}

export interface ForgejoRepository {
  id?: number
  name: string
  full_name: string
  owner?: ForgejoUser
}

export interface ForgejoRepositoryDetail extends ForgejoRepository {
  description?: string
  default_branch?: string
  private?: boolean
  internal?: boolean
  fork?: boolean
  archived?: boolean
  parent?: ForgejoRepository | null
  topics?: string[]
  html_url?: string
  clone_url?: string
  ssh_url?: string
  created_at?: string
  updated_at?: string
  open_issues_count?: number
  open_pr_counter?: number
  permissions?: { admin: boolean, push: boolean, pull: boolean }
  allow_merge_commits?: boolean
  allow_squash_merge?: boolean
  allow_rebase?: boolean
  allow_rebase_explicit?: boolean
  allow_fast_forward_only_merge?: boolean
  has_issues?: boolean
  has_wiki?: boolean
  has_projects?: boolean
  has_releases?: boolean
  has_pull_requests?: boolean
  language?: string
  website?: string
  /** SPDX identifiers, on Gitea 1.23 and later. */
  licenses?: string[] | null
  stars_count?: number
  forks_count?: number
  watchers_count?: number
}

export interface ForgejoLabel {
  id?: number
  name: string
  color?: string
  description?: string
}

export interface ForgejoMilestone {
  id: number
  title: string
  state?: string
  description?: string | null
  due_on?: string | null
}

export interface ForgejoNotification {
  id: number
  unread: boolean
  pinned?: boolean
  updated_at: string
  url: string
  subject: {
    title: string
    url: string | null
    latest_comment_url?: string | null
    type: string
    state?: string
  }
  repository: ForgejoRepository
}

export interface ForgejoIssue {
  id?: number
  number: number
  title: string
  body?: string | null
  state: string
  merged?: boolean
  draft?: boolean
  is_locked?: boolean
  comments?: number
  html_url?: string
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  user?: ForgejoUser
  labels?: Array<{ id?: number, name: string, color?: string, description?: string }>
  assignees?: ForgejoUser[] | null
  requested_reviewers?: ForgejoUser[] | null
  head?: { ref: string, sha: string, repo?: ForgejoRepository | null }
  base?: { ref: string, sha: string }
  merge_commit_sha?: string | null
  /** Only on the cross-repository issue search, which reports the owner as a string. */
  repository?: { id?: number, name: string, full_name: string, owner?: string }
  pull_request?: { merged?: boolean, draft?: boolean } | null
  milestone?: ForgejoMilestone | null
}

export interface ForgejoComment {
  id: number
  body?: string
  user?: ForgejoUser
  created_at?: string
  updated_at?: string
  html_url?: string
}

export interface ForgejoTimelineEntry {
  id?: number
  type?: string
  body?: string | null
  created_at?: string
  user?: ForgejoUser
  label?: { name: string }
  assignee?: ForgejoUser
  ref_commit_sha?: string | null
  review_id?: number
  /** Only on `issue_ref`, `pull_ref` and `change_issue_ref` entries. */
  ref_issue?: { number: number, pull_request?: unknown, repository?: { id?: number, name: string, full_name: string, owner?: string } }
}

export interface ForgejoCommitStatus {
  id: number
  context: string
  status: string
  target_url?: string
  description?: string
  created_at?: string
  updated_at?: string
}

export interface ForgejoCombinedStatus {
  state: string
  total_count: number
  statuses: ForgejoCommitStatus[] | null
}

export interface ForgejoActionRun {
  id: number
  title?: string
  workflow_id?: string
  index_in_repo?: number
  event?: string
  trigger_event?: string
  prettyref?: string
  commit_sha?: string
  status: string
  html_url?: string
  trigger_user?: ForgejoUser | null
  created?: string
  started?: string
  stopped?: string
}

export interface ForgejoActionRunJob {
  id: number
  run_id?: number
  name: string
  status: string
  html_url?: string
}

export interface ForgejoRelease {
  id: number
  tag_name: string
  name?: string
  body?: string
  draft: boolean
  prerelease: boolean
  author?: ForgejoUser | null
  created_at?: string
  published_at?: string
  html_url?: string
  assets?: Array<{ id?: number, name: string, browser_download_url: string, size?: number, download_count?: number }>
}

export interface ForgejoReview {
  id: number
  user?: ForgejoUser
  body?: string
  state?: string
  html_url?: string
  submitted_at?: string
  comments_count?: number
}

export interface ForgejoReviewComment {
  id: number
  body?: string
  user?: ForgejoUser
  path?: string
  original_position?: number
  position?: number
  created_at?: string
  html_url?: string
  pull_request_review_id?: number
}

export interface ForgejoContentFile {
  type: string
  name: string
  path: string
  sha: string
  size?: number
  encoding?: string
  content?: string | null
  html_url?: string | null
  download_url?: string | null
}

export interface ForgejoTreeEntry {
  path: string
  mode?: string
  type?: string
  size?: number
  sha?: string
  url?: string
}

export interface ForgejoTree {
  sha: string
  tree: ForgejoTreeEntry[] | null
  truncated?: boolean
  page?: number
  total_count?: number
}

export interface ForgejoBranch {
  name: string
  commit?: { id?: string, url?: string }
  protected?: boolean
}

export interface ForgejoTag {
  name: string
  commit?: { sha?: string, url?: string }
  id?: string
}

export interface ForgejoCommitFile {
  filename: string
  previous_filename?: string
  status?: string
  additions?: number
  deletions?: number
  changes?: number
}

export interface ForgejoCommit {
  sha: string
  html_url?: string
  commit?: {
    message?: string
    author?: { name?: string, email?: string, date?: string } | null
    committer?: { name?: string, email?: string, date?: string } | null
  }
  author?: ForgejoUser | null
  committer?: ForgejoUser | null
  parents?: Array<{ sha?: string }>
  stats?: { additions?: number, deletions?: number, total?: number }
  files?: ForgejoCommitFile[]
}

export interface ForgejoCompare {
  total_commits?: number
  commits?: ForgejoCommit[]
  files?: ForgejoCommitFile[]
}

export interface ForgejoChangedFile {
  filename: string
  previous_filename?: string
  status?: string
  additions?: number
  deletions?: number
}

export interface ForgejoHook {
  id: number
  type?: string
  active?: boolean
  events?: string[]
  config?: { url?: string, content_type?: string }
  created_at?: string
  updated_at?: string
}

export interface ForgejoReaction {
  content: string
  created_at?: string
  user?: ForgejoUser
}
