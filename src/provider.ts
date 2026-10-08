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
  Cursor,
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
import { forgeIterable, toWarning } from './utils.ts'

/** No credentials: public reads only. Every write, notifications and subscriptions are unsupported. */
export interface AnonymousAuth {
  type: 'anonymous'
}

/** A bearer or personal access token. */
export interface TokenAuth {
  type: 'token'
  /**
   * Personal access token or OAuth access token. A function is called before
   * every request, so a refreshed token applies without a new provider.
   */
  token: string | (() => string | Promise<string>)
}

/** HTTP Basic credentials, for example a Bitbucket app password or Atlassian API token. */
export interface BasicAuth {
  type: 'basic'
  username: string
  /** The password, app password or API token. */
  password: string
}

/** App credentials. Omit `installationId` to act as the app itself. */
export interface AppAuth {
  type: 'app'
  appId: string | number
  /** PEM private key: RSA (PKCS#1 or PKCS#8) on GitHub, Ed25519 PKCS#8 on Cursor Origin. */
  privateKey: string
  /** The installation to act as. Omit it to act as the app itself. */
  installationId?: string | number
}

/** The credential types that a provider can accept. */
export type AuthKind = 'token' | 'basic' | 'app' | 'app_password' | 'oauth' | 'anonymous'

/** Options that every provider accepts. */
export interface ForgeOptionsBase {
  /** API base URL. Defaults to the forge's public instance. */
  baseUrl?: string
  /** Host used in refs and keys. Defaults to the host of `baseUrl`, with API subdomains mapped to the public host. */
  instance?: string
  /** A `fetch` to use instead of the global one, for tests and for runtimes without one. */
  fetch?: FetchLike
  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
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

/**
 * What a provider supports, operation by operation. It is computed without a request, and
 * `refreshCapabilities()` refines it with the instance version. Each group holds one entry per
 * capability, and the [capability matrix](/reference/capability-matrix) lists them for every forge.
 */
export interface ForgeCapabilities {
  /** Instance version the capabilities were computed for, when known. */
  version?: string
  /** The provider as a whole has not reached parity: hand-authored fixtures only, or an unstable upstream. */
  experimental?: true
  /** `subscribe` is a long-lived push stream; see {@link SourcesApi}. */
  sources: Record<'poll' | 'webhook' | 'subscribe', Support>
  repos: {
    /** Support for `repos.get()`. */
    get: Support
    /** Support for `repos.list()` and `repos.listPage()`. */
    list: Support
    /** Support for `repos.labels()` and `repos.labelsPage()`. */
    labels: Support
    /** Support for `repos.createLabel()`. */
    createLabel: Support
    /** Support for `repos.milestones()` and `repos.milestonesPage()`. */
    milestones: Support
    /** Support for `repos.collaborators()` and `repos.collaboratorsPage()`. */
    collaborators: Support
    /** Support for `repos.permissionFor()`. */
    permissionFor: Support
    /** Support for `repos.addCollaborator()`. */
    addCollaborator: Support
    /** Support for `repos.assignableUsers()` and `repos.assignableUsersPage()`. */
    assignableUsers: Support
    /** Support for `repos.reviewerCandidates()` and `repos.reviewerCandidatesPage()`. */
    reviewerCandidates: Support
  }
  users: {
    /** Support for `users.get()`. */
    get: Support
    /** Support for `users.me()`. */
    me: Support
  }
  threads: {
    /** Support for `threads.get()`, per thread kind. */
    get: PerKind
    /** Support for `threads.list()` and `threads.listPage()`, per thread kind. */
    list: PerKind
    /** Support for `threads.getMany()`. */
    getMany: Support
  }
  comments: {
    /** Support for `threads.comments()` and `threads.commentsPage()`, per thread kind. */
    list: PerKind
    /** Support for `threads.editComment()`, per thread kind. */
    edit: PerKind
    /** Support for `threads.deleteComment()`, per thread kind. */
    delete: PerKind
  }
  /** Listing the reactions on a thread or one of its comments, per thread kind. */
  reactions: {
    /** Support for `threads.reactions()` and `threads.reactionsPage()`, per thread kind. */
    list: PerKind
  }
  notifications: {
    /** Support for `notifications.list()` and `notifications.listPage()`. */
    list: Support
    /** Support for `notifications.markRead()`. */
    markRead: Support
    /** Support for `notifications.markDone()`. */
    markDone: Support
    /** Support for `notifications.unsubscribe()`. */
    unsubscribe: Support
    /** Support for `notifications.markAllRead()`. */
    markAllRead: Support
    /** Support for `notifications.markAllDone()`. */
    markAllDone: Support
    /** Support for `notifications.unreadCount()`. */
    unreadCount: Support
  }
  /** Write verbs, per thread kind except `merge`, `approveAndMerge`, `transfer` and `markDuplicate`. */
  writes: {
    /** Support for `threads.comment()`, per thread kind. */
    comment: PerKind
    /** Composed from `comment`, `comments.list` and `comments.edit`, so always `'emulated'` where it works at all. */
    upsertComment: PerKind
    /** Support for `threads.close()`, per thread kind. */
    close: PerKind
    /** Support for `threads.reopen()`, per thread kind. */
    reopen: PerKind
    /** Support for `threads.create()`, per thread kind. */
    create: PerKind
    /** Support for `threads.update()`, per thread kind. */
    update: PerKind
    /** Support for `threads.setLabels()`, per thread kind. */
    setLabels: PerKind
    /** Support for `threads.addLabels()`, per thread kind. */
    addLabels: PerKind
    /** Support for `threads.removeLabels()`, per thread kind. */
    removeLabels: PerKind
    /** Support for `threads.setMilestone()`, per thread kind. */
    setMilestone: PerKind
    /** Support for `threads.react()` and `threads.unreact()`, per thread kind. */
    react: PerKind
    /** Support for `threads.setAssignees()`, per thread kind. */
    setAssignees: PerKind
    /** Support for `threads.requestReview()`, per thread kind. */
    requestReview: PerKind
    /** Support for `threads.merge()`. */
    merge: Support
    /** Composed from `merge` and `reviews.approve`. */
    approveAndMerge: Support
    /** Support for `threads.transfer()`. */
    transfer: Support
    /** Support for `threads.markDuplicate()`. */
    markDuplicate: Support
  }
  /** Reading a thread subscription (`get`) and changing it (`set`), per kind. Distinct from notification unsubscribe. */
  subscriptions: {
    /** Support for `threads.subscription()`, per thread kind. */
    get: PerKind
    /** Support for `threads.subscribe()` and `threads.unsubscribe()`, per thread kind. */
    set: PerKind
  }
  /**
   * `thread` covers `Thread.checks` and `threads.checks()` (pull requests
   * only); the rest are the commit-level surface. `report` is a commit
   * status unless the credential can write check runs.
   */
  checks: {
    /** Support for `threads.checks()`, per thread kind. */
    thread: PerKind
    /** Support for `checks.list()`. */
    list: Support
    /** Support for `checks.report()`. */
    report: Support
    /** Support for `checks.rerun()`. */
    rerun: Support
  }
  /** Read-only CI surface. `log` is `false` where job logs are not reachable over the API. */
  ci: {
    /** Support for `ci.runs()` and `ci.runsPage()`. */
    runs: Support
    /** Support for `ci.run()`. */
    run: Support
    /** Support for `ci.jobs()` and `ci.jobsPage()`. */
    jobs: Support
    /** Support for `ci.log()`. */
    log: Support
  }
  /**
   * Reviews on a pull request. `list` is `'emulated'` where reviews are
   * synthesised from approvals or votes; `create` then covers only the events
   * the forge's approval endpoint can express.
   */
  reviews: {
    /** Support for `threads.reviews()` and `threads.reviewsPage()`. */
    list: Support
    /** Support for `threads.createReview()`. */
    create: Support
    /** Support for `threads.submitReview()`. */
    submit: Support
    /** Support for `threads.approve()`. */
    approve: Support
    /** Support for `threads.resolveReviewThread()` and `threads.unresolveReviewThread()`. */
    resolveThread: Support
  }
  /**
   * Repository contents. `tree` is `'emulated'` where recursion is walked
   * level by level rather than by the forge.
   */
  contents: {
    /** Support for `contents.file()`. */
    file: Support
    /** Support for `contents.tree()` and `contents.treePage()`. */
    tree: Support
    /** Support for `contents.branches()` and `contents.branchesPage()`. */
    branches: Support
    /** Support for `contents.tags()` and `contents.tagsPage()`. */
    tags: Support
    /** Support for `contents.resolveRef()`. */
    resolveRef: Support
    /** Support for `contents.commits()` and `contents.commitsPage()`. */
    commits: Support
    /** Support for `contents.commit()`. */
    commit: Support
    /** Support for `contents.compare()`. */
    compare: Support
    /** `threads.files` and `threads.commits` on a pull request. */
    threadFiles: Support
    /** Support for `threads.commits()` and `threads.commitsPage()`. */
    threadCommits: Support
  }
  /** Managing registered webhooks, beside receiving deliveries. */
  webhooks: {
    /** Support for `webhooks.list()` and `webhooks.listPage()`. */
    list: Support
    /** Support for `webhooks.create()`. */
    create: Support
    /** Support for `webhooks.update()`. */
    update: Support
    /** Support for `webhooks.delete()`. */
    delete: Support
    /** Support for `webhooks.rotateSecret()`. */
    rotateSecret: Support
    /** Support for `webhooks.deliveries()` and `webhooks.deliveriesPage()`. */
    deliveries: Support
    /** Support for `webhooks.redeliver()`. */
    redeliver: Support
  }
  releases: {
    /** Support for `releases.list()` and `releases.listPage()`. */
    list: Support
    /** Support for `releases.get()`. */
    get: Support
    /** Support for `releases.latest()`. */
    latest: Support
    /** Support for `releases.getByTag()`. */
    getByTag: Support
    /** Support for `releases.downloadAsset()`. */
    downloadAsset: Support
  }
  /** Cross-repository search of issues and pull requests, repositories and commits. No code search. */
  search: {
    /** Support for `search.threads()` and `search.threadsPage()`. */
    threads: Support
    /** Support for `search.repos()` and `search.reposPage()`. */
    repos: Support
    /** Support for `search.commits()` and `search.commitsPage()`. */
    commits: Support
  }
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
  /** Auth types the provider accepts. The type this provider was created with is `ForgeProvider.authKind`. */
  authKinds: readonly AuthKind[]
  /** Maximum text lengths the forge accepts. */
  limits?: TextLimits
}

/**
 * An async iterable that also collects non-fatal warnings as it runs. Read
 * `warnings` during or after iteration.
 */
export interface ForgeIterable<T> extends AsyncIterable<T> {
  /** The non-fatal warnings collected so far. Read it during or after iteration. */
  readonly warnings: ForgeWarning[]
}

/** A webhook delivery as received: its headers, its raw body and, optionally, the secret to verify it with. */
export interface WebhookDelivery {
  /** The request headers, which carry the signature and the event name. */
  headers: Headers | Record<string, string>
  /** Raw body exactly as received; signatures are computed over these bytes. */
  body: string | Uint8Array
  /** Overrides the provider-level `webhookSecret` for this delivery. */
  secret?: string
}

/** Options for `markAllRead()` and `markAllDone()`. */
export interface BulkNotificationOptions {
  /** Limit to one repository. */
  repo?: RepoRef
  /** Only notifications updated before this time. */
  before?: Date
}

/** Reading and clearing the notifications of the authenticated account. */
export interface NotificationsApi {
  /** Lists the account's notifications. */
  list: (options?: NotificationListOptions) => ForgeIterable<Notification>
  /** One page of `list()`. Pass the `cursor` of the previous page to read the next. */
  listPage: (options?: NotificationListOptions) => Promise<Page<Notification>>
  /** Marks a notification as read. */
  markRead: (ref: NotificationRef) => Promise<void>
  /** Marks a notification as done, which clears it from the inbox where the forge has that state. */
  markDone: (ref: NotificationRef, options?: NotificationWriteOptions) => Promise<void>
  /** Stops notifications for the notification's thread, and on some forges also clears the notification. */
  unsubscribe: (ref: NotificationRef, options?: NotificationWriteOptions) => Promise<void>
  /** Marks every notification as read, or those of one repository. */
  markAllRead: (options?: BulkNotificationOptions) => Promise<void>
  /** Marks every notification as done, or those of one repository. */
  markAllDone: (options?: BulkNotificationOptions) => Promise<void>
  /** The number of unread notifications. */
  unreadCount: () => Promise<number>
}

/** Options for changing one notification. */
export interface NotificationWriteOptions {
  /**
   * The thread the notification points at, when the caller already holds it.
   * Providers that would otherwise look it up skip that request.
   */
  thread?: ThreadRef
}

/** Why a thread was closed. */
export type CloseReason = 'completed' | 'not_planned' | 'duplicate'

/** Options for `threads.close()`. */
export interface CloseOptions {
  /**
   * Mapped to the forge's own reason where it has one; forges without close
   * reasons close the thread without one.
   */
  reason?: CloseReason
  /** Forge-native reason, sent as is; takes precedence over `reason`. */
  reasonRaw?: string
}

/**
 * Issues, pull requests and the other kinds of discussion: reading, creating, commenting, labelling,
 * reviewing and merging them.
 */
export interface ThreadsApi {
  /**
   * Reads an issue, pull request or discussion by its ref. Rejects with `NotFoundError` when it does not exist or the
   * credential cannot see it.
   */
  get: (ref: ThreadRef) => Promise<Thread>
  /** Reads several threads, batched where the forge allows. Failures become per-item warnings. */
  getMany: (refs: ThreadRef[]) => Promise<GetManyResult[]>
  /** Lists the threads of a repository. */
  list: (repo: RepoRef, query?: ThreadQuery) => ForgeIterable<Thread>
  /** One page of `list`; pass `cursor` back in `query` to read the next. */
  listPage: (repo: RepoRef, query?: ThreadQuery) => Promise<Page<Thread>>
  /** Lists the events on a thread, such as comments, label changes and state changes. */
  events: (ref: ThreadRef, options?: ListOptions) => ForgeIterable<ForgeEvent>
  /** One page of `events()`. */
  eventsPage: (ref: ThreadRef, options?: ListOptions) => Promise<Page<ForgeEvent>>
  /** Conversation comments. Inline review comments are events, not comments. */
  comments: (ref: ThreadRef, options?: ListOptions) => ForgeIterable<Comment>
  /** One page of `comments()`. */
  commentsPage: (ref: ThreadRef, options?: ListOptions) => Promise<Page<Comment>>
  /** Adds a comment to a thread. */
  comment: (ref: ThreadRef, body: string) => Promise<Comment>
  /**
   * Creates the comment, or edits the one an earlier call with the same `key`
   * left behind. The key is carried in the body as a hidden marker; see
   * {@link commentMarker}. Composed from `comments`, `comment` and
   * `editComment`, so it costs a listing on every call.
   * @param ref The thread to comment on.
   * @param input The `key` that identifies the comment across runs, and its `body`.
   * @example
   * ```ts
   * await provider.threads.upsertComment(ref, { key: 'preview', body: 'Preview: https://pr-42.example.com' })
   * ```
   */
  upsertComment: (ref: ThreadRef, input: UpsertCommentInput) => Promise<UpsertCommentResult>
  /** Replaces the body of a comment. */
  editComment: (ref: CommentRef, body: string) => Promise<Comment>
  /** Deletes a comment. */
  deleteComment: (ref: CommentRef) => Promise<void>
  /** Creates an issue, pull request or discussion. A pull request needs `head` and `base`. */
  create: (repo: RepoRef, input: ThreadCreateInput) => Promise<Thread>
  /** Changes the title, body or other fields of a thread. Fields left out stay as they are. */
  update: (ref: ThreadRef, input: ThreadUpdateInput) => Promise<Thread>
  /** Replaces the thread's labels. */
  setLabels: (ref: ThreadRef, labels: string[]) => Promise<void>
  /** Adds labels, leaving the rest in place. */
  addLabels: (ref: ThreadRef, labels: string[]) => Promise<void>
  /** Removes labels, leaving the rest in place. Labels the thread does not carry are ignored. */
  removeLabels: (ref: ThreadRef, labels: string[]) => Promise<void>
  /** Sets the thread's milestone, by milestone, id or title, or clears it with `undefined`. */
  setMilestone: (ref: ThreadRef, milestone: Milestone | string | undefined) => Promise<void>
  /** Reactions left on the thread or on one of its comments. */
  reactions: (target: ThreadRef | CommentRef, options?: ListOptions) => ForgeIterable<Reaction>
  /** One page of `reactions()`. */
  reactionsPage: (target: ThreadRef | CommentRef, options?: ListOptions) => Promise<Page<Reaction>>
  /**
   * Reacts as the authenticated account, to the thread or to one of its comments.
   * @param target The thread or comment to react to.
   * @param reaction The reaction to leave.
   */
  react: (target: ThreadRef | CommentRef, reaction: ReactionContent) => Promise<void>
  /** Removes the account's reaction from the thread or comment. */
  unreact: (target: ThreadRef | CommentRef, reaction: ReactionContent) => Promise<void>
  /** Moves the thread to another repository, and returns its ref there. */
  transfer: (ref: ThreadRef, repo: RepoRef) => Promise<ThreadRef>
  /** Marks the thread a duplicate of `canonical`, which must be in the same repository on most forges. */
  markDuplicate: (ref: ThreadRef, canonical: ThreadRef) => Promise<void>
  /** Replaces the thread's assignees. */
  setAssignees: (ref: ThreadRef, assignees: Array<string | Actor>) => Promise<void>
  /** Adds reviewers to a pull request. */
  requestReview: (ref: ThreadRef, reviewers: Array<string | Actor>) => Promise<void>
  /** Closes a thread, optionally with a reason. */
  close: (ref: ThreadRef, options?: CloseOptions) => Promise<void>
  /** Reopens a closed thread. */
  reopen: (ref: ThreadRef) => Promise<void>
  /**
   * Merges a pull request. Without a merge method, the repository must allow exactly one.
   * @param ref The pull request to merge.
   * @param options The merge method, the head `sha` to expect and the commit message.
   * @example
   * ```ts
   * await provider.threads.merge(ref, { method: 'squash' })
   * ```
   */
  merge: (ref: ThreadRef, options?: MergeOptions) => Promise<void>
  /** Approves, then merges. The merge method is checked before the approval is sent. */
  approveAndMerge: (ref: ThreadRef, options?: ApproveAndMergeOptions) => Promise<void>
  /** The authenticated account's subscription to the thread. */
  subscription: (ref: ThreadRef) => Promise<SubscriptionState>
  /** Subscribes the account to the notifications of a thread. */
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
  /** One page of `reviews()`. */
  reviewsPage: (ref: ThreadRef, options?: PageOptions) => Promise<Page<Review>>
  /** Creates a review. Without `event` the review is pending where the forge has pending reviews. */
  createReview: (ref: ThreadRef, input: ReviewInput) => Promise<Review>
  /** Submits a pending review. */
  submitReview: (ref: ReviewRef, event: ReviewEvent, body?: string) => Promise<Review>
  /** Approves without merging; `createReview({ event: 'approve' })` with nothing else to say. */
  approve: (ref: ThreadRef, body?: string) => Promise<void>
  /** Files a pull request changes, with a per-file `patch` where the forge returns one. */
  files: (ref: ThreadRef, options?: PageOptions) => ForgeIterable<ChangedFile>
  /** One page of `files()`. */
  filesPage: (ref: ThreadRef, options?: PageOptions) => Promise<Page<ChangedFile>>
  /** Commits on a pull request. */
  commits: (ref: ThreadRef, options?: PageOptions) => ForgeIterable<Commit>
  /** One page of `commits()`. */
  commitsPage: (ref: ThreadRef, options?: PageOptions) => Promise<Page<Commit>>
  /** Resolves a review conversation, by the id on {@link ReviewComment.thread}. */
  resolveReviewThread: (ref: ThreadRef, id: string) => Promise<void>
  /** Reopens a resolved review conversation, by the id on `ReviewComment.thread`. */
  unresolveReviewThread: (ref: ThreadRef, id: string) => Promise<void>
}

/** Reading and reporting the checks on a commit. */
export interface ChecksApi {
  /** Every check on a commit: check runs, commit statuses, jobs or policy evaluations. */
  list: (repo: RepoRef, sha: string) => Promise<Page<Check>>
  /** Writes a commit status, or a check run where the credential can (GitHub app auth). */
  report: (repo: RepoRef, sha: string, input: CheckReportInput) => Promise<Check>
  /** Re-runs a check. Rejects for a `CheckRef.type` the forge cannot re-run. */
  rerun: (ref: CheckRef) => Promise<void>
}

/** Reading CI runs and their jobs. CI is read-only. */
export interface CiApi {
  /** Lists the CI runs of a repository. */
  runs: (repo: RepoRef, query?: CiRunQuery) => ForgeIterable<CiRun>
  /** One page of `runs()`. */
  runsPage: (repo: RepoRef, query?: CiRunQuery) => Promise<Page<CiRun>>
  /** Reads one CI run. */
  run: (ref: CiRunRef) => Promise<CiRun>
  /** Lists the jobs of a CI run. */
  jobs: (ref: CiRunRef, options?: PageOptions) => ForgeIterable<CiJob>
  /** One page of `jobs()`. */
  jobsPage: (ref: CiRunRef, options?: PageOptions) => Promise<Page<CiJob>>
  /** The job's log as it arrives. There is no workflow dispatch: CI is read-only here. */
  log: (ref: CiJobRef) => Promise<ReadableStream<Uint8Array>>
}

/** Files, trees, branches, tags and commits of a repository. */
export interface ContentsApi {
  /**
   * One file's contents. Binary-safe: `content` is a `Uint8Array` unless the
   * forge reports text and `as: 'text'` was asked for. Files past the forge's
   * inline limit (1 MB on GitHub) are read from the raw or blob endpoint
   * instead of failing.
   * @param repo The repository to read from.
   * @param path The path of the file from the repository root.
   * @param options The revision to read, and whether to decode the content as text.
   * @example
   * ```ts
   * const file = await provider.contents.file(repo, 'package.json', { as: 'text' })
   * const manifest = JSON.parse(file.content as string)
   * ```
   */
  file: (repo: RepoRef, path: string, options?: FileOptions) => Promise<FileContent>
  /** One level, or every descendant with `recursive`. Truncated listings carry a `tree_truncated` warning. */
  tree: (repo: RepoRef, options?: TreeOptions) => ForgeIterable<TreeEntry>
  /** One page of `tree()`. */
  treePage: (repo: RepoRef, options?: TreeOptions) => Promise<Page<TreeEntry>>
  /** Lists the branches of a repository. */
  branches: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Branch>
  /** One page of `branches()`. */
  branchesPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Branch>>
  /** Lists the tags of a repository. */
  tags: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Tag>
  /** One page of `tags()`. */
  tagsPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Tag>>
  /** Resolves a branch, tag or sha to a full commit sha; a full sha is returned as is. */
  resolveRef: (repo: RepoRef, ref: string) => Promise<string>
  /** Lists the commits that lead to `ref`, or to the default branch. */
  commits: (repo: RepoRef, query?: CommitQuery) => ForgeIterable<Commit>
  /** One page of `commits()`. */
  commitsPage: (repo: RepoRef, query?: CommitQuery) => Promise<Page<Commit>>
  /** One commit, with its files and stats. */
  commit: (repo: RepoRef, sha: string) => Promise<Commit>
  /** Commits and files between two refs. */
  compare: (repo: RepoRef, base: string, head: string) => Promise<Comparison>
}

/** Reading the releases of a repository and downloading their assets. */
export interface ReleasesApi {
  /** Lists the releases of a repository, including drafts and pre-releases where the credential can see them. */
  list: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Release>
  /** One page of `list()`. */
  listPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Release>>
  /** Reads a release by its ref. */
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

/** Searching issues and pull requests, repositories and commits across the forge. */
export interface SearchApi {
  /**
   * Issues and pull requests across repositories. Fields the forge cannot
   * filter on come back as a `filter_unsupported` warning on the page.
   */
  threads: (query: SearchQuery) => ForgeIterable<Thread>
  /** One page of `threads()`. */
  threadsPage: (query: SearchQuery) => Promise<Page<Thread>>
  /** Searches repositories. */
  repos: (query: RepoSearchQuery) => ForgeIterable<Repo>
  /** One page of `repos()`. */
  reposPage: (query: RepoSearchQuery) => Promise<Page<Repo>>
  /** Commits across repositories, where the forge indexes them. */
  commits: (query: CommitSearchQuery) => ForgeIterable<Commit>
  /** One page of `commits()`. */
  commitsPage: (query: CommitSearchQuery) => Promise<Page<Commit>>
}

/** Reading the security alerts of a repository. */
export interface SecurityAlertsApi {
  /** Lists the security alerts of a repository. */
  list: (repo: RepoRef, options?: SecurityAlertListOptions) => ForgeIterable<SecurityAlert>
  /** One page of `list()`. */
  listPage: (repo: RepoRef, options?: SecurityAlertListOptions) => Promise<Page<SecurityAlert>>
}

/** Repositories, and the labels, milestones and collaborators that belong to them. */
export interface ReposApi {
  /**
   * Reads a repository by its ref. Rejects with `NotFoundError` when it does not exist or the credential cannot see
   * it.
   */
  get: (ref: RepoRef) => Promise<Repo>
  /** The authenticated account's repositories, or the installation's under app auth. */
  list: (options?: RepoQuery) => ForgeIterable<Repo>
  /** One page of `list()`. */
  listPage: (options?: RepoQuery) => Promise<Page<Repo>>
  /** Every label defined on the repository, whether or not a thread carries it. */
  labels: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Label>
  /** One page of `labels()`. */
  labelsPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Label>>
  /** Creates a label in a repository. */
  createLabel: (repo: RepoRef, label: LabelInput) => Promise<Label>
  /** Lists the milestones of a repository. */
  milestones: (repo: RepoRef, options?: MilestoneListOptions) => ForgeIterable<Milestone>
  /** One page of `milestones()`. */
  milestonesPage: (repo: RepoRef, options?: MilestoneListOptions) => Promise<Page<Milestone>>
  /** Lists the collaborators of a repository, with their roles. */
  collaborators: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Collaborator>
  /** One page of `collaborators()`. */
  collaboratorsPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Collaborator>>
  /** One account's role on the repository; `'none'` when it has no access. */
  permissionFor: (repo: RepoRef, actor: string | Actor) => Promise<RepoRole>
  /** Gives an account a role on a repository. */
  addCollaborator: (repo: RepoRef, actor: string | Actor, role: RepoRole) => Promise<void>
  /** Accounts that can be assigned to a thread in the repository. */
  assignableUsers: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Actor>
  /** One page of `assignableUsers()`. */
  assignableUsersPage: (repo: RepoRef, options?: PageOptions) => Promise<Page<Actor>>
  /** Accounts that can be asked to review a given pull request. */
  reviewerCandidates: (ref: ThreadRef, options?: PageOptions) => ForgeIterable<Actor>
  /** One page of `reviewerCandidates()`. */
  reviewerCandidatesPage: (ref: ThreadRef, options?: PageOptions) => Promise<Page<Actor>>
}

/** Options for `repos.milestones()`. */
export interface MilestoneListOptions extends PageOptions {
  /**
   * @default 'open'
   */
  state?: 'open' | 'closed' | 'all'
}

/** The installations of the app that the provider authenticates as. */
export interface InstallationsApi {
  /** Lists the installations of the app. */
  list: (options?: PageOptions) => ForgeIterable<Installation>
  /** One page of `list()`. */
  listPage: (options?: PageOptions) => Promise<Page<Installation>>
  /** Reads one installation. */
  get: (installation: Installation | string) => Promise<Installation>
  /** Mints (or reuses a cached) installation token. */
  token: (installation: Installation | string) => Promise<InstallationToken>
  /** Lists the repositories that an installation can access. */
  repos: (installation: Installation | string, options?: PageOptions) => ForgeIterable<Repo>
  /** One page of `repos()`. */
  reposPage: (installation: Installation | string, options?: PageOptions) => Promise<Page<Repo>>
  /** Provider authenticated as one installation, sharing this instance's app credentials. */
  provider: (installation: Installation | string) => ForgeProvider
  /** One provider per installation. */
  providers: () => AsyncIterable<{ installation: Installation, provider: ForgeProvider }>
}

/** Receiving webhook deliveries, and managing the hooks registered on the forge. */
export interface WebhooksApi {
  /** Checks a delivery's signature or token against the secret. */
  verify: (delivery: WebhookDelivery) => Promise<boolean>
  /**
   * Verifies the delivery, then translates it into normalised events.
   * @param delivery The headers and the raw body of the request, exactly as received.
   * @example
   * ```ts
   * const events = await provider.webhooks.ingest({
   *   headers: request.headers,
   *   body: await request.text(),
   * })
   * ```
   */
  ingest: (delivery: WebhookDelivery) => Promise<ForgeEvent[]>
  /** Normalised kinds and actions this provider can deliver, whatever a hook is subscribed to. */
  readonly events: WebhookEventType[]
  /** Hooks on a repository, or on an organisation or workspace when `target` is a namespace ref. */
  list: (target: RepoRef, options?: PageOptions) => ForgeIterable<Webhook>
  /** One page of `list()`. */
  listPage: (target: RepoRef, options?: PageOptions) => Promise<Page<Webhook>>
  /** Registers a webhook. */
  create: (target: RepoRef, input: WebhookInput) => Promise<Webhook>
  /** Changes a webhook. */
  update: (ref: WebhookRef, update: WebhookUpdate) => Promise<Webhook>
  /** Deletes a webhook. */
  delete: (ref: WebhookRef) => Promise<void>
  /** Replaces the signing secret in place. `false` where the forge can only do it by recreating the hook. */
  rotateSecret: (ref: WebhookRef, secret: string) => Promise<Webhook>
  /** Lists the recent deliveries of a webhook. */
  deliveries: (ref: WebhookRef, options?: PageOptions) => ForgeIterable<WebhookDeliveryRecord>
  /** One page of `deliveries()`. */
  deliveriesPage: (ref: WebhookRef, options?: PageOptions) => Promise<Page<WebhookDeliveryRecord>>
  /** Sends a past delivery again. */
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

/** Options for `sources.subscribe()`. */
export interface SubscribeOptions {
  /** Resume after this cursor, as yielded by an earlier {@link SubscriptionItem}. */
  cursor?: string
  /** Aborting closes the connection and ends iteration without an error. */
  signal?: AbortSignal
}

/** One item from a push subscription. */
export interface SubscriptionItem {
  event: ForgeEvent
  /** Opaque position after `event`; persist it and pass it back to resume. */
  cursor: string
}

/** Reading accounts. */
export interface UsersApi {
  /** Reads an account by login, without needing a credential where the forge allows it. */
  get: (login: string) => Promise<User>
  /**
   * The account the provider's credential belongs to.
   * @example
   * ```ts
   * const me = await provider.users.me()
   * console.log(me.login)
   * ```
   */
  me: () => Promise<User>
}

/** Ways to receive events: polling, webhooks and push subscriptions. */
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

/** A connection to one forge, with its identity, its capabilities and the namespaces of operations. */
export interface ForgeProvider {
  /**
   * Requests endpoints relative to `baseUrl` or absolute HTTP(S) URLs.
   * Other origins omit default headers and provider credentials; explicit headers apply.
   */
  readonly request: ForgeRequest
  /** The forge this provider sends requests to; matches `forge` on every ref it returns. */
  readonly forge: ForgeKind
  readonly instance: ForgeInstance
  readonly baseUrl: string
  /** The `auth.type` the provider was created with; `'anonymous'` when it sends no credentials. */
  readonly authKind: AuthKind
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
   * @param verb The operation, named by its path on the provider, such as `threads.comment`.
   * @param kind The thread kind, for an operation whose support differs by kind.
   * @example
   * ```ts
   * if (provider.can('threads.merge')) {
   *   await provider.threads.merge(ref)
   * }
   * ```
   */
  can: (verb: ForgeVerb, kind?: ThreadKind | SecurityAlertKind) => boolean
  /**
   * How well `verb` is supported: `true`, `'experimental'`, `'emulated'` or
   * `false`, for `kind` where support differs by kind. `can()` is `true` for
   * every level but `false`. Without `kind`, a per-kind verb reports its
   * strongest level across kinds.
   * @param verb The operation, named by its path on the provider, such as `threads.comment`.
   * @param kind The thread kind, for an operation whose support differs by kind.
   */
  support: (verb: ForgeVerb, kind?: ThreadKind | SecurityAlertKind) => Support
  /**
   * The web page for `target`, built without a request; `undefined` when the forge has no such page.
   * @param target What to link to: a repository, thread, comment, release, file or comparison.
   */
  urlFor: (target: UrlTarget) => string | undefined
  /**
   * Token scopes or app permissions `verb` needs on this forge, as data for a
   * consent screen or a 403 explanation. Nothing in the library reads it, and
   * an unmapped verb returns `{}`.
   * @param verb The operation, named by its path on the provider.
   */
  scopesFor: (verb: ForgeVerb) => VerbScopes
  /**
   * Reads a web or SSH clone URL on this provider's instance into refs; `undefined` for anything else.
   * @param url The URL to read.
   */
  parseUrl: (url: string | URL) => ParsedForgeUrl | undefined
  /**
   * How to mention `ref` in Markdown on this forge (`#42`, `!42`,
   * `acme/widgets#42`), short when written in `from`; the thread URL where the
   * forge has no reference syntax.
   * @param ref The thread to mention.
   * @param options The repository the reference is written in, so that a reference within it is short.
   */
  referenceTo: (ref: ThreadRef, options?: ReferenceOptions) => string | undefined
}

/**
 * Lazily constructed provider. `createForges` calls `create()`; nothing
 * touches the network before that.
 */
export interface ForgeProviderFactory<T extends ForgeProvider = ForgeProvider> {
  readonly forge: ForgeKind
  /** The provider has not reached parity; see `ForgeCapabilities.experimental`. */
  readonly experimental?: true
  /** Creates the provider. Nothing touches the network before this. */
  create: () => T
}

/** A registry of providers that routes each ref to the provider it belongs to. */
export interface Forges {
  readonly providers: ForgeProvider[]
  /** First provider for `forge`, optionally narrowed to a single instance host. */
  get: (forge: ForgeKind, instance?: ForgeInstance) => ForgeProvider | undefined
  /** Every provider for a forge. */
  all: (forge: ForgeKind) => ForgeProvider[]
  /** The provider a ref belongs to, by `forge` and `instance`. */
  for: (ref: ForgeOrigin) => ForgeProvider | undefined
  /** The provider whose instance serves `url`. */
  forUrl: (url: string | URL) => ForgeProvider | undefined
  /** Reads a web or SSH clone URL on any registered instance. */
  parseUrl: (url: string | URL) => (ParsedForgeUrl & { provider: ForgeProvider }) | undefined
  /** Notifications from every registered provider, provider by provider. */
  notifications: {
    /** Lists the notifications of every provider, provider by provider. */
    list: (options?: Omit<NotificationListOptions, 'cursor'>) => ForgeIterable<Notification>
  }
  /** Reads routed to the provider each ref belongs to; an unregistered origin throws `UnknownForgeError`. */
  repos: {
    /** Reads a repository from the provider it belongs to. */
    get: (ref: RepoRef) => Promise<Repo>
  }
  threads: {
    /** Reads a thread from the provider it belongs to. */
    get: (ref: ThreadRef) => Promise<Thread>
    /** Grouped per provider, results in input order. An unregistered origin is a per-item warning. */
    getMany: (refs: ThreadRef[]) => Promise<GetManyResult[]>
  }
  releases: {
    /** Lists the releases of a repository. */
    list: (repo: RepoRef, options?: PageOptions) => ForgeIterable<Release>
    /** The latest release of a repository, if any. */
    latest: (repo: RepoRef) => Promise<Release | undefined>
  }
  securityAlerts: {
    list: SecurityAlertsApi['list']
  }
  /**
   * Searches every provider that supports search, reading pages as the
   * iteration needs them and merging by `updatedAt`, or by `createdAt` with
   * `sort: 'created'`, newest first unless `direction: 'asc'`. Each provider is
   * asked to sort the same way; results from one that cannot are only in order
   * within each page. A provider that rejects adds a `search_failed` warning
   * and no further items.
   */
  search: {
    /** Searches issues and pull requests on every provider that supports search. */
    threads: (query?: Omit<SearchQuery, 'cursor' | 'sort'> & { sort?: 'created' | 'updated' }) => ForgeIterable<Thread>
    /** Searches repositories on every provider that supports search. */
    repos: (query?: Omit<RepoSearchQuery, 'cursor' | 'sort'> & { sort?: 'created' | 'updated' }) => ForgeIterable<Repo>
  }
}

interface SearchOrder {
  sort: 'created' | 'updated'
  direction: 'asc' | 'desc'
}

interface SearchSource<T> {
  provider: ForgeProvider
  items: T[]
  cursor?: Cursor
  done: boolean
}

/** Items without the sorted timestamp sort last within a page and are yielded as soon as they lead it. */
function mergeByTime<Q extends Partial<SearchOrder>, T extends { createdAt?: Date, updatedAt?: Date }>(
  providers: ForgeProvider[],
  verb: ForgeVerb,
  query: Q,
  read: (provider: ForgeProvider, query: Q & SearchOrder & { cursor: Cursor | undefined }) => Promise<Page<T>>,
): ForgeIterable<T> {
  const order: SearchOrder = { sort: query.sort === 'created' ? 'created' : 'updated', direction: query.direction === 'asc' ? 'asc' : 'desc' }
  const sign = order.direction === 'asc' ? 1 : -1
  const rank = (item: T, missing: number) => {
    const time = (order.sort === 'created' ? item.createdAt : item.updatedAt)?.getTime()
    return time === undefined ? missing : sign * time
  }
  return forgeIterable(async function* (warn) {
    const sources: Array<SearchSource<T>> = providers
      .filter(provider => provider.can(verb))
      .map(provider => ({ provider, items: [], done: false }))

    async function fill(source: SearchSource<T>): Promise<void> {
      while (!source.items.length && !source.done) {
        try {
          const page = await read(source.provider, { ...query, ...order, cursor: source.cursor })
          page.warnings?.forEach(warn)
          source.items = page.items.toSorted((a, b) => rank(a, Infinity) - rank(b, Infinity) || 0)
          source.cursor = page.cursor
          source.done = !page.cursor?.nextUrl && !page.cursor?.token
        }
        catch (error) {
          warn(toWarning('search_failed', error, `${source.provider.forge}:${source.provider.instance}`))
          source.done = true
        }
      }
    }

    await Promise.all(sources.map(fill))
    while (true) {
      let next: SearchSource<T> | undefined
      let best = Infinity
      for (const source of sources) {
        const head = source.items[0]
        if (!head) {
          continue
        }
        const key = rank(head, -Infinity)
        if (!next || key < best) {
          next = source
          best = key
        }
      }
      if (!next) {
        return
      }
      yield next.items.shift()!
      await fill(next)
    }
  })
}

/**
 * Combines providers into a registry. Pass factories such as `github()`, or providers that already exist.
 * @param factories Factories such as `github()`, or providers that already exist.
 * @example
 * ```ts
 * import { createForges, github, gitlab } from 'forges'
 *
 * const forges = createForges([
 *   github({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } }),
 *   gitlab(),
 * ])
 *
 * const repo = await forges.repos.get({ forge: 'github', instance: 'github.com', owner: 'danielroe', name: 'forges' })
 * ```
 */
export function createForges(factories: Array<ForgeProviderFactory | ForgeProvider>): Forges {
  const providers = factories.map(factory => 'create' in factory ? factory.create() : factory)
  const seen = new Set<string>()
  for (const provider of providers) {
    const key = `${provider.forge}:${provider.instance}`
    if (seen.has(key)) {
      throw new TypeError(`Two providers are registered for ${provider.forge} on ${provider.instance}; pass \`instance\` to tell them apart`)
    }
    seen.add(key)
  }
  const find = (ref: ForgeOrigin) => providers.find(provider => provider.forge === ref.forge && provider.instance === ref.instance)
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
      threads: (query = {}) => mergeByTime(providers, 'search.threads', query, (provider, page) => provider.search.threadsPage(page)),
      repos: (query = {}) => mergeByTime(providers, 'search.repos', query, (provider, page) => provider.search.reposPage(page)),
    },
    get: (forge, instance) => providers.find(
      provider => provider.forge === forge && (!instance || provider.instance === instance),
    ),
    all: forge => providers.filter(provider => provider.forge === forge),
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
              const iterable = provider.notifications.list({ ...options, cursor: undefined })
              try {
                yield* iterable
              }
              catch (error) {
                warnings.push({ ...toWarning('notifications_failed', error), subject: `${provider.forge}:${provider.instance}` })
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
