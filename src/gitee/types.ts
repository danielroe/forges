export interface GiteeUser {
  id: number
  login: string
  name?: string
  avatar_url?: string
  html_url?: string
  type?: string
}

export interface GiteeNamespace {
  id?: number
  type?: string
  name?: string
  path: string
}

export interface GiteeRepository {
  id: number
  full_name: string
  path: string
  name?: string
  namespace?: GiteeNamespace
  owner?: GiteeUser
  description?: string | null
  private?: boolean
  public?: boolean
  internal?: boolean
  fork?: boolean
  html_url?: string
  ssh_url?: string
  default_branch?: string
  pushed_at?: string | null
  created_at?: string
  updated_at?: string
  open_issues_count?: number
  parent?: GiteeRepository | null
  language?: string | null
  homepage?: string | null
  license?: string | null
  stargazers_count?: number
  forks_count?: number
  watchers_count?: number
}

export interface GiteeLabel {
  id?: number
  name: string
  color?: string
}

export interface GiteeIssue {
  id: number
  number: string
  state: string
  title: string
  body?: string | null
  user?: GiteeUser
  labels?: GiteeLabel[]
  assignee?: GiteeUser | null
  collaborators?: GiteeUser[]
  repository?: GiteeRepository
  html_url?: string
  created_at?: string
  updated_at?: string
  finished_at?: string | null
  comments?: number
  issue_state?: string
}

export interface GiteeBranchRef {
  label?: string
  ref: string
  sha: string
  repo?: GiteeRepository | null
}

export interface GiteePullRequest {
  id: number
  number: number
  state: string
  title: string
  body?: string | null
  user?: GiteeUser
  labels?: GiteeLabel[]
  assignees?: Array<GiteeUser & { accept?: boolean }>
  testers?: Array<GiteeUser & { accept?: boolean }>
  html_url?: string
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  merged_at?: string | null
  draft?: boolean
  locked?: boolean
  head?: GiteeBranchRef
  base?: GiteeBranchRef
}

export interface GiteeComment {
  id: number
  body: string
  user?: GiteeUser
  created_at?: string
  updated_at?: string
  html_url?: string
  /** Pull request comments: `diff_comment` for inline comments, `pr_comment` otherwise. */
  comment_type?: string
  path?: string | null
}

export interface GiteeOperateLog {
  id: number
  user?: GiteeUser
  content?: string
  action_type?: string
  created_at?: string
}

export interface GiteeNotification {
  id: number
  content?: string
  type?: string
  unread: boolean
  updated_at: string
  html_url?: string
  actor?: GiteeUser
  repository?: GiteeRepository
  subject?: { title?: string, url?: string, latest_comment_url?: string, type?: string }
}

export interface GiteeCheckRun {
  id: number
  head_sha?: string
  html_url?: string
  details_url?: string
  status: string
  conclusion?: string | null
  started_at?: string | null
  completed_at?: string | null
  name: string
}

export interface GiteeRelease {
  id: number
  tag_name: string
  name?: string
  body?: string
  prerelease: boolean
  author?: GiteeUser
  created_at?: string
  assets?: Array<{ name?: string, browser_download_url: string }>
}

export interface GiteeContentFile {
  type?: string
  name?: string
  path: string
  sha?: string
  size?: number
  encoding?: string
  content?: string
  _links?: { html?: string }
}

export interface GiteeTreeEntry {
  path: string
  mode?: string
  type?: string
  sha?: string
  size?: number
}

export interface GiteeTree {
  sha?: string
  tree?: GiteeTreeEntry[]
  truncated?: boolean
}

export interface GiteeBranch {
  name: string
  commit?: { sha?: string }
  protected?: boolean
}

export interface GiteeTag {
  name: string
  commit?: { sha?: string }
}

export interface GiteeCommitFile {
  filename: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string | { diff?: string }
  sha?: string
}

export interface GiteeCommit {
  sha: string
  html_url?: string
  commit?: {
    message?: string
    author?: { name?: string, email?: string, date?: string }
    committer?: { name?: string, email?: string, date?: string }
  }
  author?: GiteeUser | null
  committer?: GiteeUser | null
  /** An array on repository commits; one object on pull request commits, with every parent in `shas`. */
  parents?: Array<{ sha?: string } | string> | { sha?: string, shas?: string[] }
  stats?: { additions?: number, deletions?: number, total?: number }
  files?: GiteeCommitFile[]
}

export interface GiteeCompare {
  commits?: GiteeCommit[]
  files?: GiteeCommitFile[]
}

export interface GiteeHook {
  id: number
  url: string
  created_at?: string
  /** Every `*_events` flag the hook has switched on. */
  [flag: string]: unknown
}
