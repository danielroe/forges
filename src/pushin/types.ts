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

export interface PushinRelease {
  id: number
  name: string
  body: string | null
  tag_name: string
  author: PushinUser
  url: string
  created_at: string
  published_at: string | null
  updated_at: string
  prerelease: boolean
  immutable: boolean
  draft: boolean
  node_id: string
  assets: Array<{ id: number, name: string, url: string, browser_download_url: string, created_at: string, content_type: string, download_count: number, size: number, node_id: string }>
}
