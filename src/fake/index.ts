import type { SupportInput, VerbKind } from '../define.ts'
import type {
  Actor,
  ChangedFile,
  Check,
  ChecksSummary,
  CheckState,
  CiJob,
  CiRun,
  CiRunRef,
  Comment,
  CommentRef,
  Commit,
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
  Reaction,
  Release,
  Repo,
  RepoRef,
  Review,
  ReviewComment,
  ReviewEvent,
  ReviewInput,
  ReviewState,
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
import type { ForgeCapabilities, ForgeOptionsBase, ForgeProvider, ForgeProviderFactory, ForgeVerb, SubscribeOptions } from '../provider.ts'
import { toFileContent } from '../contents.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { NotFoundError } from '../errors.ts'
import { completeEvent } from '../events.ts'
import { capabilityOf } from '../supports.ts'
import { getManyConcurrently } from '../utils.ts'
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
  labels?: string[]
  assignees?: string[]
  comments?: Array<{ body: string, author?: string }>
  checks?: Array<{ name: string, state: CheckState }>
  /** Files the pull request changes. */
  files?: Array<{ path: string, status?: FileStatus, additions?: number, deletions?: number, patch?: string }>
  /** Shas of seeded commits on the pull request. */
  commits?: string[]
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
  publishedAt?: Date
  assets?: Array<{ name: string, content: string | Uint8Array, contentType?: string }>
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
    /** Seeded release asset bytes, keyed by `<releaseId>:<assetName>`. */
    assets: Map<string, Uint8Array>
  }>
  notifications: Notification[]
  /** Every event a write produced, in order. */
  events: ForgeEvent[]
  /** Registered webhooks. Secrets are held separately and never readable. */
  webhooks: Webhook[]
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

/** What `fake()` returns: a provider factory that also exposes the store. */
export interface FakeForgeFactory extends ForgeProviderFactory<ForgeProvider> {
  /** The in-memory state of the forge. */
  readonly store: FakeStore
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
  const store: FakeStore = { repos: new Map(), notifications: [], events: [], webhooks: [] }
  const secrets = new Map<string, string | undefined>()
  const listeners = new Set<(event: ForgeEvent) => void>()

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
      assets: new Map(),
    })
  }

  function webhookState(ref: WebhookRef): Webhook {
    const hook = store.webhooks.find(item => item.ref.id === ref.id)
    if (!hook) {
      throw notFound(`No webhook ${ref.id}`)
    }
    return hook
  }

  function threadState(ref: ThreadRef): FakeThreadState {
    const state = repoState(ref.repo).threads.get(String(ref.number))
    if (!state || state.thread.kind !== ref.kind) {
      throw notFound(`No ${ref.kind} ${slugOf(ref.repo)}#${ref.number}`)
    }
    return state
  }

  function addThread(seed: FakeThreadSeed): Thread {
    const repo = store.repos.get(seed.repo) ?? (addRepo({ repo: seed.repo }), store.repos.get(seed.repo)!)
    const number = String(seed.number ?? repo.threads.size + 1)
    const ref: ThreadRef = { ...origin, repo: repo.repo.ref, kind: seed.kind, number }
    const now = new Date()
    const thread: Thread = {
      ref,
      kind: seed.kind,
      title: seed.title,
      body: seed.body,
      state: seed.state ?? 'open',
      isDraft: seed.isDraft ?? false,
      author: actor(seed.author ?? viewerLogin),
      assignees: (seed.assignees ?? []).map(actor),
      reviewers: [],
      labels: (seed.labels ?? []).map(label),
      url: `https://${instance}/${seed.repo}/${seed.kind === 'pull_request' ? 'pull' : seed.kind === 'discussion' ? 'discussions' : 'issues'}/${number}`,
      createdAt: now,
      updatedAt: now,
      commentCount: seed.comments?.length ?? 0,
      raw: seed,
    }
    const comments = (seed.comments ?? []).map((comment, index): Comment => ({
      ref: { ...origin, thread: ref, id: `${number}-${index + 1}` },
      body: comment.body,
      author: actor(comment.author ?? viewerLogin),
      createdAt: now,
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
    repo.threads.set(number, { thread, files, commits: seed.commits ?? [], comments, reactions: new Map(), checks, reviews: [], subscription: 'subscribed' })
    return thread
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

  function record(thread: ThreadRef, kind: EventKind, action: EventAction, summary: string, detail?: EventDetail): void {
    const event = completeEvent({
      ...origin,
      id: String(store.events.length + 1),
      kind,
      action,
      actionRaw: action,
      summary: `${viewerLogin} ${summary}`,
      occurredAt: new Date(),
      actor: actor(viewerLogin),
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
    }
    for (const listener of listeners) {
      listener(event)
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
      publishedAt: seed.publishedAt ?? new Date(),
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
        createdAt: new Date(),
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
      author: { actor: actor(seed.author ?? viewerLogin), name: seed.author ?? viewerLogin, date: seed.committedAt ?? new Date() },
      parents: seed.parents ?? [],
      stats: {
        additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
        deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
      },
      files,
      raw: seed,
    })
  }
  for (const [index, seed] of (options.seed?.notifications ?? []).entries()) {
    const state = store.repos.get(seed.repo)?.threads.get(String(seed.number))
    if (!state) {
      throw new Error(`Notification seed references unknown thread ${seed.repo}#${seed.number}`)
    }
    store.notifications.push({
      ref: { ...origin, id: String(index + 1) },
      subject: { type: 'thread', thread: state.thread.ref },
      reason: seed.reason ?? 'subscribed',
      reasonRaw: seed.reason ?? 'subscribed',
      unread: seed.unread ?? true,
      title: state.thread.title,
      subjectState: state.thread.state,
      updatedAt: new Date(),
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

  const listSupport = support('notifications.list', true)
  const pollSupport = typeof listSupport === 'function' ? true : listSupport

  function setState(ref: ThreadRef, state: ThreadState, action: EventAction): void {
    const current = threadState(ref).thread
    current.state = state
    current.closedAt = state === 'open' ? undefined : new Date()
    record(ref, 'state_change', action, action, { type: 'state_change', state })
  }

  function runState(ref: CiRunRef): FakeRunState {
    const found = repoState(ref.repo).runs.find(item => item.run.ref.id === ref.id)
    if (!found) {
      throw notFound(`No run ${ref.id}`)
    }
    return found
  }

  const REVIEW_STATES: Record<ReviewEvent, ReviewState> = { approve: 'approved', request_changes: 'changes_requested', comment: 'commented' }

  function createReview(ref: ThreadRef, input: ReviewInput): Review {
    const state = threadState(ref)
    const id = String(state.reviews.length + 1)
    const comments = (input.comments ?? []).map((comment, index): ReviewComment => ({
      ref: { ...origin, thread: state.thread.ref, id: `${ref.number}-review-${id}-${index + 1}` },
      body: comment.body,
      author: actor(viewerLogin),
      path: comment.path,
      line: comment.line,
      side: comment.side ?? 'right',
      thread: { id: `${ref.number}-thread-${id}-${index + 1}`, resolved: false },
      createdAt: new Date(),
      raw: comment,
    }))
    const review: Review = {
      ref: { ...origin, thread: state.thread.ref, id },
      author: actor(viewerLogin),
      state: input.event ? REVIEW_STATES[input.event] : 'pending',
      stateRaw: input.event ?? 'pending',
      body: input.body,
      submittedAt: input.event ? new Date() : undefined,
      comments,
      raw: input,
    }
    state.reviews.push(review)
    if (input.event) {
      record(state.thread.ref, 'review', 'submitted', `reviewed (${review.state})`, { type: 'review', state: review.state, body: input.body })
    }
    return review
  }

  function setReviewThreadResolved(ref: ThreadRef, id: string, resolved: boolean): void {
    const comment = threadState(ref).reviews.flatMap(review => review.comments === false ? [] : review.comments).find(item => item.thread?.id === id)
    if (!comment?.thread) {
      throw notFound(`No review thread ${id}`)
    }
    comment.thread = { id, resolved }
  }

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
    setup: () => ({
      traits: { poll: pollSupport, eventKinds: 'native', authKinds: ['token'] },
      users: {
        me: verb(support('users.me', true), async () => ({ ...actor(viewerLogin), raw: undefined })),
      },
      repos: {
        get: verb(support('repos.get', true), async repo => repoState(repo).repo),
        listPage: verb(support('repos.list', true), async (listOptions: ListOptions = {}) => pageOf([...store.repos.values()].map(state => state.repo), listOptions)),
      },
      search: {
        threadsPage: verb(support('search.threads', true), async (query = {}) => {
          const text = query.text?.toLowerCase()
          const state = query.state ?? 'all'
          const items = [...store.repos.values()]
            .filter(entry => !query.repo || slugOf(entry.repo.ref) === slugOf(query.repo))
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
      },
      threads: {
        get: perKind(kinds('threads.get', ALL_KINDS), async ref => threadState(ref).thread),
        listPage: perKind(kinds('threads.list', ALL_KINDS), async (repo, query = {}) => {
          const state = query.state ?? 'open'
          const items = [...repoState(repo).threads.values()]
            .map(entry => entry.thread)
            .filter(thread => (!query.kind || thread.kind === query.kind)
              && (state === 'all' || (state === 'open' ? thread.state === 'open' : state === 'merged' ? thread.state === 'merged' : thread.state !== 'open'))
              && (!query.labels?.length || query.labels.every(name => thread.labels.some(item => item.name === name)))
              && (!query.author || thread.author?.login === query.author)
              && (!query.assignee || thread.assignees.some(item => item.login === query.assignee)))
          return pageOf(query.direction === 'asc' ? items : items.toReversed(), query)
        }),
        getMany: verb(support('threads.getMany', true), refs => getManyConcurrently(refs, async ref => threadState(ref).thread)),
        eventsPage: verb(true, async (ref, listOptions = {}) => pageOf(store.events.filter(event => event.thread?.repo.owner === ref.repo.owner && event.thread.repo.name === ref.repo.name && event.thread.number === ref.number), listOptions)),
        commentsPage: perKind(kinds('threads.comments', ALL_KINDS), async (ref, listOptions = {}) => pageOf(threadState(ref).comments, listOptions)),
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
            if (!left.some(item => item.content === reaction && item.actor.login === viewerLogin)) {
              left.push({ content: reaction, contentRaw: reaction, actor: actor(viewerLogin), createdAt: new Date(), raw: { content: reaction } })
            }
            state.reactions.set(key, left)
            record(thread, 'reaction', 'created', `reacted ${reaction}`)
          },
          async unreact(target, reaction) {
            const thread = 'thread' in target ? target.thread : target
            const state = threadState(thread)
            const key = 'thread' in target ? target.id : ''
            const left = (state.reactions.get(key) ?? []).filter(item => !(item.content === reaction && item.actor.login === viewerLogin))
            state.reactions.set(key, left)
            record(thread, 'reaction', 'deleted', `removed a ${reaction} reaction`)
          },
        }),
        comment: perKind(kinds('threads.comment', WRITABLE), async (ref, body) => {
          const state = threadState(ref)
          const comment: Comment = { ref: { ...origin, thread: state.thread.ref, id: `${ref.number}-${state.comments.length + 1}` }, body, author: actor(viewerLogin), createdAt: new Date(), raw: { body } }
          state.comments.push(comment)
          state.thread.commentCount = state.comments.length
          record(state.thread.ref, 'comment', 'created', 'commented', { type: 'comment', comment: comment.ref, body })
          return comment
        }),
        editComment: perKind(kinds('threads.editComment', WRITABLE), async (ref: CommentRef, body: string) => {
          const comment = threadState(ref.thread).comments.find(item => item.ref.id === ref.id)
          if (!comment) {
            throw notFound(`No comment ${ref.id}`)
          }
          comment.body = body
          comment.updatedAt = new Date()
          record(ref.thread, 'comment', 'edited', 'edited a comment', { type: 'comment', comment: comment.ref, body })
          return comment
        }),
        deleteComment: perKind(kinds('threads.deleteComment', WRITABLE), async (ref: CommentRef) => {
          const state = threadState(ref.thread)
          const index = state.comments.findIndex(item => item.ref.id === ref.id)
          if (index < 0) {
            throw notFound(`No comment ${ref.id}`)
          }
          state.comments.splice(index, 1)
          state.thread.commentCount = state.comments.length
          record(ref.thread, 'comment', 'deleted', 'deleted a comment', { type: 'comment', comment: ref })
        }),
        create: perKind(kinds('threads.create', { issue: true, pull_request: true, discussion: true }), async (repo, input) => {
          const thread = addThread({ repo: slugOf(repo), kind: input.kind, title: input.title, body: input.body, labels: input.labels, assignees: input.assignees?.map(item => typeof item === 'string' ? item : item.login) })
          record(thread.ref, 'state_change', 'opened', `opened ${thread.kind === 'pull_request' ? 'a pull request' : `a ${thread.kind}`}`, { type: 'state_change', state: 'open' })
          return thread
        }),
        update: perKind(kinds('threads.update', WRITABLE), async (ref, input) => {
          const thread = threadState(ref).thread
          Object.assign(thread, input.title === undefined ? {} : { title: input.title }, input.body === undefined ? {} : { body: input.body })
          record(ref, 'other', 'edited', 'edited the thread')
          return thread
        }),
        close: perKind(kinds('threads.close', WRITABLE), async (ref, closeOptions = {}) => {
          threadState(ref).thread.stateReason = closeOptions.reasonRaw ?? closeOptions.reason
          setState(ref, 'closed', 'closed')
        }),
        reopen: perKind(kinds('threads.reopen', WRITABLE), async ref => setState(ref, 'open', 'reopened')),
        addLabels: perKind(kinds('threads.addLabels', WRITABLE), async (ref, labels) => {
          const thread = threadState(ref).thread
          for (const name of labels.filter(name => !thread.labels.some(item => item.name === name))) {
            thread.labels = [...thread.labels, label(name)]
            record(ref, 'label', 'labelled', `added label ${name}`, { type: 'label', label: name })
          }
        }),
        removeLabels: perKind(kinds('threads.removeLabels', WRITABLE), async (ref, labels) => {
          const thread = threadState(ref).thread
          for (const name of labels.filter(name => thread.labels.some(item => item.name === name))) {
            thread.labels = thread.labels.filter(item => item.name !== name)
            record(ref, 'label', 'unlabelled', `removed label ${name}`, { type: 'label', label: name })
          }
        }),
        setLabels: perKind(kinds('threads.setLabels', WRITABLE), async (ref, labels) => {
          const thread = threadState(ref).thread
          const before = new Set(thread.labels.map(item => item.name))
          const after = new Set(labels)
          thread.labels = labels.map(label)
          for (const name of [...after].filter(name => !before.has(name))) {
            record(ref, 'label', 'labelled', `added label ${name}`, { type: 'label', label: name })
          }
          for (const name of [...before].filter(name => !after.has(name))) {
            record(ref, 'label', 'unlabelled', `removed label ${name}`, { type: 'label', label: name })
          }
        }),
        setAssignees: perKind(kinds('threads.setAssignees', WRITABLE), async (ref, assignees) => {
          const thread = threadState(ref).thread
          thread.assignees = assignees.map(item => typeof item === 'string' ? actor(item) : item)
          for (const assignee of thread.assignees) {
            record(ref, 'assignment', 'assigned', `assigned ${assignee.login}`, { type: 'assignment', assignee })
          }
        }),
        requestReview: perKind(kinds('threads.requestReview', PULLS), async (ref, reviewers) => {
          const thread = threadState(ref).thread
          for (const reviewer of reviewers.map(item => typeof item === 'string' ? actor(item) : item)) {
            thread.reviewers.push({ actor: reviewer, state: 'pending' })
            record(ref, 'assignment', 'review_requested', `requested review from ${reviewer.login}`, { type: 'assignment', assignee: reviewer })
          }
        }),
        ...givenSupport('threads.approveAndMerge') === undefined ? {} : { approveAndMerge: { support: support('threads.approveAndMerge', true) } },
        merge: verb(support('threads.merge', true), async (ref, _mergeOptions = {}, hooks = {}) => {
          const state = threadState(ref)
          if (state.thread.kind !== 'pull_request') {
            throw notFound(`No pull request ${slugOf(ref.repo)}#${ref.number}`)
          }
          await hooks.beforeMerge?.()
          setState(ref, 'merged', 'merged')
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
        createReview: verb(support('threads.createReview', true), async (ref, input) => createReview(ref, input)),
        submitReview: verb(support('threads.submitReview', true), async (ref, event, body) => {
          const review = threadState(ref.thread).reviews.find(item => item.ref.id === ref.id)
          if (!review || review.state !== 'pending') {
            throw notFound(`No pending review ${ref.id}`)
          }
          review.state = REVIEW_STATES[event]
          review.stateRaw = event
          review.submittedAt = new Date()
          if (body !== undefined) {
            review.body = body
          }
          record(ref.thread, 'review', 'submitted', `reviewed (${review.state})`, { type: 'review', state: review.state, body: review.body })
          return review
        }),
        filesPage: verb(support('threads.files', true), async (ref, listOptions = {}) => pageOf(threadState(ref).files, listOptions)),
        commitsPage: verb(support('threads.commits', true), async (ref, listOptions = {}) => {
          const state = repoState(ref.repo)
          const shas = new Set(threadState(ref).commits)
          return pageOf(state.commits.filter(commit => shas.has(commit.sha)), listOptions)
        }),
        reviewThreads: verb(support('threads.resolveReviewThread', true), {
          resolveReviewThread: async (ref, id) => setReviewThreadResolved(ref, id, true),
          unresolveReviewThread: async (ref, id) => setReviewThreadResolved(ref, id, false),
        }),
      },
      contents: {
        file: verb(support('contents.file', true), async (repo, path, fileOptions = {}) => {
          const state = repoState(repo)
          const bytes = state.files.get(`${fileOptions.ref ?? '*'}:${path}`) ?? state.files.get(`*:${path}`)
          if (!bytes) {
            throw notFound(`No file ${path} in ${slugOf(repo)}`)
          }
          return toFileContent(bytes, { path, size: bytes.byteLength }, fileOptions, origin)
        }),
        treePage: verb(support('contents.tree', true), async (repo, treeOptions = {}) => {
          const prefix = treeOptions.path?.replace(/^\/|\/$/g, '')
          const paths = [...repoState(repo).files.keys()]
            .flatMap((key) => {
              const separator = key.indexOf(':')
              const ref = key.slice(0, separator)
              const path = key.slice(separator + 1)
              return ref === '*' || ref === treeOptions.ref ? [path] : []
            })
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
            size: repoState(repo).files.get(`*:${path}`)?.byteLength,
          })), treeOptions)
        }),
        branchesPage: verb(support('contents.branches', true), async (repo, listOptions = {}) => {
          const state = repoState(repo)
          const name = state.repo.defaultBranch ?? 'main'
          return pageOf([{ name, sha: state.commits.at(-1)?.sha ?? '0'.repeat(40), isDefault: true, raw: { name } }], listOptions)
        }),
        tagsPage: verb(support('contents.tags', true), async (repo, listOptions = {}) => pageOf(
          repoState(repo).releases.map(release => ({ name: release.tag, sha: '0'.repeat(40), raw: release.raw })),
          listOptions,
        )),
        resolveRef: verb(support('contents.resolveRef', true), async (repo, ref) => {
          const state = repoState(repo)
          const commit = state.commits.find(item => item.sha === ref) ?? state.commits.at(-1)
          if (!commit) {
            throw notFound(`No commit for ${ref} in ${slugOf(repo)}`)
          }
          return commit.sha
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
            commits: between,
            files: between.flatMap(commit => commit.files ?? []),
            raw: { base, head },
          }
        }),
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
            startedAt: new Date(),
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
        get: verb(support('releases.get', true), async (ref) => {
          const release = repoState(ref.repo).releases.find(item => item.ref.id === ref.id || (ref.tag && item.tag === ref.tag))
          if (!release) {
            throw notFound(`No release ${ref.tag ?? ref.id}`)
          }
          return release
        }),
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
      },
      notifications: {
        listPage: verb(support('notifications.list', true), async (listOptions = {}) => pageOf(store.notifications.filter(item => listOptions.all || item.unread), listOptions)),
        markRead: verb(support('notifications.markRead', true), async (ref) => {
          const notification = store.notifications.find(item => item.ref.id === ref.id)
          if (notification) {
            notification.unread = false
          }
        }),
        markDone: verb(support('notifications.markDone', true), async (ref) => {
          store.notifications = store.notifications.filter(item => item.ref.id !== ref.id)
        }),
        unsubscribe: verb(support('notifications.unsubscribe', true), async (ref) => {
          const notification = store.notifications.find(item => item.ref.id === ref.id)
          if (notification?.subject.type === 'thread') {
            threadState(notification.subject.thread).subscription = 'none'
          }
        }),
        markAllRead: verb(support('notifications.markAllRead', true), async () => {
          for (const notification of store.notifications) {
            notification.unread = false
          }
        }),
        markAllDone: verb(support('notifications.markAllDone', true), async () => {
          store.notifications = []
        }),
        unreadCount: verb(support('notifications.unreadCount', true), async () => store.notifications.filter(item => item.unread).length),
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
          const hook: Webhook = {
            ref: { ...origin, target, id: String(store.webhooks.length + 1) },
            url: input.url,
            events: input.events ?? [],
            nativeEvents: input.nativeEvents ?? (input.events ?? []).map(kind => kind),
            active: input.active ?? true,
            contentType: input.contentType ?? 'json',
            createdAt: new Date(),
            raw: input,
          }
          secrets.set(hook.ref.id, input.secret)
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
            updatedAt: new Date(),
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
          hook.updatedAt = new Date()
          return hook
        }),
      },
    }),
  })

  async function* subscribeTo(subscribeOptions: SubscribeOptions): AsyncGenerator<{ event: ForgeEventInput, cursor: string }> {
    const queue: ForgeEvent[] = store.events.slice(Number(subscribeOptions.cursor ?? store.events.length))
    let wake: (() => void) | undefined
    const listener = (event: ForgeEvent) => {
      queue.push(event)
      wake?.()
    }
    const aborted = new Promise<void>(resolve => subscribeOptions.signal?.addEventListener('abort', () => resolve(), { once: true }))
    listeners.add(listener)
    try {
      while (!subscribeOptions.signal?.aborted) {
        const event = queue.shift()
        if (event) {
          yield { event, cursor: event.id }
          continue
        }
        await Promise.race([new Promise<void>((resolve) => {
          wake = resolve
        }), aborted])
      }
    }
    finally {
      listeners.delete(listener)
    }
  }

  return Object.assign(factory(options), { store })
}
