import type { AlertKind, SupportInput, VerbKind } from '../define.ts'
import type {
  Actor,
  AuthorAssociation,
  ChangedFile,
  Check,
  ChecksSummary,
  CheckState,
  CiJob,
  CiRun,
  CiRunRef,
  CodeMatch,
  Comment,
  CommentRef,
  Commit,
  CommitFilesInput,
  Cursor,
  EventAction,
  EventDetail,
  EventKind,
  FileStatus,
  ForgeEvent,
  ForgeEventInput,
  ForgeKind,
  Label,
  ListOptions,
  Notification,
  NotificationReason,
  Page,
  RateLimit,
  Reaction,
  Release,
  ReleaseRef,
  Repo,
  RepoRef,
  ResolvedThreadRef,
  Review,
  ReviewComment,
  ReviewEvent,
  ReviewInput,
  ReviewState,
  SecurityAlert,
  SecurityAlertKind,
  SecurityAlertListOptions,
  SecuritySeverity,
  SubscriptionState,
  Thread,
  ThreadKind,
  ThreadRef,
  ThreadState,
  TreeEntry,
  Webhook,
  WebhookEventType,
  WebhookRef,
} from '../model.ts'
import type { BulkNotificationOptions, ForgeCapabilities, ForgeOptionsBase, ForgeProvider, ForgeProviderFactory, ForgeVerb, HideCommentReason, SubscribeOptions } from '../provider.ts'
import { toFileContent } from '../contents.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { BranchMovedError, ForbiddenError, ForgeApiError, ForgeNetworkError, ForgeTimeoutError, MergeBlockedError, MergeConflictError, NotFoundError, RateLimitedError, SubscriptionClosedError } from '../errors.ts'
import { completeEvent } from '../events.ts'
import { sleep } from '../fetch.ts'
import { capabilityOf } from '../supports.ts'
import { getManyConcurrently, requireThread } from '../utils.ts'
import { verifyHmacSignature } from '../webhooks.ts'

/** A repository to seed, as `owner/name` plus whatever the test cares about. */
export interface FakeRepoSeed {
  /** The repository as `owner/name`. */
  repo: string
  description?: string
  /**
   * The default branch.
   * @default main
   */
  defaultBranch?: string
  /**
   * @default public
   */
  visibility?: Repo['visibility']
  /** Names of the labels that the repository defines. */
  labels?: string[]
}

/** An issue, pull request or discussion to seed. */
export interface FakeThreadSeed {
  /** The repository as `owner/name`. */
  repo: string
  kind: Exclude<ThreadKind, 'other' | 'commit'>
  /** Defaults to the next free number in the repository. */
  number?: number
  title: string
  body?: string
  /**
   * @default open
   */
  state?: ThreadState
  isDraft?: boolean
  /** The login of the author. Defaults to the viewer. */
  author?: string
  authorAssociation?: AuthorAssociation
  labels?: string[]
  assignees?: string[]
  /** The title of the milestone the thread belongs to. */
  milestone?: string
  comments?: Array<{ body: string, author?: string, authorAssociation?: AuthorAssociation }>
  checks?: Array<{ name: string, state: CheckState }>
  /** Files the pull request changes. */
  files?: Array<{ path: string, status?: FileStatus, additions?: number, deletions?: number, patch?: string }>
  /** Shas of seeded commits on the pull request. */
  commits?: string[]
  /** The head branch of a pull request. `sha` defaults to the last of `commits`. */
  head?: { ref?: string, sha?: string }
  /**
   * Whether `threads.merge()` can merge the pull request.
   * @default clean
   */
  mergeable?: FakeMergeability
}

/**
 * Whether a pull request can merge: `blocked` rejects a merge with
 * `MergeBlockedError`, and `conflict` rejects a merge or a branch update with `MergeConflictError`.
 */
export type FakeMergeability = 'clean' | 'blocked' | 'conflict'

/** A delay in milliseconds for every request, or a function of the verb, which names a listing by its page, such as `threads.commentsPage`. */
export type FakeLatency = number | ((verb: ForgeVerb) => number)

/**
 * A request budget that every request spends, starting a new window once `window` elapses on the clock.
 * `provider.rateLimits()` reports it as the latest request left it, until its window ends.
 */
export interface FakeRateLimit {
  /** Requests per window. */
  limit: number
  /** Requests left in the first window. Defaults to `limit`. */
  remaining?: number
  /**
   * Length of a window in milliseconds.
   * @default 3600000
   */
  window?: number
}

/** Options for `failNext()`. */
export interface FakeFailureOptions {
  /**
   * Applies the write to the store before rejecting, as when a request times
   * out after the forge received it.
   * @default false
   */
  applied?: boolean
  /**
   * How many calls in a row reject.
   * @default 1
   */
  times?: number
}

/** A CI run to seed, with its jobs and their logs. */
export interface FakeRunSeed {
  /** The repository as `owner/name`. */
  repo: string
  name: string
  state?: CheckState
  branch?: string
  sha?: string
  jobs?: Array<{ name: string, state?: CheckState, log?: string }>
}

/** A file to seed into a repository, at `ref` or on every ref. */
export interface FakeFileSeed {
  /** The repository as `owner/name`. */
  repo: string
  path: string
  /** Text, or bytes for a binary file. */
  content: string | Uint8Array
  /** Branch, tag or sha the file exists at. Defaults to every ref. */
  ref?: string
}

/** A commit to seed, with the files it changed. */
export interface FakeCommitSeed {
  /** The repository as `owner/name`. */
  repo: string
  sha: string
  message: string
  author?: string
  parents?: string[]
  committedAt?: Date
  files?: Array<{ path: string, status?: FileStatus, additions?: number, deletions?: number, patch?: string }>
}

/** A notification to seed, for an issue or pull request that is seeded as well. */
export interface FakeNotificationSeed {
  /** The repository as `owner/name`. */
  repo: string
  /** The number of the thread the notification is about. */
  number: number
  /** Why the viewer got the notification. */
  reason?: NotificationReason
  /**
   * @default true
   */
  unread?: boolean
}

/** A release to seed. */
export interface FakeReleaseSeed {
  /** The repository as `owner/name`. */
  repo: string
  tag: string
  name?: string
  body?: string
  isDraft?: boolean
  isPrerelease?: boolean
  /** The release is immutable, so its tag and target cannot change. */
  immutable?: boolean
  publishedAt?: Date
  assets?: Array<{ name: string, content: string | Uint8Array, contentType?: string }>
}

/** A security alert to seed. Alerts of each kind are numbered separately, from 1. */
export interface FakeSecurityAlertSeed {
  /** The repository as `owner/name`. */
  repo: string
  kind: Exclude<SecurityAlertKind, 'other'>
  title: string
  /**
   * @default medium
   */
  severity?: SecuritySeverity
  /**
   * @default open
   */
  state?: 'open' | 'fixed' | 'dismissed'
  package?: SecurityAlert['package']
}

/** The data a fake forge starts with. */
export interface FakeSeed {
  repos?: FakeRepoSeed[]
  files?: FakeFileSeed[]
  commits?: FakeCommitSeed[]
  runs?: FakeRunSeed[]
  threads?: FakeThreadSeed[]
  notifications?: FakeNotificationSeed[]
  releases?: FakeReleaseSeed[]
  securityAlerts?: FakeSecurityAlertSeed[]
}

/** Support for one verb: a level, or a level per thread kind for per-kind verbs. */
export type FakeSupport = SupportInput | Partial<Record<VerbKind, SupportInput>>

/** Options for `fake()`. */
export interface FakeOptions extends Omit<ForgeOptionsBase, 'fetch'> {
  /**
   * @default fake
   */
  forge?: ForgeKind
  /**
   * Login of the authenticated account; authors every write.
   * @default fake-user
   */
  viewer?: string
  seed?: FakeSeed
  /** Overrides the default support of individual verbs. */
  support?: Partial<Record<ForgeVerb, FakeSupport>>
  /** Support to copy from a real provider, such as `github().create().capabilities`. `support` wins where both set a verb. */
  capabilities?: ForgeCapabilities
  /** The clock behind every timestamp the forge writes and every rate limit window. Defaults to the system time. */
  now?: () => Date
  /** How long each request takes. A request slower than `timeout` rejects with `ForgeTimeoutError`. */
  latency?: FakeLatency
  /** A request budget. Without one, requests are unlimited. */
  rateLimit?: FakeRateLimit
}

interface FakeRunState {
  run: CiRun
  jobs: Array<{ job: CiJob, log: string }>
}

interface FakeThreadState {
  thread: Thread
  files: ChangedFile[]
  commits: string[]
  comments: Comment[]
  /** Reactions on the thread, keyed by comment id, with `''` for the thread itself. */
  reactions: Map<string, Reaction[]>
  checks: Check[]
  reviews: Review[]
  subscription: SubscriptionState
  /** Whether `threads.merge()` can merge the pull request. */
  mergeable: FakeMergeability
  /** The reasons that `threads.hideComment()` gave, keyed by comment id. */
  hidden: Map<string, HideCommentReason>
}

/** The in-memory state behind a fake forge. Mutate it to set up a test, read it to assert. */
export interface FakeStore {
  /** Every repository with its threads, releases, runs, files and commits, keyed by `owner/name`. */
  repos: Map<string, {
    repo: Repo
    labels: string[]
    threads: Map<string, FakeThreadState>
    releases: Release[]
    statuses: Map<string, Check[]>
    runs: FakeRunState[]
    /** Seeded file bytes, keyed by `<ref>:<path>`, with `*` for a file on every ref. */
    files: Map<string, Uint8Array>
    commits: Commit[]
    /** The head of each branch that `contents.commitFiles()` wrote to. A branch other than the default one holds only its own `<branch>:<path>` files. */
    branches: Map<string, string>
    /** Seeded release asset bytes, keyed by `<releaseId>:<assetName>`. */
    assets: Map<string, Uint8Array>
    securityAlerts: SecurityAlert[]
  }>
  notifications: Notification[]
  /** Every event a write produced, in order. */
  events: ForgeEvent[]
  /** Registered webhooks. Secrets are held separately and never readable. */
  webhooks: Webhook[]
  /** The logins each organisation blocks, keyed by its login, and those each viewer blocks, keyed by theirs. */
  blocks: Map<string, Set<string>>
}

/** Every normalised kind the fake forge records, so a test can subscribe to any of them. */
const FAKE_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment' },
  { kind: 'state_change' },
  { kind: 'label' },
  { kind: 'assignment' },
  { kind: 'review' },
  { kind: 'push' },
]

/**
 * What `fake()` returns: a provider factory that also exposes the store and
 * controls the network between the providers and the store. Every provider
 * that `create()` returns shares both.
 */
export interface FakeForgeFactory extends ForgeProviderFactory<ForgeProvider> {
  /** The in-memory state of the forge. Results are copies, so changing one leaves the store as it was. */
  readonly store: FakeStore
  /**
   * Rejects the next call of `verb` with `error`. A listing and its page
   * share a verb, so `threads.comments` also fails `threads.commentsPage`.
   * Verbs that core builds from other requests, such as an emulated
   * `threads.getComment`, fail through those requests.
   * @param verb The verb whose next call rejects.
   * @param error The error to reject with, or a function that creates one for each call.
   * @param options Whether the write lands first, and how many calls reject.
   * @throws {TypeError} For a verb that sends no request of its own, or that the fake forge does not implement.
   * @example
   * ```ts
   * factory.failNext('threads.comment', new ForgeTimeoutError('Timed out', 30_000), { applied: true })
   * ```
   */
  failNext: (verb: ForgeVerb, error: Error | (() => Error), options?: FakeFailureOptions) => void
  /** Rejects every request with `ForgeNetworkError` until `online()`, and closes open subscriptions with `SubscriptionClosedError`. */
  offline: () => void
  /** Ends `offline()`. */
  online: () => void
  /** Replaces the `latency` option. `undefined` removes the delay. */
  setLatency: (latency: FakeLatency | undefined) => void
  /** Replaces the `rateLimit` option and starts a new window, which `rateLimits()` reports from the next request. `undefined` removes the budget. */
  setRateLimit: (budget: FakeRateLimit | undefined) => void
  /**
   * A provider on the same store whose writes are by `login`, with no notifications or subscriptions of its own.
   * A comment, review, state change or assignment by `login` notifies the viewer when it mentions the viewer,
   * assigns the viewer or requests the viewer's review, or when the viewer is subscribed to the thread. The
   * notification for the thread then becomes unread, or is added.
   * @example
   * ```ts
   * await factory.as('octocat').threads.comment(issue, 'Any news, @fake-user?')
   * ```
   */
  as: (login: string) => ForgeProvider
}

/** Verbs that send no request of their own, with what to fail instead. */
const COMPOSED_VERBS: Partial<Record<ForgeVerb, string>> = {
  'threads.getComment': 'fail threads.comments instead',
  'threads.getReview': 'fail threads.reviews instead',
  'threads.approve': 'fail threads.createReview instead',
  'ci.job': 'fail ci.jobs instead',
  'webhooks.verify': 'it runs locally',
  'webhooks.ingest': 'it runs locally',
}

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi

/** The numbers of the issues in the same repository that a pull request body names after a closing keyword, such as `Fixes #1`. */
function closedNumbers(body: string | undefined): Set<string> {
  return new Set([...(body ?? '').matchAll(CLOSING_KEYWORD)].map(match => match[1]!))
}

const ALL_KINDS: Partial<Record<VerbKind, SupportInput>> = { issue: true, pull_request: true, discussion: true, commit: true }
const WRITABLE: Partial<Record<VerbKind, SupportInput>> = { issue: true, pull_request: true, discussion: true }
const PULLS: Partial<Record<VerbKind, SupportInput>> = { pull_request: true }
const SIGNATURE_HEADER = 'x-fake-signature'

function pageOf<T>(items: T[], options: { cursor?: { token?: string }, perPage?: number } = {}): Page<T> {
  const offset = Number(options.cursor?.token ?? 0)
  const size = options.perPage ?? 30
  const next = offset + size
  return { items: items.slice(offset, next), cursor: next < items.length ? { token: String(next) } : undefined }
}

function splitRepo(slug: string): { owner: string, name: string } {
  const index = slug.lastIndexOf('/')
  return { owner: slug.slice(0, index), name: slug.slice(index + 1) }
}

/** A weak validator from an FNV-1a hash of the JSON of `value`. */
function digest(value: unknown): string {
  let hash = 0x811C9DC5
  for (const char of JSON.stringify(value)) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  }
  return `W/"${(hash >>> 0).toString(16)}"`
}

/** Gives a first page an etag, and returns an empty `notModified` page for a matching `cursor.etag`. */
function conditional<T>(page: Page<T>, options: { cursor?: Cursor }): Page<T> {
  if (options.cursor?.token) {
    return page
  }
  const etag = digest(page.items)
  return options.cursor?.etag === etag ? { items: [], notModified: true, etag } : { ...page, etag }
}

function copyOf<T>(value: T): T {
  return value instanceof ReadableStream ? value : structuredClone(value)
}

function signalOf(args: unknown[]): AbortSignal | undefined {
  for (const arg of args.toReversed()) {
    const signal = (arg as { signal?: unknown } | undefined)?.signal
    if (signal instanceof AbortSignal) {
      return signal
    }
  }
  return undefined
}

/** Reads a stored file key, `<ref>:<path>`, where the ref `*` stands for every ref. */
function splitFileKey(key: string): { ref: string, path: string } {
  const index = key.indexOf(':')
  return { ref: key.slice(0, index), path: key.slice(index + 1) }
}

/**
 * An in-memory forge implementing the whole provider surface, for testing
 * code that writes. Every write changes `store` and appends a `ForgeEvent`
 * that `threads.events()` and `sources.subscribe()` return. Webhook
 * deliveries carry normalised events as JSON, signed as `signDelivery('fake', ...)`
 * from `forges/testing` signs them.
 * @param options The data the forge starts with, and the support of individual operations.
 * @example
 * ```ts
 * import { createForges } from 'forges'
 * import { fake } from 'forges/fake'
 *
 * const factory = fake({
 *   seed: {
 *     repos: [{ repo: 'acme/widgets' }],
 *     threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Broken build' }],
 *   },
 * })
 * const forges = createForges([factory])
 * ```
 */
export function fake(options: FakeOptions = {}): FakeForgeFactory {
  const forge = options.forge ?? 'fake'
  const instance = options.instance ?? 'fake.test'
  const origin = { forge, instance }
  const viewerLogin = options.viewer ?? 'fake-user'
  const store: FakeStore = { repos: new Map(), notifications: [], events: [], webhooks: [], blocks: new Map() }
  const secrets = new Map<string, string | undefined>()
  const listeners = new Set<(event: ForgeEvent) => void>()
  const now = () => new Date(options.now?.() ?? Date.now())
  const timeout = options.timeout ?? 30_000
  const failures = new Map<string, Array<{ error: Error | (() => Error), applied: boolean, times: number }>>()
  const disconnects = new Set<() => void>()
  const sent = new Set<string>()
  let connected = true
  let latency = options.latency
  let budget: { limit: number, remaining: number, window: number, resetAt: Date } | undefined
  let seen: RateLimit | undefined
  let notificationCount = 0
  let webhookCount = 0
  const commentCounts = new WeakMap<FakeThreadState, number>()

  function setRateLimit(given: FakeRateLimit | undefined): void {
    const window = given?.window ?? 3_600_000
    budget = given && { limit: given.limit, remaining: given.remaining ?? given.limit, window, resetAt: new Date(now().getTime() + window) }
    seen = undefined
  }
  setRateLimit(options.rateLimit)

  function spend(): RateLimit | undefined {
    if (!budget) {
      return undefined
    }
    const at = now()
    if (at >= budget.resetAt) {
      budget.remaining = budget.limit
      budget.resetAt = new Date(at.getTime() + budget.window)
    }
    const exhausted = budget.remaining <= 0
    budget.remaining = Math.max(0, budget.remaining - 1)
    seen = { limit: budget.limit, remaining: budget.remaining, resetAt: new Date(budget.resetAt) }
    if (exhausted) {
      throw new RateLimitedError(`Rate limit of ${budget.limit} requests exhausted until ${budget.resetAt.toISOString()}`, 429, '', { ...origin, resetAt: new Date(budget.resetAt) })
    }
    return { ...seen, resetAt: new Date(budget.resetAt) }
  }

  function rateLimits(): RateLimit[] {
    return seen?.resetAt && now() < seen.resetAt ? [{ ...seen, resetAt: new Date(seen.resetAt) }] : []
  }

  function takeFailure(verb: string): { error: Error, applied: boolean } | undefined {
    const queue = failures.get(verb.replace(/Page$/, ''))
    const next = queue?.[0]
    if (!next) {
      return undefined
    }
    if (--next.times <= 0) {
      queue.shift()
    }
    return { error: typeof next.error === 'function' ? next.error() : next.error, applied: next.applied }
  }

  const disconnected = (verb: string) => new ForgeNetworkError(`${verb} failed: ${instance} is offline`, origin)

  /** Runs `run` as one request: offline, latency, rate limit and injected failures apply, and the result is a copy. */
  function request(verb: string, run: (...args: any[]) => any): (...args: any[]) => Promise<unknown> {
    sent.add(verb.replace(/Page$/, ''))
    return async (...args) => {
      const signal = signalOf(args)
      signal?.throwIfAborted()
      if (!connected) {
        throw disconnected(verb)
      }
      const delay = typeof latency === 'function' ? latency(verb as ForgeVerb) : latency ?? 0
      if (delay > 0) {
        await sleep(Math.min(delay, timeout), signal)
        if (delay > timeout) {
          throw new ForgeTimeoutError(`${verb} timed out after ${timeout}ms`, timeout, origin)
        }
        if (!connected) {
          throw disconnected(verb)
        }
      }
      const rateLimit = spend()
      const failure = takeFailure(verb)
      if (failure && !failure.applied) {
        throw failure.error
      }
      const result = copyOf(await run(...args))
      if (failure) {
        throw failure.error
      }
      if (!rateLimit || !result || typeof result !== 'object' || !('items' in result)) {
        return result
      }
      // GitHub does not count a 304 against the rate limit.
      if ((result as Page<unknown>).notModified && budget) {
        rateLimit.remaining = ++budget.remaining
        seen = seen && { ...seen, remaining: rateLimit.remaining }
      }
      return { ...result, rateLimit }
    }
  }

  /** Routes every declared verb of `spec` through `request()`. */
  function overNetwork<T extends object>(spec: T): T {
    for (const [group, members] of Object.entries(spec)) {
      if (group === 'traits' || group === 'sources' || !members || typeof members !== 'object') {
        continue
      }
      for (const [name, declared] of Object.entries(members as Record<string, { run?: unknown }>)) {
        if (typeof declared.run === 'function') {
          declared.run = request(`${group}.${name}`, declared.run as (...args: any[]) => any)
        }
        else if (declared.run && typeof declared.run === 'object') {
          const methods = declared.run as Record<string, (...args: any[]) => any>
          for (const [method, run] of Object.entries(methods)) {
            methods[method] = request(`${group}.${method}`, run)
          }
        }
      }
    }
    return spec
  }

  const notFound = (message: string) => new NotFoundError(message, 404, '', origin)
  const actor = (login: string): Actor => ({ ...origin, login, id: login, isBotHint: login.endsWith('[bot]') })
  const label = (name: string): Label => ({ name })
  const repoRef = (slug: string): RepoRef => ({ ...origin, ...splitRepo(slug) })
  const slugOf = (repo: RepoRef) => `${repo.owner}/${repo.name}`

  function repoState(repo: RepoRef) {
    const state = store.repos.get(slugOf(repo))
    if (!state) {
      throw notFound(`No repository ${slugOf(repo)}`)
    }
    return state
  }

  function addRepo(seed: FakeRepoSeed) {
    const ref = repoRef(seed.repo)
    store.repos.set(seed.repo, {
      repo: {
        ref,
        description: seed.description,
        defaultBranch: seed.defaultBranch ?? 'main',
        visibility: seed.visibility ?? 'public',
        isFork: false,
        isArchived: false,
        topics: [],
        url: `https://${instance}/${seed.repo}`,
        raw: seed,
      },
      labels: seed.labels ?? [],
      threads: new Map(),
      releases: [],
      statuses: new Map(),
      runs: [],
      files: new Map(),
      commits: [],
      branches: new Map(),
      assets: new Map(),
      securityAlerts: [],
    })
  }

  function releaseState(ref: ReleaseRef): Release {
    const release = repoState(ref.repo).releases.find(item => item.ref.id === ref.id || (ref.tag && item.tag === ref.tag))
    if (!release) {
      throw notFound(`No release ${ref.tag ?? ref.id}`)
    }
    return release
  }

  function requireFreeTag(releases: Release[], tag: string): void {
    if (releases.some(release => release.tag === tag)) {
      throw new ForgeApiError(`A release tagged ${tag} already exists`, 422, '', origin)
    }
  }

  function webhookState(ref: WebhookRef): Webhook {
    const hook = store.webhooks.find(item => item.ref.id === ref.id)
    if (!hook) {
      throw notFound(`No webhook ${ref.id}`)
    }
    return hook
  }

  /** A repeat rejects with status 422, as the forges that block accounts do. */
  function setBlocked(blocker: string, login: string, blocked: boolean): void {
    const logins = store.blocks.get(blocker) ?? new Set()
    if (logins.has(login) === blocked) {
      throw new ForgeApiError(`${login} is ${blocked ? 'already' : 'not'} blocked by ${blocker}`, 422, '', origin)
    }
    if (blocked) {
      logins.add(login)
    }
    else {
      logins.delete(login)
    }
    store.blocks.set(blocker, logins)
  }

  function threadsOf(repo: RepoRef, kind: ThreadKind): Thread[] {
    return [...repoState(repo).threads.values()].map(state => state.thread).filter(thread => thread.kind === kind)
  }

  function threadState(ref: ThreadRef): FakeThreadState {
    const { number } = requireThread(ref, origin)
    const state = repoState(ref.repo).threads.get(number)
    if (!state || state.thread.kind !== ref.kind) {
      throw notFound(`No ${ref.kind} ${slugOf(ref.repo)}#${ref.number}`)
    }
    return state
  }

  function addThread(seed: FakeThreadSeed): Thread {
    const repo = store.repos.get(seed.repo) ?? (addRepo({ repo: seed.repo }), store.repos.get(seed.repo)!)
    const number = String(seed.number ?? Math.max(0, ...[...repo.threads.keys()].map(Number)) + 1)
    const ref: ResolvedThreadRef = { ...origin, repo: repo.repo.ref, kind: seed.kind, number }
    const at = now()
    const thread: Thread = {
      ref,
      kind: seed.kind,
      title: seed.title,
      body: seed.body,
      state: seed.state ?? 'open',
      isDraft: seed.isDraft ?? false,
      author: actor(seed.author ?? viewerLogin),
      ...seed.authorAssociation ? { authorAssociation: seed.authorAssociation } : {},
      assignees: (seed.assignees ?? []).map(actor),
      reviewers: [],
      labels: (seed.labels ?? []).map(label),
      ...seed.milestone === undefined ? {} : { milestone: { id: seed.milestone, title: seed.milestone, state: 'open' as const, raw: { title: seed.milestone } } },
      url: `https://${instance}/${seed.repo}/${seed.kind === 'pull_request' ? 'pull' : seed.kind === 'discussion' ? 'discussions' : 'issues'}/${number}`,
      createdAt: at,
      updatedAt: at,
      commentCount: seed.comments?.length ?? 0,
      ...seed.kind === 'pull_request' ? { branches: { head: { ref: seed.head?.ref ?? `patch-${number}`, sha: seed.head?.sha ?? seed.commits?.at(-1) }, base: { ref: repo.repo.defaultBranch ?? 'main' } } } : {},
      raw: seed,
    }
    const comments = (seed.comments ?? []).map((comment, index): Comment => ({
      ref: { ...origin, thread: ref, id: `${number}-${index + 1}` },
      body: comment.body,
      author: actor(comment.author ?? viewerLogin),
      ...comment.authorAssociation ? { authorAssociation: comment.authorAssociation } : {},
      createdAt: at,
      raw: comment,
    }))
    const checks = (seed.checks ?? []).map((check, index): Check => ({
      ref: { ...origin, repo: ref.repo, id: `${number}-check-${index + 1}`, type: 'check_run' },
      name: check.name,
      state: check.state,
      stateRaw: check.state,
      raw: check,
    }))
    if (checks.length) {
      thread.checks = { state: summaryState(checks), stateRaw: summaryState(checks), total: checks.length, failed: checks.filter(check => check.state === 'failure').length }
    }
    const files = (seed.files ?? []).map((file): ChangedFile => ({
      path: file.path,
      status: file.status ?? 'modified',
      statusRaw: file.status ?? 'modified',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      patch: file.patch,
    }))
    const state: FakeThreadState = { thread, files, commits: seed.commits ?? [], comments, reactions: new Map(), checks, reviews: [], subscription: 'subscribed', mergeable: seed.mergeable ?? 'clean', hidden: new Map() }
    repo.threads.set(number, state)
    commentCounts.set(state, comments.length)
    return thread
  }

  function mentioned(thread: Thread, comments: Comment[], login: string): boolean {
    return [thread.body, ...comments.map(comment => comment.body)].some(body => mentions(body, login))
  }

  function mentions(body: string | undefined, login: string): boolean {
    return body !== undefined && new RegExp(`(?:^|[^\\w@])@${login.replace(/\W/g, '\\$&')}(?![\\w-])`, 'i').test(body)
  }

  function involved(thread: Thread, comments: Comment[], login: string): boolean {
    return thread.author?.login === login
      || thread.assignees.some(item => item.login === login)
      || comments.some(comment => comment.author?.login === login)
      || mentioned(thread, comments, login)
  }

  function inBulk(notification: Notification, bulk: BulkNotificationOptions): boolean {
    const repo = notification.subject.type === 'thread' ? notification.subject.thread.repo : 'repo' in notification.subject ? notification.subject.repo : undefined
    return (!bulk.repo || (repo !== undefined && slugOf(repo) === slugOf(bulk.repo)))
      && (!bulk.before || notification.updatedAt < bulk.before)
  }

  function summaryState(checks: Check[]): ChecksSummary['state'] {
    if (checks.some(check => check.state === 'failure')) {
      return 'failure'
    }
    if (checks.some(check => check.state === 'pending')) {
      return 'pending'
    }
    return checks.every(check => check.state === 'success' || check.state === 'neutral') ? 'success' : 'unknown'
  }

  /** The recorded events that `match`, newest first, as a feed reads them. */
  function feed(match: (event: ForgeEvent) => boolean): ForgeEvent[] {
    return store.events.filter(match).toReversed().map(event => polled(event, 'feed'))
  }

  /** Each listing gives an event an id of its own. */
  function polled(event: ForgeEvent, listing: 'feed' | 'timeline'): ForgeEvent {
    return { ...event, id: `${listing}-${event.id}`, source: 'poll' }
  }

  function record(by: string, thread: ThreadRef, kind: EventKind, action: EventAction, summary: string, detail?: EventDetail): void {
    const event = completeEvent({
      ...origin,
      id: String(store.events.length + 1),
      kind,
      action,
      actionRaw: action,
      summary: `${by} ${summary}`,
      occurredAt: now(),
      actor: actor(by),
      repo: thread.repo,
      thread,
      detail,
      source: 'subscribe',
      payload: { kind, action, detail },
    })
    store.events.push(event)
    const state = repoState(thread.repo).threads.get(String(thread.number))
    if (state) {
      state.thread.updatedAt = event.occurredAt
      state.thread.lastActivityAt = event.occurredAt
      if (by !== viewerLogin) {
        notify(state, event)
      }
    }
    for (const listener of listeners) {
      listener(event)
    }
  }

  function reasonFor(state: FakeThreadState, event: ForgeEvent): NotificationReason | undefined {
    const detail = event.detail
    if (detail?.type === 'assignment') {
      return detail.assignee?.login !== viewerLogin ? undefined : event.action === 'review_requested' ? 'review_requested' : event.action === 'assigned' ? 'assigned' : undefined
    }
    if (!['comment', 'review', 'review_comment', 'state_change'].includes(event.kind) || event.action === 'deleted') {
      return undefined
    }
    const body = detail && 'body' in detail ? detail.body : undefined
    if (mentions(body, viewerLogin)) {
      return 'mention'
    }
    if (state.subscription !== 'subscribed') {
      return undefined
    }
    return state.thread.author?.login === viewerLogin ? 'author' : state.comments.some(comment => comment.author?.login === viewerLogin) ? 'comment' : 'subscribed'
  }

  function notify(state: FakeThreadState, event: ForgeEvent): void {
    const reason = reasonFor(state, event)
    if (!reason) {
      return
    }
    const { thread } = state
    const existing = store.notifications.find(item => item.subject.type === 'thread' && slugOf(item.subject.thread.repo) === slugOf(thread.ref.repo) && item.subject.thread.number === thread.ref.number)
    const notification: Notification = existing ?? {
      ref: { ...origin, id: String(++notificationCount) },
      subject: { type: 'thread', thread: thread.ref },
      reason,
      unread: true,
      title: thread.title,
      subjectState: thread.state,
      updatedAt: event.occurredAt,
      raw: { reason },
    }
    Object.assign(notification, { reason, reasonRaw: reason, unread: true, title: thread.title, subjectState: thread.state, updatedAt: event.occurredAt })
    if (event.detail?.type === 'comment' && event.detail.comment) {
      notification.latestComment = { ...event.detail.comment, thread: thread.ref }
    }
    if (!existing) {
      store.notifications.push(notification)
    }
  }

  for (const seed of options.seed?.repos ?? []) {
    addRepo(seed)
  }
  for (const seed of options.seed?.threads ?? []) {
    addThread(seed)
  }
  for (const seed of options.seed?.releases ?? []) {
    const repo = store.repos.get(seed.repo) ?? (addRepo({ repo: seed.repo }), store.repos.get(seed.repo)!)
    const releaseRef = { ...origin, repo: repo.repo.ref, id: String(repo.releases.length + 1), tag: seed.tag }
    for (const asset of seed.assets ?? []) {
      repo.assets.set(`${releaseRef.id}:${asset.name}`, typeof asset.content === 'string' ? new TextEncoder().encode(asset.content) : asset.content)
    }
    repo.releases.push({
      ref: releaseRef,
      assets: (seed.assets ?? []).map(asset => ({
        ref: { ...origin, repo: repo.repo.ref, release: releaseRef, id: asset.name },
        name: asset.name,
        url: `https://${instance}/${seed.repo}/releases/download/${seed.tag}/${asset.name}`,
        size: (typeof asset.content === 'string' ? new TextEncoder().encode(asset.content) : asset.content).byteLength,
        contentType: asset.contentType,
      })),
      tag: seed.tag,
      name: seed.name,
      body: seed.body,
      isDraft: seed.isDraft ?? false,
      isPrerelease: seed.isPrerelease ?? false,
      immutable: seed.immutable,
      publishedAt: seed.publishedAt ?? now(),
      raw: seed,
    })
  }
  for (const seed of options.seed?.runs ?? []) {
    const repo = store.repos.get(seed.repo) ?? (addRepo({ repo: seed.repo }), store.repos.get(seed.repo)!)
    const id = String(repo.runs.length + 1)
    const ref: CiRunRef = { ...origin, repo: repo.repo.ref, id }
    repo.runs.push({
      run: {
        ref,
        name: seed.name,
        state: seed.state ?? 'success',
        stateRaw: seed.state ?? 'success',
        number: id,
        branch: seed.branch ?? repo.repo.defaultBranch,
        sha: seed.sha,
        createdAt: now(),
        raw: seed,
      },
      jobs: (seed.jobs ?? []).map((job, index) => ({
        job: {
          ref: { ...origin, repo: repo.repo.ref, id: `${id}-${index + 1}`, run: ref },
          name: job.name,
          state: job.state ?? seed.state ?? 'success',
          stateRaw: job.state ?? seed.state ?? 'success',
          raw: job,
        },
        log: job.log ?? '',
      })),
    })
  }
  for (const seed of options.seed?.files ?? []) {
    const repo = store.repos.get(seed.repo) ?? (addRepo({ repo: seed.repo }), store.repos.get(seed.repo)!)
    repo.files.set(`${seed.ref ?? '*'}:${seed.path}`, typeof seed.content === 'string' ? new TextEncoder().encode(seed.content) : seed.content)
  }
  for (const seed of options.seed?.commits ?? []) {
    const repo = store.repos.get(seed.repo) ?? (addRepo({ repo: seed.repo }), store.repos.get(seed.repo)!)
    const files = (seed.files ?? []).map((file): ChangedFile => ({
      path: file.path,
      status: file.status ?? 'modified',
      statusRaw: file.status ?? 'modified',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      patch: file.patch,
    }))
    repo.commits.push({
      ref: { ...origin, repo: repo.repo.ref, sha: seed.sha },
      sha: seed.sha,
      message: seed.message,
      author: { actor: actor(seed.author ?? viewerLogin), name: seed.author ?? viewerLogin, date: seed.committedAt ?? now() },
      parents: seed.parents ?? [],
      stats: {
        additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
        deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
      },
      files,
      raw: seed,
    })
  }
  for (const seed of options.seed?.notifications ?? []) {
    const state = store.repos.get(seed.repo)?.threads.get(String(seed.number))
    if (!state) {
      throw new Error(`Notification seed references unknown thread ${seed.repo}#${seed.number}`)
    }
    store.notifications.push({
      ref: { ...origin, id: String(++notificationCount) },
      subject: { type: 'thread', thread: state.thread.ref },
      reason: seed.reason ?? 'subscribed',
      reasonRaw: seed.reason ?? 'subscribed',
      unread: seed.unread ?? true,
      title: state.thread.title,
      subjectState: state.thread.state,
      updatedAt: now(),
      raw: seed,
    })
  }

  for (const seed of options.seed?.securityAlerts ?? []) {
    const repo = store.repos.get(seed.repo) ?? (addRepo({ repo: seed.repo }), store.repos.get(seed.repo)!)
    const id = String(repo.securityAlerts.filter(alert => alert.kind === seed.kind).length + 1)
    const severity = seed.severity ?? 'medium'
    const state = seed.state ?? 'open'
    const at = now()
    repo.securityAlerts.push({
      ref: { ...origin, repo: repo.repo.ref, id, kind: seed.kind, severityRaw: severity },
      kind: seed.kind,
      kindRaw: seed.kind,
      severity,
      severityRaw: severity,
      state,
      stateRaw: state,
      title: seed.title,
      package: seed.package,
      url: `https://${instance}/${seed.repo}/security/${seed.kind}/${id}`,
      createdAt: at,
      updatedAt: at,
      ...state === 'dismissed' ? { dismissedAt: at } : {},
      raw: seed,
    })
  }

  const givenSupport = (name: ForgeVerb): FakeSupport | undefined => options.support?.[name] ?? (options.capabilities && capabilityOf(options.capabilities, name))
  const support = (name: ForgeVerb, fallback: SupportInput): SupportInput => {
    const given = givenSupport(name)
    return given === undefined || typeof given === 'object' ? fallback : given
  }
  const kinds = (name: ForgeVerb, fallback: Partial<Record<VerbKind, SupportInput>>): Partial<Record<VerbKind, SupportInput>> => {
    const given = givenSupport(name)
    if (given === undefined) {
      return fallback
    }
    return typeof given === 'object' ? given : Object.fromEntries(Object.keys(fallback).map(kind => [kind, given]))
  }

  type RepoState = ReturnType<typeof repoState>
  let commitCount = 0

  const defaultBranchOf = (state: RepoState) => state.repo.defaultBranch ?? 'main'

  /** A branch that `commitFiles()` created holds only its own files, rather than falling back on `*`. */
  const ownFiles = (state: RepoState, ref: string | undefined) => ref !== undefined && ref !== defaultBranchOf(state) && state.branches.has(ref)

  function headOf(state: RepoState, branch: string): string | undefined {
    return state.branches.get(branch) ?? (branch === defaultBranchOf(state) ? state.commits.at(-1)?.sha ?? '0'.repeat(40) : undefined)
  }

  function readFile(state: RepoState, ref: string | undefined, path: string): Uint8Array | undefined {
    return ownFiles(state, ref)
      ? state.files.get(`${ref}:${path}`)
      : state.files.get(`${ref ?? '*'}:${path}`) ?? state.files.get(`*:${path}`)
  }

  function commitFiles(by: string, repo: RepoRef, input: CommitFilesInput): Commit {
    const state = repoState(repo)
    const main = defaultBranchOf(state)
    if (!state.branches.has(main)) {
      state.branches.set(main, headOf(state, main)!)
    }
    const head = headOf(state, input.branch)
    const from = input.createFrom
    if (from !== undefined && head !== undefined) {
      throw new ForgeApiError(`Branch ${input.branch} already exists`, 422, '', origin)
    }
    const parent = from === undefined ? head : headOf(state, from) ?? state.commits.find(commit => commit.sha === from.toLowerCase())?.sha
    if (parent === undefined) {
      throw notFound(`No branch ${from ?? input.branch} in ${slugOf(repo)}`)
    }
    if (input.expectedHead !== undefined && input.expectedHead.toLowerCase() !== parent) {
      throw new BranchMovedError(`Branch ${input.branch} is at ${parent}, not ${input.expectedHead}`, 409, '', origin)
    }
    const read = (path: string) => from === undefined ? readFile(state, input.branch, path) : readFile(state, from, path)
    const missing = input.changes.find(change => change.content === null && !read(change.path))
    if (missing) {
      throw notFound(`No file ${missing.path} on ${from ?? input.branch} in ${slugOf(repo)}`)
    }
    if (from !== undefined) {
      const paths = new Set([...state.files.keys()].flatMap((key) => {
        const { ref, path } = splitFileKey(key)
        return ref === '*' || ref === from ? [path] : []
      }))
      for (const path of paths) {
        const bytes = readFile(state, from, path)
        if (bytes) {
          state.files.set(`${input.branch}:${path}`, bytes)
        }
      }
    }
    const files = input.changes.map((change): ChangedFile => {
      const status: FileStatus = change.content === null ? 'removed' : read(change.path) ? 'modified' : 'added'
      return { path: change.path, status, statusRaw: status }
    })
    const prefix = input.branch === main ? '*' : input.branch
    for (const change of input.changes) {
      state.files.delete(`${input.branch}:${change.path}`)
      if (change.content === null) {
        state.files.delete(`${prefix}:${change.path}`)
      }
      else {
        state.files.set(`${prefix}:${change.path}`, typeof change.content === 'string' ? new TextEncoder().encode(change.content) : change.content)
      }
    }
    const sha = `fa4e${String(++commitCount).padStart(36, '0')}`
    const date = now()
    const commit: Commit = {
      ref: { ...origin, repo: state.repo.ref, sha },
      sha,
      message: input.message,
      author: input.author ? { ...input.author, date } : { actor: actor(by), name: by, date },
      committer: { actor: actor(by), name: by, date },
      parents: /^0+$/.test(parent) ? [] : [parent],
      url: `https://${instance}/${slugOf(repo)}/commit/${sha}`,
      files,
      raw: { ...input, changes: input.changes.map(change => ({ path: change.path, deleted: change.content === null })) },
    }
    state.commits.push(commit)
    state.branches.set(input.branch, sha)
    return commit
  }

  let merges = 0
  let updates = 0

  function setState(by: string, ref: ThreadRef, state: ThreadState, action: EventAction): void {
    const current = threadState(ref).thread
    if (current.state === state) {
      return
    }
    current.state = state
    current.closedAt = state === 'open' ? undefined : now()
    if (state === 'merged') {
      current.mergedAt = current.closedAt
      current.mergedBy = actor(by)
    }
    record(by, ref, 'state_change', action, action, { type: 'state_change', state })
  }

  function setLabels(by: string, ref: ThreadRef, labels: string[]): Label[] {
    const thread = threadState(ref).thread
    const before = new Set(thread.labels.map(item => item.name))
    const after = new Set(labels)
    thread.labels = labels.map(label)
    for (const name of [...after].filter(name => !before.has(name))) {
      record(by, ref, 'label', 'labelled', `added label ${name}`, { type: 'label', label: name })
    }
    for (const name of [...before].filter(name => !after.has(name))) {
      record(by, ref, 'label', 'unlabelled', `removed label ${name}`, { type: 'label', label: name })
    }
    return thread.labels
  }

  function setAssignees(by: string, ref: ThreadRef, assignees: Array<string | Actor>): Actor[] {
    const thread = threadState(ref).thread
    const before = thread.assignees
    thread.assignees = assignees.map(item => typeof item === 'string' ? actor(item) : { ...item })
    for (const assignee of thread.assignees.filter(item => !before.some(existing => existing.login === item.login))) {
      record(by, ref, 'assignment', 'assigned', `assigned ${assignee.login}`, { type: 'assignment', assignee })
    }
    for (const assignee of before.filter(item => !thread.assignees.some(kept => kept.login === item.login))) {
      record(by, ref, 'assignment', 'unassigned', `unassigned ${assignee.login}`, { type: 'assignment', assignee })
    }
    return thread.assignees
  }

  function runState(ref: CiRunRef): FakeRunState {
    const found = repoState(ref.repo).runs.find(item => item.run.ref.id === ref.id)
    if (!found) {
      throw notFound(`No run ${ref.id}`)
    }
    return found
  }

  const REVIEW_STATES: Record<ReviewEvent, ReviewState> = { approve: 'approved', request_changes: 'changes_requested', comment: 'commented' }

  function createReview(by: string, ref: ThreadRef, input: ReviewInput): Review {
    const state = threadState(ref)
    const id = String(state.reviews.length + 1)
    const comments = (input.comments ?? []).map((comment, index): ReviewComment => ({
      ref: { ...origin, thread: state.thread.ref, id: `${ref.number}-review-${id}-${index + 1}` },
      body: comment.body,
      author: actor(by),
      path: comment.path,
      line: comment.line,
      side: comment.side ?? 'right',
      thread: { id: `${ref.number}-thread-${id}-${index + 1}`, resolved: false },
      createdAt: now(),
      raw: comment,
    }))
    const review: Review = {
      ref: { ...origin, thread: state.thread.ref, id },
      author: actor(by),
      state: input.event ? REVIEW_STATES[input.event] : 'pending',
      stateRaw: input.event ?? 'pending',
      body: input.body,
      submittedAt: input.event ? now() : undefined,
      comments,
      raw: input,
    }
    state.reviews.push(review)
    if (input.event) {
      record(by, state.thread.ref, 'review', 'submitted', `reviewed (${review.state})`, { type: 'review', state: review.state, body: input.body, review: review.ref })
    }
    return review
  }

  function setReviewThreadResolved(ref: ThreadRef, id: string, resolved: boolean): void {
    const comments = threadState(ref).reviews.flatMap(review => review.comments === false ? [] : review.comments).filter(item => item.thread?.id === id)
    if (comments.length === 0) {
      throw notFound(`No review thread ${id}`)
    }
    for (const comment of comments) {
      comment.thread = { id, resolved }
    }
  }

  function replyToReviewComment(by: string, ref: ThreadRef, comment: Pick<ReviewComment, 'ref' | 'thread' | 'inReplyTo'>, body: string): ReviewComment {
    const state = threadState(ref)
    for (const review of state.reviews) {
      if (review.comments === false) {
        continue
      }
      const parent = review.comments.find(item => comment.ref ? item.ref?.id === comment.ref.id : comment.thread !== undefined && item.thread?.id === comment.thread.id)
      if (!parent?.ref) {
        continue
      }
      const reply: ReviewComment = {
        ref: { ...origin, thread: state.thread.ref, id: `${parent.ref.id}-reply-${review.comments.length + 1}` },
        body,
        author: actor(by),
        path: parent.path,
        line: parent.line,
        side: parent.side,
        inReplyTo: parent.inReplyTo ?? parent.ref.id,
        thread: parent.thread && { ...parent.thread },
        createdAt: now(),
        raw: { body },
      }
      review.comments.push(reply)
      record(by, state.thread.ref, 'review_comment', 'created', 'replied to a review comment', { type: 'review_comment', comment: reply.ref, body, path: reply.path, line: reply.line })
      return reply
    }
    throw notFound(`No review comment ${comment.ref?.id ?? comment.thread?.id}`)
  }

  const alertKinds = ((): Partial<Record<AlertKind, SupportInput>> => {
    const given = givenSupport('securityAlerts.list') as SupportInput | Partial<Record<AlertKind, SupportInput>> | undefined
    if (given !== undefined && typeof given === 'object') {
      return given
    }
    return { dependency: given ?? true, code_scanning: given ?? true, secret: given ?? true, advisory: given ?? true }
  })()

  /** An `'emulated'` `markDone()` marks the notification read and keeps it. */
  const markDone = support('notifications.markDone', true)

  const factory = defineForgeProvider<FakeOptions>({
    forge,
    baseUrl: `https://${instance}`,
    webhooks: () => ({
      verify: delivery => verifyHmacSignature(delivery, options.webhookSecret, { header: SIGNATURE_HEADER }),
      translate: (delivery) => {
        const parsed = JSON.parse(bodyText(delivery.body)) as ForgeEventInput | ForgeEventInput[]
        const deliveryId = headerValue(delivery.headers, 'x-fake-delivery')
        return (Array.isArray(parsed) ? parsed : [parsed]).map((event, index) => ({
          ...event,
          ...origin,
          id: event.id ?? `${deliveryId ?? 'delivery'}:${index}`,
          occurredAt: new Date(event.occurredAt),
          source: 'webhook',
        }))
      },
      events: FAKE_WEBHOOK_EVENTS,
    }),
    setup: ({ options: { viewer: by = viewerLogin } }) => actingAs(by, overNetwork({
      traits: { eventKinds: 'native', authKinds: ['token'] },
      rateLimits,
      users: {
        me: verb(support('users.me', true), async () => ({ ...actor(by), raw: undefined })),
        eventsPage: verb(support('users.events', true), async (login, listOptions = {}) => conditional(pageOf(feed(event => event.actor?.login === login), listOptions), listOptions)),
        blocking: verb(support('users.block', true), {
          block: async login => setBlocked(by, login, true),
          unblock: async login => setBlocked(by, login, false),
        }),
      },
      orgs: {
        blocking: verb(support('orgs.block', true), {
          block: async (org, login) => setBlocked(org.owner, login, true),
          unblock: async (org, login) => setBlocked(org.owner, login, false),
        }),
      },
      repos: {
        get: verb(support('repos.get', true), async repo => repoState(repo).repo),
        listPage: verb(support('repos.list', true), async (listOptions: ListOptions = {}) => pageOf([...store.repos.values()].map(state => state.repo), listOptions)),
        byOwnerPage: verb(support('repos.byOwner', true), async (owner, query = {}) => {
          const repos = [...store.repos.values()]
            .map(state => state.repo)
            .filter(repo => (repo.ref.owner === owner.owner || (query.subgroups && repo.ref.owner.startsWith(`${owner.owner}/`)))
              && (!query.visibility || query.visibility === 'all' || repo.visibility === query.visibility))
          if (query.sort === 'name') {
            repos.sort((a, b) => slugOf(a.ref).localeCompare(slugOf(b.ref)) * (query.direction === 'desc' ? -1 : 1))
          }
          const page = pageOf(repos, query)
          return query.sort && query.sort !== 'name' && !query.cursor ? { ...page, warnings: [{ code: 'sort_unsupported', message: 'The fake forge keeps no repository dates; sorted in seed order' }] } : page
        }),
        eventsPage: verb(support('repos.events', true), async (repo, listOptions = {}) => conditional(pageOf(feed(event => event.repo?.owner === repo.owner && event.repo.name === repo.name), listOptions), listOptions)),
      },
      search: {
        threadsPage: verb(support('search.threads', true), async (query = {}) => {
          const text = query.text?.toLowerCase()
          const state = query.state ?? 'all'
          const items = [...store.repos.values()]
            .filter(entry => query.repo ? slugOf(entry.repo.ref) === slugOf(query.repo) : !query.owner || entry.repo.ref.owner === query.owner)
            .flatMap(entry => [...entry.threads.values()].map(thread => thread.thread))
            .filter(thread => (thread.kind === 'issue' || thread.kind === 'pull_request')
              && (!query.kind || thread.kind === query.kind)
              && (state === 'all' || (state === 'open' ? thread.state === 'open' : thread.state !== 'open'))
              && (!text || thread.title.toLowerCase().includes(text) || (thread.body ?? '').toLowerCase().includes(text))
              && (!query.author || thread.author?.login === query.author)
              && (!query.assignee || thread.assignees.some(item => item.login === query.assignee))
              && (!query.involves || thread.author?.login === query.involves || thread.assignees.some(item => item.login === query.involves))
              && (!query.labels?.length || query.labels.every(name => thread.labels.some(item => item.name === name)))
              && (!query.since || (thread.updatedAt?.getTime() ?? 0) >= query.since.getTime()))
          return pageOf(query.direction === 'asc' ? items : items.toReversed(), query)
        }),
        reposPage: verb(support('search.repos', true), async (query = {}) => {
          const text = query.text?.toLowerCase()
          const items = [...store.repos.values()]
            .map(entry => entry.repo)
            .filter(repo => (!query.owner || repo.ref.owner === query.owner)
              && (!text || `${repo.ref.owner}/${repo.ref.name}`.toLowerCase().includes(text) || (repo.description ?? '').toLowerCase().includes(text)))
          return pageOf(items, query)
        }),
        commitsPage: verb(support('search.commits', true), async (query = {}) => {
          const text = query.text?.toLowerCase()
          const items = [...store.repos.values()]
            .filter(entry => !query.repo || slugOf(entry.repo.ref) === slugOf(query.repo))
            .flatMap(entry => entry.commits)
            .filter(commit => (!text || commit.message.toLowerCase().includes(text))
              && (!query.author || commit.author?.name === query.author)
              && (!query.committer || commit.committer?.name === query.committer))
          return pageOf(query.direction === 'asc' ? items : items.toReversed(), query)
        }),
        codePage: verb(support('search.code', true), async (query = {}) => {
          const text = query.text?.toLowerCase()
          if (!text) {
            return pageOf([], query)
          }
          const decoder = new TextDecoder()
          const items = [...store.repos.values()]
            .filter(entry => (!query.repo || slugOf(entry.repo.ref) === slugOf(query.repo)) && (!query.owner || entry.repo.ref.owner === query.owner))
            .flatMap(entry => [...entry.files].flatMap(([key, bytes]): CodeMatch[] => {
              const { ref, path } = splitFileKey(key)
              const lines = decoder.decode(bytes).split('\n')
              const fragments = lines.flatMap((line, index) => line.toLowerCase().includes(text) ? [{ text: line, line: index + 1 }] : [])
              return fragments.length ? [{ repo: entry.repo.ref, path, ref: ref === '*' ? undefined : ref, fragments, raw: undefined }] : []
            }))
          return pageOf(items, query)
        }),
      },
      threads: {
        get: perKind(kinds('threads.get', ALL_KINDS), async ref => threadState(ref).thread),
        listPage: perKind(kinds('threads.list', ALL_KINDS), async (repo, query = {}) => {
          const state = query.state ?? 'open'
          const sortKey = (entry: FakeThreadState) => query.sort === 'comments' ? entry.thread.commentCount ?? 0 : query.sort === 'updated' ? entry.thread.updatedAt?.getTime() ?? 0 : entry.thread.createdAt?.getTime() ?? 0
          const items = [...repoState(repo).threads.values()]
            .filter(({ thread, comments }) => (!query.kind || thread.kind === query.kind)
              && (state === 'all' || (state === 'open' ? thread.state === 'open' : state === 'merged' ? thread.state === 'merged' : thread.state !== 'open'))
              && (!query.labels?.length || query.labels.every(name => thread.labels.some(item => item.name === name)))
              && (!query.author || thread.author?.login === query.author)
              && (!query.assignee || thread.assignees.some(item => item.login === query.assignee))
              && (!query.mentions || mentioned(thread, comments, query.mentions))
              && (!query.involves || involved(thread, comments, query.involves))
              && (!query.milestone || (query.milestone === 'none' ? !thread.milestone : thread.milestone?.title === query.milestone))
              && (!query.since || (thread.updatedAt?.getTime() ?? 0) >= query.since.getTime())
              && (!query.createdAfter || (thread.createdAt?.getTime() ?? 0) >= query.createdAfter.getTime()))
            .toSorted((a, b) => sortKey(a) - sortKey(b))
            .map(entry => entry.thread)
          return conditional(pageOf(query.direction === 'asc' ? items : items.toReversed(), query), query)
        }),
        listFilters: ['involves', 'mentions', 'milestone'],
        getMany: verb(support('threads.getMany', true), refs => getManyConcurrently(refs, async ref => threadState(ref).thread)),
        closingIssuesPage: verb(support('threads.closingIssues', true), async (ref, listOptions = {}) => {
          if (ref.kind !== 'pull_request') {
            throw notFound(`No pull request ${slugOf(ref.repo)}#${ref.number}`)
          }
          const numbers = closedNumbers(threadState(ref).thread.body)
          return pageOf(threadsOf(ref.repo, 'issue').filter(thread => numbers.has(thread.ref.number)), listOptions)
        }),
        closingPullRequestsPage: verb(support('threads.closingPullRequests', true), async (ref, listOptions = {}) => {
          if (ref.kind !== 'issue') {
            throw notFound(`No issue ${slugOf(ref.repo)}#${ref.number}`)
          }
          const { number } = threadState(ref).thread.ref
          return pageOf(threadsOf(ref.repo, 'pull_request').filter(thread => closedNumbers(thread.body).has(number)), listOptions)
        }),
        eventsPage: verb(true, async (ref, listOptions = {}) => conditional(pageOf(store.events.filter(event => event.thread?.repo.owner === ref.repo.owner && event.thread.repo.name === ref.repo.name && event.thread.number === ref.number).map(event => polled(event, 'timeline')), listOptions), listOptions)),
        commentsPage: perKind(kinds('threads.comments', ALL_KINDS), async (ref, listOptions = {}) => conditional(pageOf(threadState(ref).comments, listOptions), listOptions)),
        reactionsPage: perKind(kinds('threads.reactions', ALL_KINDS), async (target, listOptions = {}) => {
          const thread = 'thread' in target ? target.thread : target
          return pageOf(threadState(thread).reactions.get('thread' in target ? target.id : '') ?? [], listOptions)
        }),
        reactions: perKind(kinds('threads.react', WRITABLE), {
          async react(target, reaction) {
            const thread = 'thread' in target ? target.thread : target
            const state = threadState(thread)
            const key = 'thread' in target ? target.id : ''
            const left = state.reactions.get(key) ?? []
            if (left.some(item => item.content === reaction && item.actor.login === by)) {
              return
            }
            left.push({ content: reaction, contentRaw: reaction, actor: actor(by), createdAt: now(), raw: { content: reaction } })
            state.reactions.set(key, left)
            record(by, thread, 'reaction', 'created', `reacted ${reaction}`)
          },
          async unreact(target, reaction) {
            const thread = 'thread' in target ? target.thread : target
            const state = threadState(thread)
            const key = 'thread' in target ? target.id : ''
            const before = state.reactions.get(key) ?? []
            const left = before.filter(item => !(item.content === reaction && item.actor.login === by))
            if (left.length === before.length) {
              return
            }
            state.reactions.set(key, left)
            record(by, thread, 'reaction', 'deleted', `removed a ${reaction} reaction`)
          },
        }),
        comment: perKind(kinds('threads.comment', WRITABLE), async (ref, body) => {
          const state = threadState(ref)
          const count = Math.max(commentCounts.get(state) ?? 0, state.comments.length) + 1
          commentCounts.set(state, count)
          const comment: Comment = { ref: { ...origin, thread: state.thread.ref, id: `${ref.number}-${count}` }, body, author: actor(by), createdAt: now(), raw: { body } }
          state.comments.push(comment)
          state.thread.commentCount = state.comments.length
          record(by, state.thread.ref, 'comment', 'created', 'commented', { type: 'comment', comment: comment.ref, body })
          return comment
        }),
        editComment: perKind(kinds('threads.editComment', WRITABLE), async (ref: CommentRef, body: string) => {
          const comment = threadState(ref.thread).comments.find(item => item.ref.id === ref.id)
          if (!comment) {
            throw notFound(`No comment ${ref.id}`)
          }
          comment.body = body
          comment.updatedAt = now()
          record(by, ref.thread, 'comment', 'edited', 'edited a comment', { type: 'comment', comment: comment.ref, body })
          return comment
        }),
        hiding: perKind(kinds('threads.hideComment', WRITABLE), {
          hideComment: async (ref: CommentRef, reason: HideCommentReason) => {
            const state = threadState(ref.thread)
            if (!state.comments.some(item => item.ref.id === ref.id)) {
              throw notFound(`No comment ${ref.id}`)
            }
            state.hidden.set(ref.id, reason)
          },
          unhideComment: async (ref: CommentRef) => {
            const state = threadState(ref.thread)
            if (!state.comments.some(item => item.ref.id === ref.id)) {
              throw notFound(`No comment ${ref.id}`)
            }
            state.hidden.delete(ref.id)
          },
        }),
        deleteComment: perKind(kinds('threads.deleteComment', WRITABLE), async (ref: CommentRef) => {
          const state = threadState(ref.thread)
          const index = state.comments.findIndex(item => item.ref.id === ref.id)
          if (index < 0) {
            throw notFound(`No comment ${ref.id}`)
          }
          state.comments.splice(index, 1)
          state.hidden.delete(ref.id)
          state.thread.commentCount = state.comments.length
          record(by, ref.thread, 'comment', 'deleted', 'deleted a comment', { type: 'comment', comment: ref })
        }),
        create: perKind(kinds('threads.create', { issue: true, pull_request: true, discussion: true }), async (repo, input) => {
          const existing = store.repos.get(slugOf(repo))
          const base = input.base ?? existing?.repo.defaultBranch ?? 'main'
          const open = input.kind === 'pull_request' && input.head !== undefined && [...existing?.threads.values() ?? []]
            .some(({ thread }) => thread.kind === 'pull_request' && thread.state === 'open' && thread.branches?.head.ref === input.head && thread.branches?.base.ref === base)
          if (open) {
            throw new ForgeApiError(`A pull request already exists for ${input.head}`, 422, '', origin)
          }
          const thread = addThread({ repo: slugOf(repo), kind: input.kind, title: input.title, body: input.body, author: by, labels: input.labels, assignees: input.assignees?.map(item => typeof item === 'string' ? item : item.login), ...input.head === undefined ? {} : { head: { ref: input.head } } })
          if (thread.branches) {
            thread.branches.base.ref = base
          }
          record(by, thread.ref, 'state_change', 'opened', `opened ${thread.kind === 'pull_request' ? 'a pull request' : `a ${thread.kind}`}`, { type: 'state_change', state: 'open' })
          return thread
        }),
        update: perKind(kinds('threads.update', WRITABLE), async (ref, input) => {
          const thread = threadState(ref).thread
          if (input.title !== undefined || input.body !== undefined) {
            thread.title = input.title ?? thread.title
            thread.body = input.body ?? thread.body
            record(by, ref, 'other', 'edited', 'edited the thread')
          }
          if (input.state && input.state !== thread.state) {
            thread.stateReason = undefined
            setState(by, ref, input.state, input.state === 'open' ? 'reopened' : 'closed')
          }
          if (input.labels) {
            setLabels(by, ref, input.labels)
          }
          if (input.assignees) {
            setAssignees(by, ref, input.assignees)
          }
          return thread
        }),
        close: perKind(kinds('threads.close', WRITABLE), async (ref, closeOptions = {}) => {
          threadState(ref).thread.stateReason = closeOptions.reasonRaw ?? closeOptions.reason
          setState(by, ref, 'closed', 'closed')
          return threadState(ref).thread
        }),
        reopen: perKind(kinds('threads.reopen', WRITABLE), async (ref) => {
          setState(by, ref, 'open', 'reopened')
          return threadState(ref).thread
        }),
        locking: perKind(kinds('threads.lock', WRITABLE), {
          lock: async (ref) => {
            threadState(ref).thread.locked = true
          },
          unlock: async (ref) => {
            threadState(ref).thread.locked = false
          },
        }),
        addLabels: perKind(kinds('threads.addLabels', WRITABLE), async (ref, labels) => {
          const thread = threadState(ref).thread
          for (const name of labels.filter(name => !thread.labels.some(item => item.name === name))) {
            thread.labels = [...thread.labels, label(name)]
            record(by, ref, 'label', 'labelled', `added label ${name}`, { type: 'label', label: name })
          }
          return thread.labels
        }),
        removeLabels: perKind(kinds('threads.removeLabels', WRITABLE), async (ref, labels) => {
          const thread = threadState(ref).thread
          for (const name of labels.filter(name => thread.labels.some(item => item.name === name))) {
            thread.labels = thread.labels.filter(item => item.name !== name)
            record(by, ref, 'label', 'unlabelled', `removed label ${name}`, { type: 'label', label: name })
          }
          return thread.labels
        }),
        setLabels: perKind(kinds('threads.setLabels', WRITABLE), async (ref, labels) => setLabels(by, ref, labels)),
        setAssignees: perKind(kinds('threads.setAssignees', WRITABLE), async (ref, assignees) => setAssignees(by, ref, assignees)),
        requestReview: perKind(kinds('threads.requestReview', PULLS), async (ref, reviewers) => {
          const thread = threadState(ref).thread
          for (const reviewer of reviewers.map(item => typeof item === 'string' ? actor(item) : { ...item }).filter(item => !thread.reviewers.some(existing => existing.actor.login === item.login))) {
            thread.reviewers.push({ actor: reviewer, state: 'pending' })
            record(by, ref, 'assignment', 'review_requested', `requested review from ${reviewer.login}`, { type: 'assignment', assignee: reviewer })
          }
        }),
        merge: verb(support('threads.merge', true), async (ref, mergeOptions = {}) => {
          const state = threadState(ref)
          if (state.thread.kind !== 'pull_request') {
            throw notFound(`No pull request ${slugOf(ref.repo)}#${ref.number}`)
          }
          if (state.thread.state !== 'open' || (state.mergeable === 'blocked' && !mergeOptions.whenChecksPass)) {
            throw new MergeBlockedError(`Pull request ${slugOf(ref.repo)}#${ref.number} is not mergeable`, 405, '', origin)
          }
          if (state.mergeable === 'conflict') {
            throw new MergeConflictError(`Pull request ${slugOf(ref.repo)}#${ref.number} conflicts with its base`, 409, '', origin)
          }
          if (mergeOptions.sha !== undefined && mergeOptions.sha !== state.thread.branches?.head.sha) {
            throw new MergeConflictError(`Head branch of ${slugOf(ref.repo)}#${ref.number} moved from ${mergeOptions.sha}`, 409, '', origin)
          }
          if (mergeOptions.whenChecksPass) {
            return { status: 'queued' }
          }
          const sha = (++merges).toString(16).padStart(40, 'f')
          if (state.thread.branches) {
            state.thread.branches = { ...state.thread.branches, mergeCommitSha: sha }
          }
          setState(by, ref, 'merged', 'merged')
          return { status: 'merged', sha, raw: { sha } }
        }),
        updateBranch: verb(support('threads.updateBranch', true), async (ref, updateOptions = {}) => {
          const state = threadState(ref)
          if (state.thread.kind !== 'pull_request') {
            throw notFound(`No pull request ${slugOf(ref.repo)}#${ref.number}`)
          }
          if (state.thread.state !== 'open') {
            throw new MergeBlockedError(`Pull request ${slugOf(ref.repo)}#${ref.number} is not open`, 422, '', origin)
          }
          if (state.mergeable === 'conflict') {
            throw new MergeConflictError(`Pull request ${slugOf(ref.repo)}#${ref.number} conflicts with its base`, 409, '', origin)
          }
          const branches = state.thread.branches
          if (updateOptions.sha !== undefined && updateOptions.sha !== branches?.head.sha) {
            throw new BranchMovedError(`Head branch of ${slugOf(ref.repo)}#${ref.number} is at ${branches?.head.sha}, not ${updateOptions.sha}`, 409, '', origin)
          }
          if (branches) {
            state.thread.branches = { ...branches, head: { ...branches.head, sha: (++updates).toString(16).padStart(40, 'e') } }
          }
          return { status: 'updated' }
        }),
        subscriptions: perKind(kinds('threads.subscription', WRITABLE), {
          subscription: async ref => threadState(ref).subscription,
          subscribe: async (ref) => {
            threadState(ref).subscription = 'subscribed'
          },
          unsubscribe: async (ref) => {
            threadState(ref).subscription = 'none'
          },
        }),
        checks: perKind(kinds('threads.checks', PULLS), async ref => ({ items: threadState(ref).checks })),
        reviewsPage: verb(support('threads.reviews', true), async (ref, listOptions = {}) => pageOf(threadState(ref).reviews, listOptions)),
        createReview: verb(support('threads.createReview', true), async (ref, input) => createReview(by, ref, input)),
        submitReview: verb(support('threads.submitReview', true), async (ref, event, body) => {
          const review = threadState(ref.thread).reviews.find(item => item.ref.id === ref.id)
          if (!review || review.state !== 'pending') {
            throw notFound(`No pending review ${ref.id}`)
          }
          review.state = REVIEW_STATES[event]
          review.stateRaw = event
          review.submittedAt = now()
          if (body !== undefined) {
            review.body = body
          }
          record(by, ref.thread, 'review', 'submitted', `reviewed (${review.state})`, { type: 'review', state: review.state, body: review.body, review: review.ref })
          return review
        }),
        filesPage: verb(support('threads.files', true), async (ref, listOptions = {}) => pageOf(threadState(ref).files, listOptions)),
        commitsPage: verb(support('threads.commits', true), async (ref, listOptions = {}) => {
          const state = repoState(ref.repo)
          const shas = new Set(threadState(ref).commits)
          return pageOf(state.commits.filter(commit => shas.has(commit.sha)), listOptions)
        }),
        replyToReviewComment: verb(support('threads.replyToReviewComment', true), async (ref, comment, body) => replyToReviewComment(by, ref, comment, body)),
        reviewThreads: verb(support('threads.resolveReviewThread', true), {
          resolveReviewThread: async (ref, id) => setReviewThreadResolved(ref, id, true),
          unresolveReviewThread: async (ref, id) => setReviewThreadResolved(ref, id, false),
        }),
      },
      contents: {
        file: verb(support('contents.file', true), async (repo, path, fileOptions = {}) => {
          const bytes = readFile(repoState(repo), fileOptions.ref, path)
          if (!bytes) {
            throw notFound(`No file ${path} in ${slugOf(repo)}`)
          }
          return toFileContent(bytes, { path, size: bytes.byteLength }, fileOptions, origin)
        }),
        treePage: verb(support('contents.tree', true), async (repo, treeOptions = {}) => {
          const prefix = treeOptions.path?.replace(/^\/|\/$/g, '')
          const state = repoState(repo)
          const own = ownFiles(state, treeOptions.ref)
          const paths = [...new Set([...state.files.keys()]
            .flatMap((key) => {
              const { ref, path } = splitFileKey(key)
              return (ref === '*' && !own) || ref === treeOptions.ref ? [path] : []
            }))]
            .filter(path => !prefix || path.startsWith(`${prefix}/`))
          const entries = treeOptions.recursive
            ? paths
            : [...new Set(paths.map((path) => {
                const rest = prefix ? path.slice(prefix.length + 1) : path
                return prefix ? `${prefix}/${rest.split('/')[0]}` : rest.split('/')[0]!
              }))]
          return pageOf(entries.toSorted().map((path): TreeEntry => ({
            path,
            type: paths.includes(path) ? 'file' : 'directory',
            size: readFile(state, treeOptions.ref, path)?.byteLength,
          })), treeOptions)
        }),
        branchesPage: verb(support('contents.branches', true), async (repo, listOptions = {}) => {
          const state = repoState(repo)
          const main = defaultBranchOf(state)
          const names = [main, ...[...state.branches.keys()].filter(name => name !== main)]
          return pageOf(names.map(name => ({ name, sha: headOf(state, name)!, isDefault: name === main, raw: { name } })), listOptions)
        }),
        tagsPage: verb(support('contents.tags', true), async (repo, listOptions = {}) => pageOf(
          repoState(repo).releases.map(release => ({ name: release.tag, sha: '0'.repeat(40), raw: release.raw })),
          listOptions,
        )),
        resolveRef: verb(support('contents.resolveRef', true), async (repo, ref) => {
          const state = repoState(repo)
          const sha = state.branches.get(ref) ?? (state.commits.find(item => item.sha === ref) ?? state.commits.at(-1))?.sha
          if (!sha) {
            throw notFound(`No commit for ${ref} in ${slugOf(repo)}`)
          }
          return sha
        }),
        commitsPage: verb(support('contents.commits', true), async (repo, query = {}) => pageOf(
          repoState(repo).commits
            .filter(commit => (!query.since || (commit.author?.date ?? new Date(0)) >= query.since)
              && (!query.path || commit.files?.some(file => file.path === query.path))
              && (!query.author || commit.author?.actor?.login === query.author))
            .toReversed(),
          query,
        )),
        commit: verb(support('contents.commit', true), async (repo, sha) => {
          const commit = repoState(repo).commits.find(item => item.sha === sha)
          if (!commit) {
            throw notFound(`No commit ${sha} in ${slugOf(repo)}`)
          }
          return commit
        }),
        compare: verb(support('contents.compare', true), async (repo, base, head) => {
          const commits = repoState(repo).commits
          const from = commits.findIndex(commit => commit.sha === base)
          const to = commits.findIndex(commit => commit.sha === head)
          const between = commits.slice(from + 1, to < 0 ? undefined : to + 1)
          return {
            base,
            head,
            aheadBy: between.length,
            behindBy: 0,
            commits: between.toReversed(),
            files: between.flatMap(commit => commit.files ?? []),
            raw: { base, head },
          }
        }),
        commitFiles: verb(support('contents.commitFiles', true), async (repo, input) => commitFiles(by, repo, input)),
      },
      checks: {
        list: verb(support('checks.list', true), async (repo, sha) => ({ items: repoState(repo).statuses.get(sha) ?? [] })),
        report: verb(support('checks.report', true), async (repo, sha, input) => {
          const state = repoState(repo)
          const existing = state.statuses.get(sha) ?? []
          const check: Check = {
            ref: { ...origin, repo: state.repo.ref, id: input.externalId ?? `${sha}-${existing.length + 1}`, type: 'status' },
            name: input.name,
            state: input.state,
            stateRaw: input.state,
            url: input.url,
            startedAt: now(),
            raw: input,
          }
          state.statuses.set(sha, [...existing.filter(item => item.name !== input.name), check])
          return check
        }),
      },
      ci: {
        runsPage: verb(support('ci.runs', true), async (repo, query = {}) => pageOf(
          repoState(repo).runs
            .map(item => item.run)
            .filter(run => (!query.branch || run.branch === query.branch) && (!query.state || run.state === query.state))
            .toReversed(),
          query,
        )),
        run: verb(support('ci.run', true), async ref => runState(ref).run),
        jobsPage: verb(support('ci.jobs', true), async (ref, listOptions = {}) => pageOf(runState(ref).jobs.map(item => item.job), listOptions)),
        log: verb(support('ci.log', true), async (ref) => {
          const job = repoState(ref.repo).runs.flatMap(item => item.jobs).find(item => item.job.ref.id === ref.id)
          if (!job) {
            throw notFound(`No job ${ref.id}`)
          }
          return new Blob([job.log]).stream()
        }),
      },
      releases: {
        listPage: verb(support('releases.list', true), async (repo, listOptions = {}) => pageOf(repoState(repo).releases.toReversed(), listOptions)),
        get: verb(support('releases.get', true), async ref => releaseState(ref)),
        getByTag: verb(support('releases.getByTag', true), async (repo, tag) => {
          const release = repoState(repo).releases.find(item => item.tag === tag)
          if (!release) {
            throw notFound(`No release tagged ${tag}`)
          }
          return release
        }),
        downloadAsset: verb(support('releases.downloadAsset', true), async (ref) => {
          const bytes = repoState(ref.repo).assets.get(`${ref.release.id}:${ref.id}`)
          if (!bytes) {
            throw notFound(`No asset ${ref.id} on release ${ref.release.id}`)
          }
          return new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
        }),
        latest: verb(support('releases.latest', true), async repo => repoState(repo).releases.findLast(release => !release.isDraft && !release.isPrerelease)),
        create: verb(support('releases.create', true), async (repo, input) => {
          const state = repoState(repo)
          requireFreeTag(state.releases, input.tag)
          const at = now()
          const release: Release = {
            ref: { ...origin, repo: state.repo.ref, id: String(state.releases.length + 1), tag: input.tag },
            tag: input.tag,
            name: input.name,
            body: input.body,
            isDraft: input.draft ?? false,
            isPrerelease: input.prerelease ?? false,
            author: actor(by),
            createdAt: at,
            publishedAt: input.draft ? undefined : at,
            assets: [],
            raw: input,
          }
          state.releases.push(release)
          return release
        }),
        update: verb(support('releases.update', true), async (ref, update) => {
          const release = releaseState(ref)
          if (release.immutable && ((update.tag !== undefined && update.tag !== release.tag) || update.target !== undefined || (update.draft !== undefined && update.draft !== release.isDraft))) {
            throw new ForbiddenError(`Release ${release.tag} is immutable; its tag, target and draft state are locked`, 422, '', 'immutable_release', origin)
          }
          if (update.tag !== undefined && update.tag !== release.tag) {
            requireFreeTag(repoState(ref.repo).releases, update.tag)
            release.tag = update.tag
            release.ref = { ...release.ref, tag: update.tag }
          }
          release.name = update.name ?? release.name
          release.body = update.body ?? release.body
          release.isDraft = update.draft ?? release.isDraft
          release.isPrerelease = update.prerelease ?? release.isPrerelease
          release.publishedAt = release.isDraft ? undefined : release.publishedAt ?? now()
          return release
        }),
      },
      notifications: {
        listPage: verb(support('notifications.list', true), async (listOptions = {}) => conditional(pageOf(store.notifications.filter(item => (listOptions.all || item.unread) && (!listOptions.since || item.updatedAt >= listOptions.since)), listOptions), listOptions)),
        markRead: verb(support('notifications.markRead', true), async (ref) => {
          const notification = store.notifications.find(item => item.ref.id === ref.id)
          if (notification) {
            notification.unread = false
          }
        }),
        markDone: verb(markDone, async (ref) => {
          if (markDone === 'emulated') {
            const notification = store.notifications.find(item => item.ref.id === ref.id)
            if (notification) {
              notification.unread = false
            }
            return
          }
          store.notifications = store.notifications.filter(item => item.ref.id !== ref.id)
        }),
        unsubscribe: verb(support('notifications.unsubscribe', true), async (ref) => {
          const notification = store.notifications.find(item => item.ref.id === ref.id)
          if (notification?.subject.type === 'thread') {
            threadState(notification.subject.thread).subscription = 'none'
          }
        }),
        markAllRead: verb(support('notifications.markAllRead', true), async (bulk: BulkNotificationOptions = {}) => {
          for (const notification of store.notifications.filter(item => inBulk(item, bulk))) {
            notification.unread = false
          }
        }),
        markAllDone: verb(support('notifications.markAllDone', true), async (bulk: BulkNotificationOptions = {}) => {
          store.notifications = store.notifications.filter(item => !inBulk(item, bulk))
        }),
        unreadCount: verb(support('notifications.unreadCount', true), async () => store.notifications.filter(item => item.unread).length),
      },
      securityAlerts: {
        kinds: alertKinds,
        listPage: request('securityAlerts.listPage', async (repo: RepoRef, listOptions: SecurityAlertListOptions = {}) => {
          const state = listOptions.state ?? 'open'
          const items = repoState(repo).securityAlerts.filter(alert => (!listOptions.kind || alert.kind === listOptions.kind)
            && (state === 'all' || (state === 'open') === (alert.state === 'open')))
          return conditional(pageOf(items.toReversed(), listOptions), listOptions)
        }) as (repo: RepoRef, options?: SecurityAlertListOptions) => Promise<Page<SecurityAlert>>,
      },
      sources: {
        subscribe: verb(support('sources.subscribe', true), (subscribeOptions: SubscribeOptions = {}) => subscribeTo(subscribeOptions)),
      },
      webhooks: {
        listPage: verb(support('webhooks.list', true), async (target, listOptions = {}) => pageOf(
          store.webhooks.filter(hook => slugOf(hook.ref.target) === slugOf(target)),
          listOptions,
        )),
        create: verb(support('webhooks.create', true), async (target, input) => {
          const { secret, ...settings } = input
          while (store.webhooks.some(hook => hook.ref.id === String(webhookCount + 1))) {
            webhookCount++
          }
          const hook: Webhook = {
            ref: { ...origin, target, id: String(++webhookCount) },
            url: input.url,
            events: input.events ?? [],
            nativeEvents: input.nativeEvents ?? (input.events ?? []).map(kind => kind),
            active: input.active ?? true,
            contentType: input.contentType ?? 'json',
            createdAt: now(),
            raw: settings,
          }
          secrets.set(hook.ref.id, secret)
          store.webhooks.push(hook)
          return hook
        }),
        update: verb(support('webhooks.update', true), async (ref, update) => {
          const hook = webhookState(ref)
          Object.assign(hook, {
            ...update.url ? { url: update.url } : {},
            ...update.events ? { events: update.events } : {},
            ...update.nativeEvents ? { nativeEvents: update.nativeEvents } : {},
            ...update.active === undefined ? {} : { active: update.active },
            ...update.contentType ? { contentType: update.contentType } : {},
            updatedAt: now(),
          })
          if (update.secret) {
            secrets.set(ref.id, update.secret)
          }
          return hook
        }),
        delete: verb(support('webhooks.delete', true), async (ref) => {
          store.webhooks.splice(store.webhooks.indexOf(webhookState(ref)), 1)
          secrets.delete(ref.id)
        }),
        rotateSecret: verb(support('webhooks.rotateSecret', true), async (ref, secret) => {
          const hook = webhookState(ref)
          secrets.set(ref.id, secret)
          hook.updatedAt = now()
          return hook
        }),
      },
    })),
  })

  /** Leaves the viewer's notifications and subscriptions out of a provider that acts as someone else. */
  function actingAs<T extends { notifications?: unknown, threads: { subscriptions?: unknown } }>(by: string, spec: T): T {
    if (by !== viewerLogin) {
      delete spec.notifications
      delete spec.threads.subscriptions
    }
    return spec
  }

  async function* subscribeTo(subscribeOptions: SubscribeOptions): AsyncGenerator<{ event: ForgeEventInput, cursor: string }> {
    if (!connected) {
      throw disconnected('sources.subscribe')
    }
    const failure = takeFailure('sources.subscribe')
    if (failure) {
      throw failure.error
    }
    const queue: ForgeEvent[] = store.events.slice(Number(subscribeOptions.cursor ?? store.events.length))
    let cursor = subscribeOptions.cursor
    let dropped = false
    let wake: (() => void) | undefined
    const listener = (event: ForgeEvent) => {
      queue.push(event)
      wake?.()
    }
    const disconnect = () => {
      dropped = true
      wake?.()
    }
    const aborted = new Promise<void>(resolve => subscribeOptions.signal?.addEventListener('abort', () => resolve(), { once: true }))
    listeners.add(listener)
    disconnects.add(disconnect)
    try {
      while (!subscribeOptions.signal?.aborted) {
        if (dropped) {
          throw new SubscriptionClosedError(`Subscription to ${instance} closed: ${instance} is offline`, cursor, origin)
        }
        const event = queue.shift()
        if (event) {
          cursor = event.id
          yield { event: structuredClone(event), cursor }
          continue
        }
        await Promise.race([new Promise<void>((resolve) => {
          wake = resolve
        }), aborted])
      }
    }
    finally {
      listeners.delete(listener)
      disconnects.delete(disconnect)
    }
  }

  const provider = factory(options)

  /** Whether a call of the verb sends a request, read from the spec of a provider the first time it is needed. */
  function sendsRequest(key: string): boolean {
    if (!sent.size) {
      provider.create()
    }
    return key === 'sources.subscribe' || sent.has(key)
  }

  return Object.assign(provider, {
    store,
    failNext(verb: ForgeVerb, error: Error | (() => Error), failureOptions: FakeFailureOptions = {}) {
      const composed = COMPOSED_VERBS[verb]
      if (composed) {
        throw new TypeError(`${verb} sends no request of its own; ${composed}`)
      }
      const key = verb.replace(/Page$/, '')
      if (!sendsRequest(key)) {
        throw new TypeError(`${verb} is not implemented by the fake forge, so it sends no request to fail`)
      }
      failures.set(key, [...failures.get(key) ?? [], { error, applied: failureOptions.applied ?? false, times: failureOptions.times ?? 1 }])
    },
    offline() {
      connected = false
      for (const disconnect of disconnects) {
        disconnect()
      }
    },
    online() {
      connected = true
    },
    setLatency(given: FakeLatency | undefined) {
      latency = given
    },
    setRateLimit,
    as: (login: string) => factory({ ...options, viewer: login }).create(),
  })
}
