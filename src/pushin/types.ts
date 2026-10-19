export interface PushinUser {
  id?: number | string
  login: string
  type?: string
  name?: string | null
  company?: string | null
  avatar_url?: string
  html_url?: string
}

export interface PushinRepository {
  id: number | string
  node_id?: string
  name: string
  full_name: string
  owner?: PushinUser | null
  private?: boolean
  visibility?: string
  description?: string | null
  homepage?: string | null
  default_branch?: string
  url?: string
  html_url?: string
  clone_url?: string
  topics?: string[]
  created_at?: string
  updated_at?: string
  forks_count?: number
  stargazers_count?: number
  watchers_count?: number
  permissions?: { admin?: boolean, maintain?: boolean, push?: boolean, triage?: boolean, pull?: boolean }
}

export interface PushinComment {
  id: number | string
  user?: PushinUser | null
  body: string
  created_at?: string
  updated_at?: string
  in_reply_to_id?: number | string | null
}

export interface PushinLabel {
  id: number | string
  name: string
  description?: string | null
  color?: string | null
  default?: boolean
}

export interface PushinCollaborator extends PushinUser {
  role_name?: string
  permissions?: { admin?: boolean, maintain?: boolean, push?: boolean, triage?: boolean, pull?: boolean }
}

export interface PushinThread {
  id: number | string
  node_id?: string
  number: number
  title: string
  body?: string | null
  state?: string
  draft?: boolean
  locked?: boolean
  user?: PushinUser | null
  assignees?: PushinUser[]
  labels?: PushinLabel[]
  html_url?: string
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  comments?: number
  url?: string
  repository_url?: string
  pull_request?: { url: string, html_url?: string, merged_at?: string | null }
  merged?: boolean
  merged_at?: string | null
  head?: { ref?: string | null, sha?: string | null } | null
  base?: { ref?: string | null } | null
}

export interface PushinNotification {
  id: number | string
  html_url?: string
  last_read_at?: string | null
  reason: string
  repository: PushinRepository
  subject: { title: string, type: string, url: string }
  unread: boolean
  updated_at: string
}

export interface PushinReleaseAsset {
  id: number
  name: string
  label: string | null
  state: string
  url: string
  browser_download_url: string | null
  created_at: string
  updated_at: string
  content_type: string
  download_count: number
  size: number
  digest: string | null
  uploader: PushinUser | null
  node_id: string
}

export interface PushinRelease {
  id: number
  name: string | null
  body: string | null
  tag_name: string
  target_commitish: string
  author: PushinUser | null
  url: string
  html_url: string
  created_at: string
  published_at: string | null
  updated_at: string
  prerelease: boolean
  immutable: boolean
  draft: boolean
  node_id: string
  assets: PushinReleaseAsset[]
}

export interface PushinTeam {
  id: number
  name: string
  slug: string
  node_id: string
  organization: PushinUser | null
}

export interface PushinReview {
  id: number
  node_id: string
  body: string | null
  commit_id: string | null
  state: string
  submitted_at: string | null
  created_at: string
  html_url: string
  user: PushinUser | null
}

export interface PushinReviewComment {
  id: number
  node_id: string
  body: string
  path: string | null
  line: number | null
  side: string | null
  start_line: number | null
  start_side: string | null
  commit_id: string | null
  diff_hunk: string | null
  in_reply_to_id: number | null
  pull_request_review_id: number | null
  resolved: boolean
  created_at: string
  updated_at: string
  html_url: string
  user: PushinUser | null
}
