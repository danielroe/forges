export interface StrongRef {
  uri: string
  cid: string
}

export interface BlobRef {
  $type?: 'blob'
  ref: { $link: string }
  mimeType?: string
  size?: number
}

/** Fields a knot adds to the records it hosts. */
export interface KnotStamped {
  /** The account that wrote this version of the record. */
  'x-tngl-editor'?: string
}

export interface Markdown {
  $type?: 'org.tangled.markup.markdown'
  text: string
  blobs?: unknown[]
}

export type TicketState = 'open' | 'closed' | 'completed'

/** An issue, or with `targetBranch` a pull request. */
export interface TicketRecord extends KnotStamped {
  $type?: 'org.tangled.track.ticket'
  title: { $type?: 'org.tangled.markup.markdown#inline', text: string }
  body?: Markdown
  state: TicketState | (string & {})
  /** The keys of the repo's label definitions. */
  tangledLabels?: Array<{ $type?: 'org.tangled.label.defs#labelToken', key: string }>
  assignees?: string[]
  targetBranch?: string
  createdAt: string
}

/** One round of a pull request: the commits `head` has and `base` lacks. */
export interface PatchRecord extends KnotStamped {
  $type?: 'org.tangled.review.patch'
  /** The record key of the ticket. */
  ticket: string
  base: { oid: string }
  head: { oid: string }
  source?: { repo: string, branch: string }
  createdAt: string
}

export interface CommentRecord extends KnotStamped {
  $type?: 'org.tangled.feed.comment'
  body: Markdown
  subject: StrongRef & { $type?: 'com.atproto.repo.strongRef' }
  replyTo?: StrongRef
  createdAt: string
}

export interface ReactionRecord extends KnotStamped {
  $type?: 'org.tangled.feed.reaction'
  subject: StrongRef
  reaction: string
  createdAt: string
}

export interface LabelDefinitionRecord extends KnotStamped {
  $type?: 'org.tangled.label.definition'
  name: string
  color?: string
  createdAt?: string
}

export interface ProfileRecord {
  description?: string
  location?: string
  links?: string[]
  avatar?: BlobRef
  createdAt?: string
}

export interface SubscriptionRecord {
  $type?: 'org.tangled.feed.subscription'
  subject: { $type?: string, uri?: string, did?: string }
  /** Mutes the subject. */
  ignore?: boolean
  createdAt: string
}

export interface RepoManifest extends KnotStamped {
  $type?: 'org.tangled.repo.manifest'
  declaration: { owner: string, name: string }
  description?: string
  website?: string
  topics?: string[]
  source?: { did?: string, uri?: string }
  contributionPolicy?: string
  /** The DID of the spindle that runs the repo's pipelines and webhooks. */
  spindle?: string
  createdAt: string
}

export interface RepoDeclaration extends KnotStamped {
  $type?: 'org.tangled.repo.declaration'
  repo: string
  createdAt: string
}

export type TangledRecord
  = | TicketRecord
    | PatchRecord
    | CommentRecord
    | ReactionRecord
    | LabelDefinitionRecord
    | ProfileRecord
    | SubscriptionRecord
    | RepoManifest
    | RepoDeclaration

export interface RecordResponse<T = TangledRecord> {
  uri: string
  cid?: string
  value: T
}

/** A repo manifest as the index returns it, with the knot that hosts the repo. */
export interface RepoView extends RecordResponse<RepoManifest> {
  /** The knot's hostname. */
  knot?: string
  defaultBranch?: string
}

/** A ticket as the index lists it. */
export interface TicketItem extends RecordResponse<TicketRecord> {
  /** The account that opened the ticket. */
  author?: string
  state?: string
  commentCount?: number
}

/** A comment as the index lists it. */
export interface CommentView {
  uri: string
  cid: string
  subject: StrongRef
  body: Markdown
  replyTo?: StrongRef
  /** The account that wrote this version of the comment. */
  editor?: string
  createdAt: string
}

/** One version of a record a knot hosts. */
export interface RecordVersion {
  cid: string
  changeId?: string
  editor?: string
  createdAt: string
}

export interface DidDocument {
  id: string
  alsoKnownAs?: string[]
  service?: Array<{ id: string, type: string, serviceEndpoint: string }>
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
