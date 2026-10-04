export interface PushinUser {
  id: string
  login: string
  type?: string
  name?: string | null
  company?: string | null
  avatar_url?: string
  html_url?: string
}

export interface PushinRepository {
  id: string
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
  id: string
  user?: PushinUser | null
  body: string
  created_at?: string
  updated_at?: string
  in_reply_to_id?: string | null
}

export interface PushinLabel {
  id: string
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
  id: string
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
  id: string
  html_url?: string
  last_read_at?: string | null
  reason: string
  repository: PushinRepository
  subject: { title: string, type: string, url: string }
  unread: boolean
  updated_at: string
}
