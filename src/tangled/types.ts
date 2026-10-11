export interface StrongRef {
  uri: string
  cid: string
}

export interface IssueRecord {
  $type?: 'sh.tangled.repo.issue'
  title: string
  body?: string
  /** Repo DID, or in older records the `sh.tangled.repo` AT-URI. */
  repo: string
  mentions?: string[]
  createdAt: string
}

export interface PullRecord {
  $type?: 'sh.tangled.repo.pull'
  title: string
  body?: string
  target: { repo: string, branch: string }
  source?: { repo?: string, branch: string }
  rounds?: Array<{ createdAt: string, patchBlob?: BlobRef }>
  /** The patch, inline, in records written before `rounds` carried blobs. */
  patch?: string
  createdAt: string
}

export interface BlobRef {
  $type?: 'blob'
  ref: { $link: string }
  mimeType?: string
  size?: number
}

export interface FeedCommentRecord {
  $type?: 'sh.tangled.feed.comment'
  body: { $type?: string, text?: string, original?: string } | string
  subject: StrongRef
  replyTo?: StrongRef
  createdAt: string
}

export interface LegacyCommentRecord {
  body: string
  issue?: string
  pull?: string
  replyTo?: string
  createdAt: string
}

export interface StateRecord {
  issue?: string
  pull?: string
  state?: string
  status?: string
  createdAt: string
}

export interface ReactionRecord {
  subject: string
  reaction: string
  createdAt: string
}

export interface LabelOpRecord {
  subject: string
  add: Array<{ key: string, value: string }>
  delete: Array<{ key: string, value: string }>
  performedAt: string
}

export interface LabelDefinitionRecord {
  name: string
  valueType?: { type: 'null' | 'boolean' | 'integer' | 'string', format?: 'any' | 'did' | 'nsid', enum?: string[] }
  /** Collections the label applies to; every collection when empty. */
  scope?: string[]
  color?: string
  multiple?: boolean
  createdAt?: string
}

export interface ProfileRecord {
  description?: string
  location?: string
  links?: string[]
  avatar?: BlobRef
  createdAt?: string
}

export type TangledRecord
  = | IssueRecord
    | PullRecord
    | FeedCommentRecord
    | LegacyCommentRecord
    | StateRecord
    | ReactionRecord
    | LabelOpRecord
    | LabelDefinitionRecord
    | ProfileRecord

export interface RecordResponse<T = TangledRecord> {
  uri: string
  cid?: string
  value: T
}

export interface DidDocument {
  id: string
  alsoKnownAs?: string[]
  service?: Array<{ id: string, type: string, serviceEndpoint: string }>
}

export interface BacklinksResponse {
  total?: number
  linking_records: Array<{ did: string, collection: string, rkey: string }>
  cursor?: string | null
}

export interface JetstreamCommitEvent {
  did: string
  time_us: number
  kind: 'commit'
  commit: {
    rev: string
    operation: 'create' | 'update' | 'delete'
    collection: string
    rkey: string
    record?: TangledRecord & { $type?: string }
    cid?: string
  }
}

export interface JetstreamOtherEvent {
  did: string
  time_us: number
  kind: 'identity' | 'account'
}

export type JetstreamEvent = JetstreamCommitEvent | JetstreamOtherEvent

export interface Session {
  did: string
  accessJwt: string
  refreshJwt: string
}

export interface RepoRecord {
  $type?: 'sh.tangled.repo'
  knot: string
  name?: string
  description?: string
  topics?: string[]
  source?: string
  website?: string
  repoDid?: string
  /** The label definitions the repo uses, as AT-URIs. */
  labels?: string[]
  createdAt: string
}

/** A go-git signature, as knots serialise it. */
export interface KnotSignature {
  Name: string
  Email: string
  When: string
}

/** A go-git hash: 20 bytes as a JSON array, or hex. */
export type KnotHash = number[] | string

export interface KnotCommit {
  hash: KnotHash
  /** The full sha, in hex. */
  this?: string
  author?: KnotSignature
  committer?: KnotSignature
  message: string
  parent_hashes?: KnotHash[]
}

export interface KnotTextFragment {
  Comment?: string
  OldPosition: number
  OldLines: number
  NewPosition: number
  NewLines: number
  LinesAdded: number
  LinesDeleted: number
  /** `Op` is 0 for context, 1 for a deletion and 2 for an addition. */
  Lines?: Array<{ Op: number, Line: string }>
}

/** A file of a `sh.tangled.repo.diff` response. */
export interface KnotDiffFile {
  name: { old: string, new: string }
  text_fragments?: KnotTextFragment[] | null
  is_binary: boolean
  is_new: boolean
  is_delete: boolean
  is_copy: boolean
  is_rename: boolean
}

/** A file of a `sh.tangled.repo.compare` response, as go-gitdiff serialises it. */
export interface KnotPatchFile {
  OldName: string
  NewName: string
  IsNew: boolean
  IsDelete: boolean
  IsCopy: boolean
  IsRename: boolean
  IsBinary: boolean
  NewOIDPrefix?: string
  TextFragments?: KnotTextFragment[] | null
}

export interface KnotPatchHeader {
  SHA: string
  Author?: { Name: string, Email: string } | null
  AuthorDate?: string
  Committer?: { Name: string, Email: string } | null
  CommitterDate?: string
  Title: string
  Body?: string
  Files?: KnotPatchFile[] | null
}

export interface KnotTreeEntry {
  name: string
  /** Octal, for example `0100644` or `0040000`. */
  mode: string
  size: number
  last_commit?: { hash: string, message: string, when: string }
}

export interface KnotBlob {
  ref: string
  path: string
  content?: string
  encoding?: 'utf-8' | 'base64'
  size?: number
  isBinary?: boolean
  submodule?: { name: string, url: string, branch?: string }
}

export interface KnotBranch {
  reference: { name: string, hash: string }
  commit?: unknown
  is_default?: boolean
}

export interface KnotTag {
  name: string
  /** The tag object for an annotated tag, else the commit. */
  hash: string
  tag?: { Target: KnotHash, Message?: string } | null
  message?: string
}

export interface SubscriptionRecord {
  subject: { $type?: string, uri?: string, did?: string }
  createdAt: string
}
