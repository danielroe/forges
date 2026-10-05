import type { FetcherOptions, FetchLike, ForgeRequest } from './fetch.ts'
import type {
  Actor,
  ApproveAndMergeOptions,
  Branch,
  ChangedFile,
  Check,
  CheckRef,
  CheckReportInput,
  CiJob,
  CiJobRef,
  CiRun,
  CiRunQuery,
  CiRunRef,
  Collaborator,
  Comment,
  CommentRef,
  Commit,
  CommitQuery,
  CommitSearchQuery,
  Comparison,
  FileContent,
  FileOptions,
  ForgeEvent,
  ForgeInstance,
  ForgeKind,
  ForgeOrigin,
  ForgeWarning,
  GetManyResult,
  Installation,
  InstallationToken,
  Label,
  LabelInput,
  ListOptions,
  MergeOptions,
  Milestone,
  Notification,
  NotificationListOptions,
  NotificationRef,
  Page,
  PageOptions,
  Reaction,
  ReactionContent,
  Release,
  ReleaseAssetRef,
  ReleaseRef,
  Repo,
  RepoQuery,
  RepoRef,
  RepoRole,
  RepoSearchQuery,
  Review,
  ReviewEvent,
  ReviewInput,
  ReviewRef,
  SearchQuery,
  SecurityAlert,
  SecurityAlertKind,
  SecurityAlertListOptions,
  SubscriptionState,
  Support,
  Tag,
  TextLimits,
  Thread,
  ThreadCreateInput,
  ThreadKind,
  ThreadQuery,
  ThreadRef,
  ThreadUpdateInput,
  TreeEntry,
  TreeOptions,
  UpsertCommentInput,
  UpsertCommentResult,
  User,
  Webhook,
  WebhookDeliveryRecord,
  WebhookDeliveryRef,
  WebhookEventType,
  WebhookInput,
  WebhookRef,
  WebhookUpdate,
} from './model.ts'
import type { ForgeVerb } from './supports.ts'
import type { ParsedForgeUrl, ReferenceOptions, UrlTarget } from './web.ts'
import { UnknownForgeError } from './errors.ts'
import { toWarning } from './utils.ts'

/** No credentials: public reads only. Every write, notifications and subscriptions are unsupported. */
export interface AnonymousAuth {
  type: 'anonymous'
}

export interface TokenAuth {
  type: 'token'
  /** Personal access token or OAuth access token. */
  token: string
}

/** HTTP Basic credentials, for example a Bitbucket app password or Atlassian API token. */
export interface BasicAuth {
  type: 'basic'
  username: string
  password: string
}

/** App credentials. Omit `installationId` to act as the app itself. */
export interface AppAuth {
  type: 'app'
  appId: string | number
  /** PEM private key: RSA (PKCS#1 or PKCS#8) on GitHub, Ed25519 PKCS#8 on Cursor Origin. */
  privateKey: string
  installationId?: string | number
}

export type AuthKind = 'token' | 'basic' | 'app' | 'app_password' | 'oauth' | 'anonymous'

export interface ForgeOptionsBase {
  /** API base URL. Defaults to the forge's public instance. */
  baseUrl?: string
  /** Host used in refs and keys. Defaults to the host of `baseUrl`, with API subdomains mapped to the public host. */
  instance?: string
  fetch?: FetchLike
  timeout?: number
  /** Shared secret used to verify inbound webhook deliveries. */
  webhookSecret?: string
  userAgent?: string
  /**
   * Version of the forge instance, when the caller already knows it. Gates
   * version-dependent capabilities without the network call
   * `refreshCapabilities()` makes.
   */
  instanceVersion?: string
  /** Every write, including a mutating `request()`, rejects with `ReadOnlyError` and reports `false`. */
  readOnly?: boolean
  /** Called before a request is retried after a secondary rate limit, with the wait in milliseconds. */
  onRetry?: FetcherOptions['onRetry']
}

/** Per-thread-kind support. `'other'` subjects have no verbs, so they have no entry. */
export type PerKind = Record<Exclude<ThreadKind, 'other'>, Support>

/** Support per security alert kind. */
export type AlertSupport = Record<'dependency' | 'code_scanning' | 'secret' | 'advisory', Support>

export interface ForgeCapabilities {
  /** Instance version the capabilities were computed for, when known. */
  version?: string
  /** The provider as a whole has not reached parity: hand-authored fixtures only, or an unstable upstream. */
  experimental?: true
  /** `subscribe` is a long-lived push stream; see {@link SourcesApi}. */
  sources: Record<'poll' | 'webhook' | 'subscribe', Support>
  repos: {
    get: Support
    list: Support
    labels: Support
    createLabel: Support
    milestones: Support
    collaborators: Support
    permissionFor: Support
    addCollaborator: Support
    assignableUsers: Support
    reviewerCandidates: Support
  }
  users: { get: Support }
  threads: { get: PerKind, list: PerKind, getMany: Support }
  comments: { list: PerKind, edit: PerKind, delete: PerKind }
  /** Listing the reactions on a thread or one of its comments, per thread kind. */
  reactions: { list: PerKind }
  notifications: {
    list: Support
    markRead: Support
    markDone: Support
    unsubscribe: Support
    markAllRead: Support
    markAllDone: Support
    unreadCount: Support
  }
  /** Write verbs, per thread kind except `merge`, `approveAndMerge`, `transfer` and `markDuplicate`. */
  writes: {
    comment: PerKind
    /** Composed from `comment`, `comments.list` and `comments.edit`, so always `'emulated'` where it works at all. */
    upsertComment: PerKind
    close: PerKind
    reopen: PerKind
    create: PerKind
    update: PerKind
    setLabels: PerKind
    addLabels: PerKind
    removeLabels: PerKind
    setMilestone: PerKind
    react: PerKind
    setAssignees: PerKind
    requestReview: PerKind
    merge: Support
    /** Composed from `merge` and `reviews.approve`. */
    approveAndMerge: Support
    transfer: Support
    markDuplicate: Support
  }
  /** Reading a thread subscription (`get`) and changing it (`set`), per kind. Distinct from notification unsubscribe. */
  subscriptions: { get: PerKind, set: PerKind }
  /**
   * `thread` covers `Thread.checks` and `threads.checks()` (pull requests
   * only); the rest are the commit-level surface. `report` is a commit
   * status unless the credential can write check runs.
   */
  checks: { thread: PerKind, list: Support, report: Support, rerun: Support }
  /** Read-only CI surface. `log` is `false` where job logs are not reachable over the API. */
  ci: { runs: Support, run: Support, jobs: Support, log: Support }
  /**
   * Reviews on a pull request. `list` is `'emulated'` where reviews are
   * synthesised from approvals or votes; `create` then covers only the events
   * the forge's approval endpoint can express.
   */
  reviews: { list: Support, create: Support, submit: Support, approve: Support, resolveThread: Support }
  /**
   * Repository contents. `tree` is `'emulated'` where recursion is walked
   * level by level rather than by the forge.
   */
  contents: {
    file: Support
    tree: Support
    branches: Support
    tags: Support
    resolveRef: Support
    commits: Support
    commit: Support
    compare: Support
    /** `threads.files` and `threads.commits` on a pull request. */
    threadFiles: Support
    threadCommits: Support
  }
  /** Managing registered webhooks, beside receiving deliveries. */
  webhooks: {
    list: Support
    create: Support
    update: Support
    delete: Support
    rotateSecret: Support
    deliveries: Support
    redeliver: Support
  }
  releases: { list: Support, get: Support, latest: Support, getByTag: Support, downloadAsset: Support }
  /** Cross-repository search of issues and pull requests, repositories and commits. No code search. */
  search: { threads: Support, repos: Support, commits: Support }
  /** Per alert kind, since each needs its own token scope on GitHub. */
  securityAlerts: AlertSupport
  /** Enumerating app installations and deriving one provider per installation. */
  installations: Support
  /**
   * `'heuristic'` when event kinds are inferred from free text (GitLab system
   * notes) rather than reported by the forge, so `kind` may be `'other'` or
   * wrong for unrecognised wording; `kindRaw` and `payload` stay exact.
   */
  eventKinds: 'native' | 'heuristic'
  auth: readonly AuthKind[]
  limits?: TextLimits
}

/**
 * An async iterable that also collects non-fatal warnings as it runs. Read
 * `warnings` during or after iteration.
 */
export interface ForgeIterable<T> extends AsyncIterable<T> {
  readonly warnings: ForgeWarning[]
}

export interface WebhookDelivery {
  headers: Headers | Record<string, string>
  /** Raw body exactly as received; signatures are computed over these bytes. */
  body: string | Uint8Array
  /** Overrides the provider-level `webhookSecret` for this delivery. */
  secret?: string
}

export interface BulkNotificationOptions {
  /** Limit to one repository. */
  repo?: RepoRef
  /** Only notifications updated before this time. */
  before?: Date
}

export interface NotificationsApi {
  list: (options?: NotificationListOptions) => ForgeIterable<Notification>
  listPage: (options?: NotificationListOptions) => Promise<Page<Notification>>
  markRead: (ref: NotificationRef) => Promise<void>
  markDone: (ref: NotificationRef, options?: NotificationWriteOptions) => Promise<void>
  /** Stops notifications for the notification's thread, and on some forges also clears the notification. */
  unsubscribe: (ref: NotificationRef, options?: NotificationWriteOptions) => Promise<void>
  markAllRead: (options?: BulkNotificationOptions) => Promise<void>
  markAllDone: (options?: BulkNotificationOptions) => Promise<void>
  unreadCount: () => Promise<number>
}

export interface NotificationWriteOptions {
  /**
   * The thread the notification points at, when the caller already holds it.
   * Providers that would otherwise look it up skip that request.
   */
  thread?: ThreadRef
}

/** Why a thread was closed. */
export type CloseReason = 'completed' | 'not_planned' | 'duplicate'

export interface CloseOptions {
  /**
   * Mapped to the forge's own reason where it has one; forges without close
   * reasons close the thread without one.
   */
  reason?: CloseReason
  /** Forge-native reason, sent as is; takes precedence over `reason`. */
  reasonRaw?: string
}

export interface ThreadsApi {
  get: (ref: ThreadRef) => Promise<Thread>
  /** Reads several threads, batched where the forge allows. Failures become per-item warnings. */
  getMany: (refs: ThreadRef[]) => Promise<GetManyResult[]>
  list: (repo: RepoRef, query?: ThreadQuery) => ForgeIterable<Thread>
  /** One page of `list`; pass `cursor` back in `query` to read the next. */
  listPage: (repo: RepoRef, query?: ThreadQuery) => Promise<Page<Thread>>
  events: (ref: ThreadRef, options?: ListOptions) => ForgeIterable<ForgeEvent>
  eventsPage: (ref: ThreadRef, options?: ListOptions) => Promise<Page<ForgeEvent>>
  /** Conversation comments. Inline review comments are events, not comments. */
  comments: (ref: ThreadRef, options?: ListOptions) => ForgeIterable<Comment>
  commentsPage: (ref: ThreadRef, options?: ListOptions) => Promise<Page<Comment>>
  comment: (ref: ThreadRef, body: string) => Promise<Comment>
  /**
   * Creates the comment, or edits the one an earlier call with the same `key`
   * left behind. The key is carried in the body as a hidden marker; see
   * {@link commentMarker}. Composed from `comments`, `comment` and
   * `editComment`, so it costs a listing on every call.
   */
  upsertComment: (ref: ThreadRef, input: UpsertCommentInput) => Promise<UpsertCommentResult>
  editComment: (ref: CommentRef, body: string) => Promise<Comment>
  deleteComment: (ref: CommentRef) => Promise<void>
  create: (repo: RepoRef, input: ThreadCreateInput) => Promise<Thread>
  update: (ref: ThreadRef, input: ThreadUpdateInput) => Promise<Thread>
  /** Replaces the thread's labels. */
  setLabels: (ref: ThreadRef, labels: string[]) => Promise<void>
  /** Adds labels, leaving the rest in place. */
  addLabels: (ref: ThreadRef, labels: string[]) => Promise<void>
  /** Removes labels, leaving the rest in place. Labels the thread does not carry are ignored. */
  removeLabels: (ref: ThreadRef, labels: string[]) => Promise<void>
  /** Sets the thread's milestone, or clears it with `undefined`. */
  setMilestone: (ref: ThreadRef, milestone: Milestone | string | undefined) => Promise<void>
  /** Reactions left on the thread or on one of its comments. */
  reactions: (target: ThreadRef | CommentRef, options?: ListOptions) => ForgeIterable<Reaction>
  reactionsPage: (target: ThreadRef | CommentRef, options?: ListOptions) => Promise<Page<Reaction>>
  /** Reacts as the authenticated account, to the thread or to one of its comments. */
  react: (target: ThreadRef | CommentRef, reaction: ReactionContent) => Promise<void>
  unreact: (target: ThreadRef | CommentRef, reaction: ReactionContent) => Promise<void>
  /** Moves the thread to another repository, and returns its ref there. */
  transfer: (ref: ThreadRef, repo: RepoRef) => Promise<ThreadRef>
  /** Marks the thread a duplicate of `canonical`, which must be in the same repository on most forges. */
  markDuplicate: (ref: ThreadRef, canonical: ThreadRef) => Promise<void>
  /** Replaces the thread's assignees. */
  setAssignees: (ref: ThreadRef, assignees: Array<string | Actor>) => Promise<void>
  /** Adds reviewers to a pull request. */
  requestReview: (ref: ThreadRef, reviewers: Array<string | Actor>) => Promise<void>
  close: (ref: ThreadRef, options?: CloseOptions) => Promise<void>
  reopen: (ref: ThreadRef) => Promise<void>
  merge: (ref: ThreadRef, options?: MergeOptions) => Promise<void>
  /** Approves, then merges. The merge method is checked before the approval is sent. */
  approveAndMerge: (ref: ThreadRef, options?: ApproveAndMergeOptions) => Promise<void>
  /** The authenticated account's subscription to the thread. */
  subscription: (ref: ThreadRef) => Promise<SubscriptionState>
  subscribe: (ref: ThreadRef) => Promise<void>
  /** Stops the account's notifications for a thread, leaving existing notifications alone. */
  unsubscribe: (ref: ThreadRef) => Promise<void>
  /** Every check on the pull's head, in one page; `warnings` names the sources that could not be read. */
  checks: (ref: ThreadRef) => Promise<Page<Check>>
  /**
   * Reviews on a pull request. Forges with approvals but no review objects
   * (GitLab approvals, Azure DevOps votes, Bitbucket participants) synthesise
   * one review per approver, with `comments: false`.
   */
  reviews: (ref: ThreadRef, options?: PageOptions) => ForgeIterable<Review>
  reviewsPage: (ref: ThreadRef, options?: PageOptions) => Promise<Page<Review>>
  /** Creates a review. Without `event` the review is pending where the forge has pending reviews. */
  createReview: (ref: ThreadRef, input: ReviewInput) => Promise<Review>
  /** Submits a pending review. */
  submitReview: (ref: ReviewRef, event: ReviewEvent, body?: string) => Promise<Review>
  /** Approves without merging; `createReview({ event: 'approve' })` with nothing else to say. */
  approve: (ref: ThreadRef, body?: string) => Promise<void>
  /** Files a pull request changes, with a per-file `patch` where the forge returns one. */
  files: (ref: ThreadRef, options?: PageOptions) => ForgeIterable<ChangedFile>
  filesPage: (ref: ThreadRef, options?: PageOptions) => Promise<Page<ChangedFile>>
  /** Commits on a pull request. */
  commits: (ref: ThreadRef, options?: PageOptions) => ForgeIterable<Commit>
  commitsPage: (ref: ThreadRef, options?: PageOptions) => Promise<Page<Commit>>
  /** Resolves a review conversation, by the id on {@link ReviewComment.thread}. */
  resolveReviewThread: (ref: ThreadRef, id: string) => Promise<void>
  unresolveReviewThread: (ref: ThreadRef, id: string) => Promise<void>
}

export interface ChecksApi {
  /** Every check on a commit: check runs, commit statuses, jobs or policy evaluations. */
  list: (repo: RepoRef, sha: string) => Promise<Page<Check>>
  /** Writes a commit status, or a check run where the credential can (GitHub app auth). */
  report: (repo: RepoRef, sha: string, input: CheckReportInput) => Promise<Check>
  /** Re-runs a check. Rejects for a `CheckRef.type` the forge cannot re-run. */
  rerun: (ref: CheckRef) => Promise<void>
}

export interface CiApi {
  runs: (repo: RepoRef, query?: CiRunQuery) => ForgeIterable<CiRun>
  runsPage: (repo: RepoRef, query?: CiRunQuery) => Promise<Page<CiRun>>
  run: (ref: CiRunRef) => Promise<CiRun>
  jobs: (ref: CiRunRef, options?: PageOptions) => ForgeIterable<CiJob>
  jobsPage: (ref: CiRunRef, options?: PageOptions) => Promise<Page<CiJob>>
  /** The job's log as it arrives. There is no workflow dispatch: CI is read-only here. */
  log: (ref: CiJobRef) => Promise<ReadableStream<Uint8Array>>
}

export interface ContentsApi {
  /**
   * One file's contents. Binary-safe: `content` is a `Uint8Array` unless the
   * forge reports text and `as: 'text'` was asked for. Files past the forge's
   * inline limit (1 MB on GitHub) are read from the raw or blob endpoint
   * instead of failing.
   */
  file: (repo: RepoRef, path: string, options?: FileOptions) => Promise<FileContent>
  /** One level, or every descendant with `recursive`. Truncated listings carry a `tree_truncated` warning. */
  tree: (repo: RepoRef, options?: TreeOptions) => ForgeIterable<TreeEntry>
  treePage: (repo: RepoRef, options?: TreeOptions) => Promise<Page<TreeEntry>>
  branches: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Branch>
  branchesPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Branch>>
  tags: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Tag>
  tagsPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Tag>>
  /** Resolves a branch, tag or sha to a full commit sha; a full sha is returned as is. */
  resolveRef: (repo: RepoRef, ref: string) => Promise<string>
  commits: (repo: RepoRef, query?: CommitQuery) => ForgeIterable<Commit>
  commitsPage: (repo: RepoRef, query?: CommitQuery) => Promise<Page<Commit>>
  /** One commit, with its files and stats. */
  commit: (repo: RepoRef, sha: string) => Promise<Commit>
  /** Commits and files between two refs. */
  compare: (repo: RepoRef, base: string, head: string) => Promise<Comparison>
}

export interface ReleasesApi {
  list: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Release>
  listPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Release>>
  get: (ref: ReleaseRef) => Promise<Release>
  /** The release for a tag name. */
  getByTag: (repo: RepoRef, tag: string) => Promise<Release>
  /**
   * The asset's bytes as they arrive. A redirect to a CDN host is followed
   * without the `Authorization` header, which those hosts reject.
   */
  downloadAsset: (ref: ReleaseAssetRef, options?: { signal?: AbortSignal }) => Promise<ReadableStream<Uint8Array>>
  /** The most recent published release that is not a draft or prerelease, if any. */
  latest: (repo: RepoRef) => Promise<Release | undefined>
}

export interface SearchApi {
  /**
   * Issues and pull requests across repositories. Fields the forge cannot
   * filter on come back as a `filter_unsupported` warning on the page.
   */
  threads: (query: SearchQuery) => ForgeIterable<Thread>
  threadsPage: (query: SearchQuery) => Promise<Page<Thread>>
  repos: (query: RepoSearchQuery) => ForgeIterable<Repo>
  reposPage: (query: RepoSearchQuery) => Promise<Page<Repo>>
  /** Commits across repositories, where the forge indexes them. */
  commits: (query: CommitSearchQuery) => ForgeIterable<Commit>
  commitsPage: (query: CommitSearchQuery) => Promise<Page<Commit>>
}

export interface SecurityAlertsApi {
  list: (repo: RepoRef, options?: SecurityAlertListOptions) => ForgeIterable<SecurityAlert>
  listPage: (repo: RepoRef, options?: SecurityAlertListOptions) => Promise<Page<SecurityAlert>>
}

export interface ReposApi {
  get: (ref: RepoRef) => Promise<Repo>
  /** The authenticated account's repositories, or the installation's under app auth. */
  list: (options?: RepoQuery) => ForgeIterable<Repo>
  listPage: (options?: RepoQuery) => Promise<Page<Repo>>
  /** Every label defined on the repository, whether or not a thread carries it. */
  labels: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Label>
  labelsPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Label>>
  createLabel: (repo: RepoRef, label: LabelInput) => Promise<Label>
  milestones: (repo: RepoRef, options?: MilestoneListOptions) => ForgeIterable<Milestone>
  milestonesPage: (repo: RepoRef, options?: MilestoneListOptions) => Promise<Page<Milestone>>
  collaborators: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Collaborator>
  collaboratorsPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Collaborator>>
  /** One account's role on the repository; `'none'` when it has no access. */
  permissionFor: (repo: RepoRef, actor: string | Actor) => Promise<RepoRole>
  addCollaborator: (repo: RepoRef, actor: string | Actor, role: RepoRole) => Promise<void>
  /** Accounts that can be assigned to a thread in the repository. */
  assignableUsers: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Actor>
  assignableUsersPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Actor>>
  /** Accounts that can be asked to review a given pull request. */
  reviewerCandidates: (ref: ThreadRef, options?: PageOptions) => ForgeIterable<Actor>
  reviewerCandidatesPage: (ref: ThreadRef, options?: PageOptions) => Promise<Page<Actor>>
}

export interface MilestoneListOptions extends PageOptions {
  /** Defaults to `'open'`. */
  state?: 'open' | 'closed' | 'all'
}

export interface InstallationsApi {
  list: (options?: PageOptions) => ForgeIterable<Installation>
  listPage: (options?: PageOptions) => Promise<Page<Installation>>
  get: (installation: Installation | string) => Promise<Installation>
  /** Mints (or reuses a cached) installation token. */
  token: (installation: Installation | string) => Promise<InstallationToken>
  repos: (installation: Installation | string, options?: PageOptions) => ForgeIterable<Repo>
  reposPage: (installation: Installation | string, options?: PageOptions) => Promise<Page<Repo>>
  /** Provider authenticated as one installation, sharing this instance's app credentials. */
  provider: (installation: Installation | string) => ForgeProvider
  /** One provider per installation. */
  providers: () => AsyncIterable<{ installation: Installation, provider: ForgeProvider }>
}

export interface WebhooksApi {
  verify: (delivery: WebhookDelivery) => Promise<boolean>
  /** Verifies the delivery, then translates it into normalised events. */
  ingest: (delivery: WebhookDelivery) => Promise<ForgeEvent[]>
  /** Normalised kinds and actions this provider can deliver, whatever a hook is subscribed to. */
  readonly events: WebhookEventType[]
  /** Hooks on a repository, or on an organisation or workspace when `target` is a namespace ref. */
  list: (target: RepoRef, options?: PageOptions) => ForgeIterable<Webhook>
  listPage: (target: RepoRef, options?: PageOptions) => Promise<Page<Webhook>>
  create: (target: RepoRef, input: WebhookInput) => Promise<Webhook>
  update: (ref: WebhookRef, update: WebhookUpdate) => Promise<Webhook>
  delete: (ref: WebhookRef) => Promise<void>
  /** Replaces the signing secret in place. `false` where the forge can only do it by recreating the hook. */
  rotateSecret: (ref: WebhookRef, secret: string) => Promise<Webhook>
  deliveries: (ref: WebhookRef, options?: PageOptions) => ForgeIterable<WebhookDeliveryRecord>
  deliveriesPage: (ref: WebhookRef, options?: PageOptions) => Promise<Page<WebhookDeliveryRecord>>
  redeliver: (ref: WebhookDeliveryRef) => Promise<void>
}

/**
 * What a credential needs for a verb, as data. Nothing in the library reads
 * it; it is there so a consumer can build a consent screen or explain a 403.
 */
export interface VerbScopes {
  /** OAuth or personal access token scopes. */
  token?: string[]
  /** Fine-grained token or app permissions, by permission name. */
  permissions?: Record<string, 'read' | 'write' | 'admin'>
  /** How the forge expresses access where scopes do not apply. */
  note?: string
}

export interface SubscribeOptions {
  /** Resume after this cursor, as yielded by an earlier {@link SubscriptionItem}. */
  cursor?: string
  /** Aborting closes the connection and ends iteration without an error. */
  signal?: AbortSignal
}

export interface SubscriptionItem {
  event: ForgeEvent
  /** Opaque position after `event`; persist it and pass it back to resume. */
  cursor: string
}

export interface UsersApi {
  /** Reads an account by login, without needing a credential where the forge allows it. */
  get: (login: string) => Promise<User>
}

export interface SourcesApi {
  /**
   * Push delivery over a long-lived connection. Iteration ends when the signal
   * aborts or the consumer stops iterating; a dropped connection throws
   * `SubscriptionClosedError` carrying the last cursor. There is no automatic
   * reconnection.
   */
  subscribe: (options?: SubscribeOptions) => AsyncIterable<SubscriptionItem>
}

export type { ForgeVerb } from './supports.ts'

export interface ForgeProvider {
  /**
   * Requests endpoints relative to `baseUrl` or absolute HTTP(S) URLs.
   * Other origins omit default headers and provider credentials; explicit headers apply.
   */
  readonly request: ForgeRequest
  readonly kind: ForgeKind
  readonly instance: ForgeInstance
  readonly baseUrl: string
  /** Static, no-network capabilities until `refreshCapabilities()` resolves. */
  readonly capabilities: ForgeCapabilities
  /**
   * Re-derives capabilities from the instance version. The version is read
   * once per provider (GHES `/meta`, GitLab, Forgejo and Gitea `/version`).
   * Updates `capabilities` and returns it.
   */
  refreshCapabilities: () => Promise<ForgeCapabilities>
  /** Rewrites Markdown into the dialect the forge renders; returns it unchanged where the forge renders CommonMark. */
  normaliseMarkdown: (body: string) => string
  readonly repos: ReposApi
  readonly notifications: NotificationsApi
  readonly sources: SourcesApi
  readonly threads: ThreadsApi
  readonly webhooks: WebhooksApi
  readonly installations: InstallationsApi
  readonly releases: ReleasesApi
  readonly contents: ContentsApi
  readonly checks: ChecksApi
  readonly ci: CiApi
  readonly users: UsersApi
  readonly search: SearchApi
  readonly securityAlerts: SecurityAlertsApi
  /**
   * Whether `verb` is supported, for `kind` where support differs by kind,
   * including version gates. Every verb is always present and rejects with
   * `UnsupportedOperationError` when this is `false`: the capability is the
   * question, the method is the action.
   */
  can: (verb: ForgeVerb, kind?: ThreadKind | SecurityAlertKind) => boolean
  /** The web page for `target`, built without a request; `undefined` when the forge has no such page. */
  urlFor: (target: UrlTarget) => string | undefined
  /**
   * Token scopes or app permissions `verb` needs on this forge, as data for a
   * consent screen or a 403 explanation. Nothing in the library reads it, and
   * an unmapped verb returns `{}`.
   */
  scopesFor: (verb: ForgeVerb) => VerbScopes
  /** Reads a web URL on this provider's instance into refs; `undefined` for anything else. */
  parseUrl: (url: string | URL) => ParsedForgeUrl | undefined
  /**
   * How to mention `ref` in Markdown on this forge (`#42`, `!42`,
   * `acme/widgets#42`), short when written in `from`; the thread URL where the
   * forge has no reference syntax.
   */
  referenceTo: (ref: ThreadRef, options?: ReferenceOptions) => string | undefined
}

/**
 * Lazily constructed provider. `createForges` calls `create()`; nothing
 * touches the network before that.
 */
export interface ForgeProviderFactory<T extends ForgeProvider = ForgeProvider> {
  readonly kind: ForgeKind
  /** The provider has not reached parity; see `ForgeCapabilities.experimental`. */
  readonly experimental?: true
  create: () => T
}

export interface Forges {
  readonly providers: ForgeProvider[]
  /** First provider of `kind`, optionally narrowed to a single instance host. */
  get: (kind: ForgeKind, instance?: ForgeInstance) => ForgeProvider | undefined
  all: (kind: ForgeKind) => ForgeProvider[]
  /** The provider a ref belongs to, by `forge` and `instance`. */
  for: (ref: ForgeOrigin) => ForgeProvider | undefined
  /** The provider whose instance serves `url`. */
  forUrl: (url: string | URL) => ForgeProvider | undefined
  /** Reads a web URL on any registered instance. */
  parseUrl: (url: string | URL) => (ParsedForgeUrl & { provider: ForgeProvider }) | undefined
  /** Notifications from every registered provider, provider by provider. */
  notifications: { list: (options?: NotificationListOptions) => ForgeIterable<Notification> }
  /** Reads routed to the provider each ref belongs to; an unregistered origin throws `UnknownForgeError`. */
  repos: { get: (ref: RepoRef) => Promise<Repo> }
  threads: {
    get: (ref: ThreadRef) => Promise<Thread>
    /** Grouped per provider, results in input order. An unregistered origin is a per-item warning. */
    getMany: (refs: ThreadRef[]) => Promise<GetManyResult[]>
  }
  releases: {
    list: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Release>
    latest: (repo: RepoRef) => Promise<Release | undefined>
  }
  securityAlerts: { list: SecurityAlertsApi['list'] }
  /**
   * Fans out to every provider that supports search, merging by `updatedAt`,
   * newest first. A provider that rejects contributes one `warnings` entry
   * and no items.
   */
  search: {
    threads: (query?: SearchQuery) => ForgeIterable<Thread>
    repos: (query?: RepoSearchQuery) => ForgeIterable<Repo>
  }
}

/**
 * One page from each provider that supports `verb`, merged newest first. A
 * provider that rejects adds a `search_failed` warning and no items; cursors
 * are per provider, so the fan-out reads one page each rather than paging.
 */
function fanOut<T extends { updatedAt?: Date }>(
  providers: ForgeProvider[],
  verb: ForgeVerb,
  read: (provider: ForgeProvider) => Promise<Page<T>>,
): ForgeIterable<T> {
  const warnings: ForgeWarning[] = []
  return {
    warnings,
    async* [Symbol.asyncIterator]() {
      const results = await Promise.all(providers.filter(provider => provider.can(verb)).map(async (provider) => {
        try {
          const page = await read(provider)
          warnings.push(...page.warnings ?? [])
          return page.items
        }
        catch (error) {
          warnings.push(toWarning('search_failed', error, `${provider.kind}:${provider.instance}`))
          return []
        }
      }))
      yield* results.flat().sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
    },
  }
}

export function createForges(factories: Array<ForgeProviderFactory | ForgeProvider>): Forges {
  const providers = factories.map(factory => 'create' in factory ? factory.create() : factory)
  const seen = new Set<string>()
  for (const provider of providers) {
    const key = `${provider.kind}:${provider.instance}`
    if (seen.has(key)) {
      throw new TypeError(`Two providers are registered for ${provider.kind} on ${provider.instance}; pass \`instance\` to tell them apart`)
    }
    seen.add(key)
  }
  const find = (ref: ForgeOrigin) => providers.find(provider => provider.kind === ref.forge && provider.instance === ref.instance)
  const route = (ref: ForgeOrigin): ForgeProvider => {
    const provider = find(ref)
    if (!provider) {
      throw new UnknownForgeError(`No provider registered for ${ref.forge} on ${ref.instance}`, { forge: ref.forge, instance: ref.instance })
    }
    return provider
  }
  const parseUrl = (url: string | URL) => {
    for (const provider of providers) {
      const parsed = provider.parseUrl(url)
      if (parsed) {
        return { ...parsed, provider }
      }
    }
    return undefined
  }

  return {
    providers,
    for: find,
    forUrl: url => parseUrl(url)?.provider,
    parseUrl,
    repos: { get: ref => route(ref).repos.get(ref) },
    threads: {
      get: ref => route(ref).threads.get(ref),
      async getMany(refs) {
        const groups = new Map<ForgeProvider, number[]>()
        const results: GetManyResult[] = Array.from({ length: refs.length })
        for (const [index, ref] of refs.entries()) {
          const provider = find(ref)
          if (!provider) {
            const error = new UnknownForgeError(`No provider registered for ${ref.forge} on ${ref.instance}`, { forge: ref.forge, instance: ref.instance })
            results[index] = { ok: false, ref, warning: toWarning('thread_unreadable', error, ref.number) }
            continue
          }
          groups.set(provider, [...groups.get(provider) ?? [], index])
        }
        await Promise.all([...groups].map(async ([provider, indexes]) => {
          const batch = await provider.threads.getMany(indexes.map(index => refs[index]!))
          for (const [position, index] of indexes.entries()) {
            results[index] = batch[position]!
          }
        }))
        return results
      },
    },
    releases: {
      list: (repo, options) => route(repo).releases.list(repo, options),
      latest: repo => route(repo).releases.latest(repo),
    },
    securityAlerts: { list: (repo, options) => route(repo).securityAlerts.list(repo, options) },
    search: {
      threads: (query = {}) => fanOut(providers, 'search.threads', provider => provider.search.threadsPage(query)),
      repos: (query = {}) => fanOut(providers, 'search.repos', provider => provider.search.reposPage(query)),
    },
    get: (kind, instance) => providers.find(
      provider => provider.kind === kind && (!instance || provider.instance === instance),
    ),
    all: kind => providers.filter(provider => provider.kind === kind),
    notifications: {
      list(options) {
        const warnings: ForgeWarning[] = []
        return {
          warnings,
          async* [Symbol.asyncIterator]() {
            for (const provider of providers) {
              if (!provider.can('notifications.list')) {
                continue
              }
              const iterable = provider.notifications.list(options)
              try {
                yield* iterable
              }
              catch (error) {
                warnings.push({ ...toWarning('notifications_failed', error), subject: `${provider.kind}:${provider.instance}` })
              }
              finally {
                warnings.push(...iterable.warnings)
              }
            }
          },
        }
      },
    },
  }
}
