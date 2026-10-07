export interface BitbucketUser {
  type?: string
  uuid?: string
  account_id?: string
  nickname?: string
  display_name?: string
  username?: string
  links?: { avatar?: { href: string }, html?: { href: string } }
}

export interface BitbucketRepository {
  has_issues?: boolean
  has_wiki?: boolean
  type?: string
  uuid?: string
  name?: string
  full_name: string
  slug?: string
  workspace?: { slug: string, uuid?: string }
}

export interface BitbucketRepositoryDetail extends BitbucketRepository {
  description?: string
  is_private?: boolean
  parent?: BitbucketRepository | null
  mainbranch?: { name: string } | null
  created_on?: string
  updated_on?: string
  links?: { html?: { href: string }, clone?: Array<{ name: string, href: string }> }
  language?: string
  website?: string | null
  owner?: BitbucketUser | null
}

export interface BitbucketPage<T> {
  values: T[]
  next?: string
  page?: number
  pagelen?: number
}

export interface BitbucketPullRequest {
  id: number
  title: string
  description?: string
  summary?: { raw?: string }
  state: string
  draft?: boolean
  author?: BitbucketUser
  created_on?: string
  updated_on?: string
  comment_count?: number
  links?: { html?: { href: string } }
  source?: { branch?: { name: string }, commit?: { hash: string }, repository?: BitbucketRepository }
  destination?: { branch?: { name: string }, commit?: { hash: string }, repository?: BitbucketRepository }
  merge_commit?: { hash: string } | null
  reviewers?: BitbucketUser[]
  participants?: Array<{ user?: BitbucketUser, role?: string, approved?: boolean, state?: string | null }>
}

export interface BitbucketCommit {
  hash: string
  message?: string
  date?: string
  author?: { raw?: string, user?: BitbucketUser }
  links?: { html?: { href: string } }
}

export interface BitbucketComment {
  id: number
  content?: { raw?: string }
  user?: BitbucketUser
  created_on?: string
  updated_on?: string
  links?: { html?: { href: string } }
  inline?: { path: string, from?: number | null, to?: number | null }
}

export interface BitbucketActivity {
  comment?: BitbucketComment
  approval?: { date: string, user?: BitbucketUser }
  changes_requested?: { date: string, user?: BitbucketUser }
  update?: { date: string, state?: string, author?: BitbucketUser, title?: string }
}

export interface BitbucketBranch {
  name: string
  default_merge_strategy?: string
  merge_strategies?: string[]
}

export interface BitbucketCommitStatus {
  uuid?: string
  key: string
  name?: string
  state: string
  url?: string
  description?: string
  created_on?: string
  updated_on?: string
}

export interface BitbucketSrcEntry {
  type?: string
  path: string
  size?: number
  commit?: { hash?: string }
  mimetype?: string | null
  attributes?: string[]
  links?: { self?: { href: string }, html?: { href: string } }
}

export interface BitbucketRef {
  name: string
  type?: string
  target?: { hash?: string }
  links?: { html?: { href: string } }
}

export interface BitbucketDiffStat {
  status?: string
  lines_added?: number
  lines_removed?: number
  old?: { path?: string } | null
  new?: { path?: string } | null
}

export interface BitbucketCommitDetail extends BitbucketCommit {
  parents?: Array<{ hash?: string }>
  summary?: { raw?: string }
}

export interface BitbucketHook {
  uuid: string
  url: string
  description?: string
  active?: boolean
  events?: string[]
  created_at?: string
}
