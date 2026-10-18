import type { FetcherOptions, FetchLike, ForgeRequest } from './fetch.ts'
import type {
  Actor,
  AddCollaboratorResult,
  BaseOptions,
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
  CodeMatch,
  CodeSearchQuery,
  Collaborator,
  Comment,
  CommentRef,
  Commit,
  CommitComment,
  CommitCommentRef,
  CommitFilesInput,
  CommitQuery,
  CommitRef,
  CommitSearchQuery,
  CompareOptions,
  Comparison,
  Contributor,
  ContributorQuery,
  ContributorStats,
  Cursor,
  DownloadAssetOptions,
  EventFeedOptions,
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
  IssueType,
  Label,
  LabelInput,
  ListOptions,
  MergeOptions,
  MergeResult,
  Milestone,
  Notification,
  NotificationListOptions,
  NotificationRef,
  OwnerRepoQuery,
  Page,
  PageOptions,
  RateLimit,
  Reaction,
  ReactionContent,
  Release,
  ReleaseAssetRef,
  ReleaseInput,
  ReleaseRef,
  ReleaseUpdate,
  Repo,
  RepoQuery,
  RepoRef,
  RepoRole,
  RepoSearchQuery,
  RepoTemplate,
  RepoTemplateOptions,
  ResolvedThreadRef,
  Review,
  ReviewComment,
  ReviewEvent,
  ReviewInput,
  ReviewRef,
  SecurityAlert,
  SecurityAlertKind,
  SecurityAlertListOptions,
  SubscriptionState,
  Support,
  Tag,
  Team,
  TeamRef,
  TextLimits,
  Thread,
  ThreadInput,
  ThreadKind,
  ThreadQuery,
  ThreadRef,
  ThreadSearchQuery,
  ThreadUpdate,
  TreeEntry,
  TreeOptions,
  UpdateBranchOptions,
  UpdateBranchResult,
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
import type { ParsedForgeUrl, ParsedReference, ParseReferencesOptions, ReferenceOptions, UrlTarget } from './web.ts'
import { UnknownForgeError } from './errors.ts'
import { forgeIterable, toWarning } from './utils.ts'
import { routeForges } from './web.ts'

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
  /**
   * The `user-agent` header. Defaults to `forges`, except in a browser, which sends its own.
   * Setting it in a browser can trigger a CORS preflight that some forges reject.
   */
  userAgent?: string
  /**
   * Version of the forge instance, when the caller already knows it. Gates
   * version-dependent capabilities without the network call
   * `refreshCapabilities()` makes.
   */
  instanceVersion?: string
  /** Every write, including a mutating `request()`, rejects with `ReadOnlyError` and reports `false`. */
  readOnly?: boolean
  /** Called before a request is retried after a rate limit that names a wait of at most a minute, with the wait in milliseconds. */
  onRetry?: FetcherOptions['onRetry']
  /**
   * Called with the rate limit of every API response that reports one, so that you can follow the budget without
   * reading `page.rateLimit`. `rateLimit.resource` names the budget where the forge has several.
   */
  onRateLimit?: FetcherOptions['onRateLimit']
}

/** Per-thread-kind support. */
export type PerKind = Record<ThreadKind, Support>

/** Support per security alert kind. */
export type AlertSupport = Record<'dependency' | 'code_scanning' | 'secret' | 'advisory', Support>

/**
 * What a provider supports, operation by operation. It is computed without a request, and
 * `refreshCapabilities()` refines it with the instance version. Each verb has an entry at its
 * path on the provider, and the [capability matrix](/reference/capability-matrix) lists them
 * for every forge.
 */
export interface ForgeCapabilities {
  /** Instance version the capabilities were computed for, when known. */
  version?: string
  /** The forge's API as a whole is unstable, so the provider can change with it. */
  experimental?: true
  sources: {
    /** Support for `sources.stream()`, a long-lived push stream; see {@link SourcesApi}. */
    stream: Support
  }
  repos: {
    /** Support for `repos.get()`. */
    get: Support
    /** Support for `repos.list()`. */
    list: Support
    /** Support for `repos.byOwner()`. */
    byOwner: Support
    /** Support for `repos.labels()`. */
    labels: Support
    /** Support for `repos.createLabel()`. */
    createLabel: Support
    /** Support for `repos.milestones()`. */
    milestones: Support
    /** Support for `repos.issueTypes()`. */
    issueTypes: Support
    /** Support for `repos.collaborators()`. */
    collaborators: Support
    /** Support for `repos.contributors()`. */
    contributors: Support
    /** Support for `repos.contributorStats()`. */
    contributorStats: Support
    /** Support for `repos.templates()`. */
    templates: Support
    /** Support for `repos.permissionFor()`. */
    permissionFor: Support
    /** Support for `repos.addCollaborator()`. */
    addCollaborator: Support
    /** Support for `repos.assignableUsers()`. */
    assignableUsers: Support
    /** Support for `repos.reviewerCandidates()`. */
    reviewerCandidates: Support
    /** Support for `repos.events()`. */
    events: Support
  }
  users: {
    /** Support for `users.get()`. */
    get: Support
    /** Support for `users.me()`. */
    me: Support
    /** Support for `users.sponsorable()`. */
    sponsorable: Support
    /** Support for `users.events()`. */
    events: Support
    /** Support for `users.block()`. */
    block: Support
    /** Support for `users.unblock()`. */
    unblock: Support
  }
  /** An organisation's teams and their members, where the forge has teams, and the accounts it blocks. */
  orgs: {
    /** Support for `orgs.teams()`. */
    teams: Support
    /** Support for `orgs.teamMembers()`. */
    teamMembers: Support
    /** Support for `orgs.block()`. */
    block: Support
    /** Support for `orgs.unblock()`. */
    unblock: Support
  }
  threads: {
    /** Support for `threads.get()`, per thread kind. */
    get: PerKind
    /** Support for `threads.list()`, per thread kind. */
    list: PerKind
    /** Support for `threads.getMany()`. */
    getMany: Support
    /** Support for `threads.closingIssues()`. */
    closingIssues: Support
    /** Support for `threads.closingPullRequests()`. */
    closingPullRequests: Support
    /** Support for `threads.events()`, per thread kind. */
    events: PerKind
    /** Support for `threads.comments()`, per thread kind. */
    comments: PerKind
    /** Support for `threads.getComment()`, per thread kind. */
    getComment: PerKind
    /** Support for `threads.createComment()`, per thread kind. */
    createComment: PerKind
    /** Support for `threads.updateComment()`, per thread kind. */
    updateComment: PerKind
    /** Support for `threads.deleteComment()`, per thread kind. */
    deleteComment: PerKind
    /** Support for `threads.hideComment()`, per thread kind. */
    hideComment: PerKind
    /** Support for `threads.unhideComment()`, per thread kind. */
    unhideComment: PerKind
    /** Support for `threads.reactions()`, per thread kind. */
    reactions: PerKind
    /** Support for `threads.react()`, per thread kind. */
    react: PerKind
    /** Support for `threads.unreact()`, per thread kind. */
    unreact: PerKind
    /** Support for `threads.create()`, per thread kind. */
    create: PerKind
    /** Support for `threads.update()`, per thread kind. */
    update: PerKind
    /** Support for `threads.close()`, per thread kind. */
    close: PerKind
    /** Support for `threads.reopen()`, per thread kind. */
    reopen: PerKind
    /** Support for `threads.lock()`, per thread kind. */
    lock: PerKind
    /** Support for `threads.unlock()`, per thread kind. */
    unlock: PerKind
    /** Support for `threads.setLabels()`, per thread kind. */
    setLabels: PerKind
    /** Support for `threads.addLabels()`, per thread kind. */
    addLabels: PerKind
    /** Support for `threads.removeLabels()`, per thread kind. */
    removeLabels: PerKind
    /** Support for `threads.setMilestone()`, per thread kind. */
    setMilestone: PerKind
    /** Support for `threads.setIssueType()`, per thread kind. */
    setIssueType: PerKind
    /** Support for `threads.setAssignees()`, per thread kind. */
    setAssignees: PerKind
    /** Support for `threads.requestReview()`, per thread kind. */
    requestReview: PerKind
    /** Support for `threads.merge()`. */
    merge: Support
    /** Support for `threads.updateBranch()`. */
    updateBranch: Support
    /** Support for `threads.transfer()`. */
    transfer: Support
    /** Support for `threads.markDuplicate()`. */
    markDuplicate: Support
    /** Support for `threads.subscription()`, per thread kind. */
    subscription: PerKind
    /** Support for `threads.subscribe()`, per thread kind. */
    subscribe: PerKind
    /** Support for `threads.unsubscribe()`, per thread kind. */
    unsubscribe: PerKind
    /** Support for `threads.checks()` and `Thread.checks`, per thread kind. */
    checks: PerKind
    /** Support for `threads.files()`. */
    files: Support
    /** Support for `threads.commits()`. */
    commits: Support
    /** Support for `threads.reviews()`. `'emulated'` where reviews are synthesised from approvals or votes. */
    reviews: Support
    /** Support for `threads.getReview()`. */
    getReview: Support
    /** Support for `threads.createReview()`. Where reviews are emulated, it covers only the events the forge's approval endpoint can express. */
    createReview: Support
    /** Support for `threads.submitReview()`. */
    submitReview: Support
    /** Support for `threads.approve()`. */
    approve: Support
    /** Support for `threads.replyToReviewComment()`. */
    replyToReviewComment: Support
    /** Support for `threads.resolveReviewThread()`. */
    resolveReviewThread: Support
    /** Support for `threads.unresolveReviewThread()`. */
    unresolveReviewThread: Support
  }
  notifications: {
    /** Support for `notifications.list()`. */
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
  installations: {
    /** Support for `installations.list()`. */
    list: Support
    /** Support for `installations.get()`. */
    get: Support
    /** Support for `installations.token()`. */
    token: Support
    /** Support for `installations.repos()`. */
    repos: Support
    /** Support for `installations.provider()`. */
    provider: Support
    /** Support for `installations.providers()`. */
    providers: Support
  }
  checks: {
    /** Support for `checks.list()`. */
    list: Support
    /** Support for `checks.get()`. */
    get: Support
    /** Support for `checks.report()`. It writes a commit status unless the credential can write check runs. */
    report: Support
    /** Support for `checks.rerun()`. */
    rerun: Support
  }
  ci: {
    /** Support for `ci.runs()`. */
    runs: Support
    /** Support for `ci.getRun()`. */
    getRun: Support
    /** Support for `ci.jobs()`. */
    jobs: Support
    /** Support for `ci.getJob()`. */
    getJob: Support
    /** Support for `ci.log()`. `false` where job logs are not reachable over the API. */
    log: Support
    /** Support for `ci.rerunFailed()`. */
    rerunFailed: Support
  }
  contents: {
    /** Support for `contents.getFile()`. */
    getFile: Support
    /** Support for `contents.tree()`. `'emulated'` where recursion is walked level by level. */
    tree: Support
    /** Support for `contents.branches()`. */
    branches: Support
    /** Support for `contents.tags()`. */
    tags: Support
    /** Support for `contents.resolveRef()`. */
    resolveRef: Support
    /** Support for `contents.compare()`. */
    compare: Support
    /** Support for `contents.commitFiles()`. */
    commitFiles: Support
  }
  commits: {
    /** Support for `commits.list()`. */
    list: Support
    /** Support for `commits.get()`. */
    get: Support
    /** Support for `commits.comments()`. */
    comments: Support
    /** Support for `commits.getComment()`. */
    getComment: Support
    /** Support for `commits.createComment()`. */
    createComment: Support
    /** Support for `commits.updateComment()`. */
    updateComment: Support
    /** Support for `commits.deleteComment()`. */
    deleteComment: Support
    /** Support for `commits.hideComment()`. */
    hideComment: Support
    /** Support for `commits.unhideComment()`. */
    unhideComment: Support
  }
  releases: {
    /** Support for `releases.list()`. */
    list: Support
    /** Support for `releases.get()`. */
    get: Support
    /** Support for `releases.latest()`. */
    latest: Support
    /** Support for `releases.getByTag()`. */
    getByTag: Support
    /** Support for `releases.downloadAsset()`. */
    downloadAsset: Support
    /** Support for `releases.create()`. */
    create: Support
    /** Support for `releases.update()`. */
    update: Support
  }
  /** Receiving deliveries and managing registered webhooks. */
  webhooks: {
    /** Support for `webhooks.verify()`. */
    verify: Support
    /** Support for `webhooks.ingest()`. */
    ingest: Support
    /** Support for `webhooks.list()`. */
    list: Support
    /** Support for `webhooks.create()`. */
    create: Support
    /** Support for `webhooks.update()`. */
    update: Support
    /** Support for `webhooks.delete()`. */
    delete: Support
    /** Support for `webhooks.rotateSecret()`. */
    rotateSecret: Support
    /** Support for `webhooks.deliveries()`. */
    deliveries: Support
    /** Support for `webhooks.redeliver()`. */
    redeliver: Support
  }
  search: {
    /** Support for `search.threads()`. */
    threads: Support
    /** Support for `search.repos()`. */
    repos: Support
    /** Support for `search.commits()`. */
    commits: Support
    /** Support for `search.code()`. */
    code: Support
  }
  securityAlerts: {
    /** Support for `securityAlerts.list()`, per alert kind. */
    list: AlertSupport
  }
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

/**
 * A listing: iterate it to read every item, or call `page()` to read one page.
 * @example
 * ```ts
 * const first = await provider.threads.comments(ref, { perPage: 20 }).page()
 * const next = first.cursor && await provider.threads.comments(ref, { perPage: 20, cursor: first.cursor }).page()
 * ```
 */
export interface ForgeListing<T> extends ForgeIterable<T> {
  /** Reads one page: the first, or the one after the `cursor` the listing was called with. */
  page: () => Promise<Page<T>>
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
export interface BulkNotificationOptions extends BaseOptions {
  /** Limit to one repository. */
  repo?: RepoRef
  /** Only notifications updated before this time. */
  before?: Date
}

/** Reading and clearing the notifications of the authenticated account. */
export interface NotificationsApi {
  /** Lists the account's notifications. */
  list: (options?: NotificationListOptions) => ForgeListing<Notification>
  /** Marks a notification as read. */
  markRead: (ref: NotificationRef, options?: BaseOptions) => Promise<void>
  /** Marks a notification as done, which clears it from the inbox where the forge has that state. */
  markDone: (ref: NotificationRef, options?: NotificationWriteOptions) => Promise<void>
  /** Stops notifications for the notification's thread, and on some forges also clears the notification. */
  unsubscribe: (ref: NotificationRef, options?: NotificationWriteOptions) => Promise<void>
  /** Marks every notification as read, or those of one repository. */
  markAllRead: (options?: BulkNotificationOptions) => Promise<void>
  /** Marks every notification as done, or those of one repository. */
  markAllDone: (options?: BulkNotificationOptions) => Promise<void>
  /** The number of unread notifications. */
  unreadCount: (options?: BaseOptions) => Promise<number>
}

/** Options for changing one notification. */
export interface NotificationWriteOptions extends BaseOptions {
  /**
   * The thread the notification points at, when the caller already holds it.
   * Providers that would otherwise look it up skip that request.
   */
  thread?: ThreadRef
}

/** Why a thread was closed. */
export type CloseReason = 'completed' | 'not_planned' | 'duplicate'

/** Options for `threads.close()`. */
export interface CloseOptions extends BaseOptions {
  /**
   * Mapped to the forge's own reason where it has one; forges without close
   * reasons close the thread without one.
   */
  reason?: CloseReason
  /** Forge-native reason, sent as is; takes precedence over `reason`. */
  reasonRaw?: string
}

/** Why a conversation was locked. */
export type LockReason = 'off_topic' | 'too_heated' | 'resolved' | 'spam'

/** Options for `threads.lock()`. */
export interface LockOptions extends BaseOptions {
  /** Forges without lock reasons lock the conversation without one. */
  reason?: LockReason
}

/** Why a comment was hidden. */
export type HideCommentReason = 'abuse' | 'duplicate' | 'low_quality' | 'off_topic' | 'outdated' | 'resolved' | 'spam'

/**
 * Issues, pull requests and the other kinds of discussion: reading, creating, commenting, labelling,
 * reviewing and merging them.
 */
export interface ThreadsApi {
  /**
   * Reads an issue, pull request or discussion by its ref. Rejects with `NotFoundError` when it does not exist or the
   * credential cannot see it.
   */
  get: (ref: ThreadRef, options?: BaseOptions) => Promise<Thread>
  /**
   * Reads several threads, batched where the forge allows. Failures become per-item warnings, except a rate limit
   * (`RateLimitedError`) or a rejected credential (`TokenRevokedError`), which reject the call.
   */
  getMany: (refs: ThreadRef[], options?: BaseOptions) => Promise<GetManyResult[]>
  /** Lists the threads of a repository. */
  list: (repo: RepoRef, query?: ThreadQuery) => ForgeListing<Thread>
  /**
   * Lists the issues that a pull request closes when it merges, such as those its description names after `Fixes`.
   * They can be in other repositories. GitHub also lists the issues linked to the pull request by hand.
   * @example
   * ```ts
   * for await (const issue of provider.threads.closingIssues(pull)) {
   *   console.log(`#${issue.ref.number} ${issue.title}`)
   * }
   * ```
   */
  closingIssues: (ref: ThreadRef, options?: PageOptions) => ForgeListing<Thread>
  /** Lists the pull requests that close an issue when they merge, whether they are open, closed or merged. */
  closingPullRequests: (ref: ThreadRef, options?: PageOptions) => ForgeListing<Thread>
  /** Lists the events on a thread, such as comments, label changes and state changes. */
  events: (ref: ThreadRef, options?: ListOptions) => ForgeListing<ForgeEvent>
  /** Conversation comments. Inline review comments are events, not comments. */
  comments: (ref: ThreadRef, options?: ListOptions) => ForgeListing<Comment>
  /**
   * Reads one conversation comment, as `comments()` lists them, so not an inline review comment. Where the forge has
   * no endpoint for it (`capabilities.threads.getComment` is `'emulated'`), it lists the comments of the thread page by page
   * until the id matches, which costs a request for each page read.
   */
  getComment: (ref: CommentRef, options?: BaseOptions) => Promise<Comment>
  /**
   * Adds a comment to a thread. A repeat posts a second comment; to make it safe to retry, mark the body with
   * `withCommentMarker()` and retry with `upsertComment()`, both from `forges/helpers`.
   * @example
   * ```ts
   * await provider.threads.createComment(ref, 'Deployed to staging')
   * ```
   */
  createComment: (ref: ThreadRef, body: string, options?: BaseOptions) => Promise<Comment>
  /** Replaces the body of a comment. */
  updateComment: (ref: CommentRef, body: string, options?: BaseOptions) => Promise<Comment>
  /** Deletes a comment. A repeat can reject with `NotFoundError` once the comment is gone. */
  deleteComment: (ref: CommentRef, options?: BaseOptions) => Promise<void>
  /**
   * Hides a comment behind a note of the reason, as GitHub does when it minimises a comment. A repeat leaves it hidden.
   * @example
   * ```ts
   * await provider.threads.hideComment(comment.ref, 'spam')
   * ```
   */
  hideComment: (ref: CommentRef, reason: HideCommentReason, options?: BaseOptions) => Promise<void>
  /** Shows a hidden comment again. A repeat leaves it shown. */
  unhideComment: (ref: CommentRef, options?: BaseOptions) => Promise<void>
  /**
   * Creates an issue, pull request or discussion. A pull request needs `head` and `base`. A repeat creates a second
   * thread, though most forges reject a second open pull request from the same `head` to the same `base`.
   */
  create: (repo: RepoRef, input: ThreadInput, options?: BaseOptions) => Promise<Thread>
  /**
   * Changes the title, body, state, labels or assignees of a thread. Fields left out stay as they are.
   * This is one request where the forge accepts every field together. Elsewhere it makes the same calls as
   * `close()`, `setLabels()` and `setAssignees()`, so a failed call can leave earlier fields changed.
   * A field the forge cannot set on this kind of thread throws `UnsupportedOperationError` before anything is written.
   * @example
   * ```ts
   * await provider.threads.update(ref, { state: 'closed', labels: ['wontfix'], assignees: [] })
   * ```
   */
  update: (ref: ThreadRef, input: ThreadUpdate, options?: BaseOptions) => Promise<Thread>
  /**
   * Replaces the thread's labels.
   * @returns The labels the thread carries afterwards. GitLab and Azure DevOps report only their names.
   */
  setLabels: (ref: ThreadRef, labels: string[], options?: BaseOptions) => Promise<Label[]>
  /**
   * Adds labels, leaving the rest in place.
   * @returns The labels the thread carries afterwards. GitLab reports only their names.
   */
  addLabels: (ref: ThreadRef, labels: string[], options?: BaseOptions) => Promise<Label[]>
  /**
   * Removes labels, leaving the rest in place. Labels the thread does not carry are ignored.
   * @returns The labels the thread carries afterwards. GitLab reports only their names. Forgejo, Gitea and Gitee read the labels after removing them, and GitHub reads them when it removes none.
   */
  removeLabels: (ref: ThreadRef, labels: string[], options?: BaseOptions) => Promise<Label[]>
  /**
   * Sets the thread's milestone, by milestone, id or title, or clears it with `undefined`.
   * @returns The milestone the thread is in afterwards, or `undefined` once it is cleared.
   */
  setMilestone: (ref: ThreadRef, milestone: Milestone | string | undefined, options?: BaseOptions) => Promise<Milestone | undefined>
  /**
   * Sets the issue's type, by issue type or name, or clears it with `undefined`. GitHub leaves the type as it was,
   * without an error, when the account cannot push to the repository, so compare the result with what you asked for.
   * @returns The type the issue has afterwards, or `undefined` once it is cleared.
   * @example
   * ```ts
   * const bug = (await provider.repos.issueTypes(repo)).find(type => type.name === 'Bug')
   * await provider.threads.setIssueType(ref, bug)
   * ```
   */
  setIssueType: (ref: ThreadRef, issueType: IssueType | string | undefined, options?: BaseOptions) => Promise<IssueType | undefined>
  /** Reactions left on the thread or on one of its comments. */
  reactions: (target: ThreadRef | CommentRef, options?: ListOptions) => ForgeListing<Reaction>
  /**
   * Reacts as the authenticated account, to the thread or to one of its comments.
   * @param target The thread or comment to react to.
   * @param reaction The reaction to leave.
   */
  react: (target: ThreadRef | CommentRef, reaction: ReactionContent, options?: BaseOptions) => Promise<void>
  /** Removes the account's reaction from the thread or comment. */
  unreact: (target: ThreadRef | CommentRef, reaction: ReactionContent, options?: BaseOptions) => Promise<void>
  /** Moves the thread to another repository, and returns its ref there. A repeat can reject once the thread has moved. */
  transfer: (ref: ThreadRef, repo: RepoRef, options?: BaseOptions) => Promise<ResolvedThreadRef>
  /** Marks the thread a duplicate of `canonical`, which must be in the same repository on most forges. */
  markDuplicate: (ref: ThreadRef, canonical: ThreadRef, options?: BaseOptions) => Promise<void>
  /**
   * Replaces the thread's assignees.
   * @returns The accounts assigned afterwards.
   */
  setAssignees: (ref: ThreadRef, assignees: Array<string | Actor>, options?: BaseOptions) => Promise<Actor[]>
  /** Adds reviewers to a pull request. */
  requestReview: (ref: ThreadRef, reviewers: Array<string | Actor>, options?: BaseOptions) => Promise<void>
  /**
   * Closes a thread, optionally with a reason.
   * @returns The thread, closed. Tangled reads the thread after writing the state record.
   */
  close: (ref: ThreadRef, options?: CloseOptions) => Promise<Thread>
  /**
   * Reopens a closed thread.
   * @returns The thread, open. Tangled reads the thread after writing the state record.
   */
  reopen: (ref: ThreadRef, options?: BaseOptions) => Promise<Thread>
  /**
   * Locks the conversation on a thread, so that only collaborators can comment. A repeat leaves it locked.
   * @example
   * ```ts
   * await provider.threads.lock(ref, { reason: 'too_heated' })
   * ```
   */
  lock: (ref: ThreadRef, options?: LockOptions) => Promise<void>
  /** Unlocks the conversation on a thread. A repeat leaves it unlocked. */
  unlock: (ref: ThreadRef, options?: BaseOptions) => Promise<void>
  /**
   * Merges a pull request. Without a merge method, the repository must allow exactly one. A repeat rejects once the
   * pull request has merged, so after a failure read the pull request to see whether it did.
   * @param ref The pull request to merge.
   * @param options The merge method, the head `sha` to expect and the commit message.
   * @returns Whether the pull request merged or the forge queued the merge, and the merge commit where the response
   * reports it. Forgejo, Gitea and Tangled report no merge commit.
   * @example
   * ```ts
   * const { status, sha } = await provider.threads.merge(ref, { method: 'squash' })
   * ```
   */
  merge: (ref: ThreadRef, options?: MergeOptions) => Promise<MergeResult>
  /**
   * Brings the base branch into a pull request's head branch, by a merge commit or a rebase. A repeat once the branch
   * is up to date rejects on GitHub, Forgejo and Gitea, and leaves the branch as it is on GitLab.
   * @param ref The pull request to update.
   * @param options The update `method`, and the head `sha` to expect. GitHub checks `sha` as it updates; Forgejo, Gitea
   * and GitLab read the pull request first and compare.
   * @returns Whether the branch was updated or the forge queued the update. GitHub and GitLab update in the background,
   * so read the pull request later to see the new head.
   * @example
   * ```ts
   * await provider.threads.updateBranch(ref, { method: 'rebase', sha: pull.branches?.head.sha })
   * ```
   */
  updateBranch: (ref: ThreadRef, options?: UpdateBranchOptions) => Promise<UpdateBranchResult>
  /** The authenticated account's subscription to the thread. */
  subscription: (ref: ThreadRef, options?: BaseOptions) => Promise<SubscriptionState>
  /** Subscribes the account to the notifications of a thread. */
  subscribe: (ref: ThreadRef, options?: BaseOptions) => Promise<void>
  /** Stops the account's notifications for a thread, leaving existing notifications alone. */
  unsubscribe: (ref: ThreadRef, options?: BaseOptions) => Promise<void>
  /** Every check on the pull's head, in one page; `warnings` names the sources that could not be read. */
  checks: (ref: ThreadRef, options?: BaseOptions) => Promise<Page<Check>>
  /**
   * Reviews on a pull request. Forges with approvals but no review objects
   * (GitLab approvals, Azure DevOps votes, Bitbucket participants) synthesise
   * one review per approver, with `comments: false`.
   */
  reviews: (ref: ThreadRef, options?: PageOptions) => ForgeListing<Review>
  /**
   * Reads one review by its ref. Where the forge has no endpoint for it (`capabilities.threads.getReview` is `'emulated'`),
   * it lists the reviews of the pull request page by page until the id matches, which costs a request for each page
   * read.
   */
  getReview: (ref: ReviewRef, options?: BaseOptions) => Promise<Review>
  /** Creates a review. Without `event` the review is pending where the forge has pending reviews. A repeat adds a second review. */
  createReview: (ref: ThreadRef, input: ReviewInput, options?: BaseOptions) => Promise<Review>
  /** Submits a pending review. A repeat can reject once the review is submitted. */
  submitReview: (ref: ReviewRef, event: ReviewEvent, body?: string, options?: BaseOptions) => Promise<Review>
  /**
   * Approves without merging; `createReview({ event: 'approve' })` with nothing else to say. A repeat adds a second
   * approving review where the forge keeps reviews, and sets the same vote or rejects where it keeps votes.
   * @returns The approval, as `createReview()` returns it. GitLab reads the signed-in account once per provider to
   * pick the approval out of a response with more than one approver.
   */
  approve: (ref: ThreadRef, body?: string, options?: BaseOptions) => Promise<Review>
  /** Files a pull request changes, with a per-file `patch` where the forge returns one. */
  files: (ref: ThreadRef, options?: PageOptions) => ForgeListing<ChangedFile>
  /** Commits on a pull request. */
  commits: (ref: ThreadRef, options?: PageOptions) => ForgeListing<Commit>
  /**
   * Replies to a review comment in its conversation. Pass the comment as `reviews()` or `comments()` returns it:
   * GitHub uses its `inReplyTo` or `ref`, Gitea its `ref`, and GitLab the discussion in its `thread`. A repeat posts a
   * second reply.
   */
  replyToReviewComment: (ref: ThreadRef, comment: Pick<ReviewComment, 'ref' | 'thread' | 'inReplyTo'>, body: string, options?: BaseOptions) => Promise<ReviewComment>
  /** Resolves a review conversation, by the id on {@link ReviewComment.thread} or {@link Comment.thread}. */
  resolveReviewThread: (ref: ThreadRef, id: string, options?: BaseOptions) => Promise<void>
  /** Reopens a resolved review conversation, by the id on `ReviewComment.thread` or `Comment.thread`. */
  unresolveReviewThread: (ref: ThreadRef, id: string, options?: BaseOptions) => Promise<void>
}

/** Reading and reporting the checks on a commit. */
export interface ChecksApi {
  /** Every check on a commit: check runs, commit statuses, jobs or policy evaluations. */
  list: (repo: RepoRef, sha: string, options?: BaseOptions) => Promise<Page<Check>>
  /** Reads one check. Rejects for a `CheckRef.type` the forge cannot read on its own. */
  get: (ref: CheckRef, options?: BaseOptions) => Promise<Check>
  /**
   * Writes a commit status, or a check run where the credential can (GitHub app auth). A repeat writes a second check
   * run; a second commit status with the same name takes the place of the first, except on GitLab, which rejects a
   * repeat of a status that is still pending.
   */
  report: (repo: RepoRef, sha: string, input: CheckReportInput, options?: BaseOptions) => Promise<Check>
  /** Re-runs a check. Rejects for a `CheckRef.type` the forge cannot re-run. A repeat can start another run. */
  rerun: (ref: CheckRef, options?: BaseOptions) => Promise<void>
}

/** Reading CI runs and their jobs, and re-running the jobs that failed. */
export interface CiApi {
  /** Lists the CI runs of a repository. */
  runs: (repo: RepoRef, query?: CiRunQuery) => ForgeListing<CiRun>
  /** Reads one CI run. */
  getRun: (ref: CiRunRef, options?: BaseOptions) => Promise<CiRun>
  /** Lists the jobs of a CI run. */
  jobs: (ref: CiRunRef, options?: PageOptions) => ForgeListing<CiJob>
  /**
   * Reads one CI job. Where the forge has no endpoint for it (`capabilities.ci.getJob` is `'emulated'`), it lists the jobs
   * of the ref's `run` page by page until the id matches, which costs a request for each page read, so the ref must
   * name its run.
   */
  getJob: (ref: CiJobRef, options?: BaseOptions) => Promise<CiJob>
  /** The job's log as it arrives. */
  log: (ref: CiJobRef, options?: BaseOptions) => Promise<ReadableStream<Uint8Array>>
  /** Re-runs the jobs of a CI run that failed, and the jobs that depend on them. A repeat can start another attempt. */
  rerunFailed: (ref: CiRunRef, options?: BaseOptions) => Promise<void>
}

/** Commits of a repository and the comments on them. */
export interface CommitsApi {
  /** Lists the commits that lead to `ref`, or to the default branch. */
  list: (repo: RepoRef, query?: CommitQuery) => ForgeListing<Commit>
  /** One commit, with its files and stats. */
  get: (ref: CommitRef, options?: BaseOptions) => Promise<Commit>
  /** Lists the comments on a commit. */
  comments: (ref: CommitRef, options?: PageOptions) => ForgeListing<CommitComment>
  /**
   * Reads one comment on a commit. Where the forge has no endpoint for it (`capabilities.commits.getComment` is
   * `'emulated'`), it lists the comments of the commit page by page until the id matches, which costs a request for
   * each page read.
   */
  getComment: (ref: CommitCommentRef, options?: BaseOptions) => Promise<CommitComment>
  /** Comments on a commit. */
  createComment: (ref: CommitRef, body: string, options?: BaseOptions) => Promise<CommitComment>
  /** Replaces the body of a comment on a commit. */
  updateComment: (ref: CommitCommentRef, body: string, options?: BaseOptions) => Promise<CommitComment>
  /** Deletes a comment on a commit. A repeat can reject with `NotFoundError` once the comment is gone. */
  deleteComment: (ref: CommitCommentRef, options?: BaseOptions) => Promise<void>
  /** Hides a comment on a commit behind a note of the reason, as `threads.hideComment()` does for a thread comment. A repeat leaves it hidden. */
  hideComment: (ref: CommitCommentRef, reason: HideCommentReason, options?: BaseOptions) => Promise<void>
  /** Shows a hidden comment on a commit again. A repeat leaves it shown. */
  unhideComment: (ref: CommitCommentRef, options?: BaseOptions) => Promise<void>
}

/** Files, trees, branches and tags of a repository, comparisons between refs, and commits that write files. */
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
   * const file = await provider.contents.getFile(repo, 'package.json', { as: 'text' })
   * const manifest = JSON.parse(file.content as string)
   * ```
   */
  getFile: (repo: RepoRef, path: string, options?: FileOptions) => Promise<FileContent>
  /** One level, or every descendant with `recursive`. Truncated listings carry a `tree_truncated` warning. */
  tree: (repo: RepoRef, options?: TreeOptions) => ForgeListing<TreeEntry>
  /** Lists the branches of a repository. */
  branches: (repo: RepoRef, options?: PageOptions) => ForgeListing<Branch>
  /** Lists the tags of a repository. */
  tags: (repo: RepoRef, options?: PageOptions) => ForgeListing<Tag>
  /** Resolves a branch, tag or sha to a full commit sha; a full sha is returned as is. */
  resolveRef: (repo: RepoRef, ref: string, options?: BaseOptions) => Promise<string>
  /** Commits and files between two refs. */
  compare: (repo: RepoRef, base: string, head: string, options?: CompareOptions) => Promise<Comparison>
  /**
   * Writes and deletes files in one commit on a branch, and moves the branch to it. A repeat with `expectedHead` or
   * `createFrom` rejects once the first attempt has moved or created the branch; without them, it adds a second commit.
   * @param repo The repository to commit to.
   * @param input The branch, the message and the files, with the head the branch must have and the ref to create it from.
   * @throws `BranchMovedError` when the branch no longer points at `expectedHead`.
   * @throws `NotFoundError` when a file to delete does not exist.
   * @example
   * ```ts
   * const commit = await provider.contents.commitFiles(repo, {
   *   branch: 'docs/readme',
   *   createFrom: 'main',
   *   message: 'docs: update readme',
   *   changes: [
   *     { path: 'README.md', content: '# widgets\n' },
   *     { path: 'OLD.md', content: null },
   *   ],
   * })
   * ```
   */
  commitFiles: (repo: RepoRef, input: CommitFilesInput, options?: BaseOptions) => Promise<Commit>
}

/** Reading, creating and updating the releases of a repository, and downloading their assets. */
export interface ReleasesApi {
  /** Lists the releases of a repository, including drafts and pre-releases where the credential can see them. */
  list: (repo: RepoRef, options?: PageOptions) => ForgeListing<Release>
  /** Reads a release by its ref. */
  get: (ref: ReleaseRef, options?: BaseOptions) => Promise<Release>
  /** The release for a tag name. */
  getByTag: (repo: RepoRef, tag: string, options?: BaseOptions) => Promise<Release>
  /**
   * Downloads a release asset, as a stream of its bytes, a `Uint8Array` with `as: 'binary'` or a string with
   * `as: 'text'`. A redirect to a CDN host is followed without the `Authorization` header, which those hosts reject.
   * @example
   * ```ts
   * const release = await provider.releases.getByTag(repo, 'v1.0.0')
   * const asset = release.assets?.find(asset => asset.name.endsWith('.pdf'))
   * if (asset?.ref) {
   *   const bytes = await provider.releases.downloadAsset(asset.ref, { as: 'binary' })
   * }
   * ```
   */
  downloadAsset: {
    (ref: ReleaseAssetRef, options?: DownloadAssetOptions & { as?: 'stream' }): Promise<ReadableStream<Uint8Array>>
    (ref: ReleaseAssetRef, options: DownloadAssetOptions & { as: 'binary' }): Promise<Uint8Array>
    (ref: ReleaseAssetRef, options: DownloadAssetOptions & { as: 'text' }): Promise<string>
  }
  /** The most recent published release that is not a draft or prerelease, if any. */
  latest: (repo: RepoRef, options?: BaseOptions) => Promise<Release | undefined>
  /**
   * Creates a release, and its tag from `target` when the tag does not exist yet. A repeat for the same tag rejects on
   * forges that hold one release per tag; read it back with `getByTag()`.
   * @param repo The repository to release.
   * @param input The tag, the name, the notes and whether the release is a draft or a prerelease.
   * @throws `UnsupportedOperationError` for `draft: true` or `prerelease: true` on a forge without drafts or prereleases.
   * @example
   * ```ts
   * const release = await provider.releases.create(repo, { tag: 'v1.2.0', body: notes, draft: true })
   * ```
   */
  create: (repo: RepoRef, input: ReleaseInput, options?: BaseOptions) => Promise<Release>
  /**
   * Changes a release. Fields left out stay as they are, so `{ draft: false }` publishes a draft.
   * @throws `UnsupportedOperationError` for a change the forge cannot make, such as a new tag on GitLab.
   * @throws `ForbiddenError` with reason `immutable_release` when the forge refuses the write because the
   * release is immutable (GitHub); its name, notes, prerelease and `latest` flags stay editable.
   */
  update: (ref: ReleaseRef, update: ReleaseUpdate, options?: BaseOptions) => Promise<Release>
}

/** Searching issues and pull requests, repositories, commits and code across the forge. */
export interface SearchApi {
  /**
   * Issues and pull requests across repositories. Fields the forge cannot
   * filter on come back as a `filter_unsupported` warning on the page.
   */
  threads: (query: ThreadSearchQuery) => ForgeListing<Thread>
  /** Searches repositories. */
  repos: (query: RepoSearchQuery) => ForgeListing<Repo>
  /** Commits across repositories, where the forge indexes them. */
  commits: (query: CommitSearchQuery) => ForgeListing<Commit>
  /** Searches the contents of files, where the forge indexes them. */
  code: (query: CodeSearchQuery) => ForgeListing<CodeMatch>
}

/** Reading the security alerts of a repository. */
export interface SecurityAlertsApi {
  /** Lists the security alerts of a repository. */
  list: (repo: RepoRef, options?: SecurityAlertListOptions) => ForgeListing<SecurityAlert>
}

/**
 * Options for `repos.get()`.
 */
export interface RepoGetOptions extends BaseOptions {
  /**
   * Includes the repository's licence in `Repo.licence`. GitLab reports it only on request, because detecting it
   * scans the repository; other forges ignore this option.
   */
  licence?: boolean
}

/** Repositories, and the labels, milestones and collaborators that belong to them. */
export interface ReposApi {
  /**
   * Reads a repository by its ref. Rejects with `NotFoundError` when it does not exist or the credential cannot see
   * it.
   */
  get: (ref: RepoRef, options?: RepoGetOptions) => Promise<Repo>
  /** The authenticated account's repositories, or the installation's under app auth. */
  list: (options?: RepoQuery) => ForgeListing<Repo>
  /**
   * The repositories of a user, organisation, group, workspace or project that the credential can see.
   * @param owner A namespace ref, such as `namespaceRef(provider, 'acme')`.
   */
  byOwner: (owner: RepoRef, query?: OwnerRepoQuery) => ForgeListing<Repo>
  /** Every label defined on the repository, whether or not a thread carries it. */
  labels: (repo: RepoRef, options?: PageOptions) => ForgeListing<Label>
  /** Creates a label in a repository. A repeat rejects on most forges, because the name is taken. */
  createLabel: (repo: RepoRef, label: LabelInput, options?: BaseOptions) => Promise<Label>
  /** Lists the milestones of a repository. */
  milestones: (repo: RepoRef, options?: MilestoneListOptions) => ForgeListing<Milestone>
  /** The issue types that issues in the repository can have. On GitHub, the enabled types of the account that owns it. */
  issueTypes: (repo: RepoRef, options?: BaseOptions) => Promise<IssueType[]>
  /** Lists the collaborators of a repository, with their roles. */
  collaborators: (repo: RepoRef, options?: PageOptions) => ForgeListing<Collaborator>
  /**
   * Lists the commit authors of a repository with their commit counts, most commits first. Pass
   * `includeUnlinked: true` to include the contributors the forge has not linked to an account.
   */
  contributors: (repo: RepoRef, options?: ContributorQuery) => ForgeListing<Contributor>
  /**
   * Weekly commit activity of each contributor to a repository. Where the forge computes the statistics in the
   * background, the provider waits for them, and throws a `ForgeApiError` with status `202` if they are still not ready.
   */
  contributorStats: (repo: RepoRef, options?: BaseOptions) => Promise<ContributorStats[]>
  /**
   * The issue and pull request templates a repository offers, ready to fill in before `threads.create()`. On GitHub,
   * a repository without its own falls back to the owner's `.github` repository, same as the web UI.
   * @example
   * ```ts
   * const [template] = await provider.repos.templates(repo, { kind: 'pull_request' })
   * const body = template?.body ?? ''
   * ```
   */
  templates: (repo: RepoRef, options?: RepoTemplateOptions) => Promise<RepoTemplate[]>
  /** One account's role on the repository; `'none'` when it has no access. */
  permissionFor: (repo: RepoRef, actor: string | Actor, options?: BaseOptions) => Promise<RepoRole>
  /**
   * Gives an account a role on a repository, or invites it where the forge asks the account to accept first. A repeat
   * can reject where the forge refuses to add an existing member (GitLab).
   */
  addCollaborator: (repo: RepoRef, actor: string | Actor, role: RepoRole, options?: BaseOptions) => Promise<AddCollaboratorResult>
  /** Accounts that can be assigned to a thread in the repository. */
  assignableUsers: (repo: RepoRef, options?: PageOptions) => ForgeListing<Actor>
  /** Accounts that can be asked to review a given pull request. */
  reviewerCandidates: (ref: ThreadRef, options?: PageOptions) => ForgeListing<Actor>
  /**
   * Lists the activity feed of a repository: pushes, new branches and tags, and changes to its threads and releases.
   * Events come in the order the forge added them to the feed, latest first, which can differ from `occurredAt`
   * where the forge adds events late. Each event has `source: 'poll'`.
   *
   * Where the forge supports conditional requests, the first page has an `etag`; pass it back as
   * `cursor: { etag }` to read the first page again, which has `notModified: true` and no items when the feed is
   * unchanged. Where the forge sets a minimum wait between reads, reading the first page again sooner sends no
   * request and returns a `throttled` page with a `feed_throttled` warning, unless you pass `force: true`.
   * Iterating then yields nothing, and the warning lands in `warnings`.
   * @example
   * ```ts
   * const page = await provider.repos.events(repo, { cursor: etag ? { etag } : undefined }).page()
   * if (!page.notModified) {
   *   etag = page.etag
   * }
   * ```
   */
  events: (repo: RepoRef, options?: EventFeedOptions) => ForgeListing<ForgeEvent>
}

/** Options for `repos.milestones()`. */
export interface MilestoneListOptions extends PageOptions {
  /**
   * @default 'open'
   */
  state?: 'open' | 'closed' | 'all'
}

/**
 * The teams of an organisation and their members. An organisation is a
 * namespace ref, as `repos.byOwner()` takes one. GitLab has no teams of its
 * own, so its subgroups play the role of teams and their members are the
 * subgroup's members.
 */
export interface OrgsApi {
  /**
   * Lists the teams of an organisation.
   * @param org A namespace ref, such as `namespaceRef(provider, 'acme')`.
   */
  teams: (org: RepoRef, options?: PageOptions) => ForgeListing<Team>
  /**
   * Lists the members of a team, as actors.
   * @param team A team's `ref` from `teams()`, or a ref with only `org` and `slug`, such as `{ forge, instance, org, slug: 'stewards' }`.
   */
  teamMembers: (team: TeamRef, options?: PageOptions) => ForgeListing<Actor>
  /**
   * Blocks an account from the repositories of an organisation. A repeat can reject with a `ForgeApiError` with
   * `status` 422.
   * @param org A namespace ref, as for `teams()`.
   * @param login The account to block.
   * @example
   * ```ts
   * await provider.orgs.block(namespaceRef(provider, 'acme'), 'spammer')
   * ```
   */
  block: (org: RepoRef, login: string, options?: BaseOptions) => Promise<void>
  /** Unblocks an account that `block()` blocked. A repeat can reject with a `ForgeApiError` with `status` 422. */
  unblock: (org: RepoRef, login: string, options?: BaseOptions) => Promise<void>
}

/** The installations of the app that the provider authenticates as. */
export interface InstallationsApi {
  /** Lists the installations of the app. */
  list: (options?: PageOptions) => ForgeListing<Installation>
  /** Reads one installation. */
  get: (installation: Installation | string, options?: BaseOptions) => Promise<Installation>
  /** Mints (or reuses a cached) installation token. */
  token: (installation: Installation | string, options?: BaseOptions) => Promise<InstallationToken>
  /** Lists the repositories that an installation can access. */
  repos: (installation: Installation | string, options?: PageOptions) => ForgeListing<Repo>
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
  list: (target: RepoRef, options?: PageOptions) => ForgeListing<Webhook>
  /** Registers a webhook. A repeat registers a second one, or rejects where the forge refuses a second hook for the same URL. */
  create: (target: RepoRef, input: WebhookInput, options?: BaseOptions) => Promise<Webhook>
  /** Changes a webhook. */
  update: (ref: WebhookRef, update: WebhookUpdate, options?: BaseOptions) => Promise<Webhook>
  /** Deletes a webhook. A repeat can reject with `NotFoundError` once the webhook is gone. */
  delete: (ref: WebhookRef, options?: BaseOptions) => Promise<void>
  /** Replaces the signing secret in place. `false` where the forge can only do it by recreating the hook. */
  rotateSecret: (ref: WebhookRef, secret: string, options?: BaseOptions) => Promise<Webhook>
  /** Lists the recent deliveries of a webhook. */
  deliveries: (ref: WebhookRef, options?: PageOptions) => ForgeListing<WebhookDeliveryRecord>
  /** Sends a past delivery again. A repeat sends it once more. */
  redeliver: (ref: WebhookDeliveryRef, options?: BaseOptions) => Promise<void>
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

/** Options for `sources.stream()`. */
export interface StreamOptions {
  /** Resume after this cursor, as yielded by an earlier {@link StreamItem}. */
  cursor?: string
  /** Aborting closes the connection and ends iteration without an error. */
  signal?: AbortSignal
}

/** One item from `sources.stream()`. */
export interface StreamItem {
  event: ForgeEvent
  /** Opaque position after `event`; persist it and pass it back to resume. */
  cursor: string
}

/** Reading accounts. */
export interface UsersApi {
  /** Reads an account by login, without needing a credential where the forge allows it. */
  get: (login: string, options?: BaseOptions) => Promise<User>
  /**
   * The account the provider's credential belongs to.
   * @example
   * ```ts
   * const me = await provider.users.me()
   * console.log(me.login)
   * ```
   */
  me: (options?: BaseOptions) => Promise<User>
  /**
   * Whether an account accepts sponsorship on the forge, such as through a GitHub Sponsors listing. Rejects with
   * `NotFoundError` when no account has the login.
   * @param login The account to check.
   * @example
   * ```ts
   * if (await provider.users.sponsorable('danielroe')) {
   *   console.log('https://github.com/sponsors/danielroe')
   * }
   * ```
   */
  sponsorable: (login: string, options?: BaseOptions) => Promise<boolean>
  /**
   * Lists what an account did across the repositories the credential can see, in the feed's order as for
   * {@link ReposApi.events}, with the same conditional requests and throttling. Each event has `source: 'poll'`.
   */
  events: (login: string, options?: EventFeedOptions) => ForgeListing<ForgeEvent>
  /**
   * Blocks an account on behalf of the account the credential belongs to. A repeat can reject with a
   * `ForgeApiError` with `status` 422.
   * @param login The account to block.
   */
  block: (login: string, options?: BaseOptions) => Promise<void>
  /** Unblocks an account that `block()` blocked. A repeat can reject with a `ForgeApiError` with `status` 422. */
  unblock: (login: string, options?: BaseOptions) => Promise<void>
}

/** Long-lived push streams of events. */
export interface SourcesApi {
  /**
   * Push delivery over a long-lived connection. Iteration ends when the signal
   * aborts or the consumer stops iterating; a dropped connection throws
   * `StreamClosedError` carrying the last cursor. There is no automatic
   * reconnection.
   */
  stream: (options?: StreamOptions) => AsyncIterable<StreamItem>
}

export type { ForgeVerb } from './supports.ts'

/** A connection to one forge, with its identity, its capabilities and the namespaces of operations. */
export interface ForgeProvider<HasWeb extends boolean = boolean> {
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
  /**
   * The request budgets of the latest responses, one per `resource`, read without sending a request. GitHub keeps
   * a budget per resource, such as `core`, `search` and `graphql`; other forges report one budget with no
   * `resource`. Empty until a response reports a budget. A budget whose `resetAt` has passed is left out.
   * @example
   * ```ts
   * const core = forge.rateLimits().find(budget => !budget.resource || budget.resource === 'core')
   * if (core?.remaining !== undefined && core.limit && core.remaining / core.limit < 0.1) {
   *   await slowDown(core.resetAt)
   * }
   * ```
   */
  rateLimits: () => RateLimit[]
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
  readonly commits: CommitsApi
  readonly checks: ChecksApi
  readonly ci: CiApi
  readonly users: UsersApi
  readonly search: SearchApi
  readonly securityAlerts: SecurityAlertsApi
  readonly orgs: OrgsApi
  /**
   * Whether `verb` is supported, for `kind` where support differs by kind,
   * including version gates. Every verb is always present and rejects with
   * `UnsupportedOperationError` when this is `false`: the capability is the
   * question, the method is the action.
   * @param verb The operation, named by its path on the provider, such as `threads.createComment`.
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
   * How well `verb` is supported: `true`, `'emulated'`, `'not_applicable'`
   * or `false`, for `kind` where support differs by kind. `can()` is `true`
   * for every level but `false` and `'not_applicable'`. Without `kind`, a
   * per-kind verb reports its strongest level across kinds.
   * @param verb The operation, named by its path on the provider, such as `threads.createComment`.
   * @param kind The thread kind, for an operation whose support differs by kind.
   */
  support: (verb: ForgeVerb, kind?: ThreadKind | SecurityAlertKind) => Support
  /**
   * The web page for `target`, built without a request; `undefined` when the forge has no such page.
   * @param target What to link to: a repository or one of its sections (`issues`, `pullRequests`, `compare`, `releases`, `stargazers`, `forks` or `watchers`), thread, comment, release, file, raw file, commit or comparison.
   */
  urlFor: {
    (target: { repo: RepoRef, section?: undefined }): HasWeb extends true ? string : string | undefined
    (target: UrlTarget): string | undefined
  }
  /**
   * The canonical origin of the forge's website for this instance, such as `https://github.com`
   * (without any deployment path), or `undefined` when the forge has no website. Useful for
   * resolving root-relative links and for building a content security policy.
   */
  readonly webOrigin: HasWeb extends true ? string : string | undefined
  /**
   * Token scopes or app permissions `verb` needs on this forge, as data for a
   * consent screen or a 403 explanation. Nothing in the library reads it, and
   * an unmapped verb returns `{}`.
   * @param verb The operation, named by its path on the provider.
   */
  scopesFor: (verb: ForgeVerb) => VerbScopes
  /**
   * Reads a web URL, clone URL or npm `repository` value (`git+https://`, `github:owner/name`) on this provider's instance into refs; `undefined` for anything else.
   * @param url The URL to read.
   */
  parseUrl: (url: string | URL) => ParsedForgeUrl | undefined
  /**
   * How to mention `ref` in Markdown on this forge (`#42`, `!42`,
   * `acme/widgets#42`, `acme/widgets@abc1234`), short when written in `from`;
   * the page URL where the forge has no reference syntax.
   * @param ref The thread or commit to mention.
   * @param options The repository the reference is written in, so that a reference within it is short.
   */
  referenceFor: (ref: ThreadRef | CommitRef, options?: ReferenceOptions) => string | undefined
  /**
   * The references to threads and commits in `text`, as `referenceFor()` writes them and people type them
   * (`#42`, `!42`, `GH-42`, `acme/widgets#42`, `acme/widgets@abc1234` or a bare sha), with their offsets,
   * in order. `#42` reads as an issue where issues and pull requests share numbers; `threads.get()`
   * returns the thread with its kind. A bare sha has 7 to 40 hex characters, with a letter and a digit.
   * Text inside a URL is skipped, but code spans are not, so leave them out of `text`. Empty when `from`
   * is on another instance, or the forge has no reference syntax.
   * @param text The text to read, such as a Markdown text node.
   * @param options The repository the text is written in, which a short reference points into.
   */
  parseReferences: (text: string, options: ParseReferencesOptions) => ParsedReference[]
}

type UnionToIntersection<U> = (U extends unknown ? (union: U) => void : never) extends (intersection: infer I) => void ? I : never

type SingleForgeOf<F> = F extends { forge: infer Forge extends ForgeKind } ? [Forge] extends [UnionToIntersection<Forge>] ? Forge : never : never

/** The forges of the fixed leading entries of `T` that each name a single forge. */
type RegisteredKinds<T extends readonly unknown[]> = T extends readonly [infer Head, ...infer Rest] ? SingleForgeOf<Head> | RegisteredKinds<Rest> : never

/** A registry of providers that routes each ref to the provider it belongs to. `Kind` is the forges it is certain to hold. */
export interface Forges<Kind extends ForgeKind = never> {
  readonly providers: ForgeProvider[]
  /** First provider for `forge`, optionally narrowed to a single instance host. Typed as present for a forge in `Kind`. */
  get: {
    (forge: Kind): ForgeProvider
    (forge: ForgeKind, instance?: ForgeInstance): ForgeProvider | undefined
  }
  /** Every provider for a forge. */
  all: (forge: ForgeKind) => ForgeProvider[]
  /** The provider a ref belongs to, by `forge` and `instance`. */
  for: (ref: ForgeOrigin) => ForgeProvider | undefined
  /** The provider whose instance serves `url`. */
  forUrl: (url: string | URL) => ForgeProvider | undefined
  /** Reads a web URL, clone URL or npm `repository` value on any registered instance. */
  parseUrl: (url: string | URL) => (ParsedForgeUrl & { provider: ForgeProvider }) | undefined
  /** The references in `text`, read by the provider of `options.from`; empty when none is registered. */
  parseReferences: (text: string, options: ParseReferencesOptions) => ParsedReference[]
  /** Notifications from every registered provider, provider by provider. */
  notifications: {
    /** Lists the notifications of every provider, provider by provider. */
    list: (options?: Omit<NotificationListOptions, 'cursor'>) => ForgeIterable<Notification>
  }
  threads: {
    /**
     * Reads threads from several forges at once: groups the refs by the provider each belongs to, batches each group
     * with that provider's `threads.getMany()`, and returns the results in input order. A ref whose origin is not
     * registered becomes a per-item warning.
     */
    getMany: (refs: ThreadRef[], options?: BaseOptions) => Promise<GetManyResult[]>
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
    threads: (query?: Omit<ThreadSearchQuery, 'cursor' | 'sort'> & { sort?: 'created' | 'updated' }) => ForgeIterable<Thread>
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
  providers: readonly ForgeProvider[],
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
 * Combines providers into a registry.
 * @param providers Providers such as `github()` creates.
 * @example
 * ```ts
 * import { createForges, github, gitlab, UnknownForgeError } from 'forges'
 *
 * const forges = createForges([
 *   github({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } }),
 *   gitlab(),
 * ])
 *
 * const ref = { forge: 'github', instance: 'github.com', owner: 'danielroe', name: 'forges' } as const
 * const provider = forges.for(ref)
 * if (!provider) {
 *   throw new UnknownForgeError(`No provider registered for ${ref.forge} on ${ref.instance}`, ref)
 * }
 * const repo = await provider.repos.get(ref)
 * ```
 */
export function createForges<const T extends readonly ForgeProvider[]>(providers: T): Forges<RegisteredKinds<T>> {
  const routes = routeForges<ForgeProvider>(providers)
  const find = routes.for

  return {
    ...routes,
    get: routes.get as Forges<RegisteredKinds<T>>['get'],
    threads: {
      async getMany(refs, options) {
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
          const batch = await provider.threads.getMany(indexes.map(index => refs[index]!), options)
          for (const [position, index] of indexes.entries()) {
            results[index] = batch[position]!
          }
        }))
        return results
      },
    },
    search: {
      threads: (query = {}) => mergeByTime(providers, 'search.threads', query, (provider, page) => provider.search.threads(page).page()),
      repos: (query = {}) => mergeByTime(providers, 'search.repos', query, (provider, page) => provider.search.repos(page).page()),
    },
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
