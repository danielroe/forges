/**
 * Every public type in this module is JSON-serialisable except `Date`, which
 * serialises to an ISO 8601 string through `JSON.stringify`, and the bytes of
 * a binary {@link FileContent}. `raw` and `payload` fields hold the forge's
 * own JSON.
 */

/**
 * Identifier of a forge implementation. Unknown forges are permitted so that
 * third-party providers can be registered without a core release.
 */
export type ForgeKind = KnownForgeKind | (string & {})

/** The forges this package ships providers for. */
export type KnownForgeKind = 'github' | 'gitlab' | 'bitbucket' | 'forgejo' | 'gitea' | 'tangled' | 'gitee' | 'azure-devops' | 'cursor-origin' | 'pushin'

/**
 * Capability flag. Every value other than `false` means the operation is
 * available:
 *
 * - `true`: native, and verified against a recording of the forge's responses.
 * - `'emulated'`: composed from other calls, so the result is approximate.
 * - `'experimental'`: native, but either unverified against the live forge or
 *   built on an API the forge marks unstable.
 */
export type Support = boolean | 'emulated' | 'experimental'

/** Host of a single forge deployment, for example `github.com` or `codeberg.org`. */
export type ForgeInstance = string

export interface ForgeOrigin {
  forge: ForgeKind
  instance: ForgeInstance
}

export interface RepoRef extends ForgeOrigin {
  /**
   * Full namespace path. On forges with nested groups (GitLab) this contains
   * slashes, for example `acme/platform`; `name` never does.
   */
  owner: string
  /** Repository name. Empty for namespace-scoped refs. */
  name: string
  /**
   * `'namespace'` for subjects that belong to a group rather than a repository
   * (GitLab epics). Absent means a repository.
   */
  kind?: 'repo' | 'namespace'
  /**
   * Stable forge-native identifier that survives renames and transfers: a
   * GitHub, Forgejo or Gitea numeric id, a GitLab project or group id, a
   * Bitbucket UUID or a Tangled repo DID. {@link repoKey} prefers it over
   * `owner` and `name`.
   */
  externalId?: string
}

export type RepoVisibility = 'public' | 'private' | 'internal'

/** The authenticated account's access to a repository. */
export interface RepoPermissions {
  admin: boolean
  maintain: boolean
  push: boolean
  triage: boolean
  pull: boolean
}

/** Which subjects a repository has switched on, where the forge makes them per repository. */
export interface RepoFeatures {
  issues: boolean
  pullRequests: boolean
  discussions: boolean
  wiki: boolean
  projects: boolean
  releases: boolean
}

/** A collaborator's role, highest first. `'none'` is an explicit absence of access. */
export type RepoRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'

export interface Collaborator {
  actor: Actor
  role: RepoRole
  /** Forge-native role name, for example `maintainer` or `reporter`. */
  roleRaw?: string
  permissions?: RepoPermissions
  raw: unknown
}

export interface Repo {
  ref: RepoRef
  /** The repository's name where `ref.name` is an identifier rather than the name (a Tangled record key). */
  displayName?: string
  description?: string
  defaultBranch?: string
  visibility: RepoVisibility
  visibilityRaw?: string
  isFork: boolean
  isArchived: boolean
  parent?: RepoRef
  topics: string[]
  url?: string
  /** Git remotes. Tangled maps the hosting knot to its SSH host. */
  cloneUrls?: { https?: string, ssh?: string }
  createdAt?: Date
  updatedAt?: Date
  /** Last push, where the listing endpoint reports it. */
  pushedAt?: Date
  /**
   * Open issues only, never combined with pull requests. Absent where the
   * forge reports only the combined count (GitHub).
   */
  openIssueCount?: number
  openPullCount?: number
  /** The account or organisation that owns the repository, where the forge reports one. */
  owner?: Actor
  /** Primary language, as the forge detects it. */
  language?: string
  /** Project website, apart from the repository's own `url`. */
  homepage?: string
  /** SPDX identifier of the licence the forge detects, for example `MIT`. */
  licence?: string
  stars?: number
  forks?: number
  /** Accounts watching the repository's activity, apart from stars. */
  watchers?: number
  permissions?: RepoPermissions
  /** Merge methods the repository allows, where the forge reports them. Empty means the forge reported none. */
  mergeMethods?: MergeMethod[]
  features?: RepoFeatures
  raw: unknown
}

/**
 * Kind of thread. `'other'` holds forge-specific subjects with no shared kind
 * yet (check suites, epics); `typeRaw` names them.
 */
export type ThreadKind = 'issue' | 'pull_request' | 'discussion' | 'commit' | 'other'

/**
 * Reference to a thread. A thread `number` is unique only within its repo, so
 * the repo is always carried alongside it.
 */
export interface ThreadRef extends ForgeOrigin {
  repo: RepoRef
  kind: ThreadKind
  /** Forge-native subject type, for example `PullRequest` or `MergeRequest`. */
  typeRaw?: string
  /**
   * Per-repo thread number, the commit sha for `kind: 'commit'`, or the
   * forge-native id for `kind: 'other'`. Absent when the forge did not
   * identify the thread; such a ref cannot be fetched or keyed until enriched.
   */
  number?: string
  /**
   * Human-facing per-repo number, when it differs from `number`. Tangled
   * identifies threads by AT-URI but shows numbers in its UI and webhooks.
   */
  displayNumber?: string
  /**
   * Globally unique forge-native identifier, where one exists: a GitHub
   * `node_id`, a GitLab global id, or an atproto record URI.
   */
  externalId?: string
}

/** A release, as a notification subject or event target. */
export interface ReleaseRef extends ForgeOrigin {
  repo: RepoRef
  /** Forge-native release id; the tag name on forges that key releases by tag. */
  id: string
  tag?: string
}

/**
 * Reference to a registered webhook. `target` is the repository, or a
 * namespace ref (`kind: 'namespace'`, empty `name`) for an organisation or
 * workspace hook.
 */
export interface WebhookRef extends ForgeOrigin {
  target: RepoRef
  /** Forge-native hook id. */
  id: string
}

/** Reference to one delivery of a webhook. */
export interface WebhookDeliveryRef extends ForgeOrigin {
  hook: WebhookRef
  id: string
  /** Delivery guid, where the forge needs it to redeliver. */
  guid?: string
}

/** A normalised event a provider can deliver, optionally narrowed to one action. */
export interface WebhookEventType {
  kind: EventKind
  action?: EventAction
}

/** A registered webhook. The secret is never readable, so it is never returned. */
export interface Webhook {
  ref: WebhookRef
  url: string
  /** Normalised kinds the subscription covers, derived from `nativeEvents`. */
  events: EventKind[]
  /** Forge-native event names exactly as the forge stores them. */
  nativeEvents: string[]
  active: boolean
  /** `'json'` or `'form'` where the forge offers a choice. */
  contentType?: 'json' | 'form'
  createdAt?: Date
  updatedAt?: Date
  /** Never returned: no forge reads a webhook secret back. */
  secret?: never
  raw: unknown
}

export interface WebhookInput {
  url: string
  /** Normalised kinds, translated to the forge's own event names. */
  events?: EventKind[]
  /** Forge-native event names, sent as given and merged with the translation of `events`. */
  nativeEvents?: string[]
  secret?: string
  contentType?: 'json' | 'form'
  /** Defaults to `true`. */
  active?: boolean
}

/** A change to a registered webhook. Fields left out are left as they are. */
export type WebhookUpdate = Partial<WebhookInput>

/** One recorded delivery attempt. */
export interface WebhookDeliveryRecord {
  ref: WebhookDeliveryRef
  /** Forge-native event name of the delivery. */
  event: string
  status: number
  /** `true` when the forge considered the delivery successful. */
  ok: boolean
  deliveredAt?: Date
  /** Round trip in milliseconds, where the forge reports it. */
  duration?: number
  raw: unknown
}

export type SecurityAlertKind = 'dependency' | 'code_scanning' | 'secret' | 'advisory' | 'other'

/** A security alert: a vulnerable dependency, a code scanning result, a leaked secret or an advisory. */
export interface SecurityAlertRef extends ForgeOrigin {
  repo: RepoRef
  /** Forge-native alert id. GitHub numbers each alert kind separately, so `kind` is needed to address one. */
  id: string
  kind?: SecurityAlertKind
  severityRaw?: string
}

/** One check run, commit status or CI job. */
export interface CheckRef extends ForgeOrigin {
  repo: RepoRef
  id: string
  /** What the id addresses: a check run, a commit status, a CI job, or a branch policy evaluation. */
  type: 'check_run' | 'status' | 'job' | 'policy'
}

/**
 * Reference to a notification. Distinct from {@link ThreadRef}: a notification
 * is a per-user delivery record whose lifetime and identity are independent of
 * the thread it points at.
 */
export interface NotificationRef extends ForgeOrigin {
  /** Forge-native notification identifier, used for read/done/unsubscribe writes. */
  id: string
}

export interface Actor extends ForgeOrigin {
  login: string
  id: string
  name?: string
  avatarUrl?: string
  url?: string
  /** Forge-reported account type, retained verbatim for callers that classify further. */
  typeRaw?: string
  /**
   * Hint derived from forge metadata that the actor is automation. Callers own
   * the classification policy.
   */
  isBotHint: boolean
  /** The app behind a bot account, where the forge ties one to it (GitHub Apps' `slug[bot]` users). */
  app?: { slug: string, id?: string }
}

/** A user or organisation account, as `users.get()` reads it. */
export interface User extends Actor {
  bio?: string
  company?: string
  location?: string
  websiteUrl?: string
  createdAt?: Date
  followers?: number
  following?: number
  publicRepos?: number
  raw: unknown
}

export interface Label {
  name: string
  colour?: string
  description?: string
}

/** What a label is created or updated with. */
export interface LabelInput {
  name: string
  /** Six-digit hex, without the leading `#`. */
  colour?: string
  description?: string
}

/** Every name {@link ReactionContent} covers. */
export const REACTION_CONTENTS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const

/**
 * The reactions every forge with reactions has in common, named as GitHub
 * names them. A forge-native name with no entry here is not reported.
 */
export type ReactionContent = (typeof REACTION_CONTENTS)[number]

/** The normalised name for a forge-native reaction name, or `'other'` where there is none. */
export function reactionContent(raw: string): ReactionContent | 'other' {
  return (REACTION_CONTENTS as readonly string[]).includes(raw) ? raw as ReactionContent : 'other'
}

/** One reaction left on a thread or a comment, as `threads.reactions()` lists them. */
export interface Reaction {
  /** `'other'` where the forge's name has no entry in {@link ReactionContent}. */
  content: ReactionContent | 'other'
  /** The forge's own name for the reaction, such as a GitLab award emoji or a Forgejo emoji. */
  contentRaw: string
  actor: Actor
  createdAt?: Date
  raw: unknown
}

export interface ReactionSummary {
  total: number
  counts: Partial<Record<ReactionContent, number>>
  /** Reactions the authenticated account has left. Absent when the forge does not report them. */
  viewerReacted?: ReactionContent[]
}

export interface Milestone {
  /** Forge-native milestone id, as `threads.setMilestone` takes it. */
  id: string
  title: string
  state: 'open' | 'closed'
  description?: string
  dueOn?: Date
  url?: string
  raw: unknown
}

/**
 * Thread state. `'unknown'` is distinct from any real state and signals that
 * the value was not present in the payload, so the caller may enrich it with
 * `threads.get()`. Draft status is orthogonal; see `Thread.isDraft`.
 */
export type ThreadState = 'open' | 'closed' | 'merged' | 'unknown'

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'pending' | 'dismissed' | 'unknown'

/** Reference to a review on a pull request. */
export interface ReviewRef extends ForgeOrigin {
  thread: ThreadRef
  /** Forge-native review id; a synthesised `approval:<login>` where the forge has approvals but no review objects. */
  id: string
}

/** A comment left on a line of the diff as part of a review. */
export interface ReviewComment {
  ref?: CommentRef
  body: string
  author?: Actor
  path?: string
  /** Line in the file the comment is anchored to, in the side it is anchored to. */
  line?: number
  /** `'left'` is the base of the diff, `'right'` the head. */
  side?: 'left' | 'right'
  /** Forge-native id of the comment this one replies to. */
  inReplyTo?: string
  /** The resolvable conversation the comment belongs to, where the forge has one. */
  thread?: { id: string, resolved: boolean }
  createdAt?: Date
  url?: string
  raw: unknown
}

export interface Review {
  ref: ReviewRef
  author?: Actor
  state: ReviewState
  stateRaw?: string
  body?: string
  submittedAt?: Date
  /**
   * Inline comments submitted with the review. `false` where the forge has
   * approvals but no review objects to hang comments on.
   */
  comments: ReviewComment[] | false
  url?: string
  raw: unknown
}

/** What a review does when it is submitted. Omitted creates a pending review where the forge has them. */
export type ReviewEvent = 'approve' | 'request_changes' | 'comment'

export interface ReviewCommentInput {
  path: string
  /** Line in the diff, in `side`. */
  line?: number
  side?: 'left' | 'right'
  /** First line of a multi-line comment. */
  startLine?: number
  body: string
}

export interface ReviewInput {
  /** Omitted creates a pending review, where the forge has them; submit it with `submitReview`. */
  event?: ReviewEvent
  body?: string
  comments?: ReviewCommentInput[]
}

export interface Reviewer {
  actor: Actor
  state: ReviewState
  stateRaw?: string
  /** True when the reviewer is a team rather than an account. */
  isTeam?: boolean
}

export interface PullBranches {
  /** `sha` is absent on forges where a pull is a patch rather than a branch (Tangled). */
  head: { ref: string, sha?: string, repo?: RepoRef }
  base: { ref: string, sha?: string }
  mergeCommitSha?: string
}

export interface ThreadStack {
  /** Forge-native stack id, where the forge names stacks. */
  id?: string
  /** The pull request this one is stacked on. Absent for the root of the stack. */
  parent?: ThreadRef
}

/**
 * Combined state of the checks on a pull request's head commit. `failure`
 * when any check failed, else `pending` while any runs, else `success`.
 */
export interface ChecksSummary {
  state: 'pending' | 'success' | 'failure' | 'unknown'
  stateRaw?: string
  /** Absent when the forge reports only a combined state. */
  total?: number
  failed?: number
  url?: string
}

/** `neutral` covers skipped and informational results, which neither pass nor fail. */
export type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'unknown'

export interface Check {
  ref: CheckRef
  name: string
  state: CheckState
  /** Forge-native status, for example `in_progress` or `running`. */
  stateRaw: string
  /** Forge-native conclusion, where the forge reports one apart from the status. */
  conclusionRaw?: string
  url?: string
  startedAt?: Date
  completedAt?: Date
  raw: unknown
}

/** What `checks.report` writes: a commit status everywhere, a check run on GitHub under app auth. */
export interface CheckReportInput {
  /** Status context or check run name. */
  name: string
  state: Exclude<CheckState, 'unknown'>
  description?: string
  /** Where a person goes to see the detail. */
  url?: string
  /** The caller's own id for the check, where the forge stores one. */
  externalId?: string
}

/** A CI run: a workflow run, a pipeline, or a build. */
export interface CiRunRef extends ForgeOrigin {
  repo: RepoRef
  id: string
}

/** One job inside a run. `run` is absent when the job was addressed on its own. */
export interface CiJobRef extends ForgeOrigin {
  repo: RepoRef
  id: string
  run?: CiRunRef
}

export interface CiRun {
  ref: CiRunRef
  name: string
  state: CheckState
  stateRaw: string
  /** Per-repo run number, where the forge has one. */
  number?: string
  /** What triggered the run, as the forge names it. */
  eventRaw?: string
  branch?: string
  sha?: string
  url?: string
  actor?: Actor
  createdAt?: Date
  startedAt?: Date
  completedAt?: Date
  raw: unknown
}

export interface CiJob {
  ref: CiJobRef
  name: string
  state: CheckState
  stateRaw: string
  /** Stage or group the job belongs to, where the forge has one. */
  stage?: string
  url?: string
  startedAt?: Date
  completedAt?: Date
  raw: unknown
}

export interface CiRunQuery extends PageOptions {
  branch?: string
  /** Normalised state; forges that filter on their own names translate it. */
  state?: Exclude<CheckState, 'unknown'>
}

/** A commit addressed by its full sha. */
export interface CommitRef extends ForgeOrigin {
  repo: RepoRef
  sha: string
}

/** `'binary'` carries bytes; `'utf-8'` carries text the forge reported as text. */
export type FileEncoding = 'utf-8' | 'binary'

export interface FileMetadata {
  path: string
  /** Blob sha, where the forge reports one. */
  sha?: string
  size?: number
  /** Web page for the file at this ref, where the forge has one. */
  url?: string
}

/** A file's contents. Narrow on `encoding` to get text or bytes. */
export type FileContent
  = | FileMetadata & { encoding: 'utf-8', content: string }
    | FileMetadata & { encoding: 'binary', content: Uint8Array }

export interface FileOptions {
  /** Branch, tag or sha. Defaults to the repository's default branch. */
  ref?: string
  /**
   * `'text'` decodes as UTF-8 and rejects with {@link ContentNotTextError}
   * when the bytes are not text. Defaults to `'binary'`.
   */
  as?: 'text' | 'binary'
  signal?: AbortSignal
}

export type TreeEntryType = 'file' | 'directory' | 'symlink' | 'submodule'

export interface TreeEntry {
  /** Path from the repository root, without a leading slash. */
  path: string
  type: TreeEntryType
  sha?: string
  size?: number
  /** POSIX mode as the forge reports it, for example `100644`. */
  mode?: string
  url?: string
}

export interface TreeOptions extends PageOptions {
  /** Branch, tag or sha. Defaults to the repository's default branch. */
  ref?: string
  /** Subdirectory to list; the root when omitted. */
  path?: string
  /** Every descendant rather than one level. Unsupported on some forges, which then warn. */
  recursive?: boolean
}

export interface Branch {
  name: string
  sha: string
  isDefault?: boolean
  isProtected?: boolean
  url?: string
  raw: unknown
}

export interface Tag {
  name: string
  /** Commit the tag points at, after dereferencing an annotated tag where the forge does so. */
  sha: string
  url?: string
  raw: unknown
}

/** Git authorship, with the forge account behind it where the forge matched one. */
export interface CommitSignature {
  actor?: Actor
  name?: string
  email?: string
  date?: Date
}

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed'

export interface ChangedFile {
  path: string
  /** Path before a rename or copy. */
  previousPath?: string
  status: FileStatus
  statusRaw?: string
  additions?: number
  deletions?: number
  /** Unified diff for the file, where the forge returns one inline. */
  patch?: string
  /** Blob sha after the change. */
  sha?: string
  isBinary?: boolean
}

export interface Commit {
  ref: CommitRef
  sha: string
  message: string
  author?: CommitSignature
  committer?: CommitSignature
  parents: string[]
  url?: string
  stats?: { additions: number, deletions: number, total?: number }
  /** Present on `contents.commit`; absent from listings. */
  files?: ChangedFile[]
  raw: unknown
}

export interface CommitQuery extends PageOptions {
  /** Branch, tag or sha to walk back from. */
  ref?: string
  since?: Date
  until?: Date
  /** Only commits touching this path. */
  path?: string
  /** Login or email, as the forge matches it. */
  author?: string
}

export interface Comparison {
  base: string
  head: string
  aheadBy?: number
  behindBy?: number
  commits: Commit[]
  files: ChangedFile[]
  /** The merge base, where the forge reports it. */
  mergeBaseSha?: string
  raw: unknown
}

/** A release asset, addressable for download with `releases.downloadAsset`. */
export interface ReleaseAssetRef extends ForgeOrigin {
  repo: RepoRef
  release: ReleaseRef
  /** Forge-native asset id; the asset name, or the link id, on forges that have no asset id. */
  id: string
}

export interface ReleaseAsset {
  /** Absent where the forge publishes a download URL but nothing to address the asset by. */
  ref?: ReleaseAssetRef
  name: string
  url: string
  size?: number
  downloadCount?: number
  contentType?: string
}

export interface Release {
  ref: ReleaseRef
  name?: string
  tag: string
  body?: string
  isDraft: boolean
  isPrerelease: boolean
  author?: Actor
  publishedAt?: Date
  createdAt?: Date
  url?: string
  assets?: ReleaseAsset[]
  raw: unknown
}

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown'

export interface SecurityAlert {
  ref: SecurityAlertRef
  kind: SecurityAlertKind
  kindRaw: string
  severity: SecuritySeverity
  severityRaw?: string
  state: 'open' | 'fixed' | 'dismissed' | 'unknown'
  stateRaw: string
  title: string
  /** `ecosystem` is absent where the forge reports only the package name. */
  package?: { ecosystem?: string, name: string, vulnerableRange?: string, fixedIn?: string }
  url?: string
  createdAt?: Date
  updatedAt?: Date
  dismissedAt?: Date
  raw: unknown
}

export interface SecurityAlertListOptions extends PageOptions {
  /** Omitted lists every kind the provider can read, one after another. */
  kind?: Exclude<SecurityAlertKind, 'other'>
  /** Defaults to `'open'`. `'closed'` is fixed or dismissed. */
  state?: 'open' | 'closed' | 'all'
}

/** The warning codes providers emit; providers may add codes in a minor release. */
export type ForgeWarningCode
  = | 'checks_unreadable'
    | 'collaborators_unreachable'
    | 'discussion_unresolved'
    | 'filter_unsupported'
    | 'index_possibly_stale'
    | 'insufficient_scope'
    | 'kind_unsupported'
    | 'notifications_failed'
    | 'record_unreachable'
    | 'recursive_unsupported'
    | 'search_failed'
    | 'sort_unsupported'
    | 'state_record_unreachable'
    | 'thread_unreadable'
    | 'thread_unresolved'
    | 'tree_truncated'
    | (string & {})

/** A non-fatal problem encountered while producing a result. */
export interface ForgeWarning {
  /** Stable machine-readable code. */
  code: ForgeWarningCode
  message: string
  /** Key or URI of the item the warning concerns, when it concerns one. */
  subject?: string
  cause?: { name: string, message: string, status?: number }
}

export interface Thread {
  ref: ThreadRef
  kind: ThreadKind
  title: string
  body?: string
  state: ThreadState
  /** Forge-native state string the normalised `state` was derived from. */
  stateRaw?: string
  /** Forge-native state qualifier, for example `completed` or `not_planned`. */
  stateReason?: string
  isDraft: boolean
  author?: Actor
  assignees: Actor[]
  /**
   * Reviewers the thread read reports. Some forges report outstanding requests
   * only, others each reviewer's verdict; `threads.reviews()` has every
   * submitted review.
   */
  reviewers: Reviewer[]
  labels: Label[]
  url?: string
  createdAt?: Date
  updatedAt?: Date
  closedAt?: Date
  /** Latest activity the forge reports for the thread. */
  lastActivityAt?: Date
  locked?: boolean
  commentCount?: number
  /** Everyone who authored or commented on the thread, where the forge reports them. */
  participants?: Actor[]
  /** Whether the authenticated account has read the thread, where the forge tracks it per thread. */
  readState?: 'read' | 'unread'
  /** The authenticated account's subscription, where the thread read already carries it. */
  subscription?: SubscriptionState
  milestone?: Milestone
  reactions?: ReactionSummary
  /** Pull requests only. */
  branches?: PullBranches
  /** Pull requests only. */
  checks?: ChecksSummary
  /** Pull requests in a stack: a chain of dependent pull requests, each based on the one before. */
  stack?: ThreadStack
  /** Non-fatal problems hit while reading the thread, for example an unreachable record. */
  warnings?: ForgeWarning[]
  /** Unnormalised forge payload, retained for fidelity. */
  raw: unknown
}

/** Reference to a comment on a thread. */
export interface CommentRef extends ForgeOrigin {
  thread: ThreadRef
  /** Forge-native comment id; an AT-URI on Tangled. */
  id: string
}

export interface Comment {
  ref: CommentRef
  body: string
  author?: Actor
  createdAt?: Date
  updatedAt?: Date
  url?: string
  reactions?: ReactionSummary
  raw: unknown
}

export type SubscriptionState = 'subscribed' | 'ignored' | 'none'

export type EventKind
  = | 'comment'
    | 'review'
    | 'review_comment'
    | 'commit'
    | 'label'
    | 'state_change'
    | 'assignment'
    | 'mention'
    | 'referenced'
    | 'reaction'
    | 'push'
    | 'ref'
    | 'repo'
    | 'installation'
    | 'membership'
    | 'release'
    | 'other'

export interface PushCommit {
  sha: string
  message?: string
  author?: string
  url?: string
}

/**
 * What happened, independent of `kind`, so "anything that closed" is
 * `action === 'closed'` whatever the subject.
 */
export type EventAction
  = | 'opened'
    | 'closed'
    | 'reopened'
    | 'merged'
    | 'edited'
    | 'created'
    | 'deleted'
    | 'submitted'
    | 'labelled'
    | 'unlabelled'
    | 'assigned'
    | 'unassigned'
    | 'review_requested'
    | 'synchronised'
    | 'ready_for_review'
    | 'converted_to_draft'
    | 'published'
    | 'renamed'
    | 'transferred'
    | 'archived'
    | 'unarchived'
    | 'added'
    | 'removed'
    | 'other'

/** Typed detail for an event. Discriminated by `type`. */
export type EventDetail
  = | { type: 'comment', comment?: CommentRef, body?: string }
    | { type: 'review_comment', comment?: CommentRef, body?: string, path?: string, line?: number }
    | { type: 'review', state: ReviewState, stateRaw?: string, body?: string }
    | { type: 'state_change', state?: ThreadState, draft?: boolean }
    | { type: 'label', label: string }
    | { type: 'assignment', assignee?: Actor }
    | { type: 'push', ref: string, before?: string, after?: string, commitCount: number, forced: boolean, commits: PushCommit[] }
    | { type: 'ref', ref: string, refType: 'branch' | 'tag' | (string & {}) }
    | { type: 'repo_renamed', from: string, to: string }
    | { type: 'repo_transferred', fromOwner?: string, toOwner?: string }
    | { type: 'repo_archived', archived: boolean }
    | { type: 'installation', actionRaw: string, installationId?: string, added: RepoRef[], removed: RepoRef[] }
    | { type: 'membership', actionRaw: string, member?: Actor }
    | { type: 'release', release: ReleaseRef, name?: string }
    /** A cross-reference: another thread or commit mentioned this one. */
    | { type: 'referenced', from?: ThreadRef | CommitRef, fromRepo?: RepoRef, text?: string }

export interface ForgeEvent extends ForgeOrigin {
  id: string
  kind: EventKind
  /** Forge-native event name the normalised `kind` was derived from. */
  kindRaw?: string
  /** Normalised verb; `other` when the forge's wording has no equivalent. */
  action: EventAction
  /** Forge-native verb `action` was derived from. */
  actionRaw?: string
  /** Single line describing the event, suitable for a list row. */
  summary: string
  occurredAt: Date
  actor?: Actor
  repo?: RepoRef
  thread?: ThreadRef
  detail?: EventDetail
  /** App installation the delivery belongs to, for app webhooks. */
  installationId?: string
  /** Delivery mechanism the event arrived through. */
  source: SourceKind
  /** Unnormalised forge payload, retained for fidelity. */
  payload: unknown
}

/** A {@link ForgeEvent} as a provider builds it; core derives `action` when it is absent. */
export type ForgeEventInput = Omit<ForgeEvent, 'action'> & { action?: EventAction }

export type SourceKind = 'poll' | 'webhook' | 'subscribe'

/**
 * Why a notification was delivered. `'unknown'` covers forges that report no
 * reason and native reasons with no normalised equivalent; `reasonRaw` keeps
 * the original.
 */
export type NotificationReason
  = | 'access_requested'
    | 'approval_requested'
    | 'assigned'
    | 'author'
    | 'ci_activity'
    | 'comment'
    | 'followed'
    | 'invitation'
    | 'manual'
    | 'mention'
    | 'merge_blocked'
    | 'review_requested'
    | 'review_submitted'
    | 'security_alert'
    | 'starred'
    | 'state_change'
    | 'subscribed'
    | 'team_mention'
    | 'unknown'

/** What a notification is about. Not every notification concerns a thread. */
export type NotificationSubject
  = | { type: 'thread', thread: ThreadRef }
    | { type: 'repo', repo: RepoRef }
    | { type: 'actor', actor: Actor }
    | { type: 'release', release: ReleaseRef }
    | { type: 'security_alert', alert: SecurityAlertRef }
    | { type: 'other', typeRaw: string, repo?: RepoRef, id?: string, url?: string }

export interface Notification {
  ref: NotificationRef
  subject: NotificationSubject
  reason: NotificationReason
  /** Forge-native reason string. Absent when the forge reports no reason at all. */
  reasonRaw?: string
  /** Forge-native subject type, for example `PullRequest`, `Release` or `followed`. */
  subjectTypeRaw?: string
  unread: boolean
  title: string
  /** State of a thread subject as reported by the notification payload. */
  subjectState: ThreadState
  subjectStateRaw?: string
  updatedAt: Date
  lastReadAt?: Date
  url?: string
  /** Unnormalised forge payload, retained for fidelity. */
  raw: unknown
}

/**
 * Opaque-ish resumption token. Fields are optional because forges differ in
 * what they support; callers should persist the whole object and hand it back.
 */
export interface Cursor {
  /** Absolute URL of the next page, from a `Link` header or the body, on the requested origin. */
  nextUrl?: string
  etag?: string
  /** Opaque forge-native cursor, for example a GraphQL `endCursor`. */
  token?: string
}

/** Request budget the forge reported on the response, where it reports one. */
export interface RateLimit {
  limit?: number
  remaining?: number
  /** When `remaining` resets. */
  resetAt?: Date
}

export interface Page<T> {
  items: T[]
  /** From the response headers of the request behind this page. */
  rateLimit?: RateLimit
  /** Absent when the listing is exhausted. */
  cursor?: Cursor
  /**
   * Validator of the first page, where the forge supports conditional
   * requests. Pass it back as `cursor: { etag }` to read the first page again.
   */
  etag?: string
  /** True when the forge reported no change since `cursor.etag`. */
  notModified?: boolean
  warnings?: ForgeWarning[]
}

/** Options for listings that can start from a point in time: events, comments, reactions. */
export interface ListOptions extends PageOptions {
  /** Only items updated at or after this time. */
  since?: Date
}

export interface NotificationListOptions extends ListOptions {
  /** Include notifications already marked read. Defaults to `false`. */
  all?: boolean
}

export interface ThreadQuery extends PageOptions {
  /** Omitted lists every listable kind; forges that list kinds separately emit them one after another. */
  kind?: 'issue' | 'pull_request' | 'discussion'
  /**
   * Defaults to `'open'`. `'closed'` includes merged pull requests; `'merged'`
   * lists pull requests only, and lists nothing for another `kind`.
   */
  state?: 'open' | 'closed' | 'merged' | 'all'
  /** Threads carrying every one of these labels. */
  labels?: string[]
  /** Author login. */
  author?: string
  /** Assignee login. */
  assignee?: string
  /** Threads the login authored, is assigned, commented on or was mentioned in. */
  involves?: string
  /** Threads the login was mentioned in. */
  mentions?: string
  /** Milestone title, or `'none'` for threads with no milestone. */
  milestone?: string
  /** Updated at or after. */
  since?: Date
  createdAfter?: Date
  /** Defaults to `'created'`. Unsupported orders produce a warning and the forge's own order. */
  sort?: 'created' | 'updated' | 'comments'
  /** Defaults to `'desc'`. */
  direction?: 'asc' | 'desc'
}

/**
 * A structured search. Providers translate it into their own syntax; a
 * field the forge cannot filter on becomes a `filter_unsupported` warning
 * on the page rather than a filter applied client-side.
 */
export interface SearchQuery extends PageOptions {
  /** Free text, matched against title and body. */
  text?: string
  /**
   * Forge-native query syntax, added to the query as is, for qualifiers the
   * other fields don't cover. Forges whose search has no query syntax ignore
   * it with a `filter_unsupported` warning.
   */
  queryRaw?: string
  /** Limit to one repository. */
  repo?: RepoRef
  kind?: 'issue' | 'pull_request'
  /** Defaults to every state. */
  state?: 'open' | 'closed' | 'all'
  author?: string
  /** Threads the login authored, is assigned, commented on or was mentioned in. */
  involves?: string
  assignee?: string
  /** Threads carrying every one of these labels. */
  labels?: string[]
  /** Updated at or after. */
  since?: Date
  /** Defaults to the forge's relevance order. */
  sort?: 'created' | 'updated' | 'comments' | 'relevance'
  /** Defaults to `'desc'`. */
  direction?: 'asc' | 'desc'
}

export interface CommitSearchQuery extends PageOptions {
  /** Free text, matched against the commit message. */
  text?: string
  /** Forge-native query syntax; see {@link SearchQuery.queryRaw}. */
  queryRaw?: string
  /** Limit to one repository. */
  repo?: RepoRef
  /** Commits whose author is this login. */
  author?: string
  /** Commits whose committer is this login. */
  committer?: string
  /** Authored or committed at or after. */
  since?: Date
  /** Authored or committed at or before. */
  until?: Date
  /** Defaults to the forge's relevance order. */
  sort?: 'author_date' | 'committer_date'
  /** Defaults to `'desc'`. */
  direction?: 'asc' | 'desc'
}

export interface RepoSearchQuery extends PageOptions {
  text?: string
  /** Forge-native query syntax; see {@link SearchQuery.queryRaw}. */
  queryRaw?: string
  /** Limit to one account or namespace. */
  owner?: string
  language?: string
  sort?: 'created' | 'updated' | 'stars' | 'relevance'
  direction?: 'asc' | 'desc'
}

/** Options for listings that take no filters: releases, installations, labels. */
export interface PageOptions {
  perPage?: number
  /** Resume after the page that returned this cursor. */
  cursor?: Cursor
  signal?: AbortSignal
}

/** How the account is attached to the repositories it lists. */
export type RepoAffiliation = 'owner' | 'collaborator' | 'organisation_member'

export interface RepoQuery extends PageOptions {
  /** Defaults to every affiliation the forge lists. Unsupported values produce a `filter_unsupported` warning. */
  affiliation?: RepoAffiliation[]
  visibility?: RepoVisibility | 'all'
  /** Defaults to the forge's own order. Unsupported orders produce a `sort_unsupported` warning. */
  sort?: 'created' | 'updated' | 'pushed' | 'name'
  direction?: 'asc' | 'desc'
}

export interface UpsertCommentInput {
  /**
   * Identifies the comment to replace across runs. It is written into the
   * body as an HTML comment, so it is invisible when rendered but matchable
   * on the next run.
   */
  key: string
  body: string
}

export interface UpsertCommentResult {
  comment: Comment
  /** `false` when an existing comment with the same key was edited. */
  created: boolean
}

export interface ThreadCreateInput {
  kind: 'issue' | 'pull_request' | 'discussion'
  title: string
  body?: string
  labels?: string[]
  /** Logins, or actors where the forge needs ids. */
  assignees?: Array<string | Actor>
  /** Pull requests: source branch, optionally `owner:branch` for forks. */
  head?: string
  /** Pull requests: target branch. */
  base?: string
  draft?: boolean
  /** Discussions: category name or id. */
  category?: string
}

export interface ThreadUpdateInput {
  title?: string
  body?: string
}

/** One `threads.getMany()` entry, in input order; narrow on `ok`. */
export type GetManyResult
  = | { ok: true, ref: ThreadRef, thread: Thread }
    | { ok: false, ref: ThreadRef, warning: ForgeWarning }

/**
 * The hidden marker `threads.upsertComment()` writes into a comment body to
 * find it again. It renders as nothing on every forge that renders Markdown
 * as HTML.
 */
export function commentMarker(key: string): string {
  const end = ['-->', '--!>'].find(token => key.includes(token))
  if (end) {
    throw new TypeError(`Comment key ${JSON.stringify(key)} contains \`${end}\`, which would end the hidden marker early`)
  }
  return `<!-- forges:key=${key} -->`
}

/** Whether `body` carries the marker for `key`. */
export function hasCommentMarker(body: string, key: string): boolean {
  return body.includes(commentMarker(key))
}

export interface InstallationToken {
  token: string
  expiresAt: Date
  permissions: Record<string, string>
  repositorySelection?: string
}

/** Maximum lengths the forge accepts, in characters. */
export interface TextLimits {
  bodyLength?: number
  commentLength?: number
  labelLength?: number
}

const CASE_INSENSITIVE = new Set<ForgeKind>(['github', 'gitlab', 'forgejo', 'gitea', 'bitbucket', 'gitee', 'azure-devops'])

/** Whether `forge` treats owner and repository names case-insensitively. Unknown forges are assumed not to. */
export function namesAreCaseInsensitive(forge: ForgeKind): boolean {
  return CASE_INSENSITIVE.has(forge)
}

/** `repo` with `owner` and `name` lowercased where the forge ignores case, so equal repositories compare equal. */
export function normaliseRepoName(repo: RepoRef): RepoRef {
  return namesAreCaseInsensitive(repo.forge) ? { ...repo, owner: repo.owner.toLowerCase(), name: repo.name.toLowerCase() } : repo
}

/** Whether `ref` addresses an organisation, group or workspace rather than a repository. */
export function isNamespaceRef(ref: RepoRef): boolean {
  return ref.kind === 'namespace' || !ref.name
}

/**
 * Stable identity key for a repository: by `externalId` when known, so renames
 * and transfers keep the key, otherwise by path, lowercased on forges that
 * ignore case. A hand-built ref without `externalId` therefore keys
 * differently from the same repo as a provider returns it.
 */
export function repoKey(repo: RepoRef): string {
  if (repo.externalId) {
    return `${repo.forge}:${repo.instance}/@${repo.kind === 'namespace' ? 'namespace:' : ''}${repo.externalId}`
  }
  const { owner, name } = normaliseRepoName(repo)
  return repo.kind === 'namespace'
    ? `${repo.forge}:${repo.instance}/${owner}/`
    : `${repo.forge}:${repo.instance}/${owner}/${name}`
}

/**
 * Reads a {@link repoKey} back. Keys built from an `externalId` carry no path,
 * so `owner` and `name` are empty on those.
 */
export function parseRepoKey(key: string): RepoRef | undefined {
  const colon = key.indexOf(':')
  const slash = key.indexOf('/', colon + 1)
  if (colon <= 0 || slash <= colon + 1) {
    return undefined
  }
  const origin = { forge: key.slice(0, colon), instance: key.slice(colon + 1, slash) }
  const path = key.slice(slash + 1)
  if (path.startsWith('@')) {
    const namespace = path.startsWith('@namespace:')
    const externalId = path.slice(namespace ? '@namespace:'.length : 1)
    return externalId ? { ...origin, owner: '', name: '', externalId, ...namespace ? { kind: 'namespace' as const } : {} } : undefined
  }
  if (path.endsWith('/')) {
    return path.length > 1 ? { ...origin, owner: path.slice(0, -1), name: '', kind: 'namespace' } : undefined
  }
  const last = path.lastIndexOf('/')
  return last > 0 && last < path.length - 1 ? { ...origin, owner: path.slice(0, last), name: path.slice(last + 1) } : undefined
}

/** The `owner/name` people read and type; the owner alone for a namespace. */
export function repoSlug(repo: RepoRef): string {
  return repo.kind === 'namespace' ? repo.owner : `${repo.owner}/${repo.name}`
}

/** A thread ref whose number is known, and which can therefore be keyed and fetched. */
export type ResolvedThreadRef = ThreadRef & { number: string }

export function isResolvedThread(thread: ThreadRef): thread is ResolvedThreadRef {
  return typeof thread.number === 'string' && thread.number !== ''
}

/**
 * Stable identity key for a thread. `'other'` threads are keyed by their
 * forge-native type so unrelated subjects with the same id never collide.
 */
export function threadKey(thread: ResolvedThreadRef): string {
  const kind = thread.kind === 'other' ? `other:${thread.typeRaw ?? 'unknown'}` : thread.kind
  return `${repoKey(thread.repo)}#${kind}/${thread.number}`
}

export function notificationKey(ref: NotificationRef): string {
  return `${ref.forge}:${ref.instance}:notification/${ref.id}`
}

const THREAD_KINDS = new Set<string>(['issue', 'pull_request', 'discussion', 'commit'])

/** Reads a {@link threadKey} back. */
export function parseThreadKey(key: string): ResolvedThreadRef | undefined {
  const hash = key.indexOf('#')
  const repo = hash > 0 ? parseRepoKey(key.slice(0, hash)) : undefined
  const rest = key.slice(hash + 1)
  const slash = rest.indexOf('/')
  if (!repo || slash <= 0 || slash === rest.length - 1) {
    return undefined
  }
  const kindText = rest.slice(0, slash)
  const number = rest.slice(slash + 1)
  const origin = { forge: repo.forge, instance: repo.instance }
  if (kindText.startsWith('other:')) {
    return { ...origin, repo, kind: 'other', typeRaw: kindText.slice('other:'.length), number }
  }
  return THREAD_KINDS.has(kindText) ? { ...origin, repo, kind: kindText as ThreadKind, number } : undefined
}

/** Reads a {@link notificationKey} back. */
export function parseNotificationKey(key: string): NotificationRef | undefined {
  const marker = key.indexOf(':notification/')
  const colon = key.indexOf(':')
  if (colon <= 0 || marker <= colon) {
    return undefined
  }
  const id = key.slice(marker + ':notification/'.length)
  return id ? { forge: key.slice(0, colon), instance: key.slice(colon + 1, marker), id } : undefined
}

/** `acme/widgets#42`, or `acme/widgets@abc1234` for a commit; uses the display number where the forge has one. */
export function threadSlug(ref: ThreadRef): string {
  const number = ref.displayNumber ?? ref.number ?? '?'
  return ref.kind === 'commit' ? `${repoSlug(ref.repo)}@${number.slice(0, 7)}` : `${repoSlug(ref.repo)}#${number}`
}

/** The thread a notification concerns, or `undefined` for repo, actor and other subjects. */
export function notificationThread(notification: Notification): ThreadRef | undefined {
  return notification.subject.type === 'thread' ? notification.subject.thread : undefined
}

export type MergeMethod = 'merge' | 'squash' | 'rebase' | 'rebase_merge' | 'fast_forward_only'

export interface MergeOptions {
  /** Defaults to the repository's only allowed method. */
  method?: MergeMethod
  /** Expected head sha; the merge is refused if the branch has moved. */
  sha?: string
  /** Merge commit message, where the forge takes one. */
  message?: string
  /** Queue the merge until required checks pass, where the forge supports it. */
  whenChecksPass?: boolean
}

export interface ApproveAndMergeOptions extends MergeOptions {
  /** Review body sent with the approval. Rejected where approvals carry no body (Azure DevOps, Bitbucket, GitLab). */
  body?: string
}

/** An app installation on an account, with its own credential scope. */
export interface Installation extends ForgeOrigin {
  id: string
  account?: Actor
  /** Forge-native target type, for example `Organization` or `User`. */
  targetTypeRaw?: string
  /** Forge-native repository selection, for example `all` or `selected`. */
  repositorySelectionRaw?: string
  raw: unknown
}

/** Every `Date` field in the model, by name. */
export const DATE_FIELDS: ReadonlySet<string> = new Set(['closedAt', 'completedAt', 'createdAt', 'date', 'deliveredAt', 'dismissedAt', 'dueOn', 'expiresAt', 'lastActivityAt', 'lastReadAt', 'occurredAt', 'publishedAt', 'pushedAt', 'resetAt', 'startedAt', 'submittedAt', 'updatedAt'])

const UNNORMALISED_FIELDS: ReadonlySet<string> = new Set(['payload', 'raw'])

/**
 * Turns the ISO strings `JSON.stringify` left in a model value back into
 * `Date`s, at any depth, for every field in {@link DATE_FIELDS}, skipping
 * `raw` and `payload`. Returns a copy.
 */
export function reviveDates<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => reviveDates(item)) as T
  }
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveField(key, item)])) as T
}

function reviveField(key: string, item: unknown): unknown {
  if (UNNORMALISED_FIELDS.has(key)) {
    return item
  }
  if (DATE_FIELDS.has(key) && typeof item === 'string' && !Number.isNaN(Date.parse(item))) {
    return new Date(item)
  }
  return reviveDates(item)
}
