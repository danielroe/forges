/**
 * The Sourcehut GraphQL responses as this provider reads them. Only the queried
 * fields are declared; each service's schema at docs.sourcehut.org is the reference.
 */

/** A page of a Sourcehut cursor resolver: `results` plus an opaque `cursor`. */
export interface ShPage<T> {
  results: T[]
  cursor?: string | null
}

/** An account, a mailbox or an external identity; the `Entity` interface. Only `canonicalName` is common to every service. */
export interface ShEntity {
  /** Absent on the entities that are not users, and on services whose `Entity` interface does not carry it. */
  id?: number
  created?: string
  updated?: string
  /** `~username` for a user, an email address for a mailbox. */
  canonicalName: string
  username?: string
  email?: string
  url?: string | null
  location?: string | null
  bio?: string | null
  avatar?: string | null
}

export type ShVisibility = 'PUBLIC' | 'UNLISTED' | 'PRIVATE'
export type ShAccessMode = 'RO' | 'RW'

// git.sr.ht

export interface ShRepository {
  id: number
  rid: string
  created: string
  updated: string
  owner: ShEntity
  name: string
  description?: string | null
  visibility: ShVisibility
  readme?: string | null
  access?: ShAccessMode
  HEAD?: ShReference | null
  path?: ShTreeEntry | null
  revparse_single?: ShCommit | null
  references?: ShPage<ShReference>
  log?: ShPage<ShCommit>
  codeSearch?: ShCodeSearch
  acls?: ShPage<ShAcl>
}

export interface ShReference {
  name: string
  target: string
  /** The object the ref points at: a `Commit`, or for an annotated tag a `Tag` whose `target` is the commit. */
  follow?: (ShObject & {
    committer?: { time: string }
    tagger?: { time: string }
    target?: ShObject & { committer?: { time: string } }
  }) | null
  artifacts?: ShPage<ShArtifact>
  artifact?: ShArtifact | null
}

export interface ShArtifact {
  id: number
  created: string
  filename: string
  checksum: string
  size: number
  url: string
}

export type ShObjectType = 'COMMIT' | 'TREE' | 'BLOB' | 'TAG'

export interface ShObject {
  type: ShObjectType
  id: string
  shortId: string
}

export interface ShTreeEntry {
  id: string
  name: string
  mode: number
  object: ShObject & {
    /** `TextBlob` */
    text?: string
    /** `TextBlob` and `BinaryBlob` */
    size?: number
    /** `BinaryBlob` */
    base64?: string
    /** `TextBlob` and `BinaryBlob`: a URL that serves the whole blob. */
    content?: string
    /** `Tree` */
    entries?: ShPage<ShTreeEntry>
  }
}

export interface ShSignature {
  name: string
  email: string
  time: string
}

export interface ShCommit extends ShObject {
  author: ShSignature
  committer: ShSignature
  message: string
  parents: ShObject[]
  diff?: string | null
}

export interface ShCodeSearch {
  totalFiles: number
  totalMatches: number
  results: ShFileMatch[]
  cursor?: string | null
}

export interface ShFileMatch {
  repo: ShRepository
  lang: string
  name: string
  lines: ShLineMatch[]
  score: number
}

export interface ShLineMatch {
  line: string
  lineNo: number
  before: string
  after: string
}

export interface ShAcl {
  id: number
  created: string
  repository: ShRepository
  entity: ShEntity
  mode?: ShAccessMode
}

// todo.sr.ht

export type ShTicketStatus = 'REPORTED' | 'CONFIRMED' | 'IN_PROGRESS' | 'PENDING' | 'RESOLVED'
export type ShTicketResolution = 'UNRESOLVED' | 'CLOSED' | 'FIXED' | 'IMPLEMENTED' | 'WONT_FIX' | 'BY_DESIGN' | 'INVALID' | 'DUPLICATE' | 'NOT_OUR_BUG'
export type ShEventType = 'CREATED' | 'COMMENT' | 'STATUS_CHANGE' | 'LABEL_ADDED' | 'LABEL_REMOVED' | 'ASSIGNED_USER' | 'UNASSIGNED_USER' | 'USER_MENTIONED' | 'TICKET_MENTIONED'

export interface ShTracker {
  id: number
  rid: string
  created: string
  updated: string
  owner: ShEntity
  name: string
  description?: string | null
  visibility: ShVisibility
  tickets?: ShPage<ShTicket>
  ticket?: ShTicket | null
  labels?: ShPage<ShLabel>
  label?: ShLabel | null
  subscription?: ShActivitySubscription | null
}

export interface ShTicket {
  id: number
  created: string
  updated: string
  submitter: ShEntity
  tracker: ShTracker
  ref: string
  subject: string
  body?: string | null
  status: ShTicketStatus
  resolution: ShTicketResolution
  labels: ShLabel[]
  assignees: ShEntity[]
  events?: ShPage<ShEvent>
  subscription?: ShActivitySubscription | null
}

export interface ShLabel {
  id: number
  created: string
  name: string
  tracker: ShTracker
  backgroundColor: string
  foregroundColor: string
}

export interface ShActivitySubscription {
  id: number
  created: string
}

export interface ShEvent {
  id: number
  created: string
  changes: ShEventDetail[]
  ticket: ShTicket
}

export interface ShEventDetail {
  eventType: ShEventType
  ticket: ShTicket
  /** `Comment` and `Created` */
  author?: ShEntity
  /** `Comment` */
  text?: string
  authenticity?: string
  /** `StatusChange` */
  editor?: ShEntity
  oldStatus?: ShTicketStatus
  newStatus?: ShTicketStatus
  oldResolution?: ShTicketResolution
  newResolution?: ShTicketResolution
  /** `Assignment` */
  assigner?: ShEntity
  assignee?: ShEntity
  /** `LabelUpdate` */
  labeler?: ShEntity
  label?: ShLabel
  /** `UserMention` (an entity) and `TicketMention` (a ticket). */
  mentioned?: ShEntity & { subject?: string }
}

// lists.sr.ht

export type ShPatchsetStatus = 'UNKNOWN' | 'PROPOSED' | 'NEEDS_REVISION' | 'SUPERSEDED' | 'APPROVED' | 'REJECTED' | 'APPLIED'

export interface ShMailingList {
  id: number
  rid: string
  created: string
  updated: string
  name: string
  owner: ShEntity
  description?: string | null
  visibility: ShVisibility
  lastActivity?: string | null
  threads?: ShPage<ShThread>
  emails?: ShPage<ShEmail>
  patches?: ShPage<ShPatchset>
  subscription?: ShActivitySubscription | null
}

export interface ShPatchset {
  id: number
  created: string
  updated: string
  subject: string
  version: number
  prefix?: string | null
  status: ShPatchsetStatus
  submitter: ShEntity
  coverLetter?: ShEmail | null
  thread?: ShThread
  supersededBy?: ShPatchset | null
  supersedes?: ShPatchset | null
  list: ShMailingList
  patches?: ShPage<ShEmail>
  mbox: string
}

export interface ShThread {
  created: string
  updated: string
  subject: string
  replies: number
  participants: number
  sender: ShEntity
  root: ShEmail
  list: ShMailingList
  descendants?: ShPage<ShEmail>
  mailto: string
  mbox: string
}

export interface ShEmail {
  id: number
  sender: ShEntity
  received: string
  date?: string | null
  subject: string
  messageID: string
  inReplyTo?: string | null
  body: string
  rawMessage: string
  thread: ShThread
  parent?: ShEmail | null
  patch?: { index?: number | null, count?: number | null } | null
  patchset?: ShPatchset | null
  list: ShMailingList
}

// builds.sr.ht

export type ShJobStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'CANCELLED'
export type ShTaskStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED'

export interface ShJob {
  id: number
  created: string
  updated: string
  status: ShJobStatus
  manifest: string
  note?: string | null
  tags: string[]
  visibility: ShVisibility
  image: string
  runner?: string | null
  owner: ShEntity
  tasks: ShTask[]
  artifacts: ShArtifact[]
  log?: ShLog | null
}

export interface ShTask {
  id: number
  created: string
  updated: string
  name: string
  status: ShTaskStatus
  log?: ShLog | null
  job: ShJob
}

export interface ShLog {
  last128KiB: string
  fullURL: string
}

// meta.sr.ht

export interface ShUser extends ShEntity {
  username: string
  email: string
  url?: string | null
  location?: string | null
  bio?: string | null
  avatar?: string | null
  pronouns?: string | null
  userType?: string | null
}
