export interface GitLabUser {
  id: number
  username: string
  name?: string
  avatar_url?: string | null
  web_url?: string
  bot?: boolean
  state?: string
}

export interface GitLabProject {
  id: number
  name?: string
  path?: string
  path_with_namespace: string
}

export interface GitLabProjectDetail extends GitLabProject {
  description?: string | null
  default_branch?: string | null
  visibility?: string
  forked_from_project?: GitLabProject | null
  archived?: boolean
  topics?: string[]
  web_url?: string
  http_url_to_repo?: string
  ssh_url_to_repo?: string
  created_at?: string
  last_activity_at?: string
  open_issues_count?: number
  permissions?: { project_access?: { access_level: number } | null, group_access?: { access_level: number } | null }
  merge_method?: 'merge' | 'rebase_merge' | 'ff'
  squash_option?: 'never' | 'always' | 'default_on' | 'default_off'
  issues_enabled?: boolean
  merge_requests_enabled?: boolean
  wiki_enabled?: boolean
  issues_access_level?: string
  merge_requests_access_level?: string
  wiki_access_level?: string
  releases_access_level?: string
  star_count?: number
  forks_count?: number
  /** Set for projects in a user's namespace, not a group's. */
  owner?: GitLabUser | null
}

export interface GitLabLabel {
  id?: number
  name: string
  color?: string
  description?: string | null
}

export interface GitLabMilestone {
  id: number
  iid?: number
  title: string
  state?: string
  description?: string | null
  due_date?: string | null
  web_url?: string
}

export interface GitLabMember {
  id: number
  username: string
  name?: string
  avatar_url?: string
  web_url?: string
  access_level: number
}

export interface GitLabAwardEmoji {
  id: number
  name: string
  user?: GitLabUser
}

export interface GitLabGroup {
  id: number
  name?: string
  path?: string
  full_path: string
}

export interface GitLabTodo {
  id: number
  project: GitLabProject | null
  group?: GitLabGroup | null
  author?: GitLabUser
  action_name: string
  target_type: string
  target?: {
    id?: number | string
    iid?: number
    title?: string
    state?: string
  } | null
  target_url?: string
  body?: string
  state: string
  created_at: string
  updated_at?: string
}

export interface GitLabIssue {
  id?: number
  iid: number
  title: string
  description?: string | null
  state: string
  draft?: boolean
  merged_at?: string | null
  author?: GitLabUser
  labels?: Array<string | { name: string, color?: string, description?: string | null }>
  web_url?: string
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  discussion_locked?: boolean | null
  user_notes_count?: number
  assignees?: GitLabUser[]
  reviewers?: GitLabUser[]
  subscribed?: boolean
  source_branch?: string
  target_branch?: string
  sha?: string
  diff_refs?: { base_sha?: string, head_sha?: string, start_sha?: string } | null
  merge_commit_sha?: string | null
  squash_commit_sha?: string | null
  source_project_id?: number
  target_project_id?: number
  /** Single merge request reads only. */
  head_pipeline?: GitLabPipeline | null
  milestone?: GitLabMilestone | null
  upvotes?: number
  downvotes?: number
}

export interface GitLabJob {
  id: number
  name: string
  stage?: string
  status: string
  allow_failure?: boolean
  web_url?: string
  started_at?: string | null
  finished_at?: string | null
}

export interface GitLabRelease {
  tag_name: string
  name?: string | null
  description?: string | null
  created_at?: string
  released_at?: string
  upcoming_release?: boolean
  author?: GitLabUser
  _links?: { self?: string }
  assets?: { links?: Array<{ id?: number, name: string, url: string, direct_asset_url?: string, link_type?: string }> }
}

export interface GitLabVulnerability {
  id: string
  title: string
  severity: string
  state: string
  reportType: string
  detectedAt?: string | null
  updatedAt?: string | null
  dismissedAt?: string | null
  resolvedAt?: string | null
  webUrl?: string | null
}

export interface GitLabCommit {
  id: string
  title: string
  message?: string
  author_name?: string
  created_at?: string
  web_url?: string
}

export interface GitLabNote {
  id: number
  type?: string | null
  body: string
  system: boolean
  author?: GitLabUser
  created_at: string
}

export interface GitLabCommitComment {
  note: string
  author?: GitLabUser
  created_at?: string
  line_type?: string | null
}

export interface GitLabProjectSettings {
  merge_method?: 'merge' | 'rebase_merge' | 'ff'
  squash_option?: 'never' | 'always' | 'default_on' | 'default_off'
}

export interface GitLabNoteDetail extends GitLabNote {
  updated_at?: string
  noteable_type?: string
}

export interface GitLabApprovals {
  approved_by?: Array<{ user?: GitLabUser }>
}

export interface GitLabCommitStatus {
  id: number
  name?: string
  status: string
  description?: string | null
  target_url?: string | null
  created_at?: string
  finished_at?: string | null
  allow_failure?: boolean
}

export interface GitLabPipeline {
  id: number
  iid?: number
  project_id?: number
  status: string
  source?: string
  ref?: string
  sha?: string
  web_url?: string
  name?: string | null
  user?: GitLabUser | null
  created_at?: string
  started_at?: string | null
  finished_at?: string | null
}

export interface GitLabCommitDetail extends GitLabCommit {
  short_id?: string
  author_email?: string
  authored_date?: string
  committer_name?: string
  committer_email?: string
  committed_date?: string
  parent_ids?: string[]
  stats?: { additions?: number, deletions?: number, total?: number }
}

export interface GitLabDiff {
  old_path?: string
  new_path?: string
  diff?: string
  new_file?: boolean
  renamed_file?: boolean
  deleted_file?: boolean
}

export interface GitLabFile {
  file_name: string
  file_path: string
  size?: number
  encoding?: string
  content?: string
  content_sha256?: string
  blob_id?: string
  ref?: string
}

export interface GitLabTreeEntry {
  id?: string
  name: string
  type?: string
  path: string
  mode?: string
}

export interface GitLabBranch {
  name: string
  commit?: { id?: string, web_url?: string }
  default?: boolean
  protected?: boolean
  web_url?: string
}

export interface GitLabTag {
  name: string
  commit?: { id?: string }
  target?: string
}

export interface GitLabCompare {
  commits?: GitLabCommitDetail[]
  diffs?: GitLabDiff[]
  commit?: GitLabCommitDetail | null
}

export interface GitLabHook {
  id: number
  url: string
  disabled_until?: string | null
  created_at?: string
  /** Every `*_events` flag the hook has switched on. */
  [flag: string]: unknown
}

export interface GitLabHookEvent {
  id: number
  url?: string
  trigger?: string
  response_status?: string | number
  execution_duration?: number
  created_at?: string
}
