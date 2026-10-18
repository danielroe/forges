import type { CapabilityPath } from './capability-table.ts'
import type { Fetcher, FetcherOptions } from './fetch.ts'
import type { BaseOptions, Check, CiJobRef, Comment, CommentRef, CommitCommentRef, CommitFilesInput, CompareOptions, Comparison, Cursor, DownloadAssetOptions, EventFeedOptions, ForgeEventInput, ForgeInstance, ForgeKind, Installation, ListOptions, Notification, NotificationListOptions, OwnerRepoQuery, Page, RateLimit, ReleaseAssetRef, Repo, RepoRef, ReviewRef, SecurityAlertKind, SecurityAlertListOptions, Support, TextLimits, ThreadKind, ThreadQuery, ThreadRef, WebhookEventType } from './model.ts'
import type {
  AuthKind,
  ChecksApi,
  CiApi,
  CommitsApi,
  ContentsApi,
  ForgeCapabilities,
  ForgeIterable,
  ForgeListing,
  ForgeOptionsBase,
  ForgeProvider,
  InstallationsApi,
  NotificationsApi,
  OrgsApi,
  ReleasesApi,
  ReposApi,
  SearchApi,
  SecurityAlertsApi,
  SubscribeOptions,
  SubscriptionItem,
  ThreadsApi,
  UsersApi,
  VerbScopes,
  WebhookDelivery,
  WebhooksApi,
} from './provider.ts'
import type { ForgeVerb } from './supports.ts'
import type { UrlTarget, WebLinks } from './web.ts'
import { ALERT_KINDS, applyNotApplicable, capabilitiesOf, ciJobSupport, commitCommentSupport, getCommentKinds, getReviewSupport, KINDS, resolve, restrict, threadEventKinds, trackDeclared, WRITE_VERBS } from './capabilities.ts'
import { CAPABILITY_TABLE } from './capability-table.ts'
import { decodeText, isSha } from './contents.ts'
import { NotFoundError, ReadOnlyError, UnsupportedOperationError, WebhookVerificationError } from './errors.ts'
import { completeEvent } from './events.ts'
import { createFetcher, createRequest } from './fetch.ts'
import { isUnsupported } from './model.ts'
import { can, support } from './supports.ts'
import { forgeIterable, hostOf, isFirstPage, iteratePages, memo } from './utils.ts'
import { parseReferences, parseWebUrl, referenceFor, webUrlFor } from './web.ts'

/** What support can depend on once the provider exists. */
export interface CapabilityEnv {
  /** Instance version from `instanceVersion` or `refreshCapabilities()`, when known. */
  version?: string
}

/**
 * The support level a provider declares for a verb: a {@link Support}, or one
 * of two levels that the capability matrix and `pnpm test:capabilities` read,
 * and that `capabilities` reports as `true`:
 *
 * - `'experimental'`: verified, but built on an API the forge marks unstable.
 * - `'unverified'`: implemented, but no test verifies it against the forge yet.
 */
export type DeclaredSupport = Support | 'experimental' | 'unverified'

/** A fixed support level, or one computed from the instance version. */
export type SupportInput = DeclaredSupport | ((env: CapabilityEnv) => DeclaredSupport)

/** The `ThreadQuery` filters that a provider declares in `threads.listFilters` when its listing applies them. */
export type ThreadFilter = 'involves' | 'mentions' | 'milestone'

const THREAD_FILTERS: readonly ThreadFilter[] = ['involves', 'mentions', 'milestone']

/** The security alert kinds that support can differ by. */
export type AlertKind = Exclude<SecurityAlertKind, 'other'>

/** A verb whose support does not depend on the thread kind. */
export interface Verb<F> {
  /** How well the verb is supported. */
  support: SupportInput
  run: F
}

/** A verb whose support depends on the thread kind it is called with. Kinds not listed are unsupported. */
export interface KindVerb<F> {
  /** How well each thread kind is supported. */
  kinds: Partial<Record<ThreadKind, SupportInput>>
  run: F
}

/**
 * Declares a verb whose support does not depend on the thread kind.
 * @param support How well the verb is supported.
 * @param run The function that implements the verb.
 */
export function verb<F>(support: SupportInput, run: F): Verb<F> {
  return { support, run }
}

/**
 * Declares a verb whose support depends on the thread kind.
 * @param kinds How well each thread kind is supported. Kinds that are left out are unsupported.
 * @param run The function that implements the verb.
 * @example
 * ```ts
 * const threads = {
 *   get: perKind({ issue: true, pull_request: true }, getThread),
 * }
 * ```
 */
export function perKind<F>(kinds: Partial<Record<ThreadKind, SupportInput>>, run: F): KindVerb<F> {
  return { kinds, run }
}

export { supportOnly } from './capabilities.ts'

type ThreadVerb<K extends keyof ThreadsApi> = KindVerb<NonNullable<ThreadsApi[K]>>

/** The installations a provider declares, with its listings as pages. */
export type InstallationsSpec = Omit<InstallationsApi, 'list' | 'repos'> & { listPage: PageOf<InstallationsApi['list']>, reposPage: PageOf<InstallationsApi['repos']> }

/** Everything a provider declares. Methods and capabilities are both derived from it. */
export interface ProviderSpec<TExtensions extends object = Record<never, never>> {
  /** Members that only this forge's providers have, such as `graphql()` on GitHub. They are added to the provider unchanged. */
  extensions?: TExtensions
  /**
   * Capabilities the forge has no such operation for, reported as
   * `'not_applicable'` rather than `false`.
   */
  notApplicable?: readonly CapabilityPath[]
  /** Capabilities that no single verb carries. */
  traits: {
    /** Whether event kinds come from the forge or are inferred from text. See `ForgeCapabilities.eventKinds`. */
    eventKinds: ForgeCapabilities['eventKinds']
    /** The auth types the provider accepts. */
    authKinds: readonly AuthKind[]
    /** Limits on the text the forge accepts. */
    limits?: TextLimits
  }
  /** Listings are declared as pages; core derives the iterables. */
  repos: {
    get: Verb<ReposApi['get']>
    listPage: Verb<PageOf<ReposApi['list']>>
    byOwnerPage?: Verb<PageOf<ReposApi['byOwner']>>
    labelsPage?: Verb<PageOf<ReposApi['labels']>>
    createLabel?: Verb<ReposApi['createLabel']>
    milestonesPage?: Verb<PageOf<ReposApi['milestones']>>
    issueTypes?: Verb<ReposApi['issueTypes']>
    collaboratorsPage?: Verb<PageOf<ReposApi['collaborators']>>
    contributorsPage?: Verb<PageOf<ReposApi['contributors']>>
    contributorStats?: Verb<ReposApi['contributorStats']>
    templates?: Verb<ReposApi['templates']>
    permissionFor?: Verb<ReposApi['permissionFor']>
    addCollaborator?: Verb<ReposApi['addCollaborator']>
    assignableUsersPage?: Verb<PageOf<ReposApi['assignableUsers']>>
    reviewerCandidatesPage?: Verb<PageOf<ReposApi['reviewerCandidates']>>
    /** The implementation of `provider.repos.events()`, one page at a time. */
    eventsPage?: Verb<(repo: RepoRef, options?: EventFeedOptions) => Promise<Page<ForgeEventInput>>>
  }
  /** `get` is omitted when the forge cannot read an account by login. */
  users?: {
    get?: Verb<UsersApi['get']>
    me?: Verb<UsersApi['me']>
    sponsorable?: Verb<UsersApi['sponsorable']>
    /** The implementation of `provider.users.events()`, one page at a time. */
    eventsPage?: Verb<(login: string, options?: EventFeedOptions) => Promise<Page<ForgeEventInput>>>
    /** One capability covers blocking and unblocking. */
    blocking?: Verb<Pick<UsersApi, 'block' | 'unblock'>>
  }
  /** An organisation's teams and their members. Listings are declared as pages; core derives the iterables. */
  orgs?: {
    /** The implementation of `provider.orgs.teams()`, one page at a time. */
    teamsPage?: Verb<PageOf<OrgsApi['teams']>>
    /** The implementation of `provider.orgs.teamMembers()`, one page at a time. */
    teamMembersPage?: Verb<PageOf<OrgsApi['teamMembers']>>
    /** One capability covers blocking and unblocking. */
    blocking?: Verb<Pick<OrgsApi, 'block' | 'unblock'>>
  }
  threads: {
    get: ThreadVerb<'get'>
    listPage: KindVerb<PageOf<ThreadsApi['list']>>
    /**
     * The {@link ThreadFilter}s that `listPage` applies, or reports with its own warning. Core leaves the others out
     * of the query and adds a `filter_unsupported` warning to the first page.
     */
    listFilters?: readonly ThreadFilter[]
    getMany: Verb<ThreadsApi['getMany']>
    closingIssuesPage?: Verb<PageOf<ThreadsApi['closingIssues']>>
    closingPullRequestsPage?: Verb<PageOf<ThreadsApi['closingPullRequests']>>
    eventsPage: Verb<(ref: ThreadRef, options?: ListOptions) => Promise<Page<ForgeEventInput>>>
    commentsPage: KindVerb<PageOf<ThreadsApi['comments']>>
    getComment?: ThreadVerb<'getComment'>
    createComment?: ThreadVerb<'createComment'>
    updateComment?: ThreadVerb<'updateComment'>
    deleteComment?: ThreadVerb<'deleteComment'>
    /** One capability covers hiding and unhiding a comment. */
    hiding?: KindVerb<Pick<ThreadsApi, 'hideComment' | 'unhideComment'>>
    close?: ThreadVerb<'close'>
    reopen?: ThreadVerb<'reopen'>
    /** One capability covers locking and unlocking. */
    locking?: KindVerb<Pick<ThreadsApi, 'lock' | 'unlock'>>
    create?: ThreadVerb<'create'>
    update?: ThreadVerb<'update'>
    setLabels?: ThreadVerb<'setLabels'>
    addLabels?: ThreadVerb<'addLabels'>
    removeLabels?: ThreadVerb<'removeLabels'>
    setMilestone?: ThreadVerb<'setMilestone'>
    setIssueType?: ThreadVerb<'setIssueType'>
    /** One capability covers reacting and removing a reaction. */
    reactions?: KindVerb<{ [K in 'react' | 'unreact']: NonNullable<ThreadsApi[K]> }>
    /** Listing the reactions on a thread or one of its comments. */
    reactionsPage?: KindVerb<PageOf<ThreadsApi['reactions']>>
    transfer?: Verb<ThreadsApi['transfer']>
    markDuplicate?: Verb<ThreadsApi['markDuplicate']>
    setAssignees?: ThreadVerb<'setAssignees'>
    requestReview?: ThreadVerb<'requestReview'>
    merge?: Verb<ThreadsApi['merge']>
    updateBranch?: Verb<ThreadsApi['updateBranch']>
    /** One capability covers reading and changing the subscription. */
    subscriptions?: KindVerb<{ [K in 'subscription' | 'subscribe' | 'unsubscribe']: NonNullable<ThreadsApi[K]> }>
    checks?: KindVerb<(ref: ThreadRef, options?: BaseOptions) => Promise<Page<Check>>>
    reviewsPage?: Verb<PageOf<ThreadsApi['reviews']>>
    getReview?: Verb<ThreadsApi['getReview']>
    createReview?: Verb<ThreadsApi['createReview']>
    submitReview?: Verb<ThreadsApi['submitReview']>
    replyToReviewComment?: Verb<ThreadsApi['replyToReviewComment']>
    /** Omit to derive approval from `createReview`. */
    approve?: Verb<ThreadsApi['approve']>
    filesPage?: Verb<PageOf<ThreadsApi['files']>>
    commitsPage?: Verb<PageOf<ThreadsApi['commits']>>
    /** One capability covers resolving and unresolving. */
    reviewThreads?: Verb<Pick<ThreadsApi, 'resolveReviewThread' | 'unresolveReviewThread'>>
  }
  /**
   * Support for the single-item reads core emulates from their listings where the spec declares no endpoint.
   * Each defaults to `'emulated'`, capped by the listing's own support.
   */
  emulated?: {
    getComment?: Partial<Record<ThreadKind, SupportInput>>
    getReview?: SupportInput
    getJob?: SupportInput
    getCommitComment?: SupportInput
  }
  /** Commit-level checks, beside the pull-level `threads.checks`. */
  checks?: {
    /** The implementation of `provider.checks.list()`. */
    list?: Verb<ChecksApi['list']>
    /** The implementation of `provider.checks.get()`. */
    get?: Verb<ChecksApi['get']>
    /** The implementation of `provider.checks.report()`. */
    report?: Verb<ChecksApi['report']>
    /** The implementation of `provider.checks.rerun()`. */
    rerun?: Verb<ChecksApi['rerun']>
  }
  /** Read-only CI. Listings are declared as pages; core derives the iterables. */
  ci?: {
    /** The implementation of `provider.ci.runs()`, one page at a time. */
    runsPage?: Verb<PageOf<CiApi['runs']>>
    /** The implementation of `provider.ci.getRun()`. */
    getRun?: Verb<CiApi['getRun']>
    /** The implementation of `provider.ci.jobs()`, one page at a time. */
    jobsPage?: Verb<PageOf<CiApi['jobs']>>
    /** The implementation of `provider.ci.getJob()`. */
    getJob?: Verb<CiApi['getJob']>
    /** The implementation of `provider.ci.log()`. */
    log?: Verb<CiApi['log']>
  }
  /** Repository contents. Listings are declared as pages; core derives the iterables. */
  contents?: {
    /** The implementation of `provider.contents.getFile()`. */
    getFile?: Verb<ContentsApi['getFile']>
    /** The implementation of `provider.contents.tree()`, one page at a time. */
    treePage?: Verb<PageOf<ContentsApi['tree']>>
    /** The implementation of `provider.contents.branches()`, one page at a time. */
    branchesPage?: Verb<PageOf<ContentsApi['branches']>>
    /** The implementation of `provider.contents.tags()`, one page at a time. */
    tagsPage?: Verb<PageOf<ContentsApi['tags']>>
    /** Omit where a sha lookup is impossible; core still short-circuits a 40-hex ref. */
    resolveRef?: Verb<ContentsApi['resolveRef']>
    /** The implementation of `provider.contents.compare()`. */
    compare?: Verb<ContentsApi['compare']>
    /** The implementation of `provider.contents.commitFiles()`, called once core has checked the input. */
    commitFiles?: Verb<ContentsApi['commitFiles']>
  }
  commits?: {
    /** The implementation of `provider.commits.list()`, one page at a time. */
    listPage?: Verb<PageOf<CommitsApi['list']>>
    /** The implementation of `provider.commits.get()`. */
    get?: Verb<CommitsApi['get']>
    /** The implementation of `provider.commits.comments()`, one page at a time. */
    commentsPage?: Verb<PageOf<CommitsApi['comments']>>
    /** Omit where the forge has no endpoint; core walks `commentsPage` instead. */
    getComment?: Verb<CommitsApi['getComment']>
    /** The implementation of `provider.commits.createComment()`. */
    createComment?: Verb<CommitsApi['createComment']>
    /** The implementation of `provider.commits.updateComment()`. */
    updateComment?: Verb<CommitsApi['updateComment']>
    /** The implementation of `provider.commits.deleteComment()`. */
    deleteComment?: Verb<CommitsApi['deleteComment']>
    /** One capability covers hiding and showing. */
    commentHiding?: Verb<Pick<CommitsApi, 'hideComment' | 'unhideComment'>>
  }
  /** Cross-repository search. Listings are declared as pages; core derives the iterables. */
  search?: {
    /** The implementation of `provider.search.threads()`, one page at a time. */
    threadsPage?: Verb<PageOf<SearchApi['threads']>>
    /** The implementation of `provider.search.repos()`, one page at a time. */
    reposPage?: Verb<PageOf<SearchApi['repos']>>
    /** The implementation of `provider.search.commits()`, one page at a time. */
    commitsPage?: Verb<PageOf<SearchApi['commits']>>
    /** The implementation of `provider.search.code()`, one page at a time. */
    codePage?: Verb<PageOf<SearchApi['code']>>
    /** The searches pass `queryRaw` on; without this, core drops it with a warning. */
    queryRaw?: boolean
  }
  releases?: {
    /** The implementation of `provider.releases.list()`, one page at a time. */
    listPage: Verb<PageOf<ReleasesApi['list']>>
    /** The implementation of `provider.releases.get()`. */
    get: Verb<ReleasesApi['get']>
    /** The implementation of `provider.releases.latest()`. */
    latest: Verb<ReleasesApi['latest']>
    /** The implementation of `provider.releases.getByTag()`. */
    getByTag?: Verb<ReleasesApi['getByTag']>
    /** The implementation of `provider.releases.downloadAsset()`. */
    downloadAsset?: Verb<(ref: ReleaseAssetRef, options?: BaseOptions) => Promise<ReadableStream<Uint8Array>>>
    /** The implementation of `provider.releases.create()`. */
    create?: Verb<ReleasesApi['create']>
    /** The implementation of `provider.releases.update()`. */
    update?: Verb<ReleasesApi['update']>
  }
  /** Support per alert kind; `listPage` is called with `kind` unset to list every supported kind. */
  securityAlerts?: {
    /** The implementation of `provider.securityAlerts.kinds()`. */
    kinds: Partial<Record<AlertKind, SupportInput>>
    /** The implementation of `provider.securityAlerts.list()`, one page at a time. */
    listPage: PageOf<SecurityAlertsApi['list']>
  }
  /** Omit when the forge has no notifications. `list` is derived from `page`. */
  notifications?: {
    listPage: Verb<(options?: NotificationListOptions) => Promise<Page<Notification>>>
  } & { [K in Exclude<keyof NotificationsApi, 'list'>]?: Verb<NonNullable<NotificationsApi[K]>> }
  /** The implementation of `provider.installations`, except for `list()` and `repos()`, which core derives. */
  installations?: Verb<InstallationsSpec>
  sources?: { /** The implementation of `provider.sources.subscribe()`. */
    subscribe: Verb<(options?: SubscribeOptions) => AsyncIterable<{ event: ForgeEventInput, cursor: string }>>
  }
  /** Managing registered hooks. Listings are declared as pages; core derives the iterables. */
  webhooks: {
    listPage?: Verb<PageOf<WebhooksApi['list']>>
    create?: Verb<WebhooksApi['create']>
    update?: Verb<WebhooksApi['update']>
    delete?: Verb<WebhooksApi['delete']>
    rotateSecret?: Verb<WebhooksApi['rotateSecret']>
    deliveriesPage?: Verb<PageOf<WebhooksApi['deliveries']>>
    redeliver?: Verb<WebhooksApi['redeliver']>
  }
  /** Token scopes or app permissions per verb, for `provider.scopesFor()`. */
  scopes?: (verb: ForgeVerb) => VerbScopes
  /** The implementation of `provider.normaliseMarkdown()`. Without it, Markdown is returned unchanged. */
  normaliseMarkdown?: (body: string) => string
  /** How the forge's web pages are laid out; omit when they have no stable pattern. */
  web?: WebLinks
  /** Fetcher behind `request()`, when it differs from the context fetcher. */
  request?: Fetcher
  /** Reads the instance version for `refreshCapabilities()`. Omit when capabilities never depend on it. */
  probeVersion?: () => Promise<string | undefined>
  /** The implementation of `provider.rateLimits()`, for a provider whose requests bypass its fetchers. */
  rateLimits?: () => RateLimit[]
}

/** The options, the identity and the resolved URLs that provider hooks receive. */
export interface ProviderBase<TOptions, TState> {
  options: TOptions
  forge: ForgeKind
  instance: ForgeInstance
  /** API base after defaults and the API path are applied. */
  baseUrl: string
  /** Default headers: the definition's, plus `user-agent` outside browsers or when the caller sets one. */
  headers: Record<string, string>
  /** Error context for this provider. */
  origin: {
    forge: ForgeKind
    instance: ForgeInstance
  }
  /** State passed to `derive()`, or created by `prepare()`. */
  state: TState
}

/** The argument of `setup()`: the base, the fetchers and `derive()`. */
export interface ProviderContext<TOptions, TState> extends ProviderBase<TOptions, TState> {
  /** Authenticated with the definition's `authHeaders`. */
  fetcher: Fetcher
  /**
   * Another fetcher with the same timeout, `fetch` and error context. It sends no credentials unless it sets
   * its own `authHeaders`. Its budgets count towards `provider.rateLimits()` only when neither it nor
   * `fetcher` sends credentials.
   */
  createFetcher: (overrides: Partial<FetcherOptions> & { baseUrl: string }) => Fetcher
  /** Another provider from the same definition, for example one per app installation. */
  derive: (options: TOptions, state?: TState) => ForgeProvider
}

/** The defaults, the authentication and the `setup()` of a forge. */
export interface ProviderDefinition<TOptions extends ForgeOptionsBase, TState = undefined, HasWeb extends boolean = boolean, TExtensions extends object = Record<never, never>> {
  forge: ForgeKind
  /** The forge's API as a whole is unstable, so the provider can change with it. */
  experimental?: true
  /**
   * Accepts a missing `auth` as `{ type: 'anonymous' }`: core then sends no
   * credentials and marks writes, notifications, subscriptions, installations
   * and the account's repository list unsupported. `'webhooks'` marks every
   * verb unsupported, for a forge whose API needs credentials but whose
   * webhook deliveries can be verified without them.
   */
  anonymous?: true | 'webhooks'
  /** Default `baseUrl` when the caller passes none. */
  baseUrl: string
  /** Appended to `baseUrl` unless already present, for example `/api/v4`. */
  apiPath?: string
  /** Maps the API host to the instance host, for example `api.github.com` to `github.com`. */
  instance?: (host: string) => string
  headers?: Record<string, string>
  /** Builds per-provider state once; receives the state given to `derive()`, if any. */
  prepare?: (base: ProviderBase<TOptions, TState | undefined>) => TState
  /** Resolves the credential headers of each request. */
  authHeaders?: (base: ProviderBase<TOptions, TState>) => FetcherOptions['authHeaders']
  /** Query parameters for every request, such as an API version; see `FetcherOptions.query`. */
  query?: Record<string, string>
  /** Whether the forge has a website: `setup()` must then return `web`, and the provider's `webOrigin` is typed `string`. */
  hasWeb?: HasWeb
  /** Declares the verbs and the web links of one provider. */
  setup: (ctx: ProviderContext<TOptions, TState>) => HasWeb extends true ? ProviderSpec<TExtensions> & { web: WebLinks } : ProviderSpec<TExtensions>
  /** Delivery verification and translation. Omit it and `webhooks.ingest()` is unsupported. */
  webhooks?: WebhookHandlers<TOptions>
}

/** Verifies and translates deliveries for one provider; built once per instance from its context. */
export type WebhookHandlers<TOptions> = (ctx: Omit<ProviderContext<TOptions, unknown>, 'state' | 'derive'>) => {
  /** Normalised kinds and actions the handlers translate. */
  events: WebhookEventType[]
  verify: (delivery: WebhookDelivery) => Promise<boolean>
  translate: (delivery: WebhookDelivery) => ForgeEventInput[] | Promise<ForgeEventInput[]>
}

/** Iterables whose page takes only options, with no target before them. */
const UNTARGETED = new Set(['repos.list', 'notifications.list', 'installations.list', 'search.threads', 'search.repos', 'search.commits', 'search.code'])

/** The thread kind a per-kind verb is called for, read from its arguments. */
function kindOf(name: string, args: unknown[]): string | undefined {
  const first = args[0] as { kind?: string, thread?: { kind?: string } } | undefined
  if (name === 'create' || name === 'list') {
    return (args[1] as { kind?: string } | undefined)?.kind
  }
  return first?.thread?.kind ?? first?.kind
}

async function* completeItems(items: AsyncIterable<{ event: ForgeEventInput, cursor: string }>): AsyncGenerator<SubscriptionItem> {
  for await (const item of items) {
    yield { ...item, event: completeEvent(item.event) }
  }
}

type AnyFunction = (...args: any[]) => any

/** The page function behind a listing such as `ThreadsApi['comments']`. */
type PageOf<F> = F extends (...args: infer A) => ForgeListing<infer T> ? (...args: A) => Promise<Page<T>> : never

function readPath(source: unknown, path: string): any {
  return path.split('.').reduce<any>((value, key) => value?.[key], source)
}

function instanceHost(baseUrl: string, kind: ForgeKind): string {
  try {
    return hostOf(baseUrl)
  }
  catch (cause) {
    throw new TypeError(`Invalid baseUrl for ${kind}: ${JSON.stringify(baseUrl)}`, { cause })
  }
}

/** Most reads spent looking for a first item when a provider's filtering empties a page. */
const MAX_EMPTY_READS = 10

/**
 * Providers that cannot filter on the forge's side drop items from each page
 * they read, so a page can come back empty with a `cursor`. Reads on until the
 * page has an item, the listing ends or `MAX_EMPTY_READS` reads are spent.
 */
async function nonEmptyPage<T>(read: (cursor: Cursor | undefined) => Promise<Page<T>>, start: Cursor | undefined): Promise<Page<T>> {
  let page = await read(start)
  const warnings = page.warnings
  for (let reads = 1; !page.items.length && page.cursor && !page.notModified && reads < MAX_EMPTY_READS; reads++) {
    page = await read(page.cursor)
  }
  if (!warnings?.length || page.warnings === warnings) {
    return page
  }
  const later = (page.warnings ?? []).filter(warning => !warnings.some(seen => seen.code === warning.code && seen.message === warning.message))
  return { ...page, warnings: [...warnings, ...later] }
}

/** Resets this close together belong to one window, as a reset in seconds from now drifts between responses. */
const RESET_TOLERANCE_MS = 1000

/** Whether `next` was counted before `kept` though it arrived after it: from an older window, or with more requests left in the same one. */
function countedBefore(next: RateLimit, kept: RateLimit): boolean {
  if (!next.resetAt || !kept.resetAt) {
    return false
  }
  const gap = next.resetAt.getTime() - kept.resetAt.getTime()
  if (Math.abs(gap) > RESET_TOLERANCE_MS) {
    return gap < 0
  }
  return next.remaining !== undefined && kept.remaining !== undefined && next.remaining > kept.remaining
}

function createProvider<TOptions extends ForgeOptionsBase, TState, HasWeb extends boolean = boolean, TExtensions extends object = Record<never, never>>(
  definition: ProviderDefinition<TOptions, TState, boolean, TExtensions>,
  givenOptions: TOptions,
  givenState?: TState,
): ForgeProvider<HasWeb> & TExtensions {
  const givenAuth = (givenOptions as { auth?: { type: string } }).auth
  const anonymous = Boolean(definition.anonymous) && (!givenAuth || givenAuth.type === 'anonymous')
  const options = anonymous && !givenAuth ? { ...givenOptions, auth: { type: 'anonymous' } } as TOptions : givenOptions
  const root = (options.baseUrl ?? definition.baseUrl).replace(/\/$/, '')
  const baseUrl = definition.apiPath && !root.endsWith(definition.apiPath) ? `${root}${definition.apiPath}` : root
  const host = instanceHost(baseUrl, definition.forge)
  const instance = options.instance ?? definition.instance?.(host) ?? host
  const origin = { forge: definition.forge, instance }
  // Browsers send their own user agent, and setting one can trigger a CORS preflight that some forges reject.
  const browser = 'document' in globalThis || 'WorkerGlobalScope' in globalThis
  const userAgent = options.userAgent ?? (browser ? undefined : 'forges')
  const headers = { ...definition.headers, ...userAgent ? { 'user-agent': userAgent } : {} }
  const prepared = { options, forge: definition.forge, instance, baseUrl, headers, origin, state: givenState }
  const state = (definition.prepare ? definition.prepare(prepared) : givenState) as TState
  const base: ProviderBase<TOptions, TState> = { ...prepared, state }
  const budgets = new Map<string | undefined, RateLimit>()
  const tracked: FetcherOptions['onRateLimit'] = (event) => {
    const kept = budgets.get(event.rateLimit.resource)
    if (!kept || !countedBefore(event.rateLimit, kept)) {
      budgets.set(event.rateLimit.resource, event.rateLimit)
    }
    options.onRateLimit?.(event)
  }
  const authHeaders = anonymous ? undefined : definition.authHeaders?.(base)
  const makeFetcher = (overrides: Partial<FetcherOptions> & { baseUrl: string }) => createFetcher({
    fetch: options.fetch,
    timeout: options.timeout,
    onRetry: options.onRetry,
    onRateLimit: 'authHeaders' in overrides || authHeaders ? options.onRateLimit : tracked,
    headers,
    query: definition.query,
    context: origin,
    ...overrides,
  })
  const fetcher = makeFetcher({ baseUrl, authHeaders, onRateLimit: tracked })
  const ctx: ProviderContext<TOptions, TState> = {
    ...base,
    fetcher,
    createFetcher: makeFetcher,
    derive: (derivedOptions, derivedState) => createProvider<TOptions, TState, HasWeb>(definition, derivedOptions, derivedState ?? state),
  }
  const declaredSpec = applyNotApplicable(definition.setup(ctx))
  const handlers = definition.webhooks?.(ctx)
  const spec = anonymous || options.readOnly ? restrict(declaredSpec, anonymous, definition.anonymous === 'webhooks') : declaredSpec
  const authKind = anonymous ? 'anonymous' : (givenAuth?.type ?? spec.traits.authKinds[0] ?? 'anonymous') as AuthKind

  const env: CapabilityEnv = { version: options.instanceVersion }
  const probeVersion = spec.probeVersion && memo(spec.probeVersion)
  const flags = { experimental: Boolean(definition.experimental), readOnly: Boolean(options.readOnly), webhook: Boolean(handlers) }
  let capabilities = capabilitiesOf(spec, env, flags)

  const unsupported = (verb: string, support?: DeclaredSupport, kind?: string) => options.readOnly && WRITE_VERBS.has(verb)
    ? new ReadOnlyError(`${verb} is a write and this ${definition.forge} provider is read-only`, origin)
    : new UnsupportedOperationError(`${definition.forge} ${support === 'not_applicable' ? 'has no' : 'does not support'} ${verb}${kind ? ` for a ${kind.replace('_', ' ')}` : ''}`, origin)
  /** An iterable that rejects on first read, for listings the forge does not have. */
  const emptyIterable = <T>(verb: string, support?: DeclaredSupport): ForgeIterable<T> => forgeIterable<T>(async function* () {
    throw unsupported(verb, support)
  })

  /** Support is resolved at call time, so a version gate is honoured once the version is known. */
  function gate(verb: string, support: SupportInput | undefined, run: AnyFunction | undefined): AnyFunction {
    return (...args) => {
      const level = resolve(support, env)
      return run && !isUnsupported(level) ? run(...args) : Promise.reject(unsupported(verb, level))
    }
  }

  /** A per-kind verb: rejects for kinds it does not support, or entirely when undeclared. */
  function kindGate(verb: string, kinds: Partial<Record<ThreadKind, SupportInput>> | undefined, run: AnyFunction | undefined): AnyFunction {
    const name = verb.slice(verb.indexOf('.') + 1)
    return (...args) => {
      const kind = kindOf(name, args)
      const knownKind = kind && (KINDS as string[]).includes(kind) ? kind as ThreadKind : undefined
      if (!run || (options.readOnly && WRITE_VERBS.has(verb))) {
        return Promise.reject(unsupported(verb, kinds && resolve(kinds[knownKind ?? 'issue'], env)))
      }
      if (knownKind) {
        const level = resolve(kinds?.[knownKind], env)
        if (isUnsupported(level)) {
          return Promise.reject(unsupported(verb, level, knownKind))
        }
      }
      return run(...args)
    }
  }

  const api: Record<string, Record<string, unknown>> = {}
  const set = (verb: string, value: unknown) => {
    const [group, name] = verb.split('.') as [string, string]
    ;(api[group] ??= {})[name] = value
  }
  const call = (verb: string): AnyFunction => readPath(api, verb)
  const listing = <T>(read: (options: any) => Promise<Page<T>>, listOptions: object = {}): ForgeListing<T> =>
    Object.assign(iteratePages(read, listOptions), { page: () => read(listOptions) })

  const subscriptions = spec.threads.subscriptions
  const createReview = spec.threads.createReview
  const approve = spec.threads.approve ?? (createReview && {
    support: createReview.support,
    ...createReview.run ? { run: (ref: ThreadRef, body?: string, options?: BaseOptions) => createReview.run(ref, { event: 'approve', body }, options) } : {},
  })
  const declaredSubscribe = spec.sources?.subscribe
  const alerts = spec.securityAlerts
  const declaredInstallations = spec.installations
  const installationsSupported = () => Boolean(declaredInstallations?.run && !isUnsupported(resolve(declaredInstallations.support, env)))

  const listThreads = kindGate('threads.list', spec.threads.listPage.kinds, spec.threads.listPage.run)
  const listOwnerRepos = gate('repos.byOwner', spec.repos.byOwnerPage?.support, spec.repos.byOwnerPage?.run)
  const listComments = kindGate('threads.comments', spec.threads.commentsPage.kinds, spec.threads.commentsPage.run)
  const listEvents = kindGate('threads.events', Object.fromEntries(KINDS.map(kind => [kind, (kindEnv: CapabilityEnv) => threadEventKinds(spec, kindEnv)[kind]])), spec.threads.eventsPage.run)
  const native = spec.search?.queryRaw
  const search = (name: 'threadsPage' | 'reposPage' | 'commitsPage' | 'codePage') => {
    const run = gate(`search.${name.slice(0, -4)}`, spec.search?.[name]?.support, spec.search?.[name]?.run)
    return async ({ queryRaw, ...query }: { queryRaw?: string, cursor?: Cursor } = {}) => {
      const page = await run(native ? { queryRaw, ...query } : query) as Page<unknown>
      return !queryRaw || native || !isFirstPage(query.cursor) ? page : { ...page, warnings: [{ code: 'filter_unsupported', message: 'This search has no query syntax; queryRaw was ignored' }, ...page.warnings ?? []] }
    }
  }
  const feed = (verb: 'repos.eventsPage' | 'users.eventsPage') => {
    const declared = readPath(spec, verb) as Verb<AnyFunction> | undefined
    const run = gate(verb.slice(0, -4), declared?.support, declared?.run)
    return async (target: unknown, pageOptions?: EventFeedOptions) => {
      const page = await run(target, pageOptions) as Page<ForgeEventInput>
      return { ...page, items: page.items.map(completeEvent) }
    }
  }
  const special: Record<string, unknown> = {
    'repos.eventsPage': feed('repos.eventsPage'),
    'users.eventsPage': feed('users.eventsPage'),
    'search.threadsPage': search('threadsPage'),
    'search.reposPage': search('reposPage'),
    'search.commitsPage': search('commitsPage'),
    'search.codePage': search('codePage'),
    'threads.listPage': async (repo: RepoRef, given: ThreadQuery = {}) => {
      if (given.state === 'merged' && given.kind && given.kind !== 'pull_request') {
        return { items: [] }
      }
      const query = { ...given }
      const ignored = THREAD_FILTERS.filter(filter => query[filter] !== undefined && !spec.threads.listFilters?.includes(filter))
      for (const filter of ignored) {
        delete query[filter]
      }
      const run = (cursor: Cursor | undefined) => listThreads(repo, { ...query, ...query.state === 'merged' ? { kind: 'pull_request' } : {}, cursor })
      const page = await nonEmptyPage(run, query.cursor)
      if (!ignored.length || !isFirstPage(query.cursor)) {
        return page
      }
      const warnings = ignored.map(filter => ({ code: 'filter_unsupported', message: `This listing has no ${filter} filter; it was ignored` }))
      return { ...page, warnings: [...warnings, ...page.warnings ?? []] }
    },
    'repos.byOwnerPage': (owner: RepoRef, query: OwnerRepoQuery = {}) => nonEmptyPage(async (cursor) => {
      const page: Page<Repo> = await listOwnerRepos(owner, { ...query, cursor })
      return !query.visibility || query.visibility === 'all' ? page : { ...page, items: page.items.filter(repo => repo.visibility === query.visibility) }
    }, query.cursor),
    'threads.eventsPage': async (ref: ThreadRef, listOptions?: ListOptions) => {
      const page = await listEvents(ref, listOptions) as Page<ForgeEventInput>
      return { ...page, items: page.items.map(completeEvent) }
    },
    'threads.commentsPage': (ref: ThreadRef, listOptions: ListOptions = {}) => {
      const since = listOptions.since
      if (!since) {
        return listComments(ref, listOptions)
      }
      return nonEmptyPage(async (cursor) => {
        const page: Page<Comment> = await listComments(ref, { ...listOptions, cursor })
        return { ...page, items: page.items.filter(comment => (comment.updatedAt ?? comment.createdAt ?? since) >= since) }
      }, listOptions.cursor)
    },
    'threads.getComment': kindGate(
      'threads.getComment',
      Object.fromEntries(KINDS.map(kind => [kind, (kindEnv: CapabilityEnv) => getCommentKinds(spec, kindEnv)[kind]])),
      (ref: CommentRef, options?: BaseOptions) => !isUnsupported(resolve(spec.threads.getComment?.kinds[ref.thread.kind], env))
        ? spec.threads.getComment!.run(ref, options)
        : listed(call('threads.comments')(ref.thread, options), ref.id, 'Comment'),
    ),
    'threads.getReview': gate('threads.getReview', (reviewEnv: CapabilityEnv) => getReviewSupport(spec, reviewEnv), (ref: ReviewRef, options?: BaseOptions) => !isUnsupported(resolve(spec.threads.getReview?.support, env))
      ? spec.threads.getReview!.run(ref, options)
      : listed(call('threads.reviews')(ref.thread, options), ref.id, 'Review')),
    'ci.getJob': gate('ci.getJob', (jobEnv: CapabilityEnv) => ciJobSupport(spec, jobEnv), (ref: CiJobRef, options?: BaseOptions) => {
      if (!isUnsupported(resolve(spec.ci?.getJob?.support, env))) {
        return spec.ci!.getJob!.run(ref, options)
      }
      if (!ref.run) {
        return Promise.reject(new UnsupportedOperationError(`${definition.forge} reads a CI job from its run's jobs, and this ref names no run`, origin))
      }
      return listed(call('ci.jobs')(ref.run, options), ref.id, 'CI job')
    }),
    'commits.getComment': gate('commits.getComment', (commentEnv: CapabilityEnv) => commitCommentSupport(spec, commentEnv), (ref: CommitCommentRef, options?: BaseOptions) => !isUnsupported(resolve(spec.commits?.getComment?.support, env))
      ? spec.commits!.getComment!.run(ref, options)
      : listed(call('commits.comments')(ref.commit, options), ref.id, 'Comment')),
    'threads.subscribe': kindGate('threads.subscribe', subscriptions?.kinds, subscriptions?.run?.subscribe),
    'threads.unsubscribe': kindGate('threads.unsubscribe', subscriptions?.kinds, subscriptions?.run?.unsubscribe),
    'threads.approve': gate('threads.approve', approve?.support, approve?.run),
    'releases.downloadAsset': async (ref: ReleaseAssetRef, options?: DownloadAssetOptions) => {
      const stream: ReadableStream<Uint8Array> = await gate('releases.downloadAsset', spec.releases?.downloadAsset?.support, spec.releases?.downloadAsset?.run)(ref, options)
      if (!options?.as || options.as === 'stream') {
        return stream
      }
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
      return options.as === 'text' ? decodeText(bytes, `Release asset ${ref.id}`, origin) : bytes
    },
    'contents.compare': async (repo: RepoRef, base: string, head: string, compareOptions: CompareOptions = {}) => {
      const comparison: Comparison = await gate('contents.compare', spec.contents?.compare?.support, spec.contents?.compare?.run)(repo, base, head, compareOptions)
      const { commitLimit, files } = compareOptions
      if (commitLimit === undefined && files !== false) {
        return comparison
      }
      const commits = commitLimit === undefined ? comparison.commits : comparison.commits.slice(0, Math.max(0, commitLimit))
      return {
        ...comparison,
        commits: files === false ? commits.map(({ files: _files, ...commit }) => commit) : commits,
        ...files === false ? { files: [] } : {},
      }
    },
    'contents.resolveRef': (repo: RepoRef, ref: string, options?: BaseOptions) => isSha(ref)
      ? Promise.resolve(ref.toLowerCase())
      : gate('contents.resolveRef', spec.contents?.resolveRef?.support, spec.contents?.resolveRef?.run)(repo, ref, options),
    'contents.commitFiles': async (repo: RepoRef, input: CommitFilesInput, options?: BaseOptions) => {
      const declared = spec.contents?.commitFiles
      const level = resolve(declared?.support, env)
      if (!declared?.run || isUnsupported(level)) {
        throw unsupported('contents.commitFiles', level)
      }
      const changes = input.changes.map(change => ({ ...change, path: change.path.replace(/^\/+/, '') }))
      const paths = new Set(changes.map(change => change.path))
      if (!changes.length || paths.size < changes.length) {
        throw new TypeError('`changes` must name at least one file, and each file once')
      }
      const invalid = changes.find(change => change.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))
      if (invalid) {
        throw new TypeError(`\`${invalid.path}\` is not a path to a file: it has an empty, \`.\` or \`..\` segment`)
      }
      if (!input.branch || !input.message.trim()) {
        throw new TypeError('`branch` and `message` cannot be empty')
      }
      if (input.expectedHead !== undefined && !isSha(input.expectedHead)) {
        throw new TypeError('`expectedHead` must be a full commit sha')
      }
      if (input.expectedHead !== undefined && input.createFrom !== undefined) {
        throw new TypeError('`expectedHead` and `createFrom` cannot be combined: a branch created from `createFrom` has no head yet')
      }
      return declared.run(repo, { ...input, changes }, options)
    },
    'webhooks.verify': handlers ? handlers.verify : () => Promise.reject(unsupported('webhooks.verify', capabilities.webhooks.ingest)),
    'webhooks.ingest': async (delivery: WebhookDelivery) => {
      if (!handlers) {
        throw unsupported('webhooks.ingest', capabilities.webhooks.ingest)
      }
      if (!await handlers.verify(delivery)) {
        throw new WebhookVerificationError('Webhook signature verification failed', origin)
      }
      return (await handlers.translate(delivery)).map(completeEvent)
    },
    'sources.subscribe': (subscribeOptions?: SubscribeOptions) => declaredSubscribe?.run && !isUnsupported(resolve(declaredSubscribe.support, env))
      ? completeItems(declaredSubscribe.run(subscribeOptions))
      : emptyIterable('sources.subscribe', resolve(declaredSubscribe?.support, env)),
    'securityAlerts.listPage': (repo: RepoRef, listOptions: SecurityAlertListOptions = {}) => {
      const supported = alerts?.listPage && (listOptions.kind ? !isUnsupported(resolve(alerts.kinds[listOptions.kind as AlertKind], env)) : ALERT_KINDS.some(kind => !isUnsupported(resolve(alerts.kinds[kind], env))))
      if (!supported) {
        const level = listOptions.kind
          ? resolve(alerts?.kinds[listOptions.kind as AlertKind], env)
          : ALERT_KINDS.every(kind => resolve(alerts?.kinds[kind], env) === 'not_applicable') ? 'not_applicable' : false
        return Promise.reject(listOptions.kind
          ? new UnsupportedOperationError(`${definition.forge} ${level === 'not_applicable' ? 'has no' : 'cannot list'} ${listOptions.kind.replace('_', ' ')} alerts`, origin)
          : unsupported('securityAlerts.list', level))
      }
      return alerts.listPage(repo, listOptions)
    },
    'installations.provider': (installation: Installation | string) => {
      if (!installationsSupported()) {
        throw unsupported('installations.provider', resolve(declaredInstallations?.support, env))
      }
      return declaredInstallations!.run.provider(installation)
    },
    'installations.providers': () => installationsSupported() ? declaredInstallations!.run.providers() : emptyIterable('installations.providers', resolve(declaredInstallations?.support, env)),
  }

  for (const entry of CAPABILITY_TABLE) {
    const declared = entry.spec ? readPath(spec, entry.spec) : undefined
    for (const verb of entry.verbs ?? []) {
      if (verb in special) {
        set(verb, special[verb])
      }
      else if (entry.listings?.includes(verb)) {
        const pageVerb = `${verb}Page`
        const run = typeof declared?.run === 'function' ? declared.run : declared?.run?.[pageVerb.slice(pageVerb.indexOf('.') + 1)]
        const page = (special[pageVerb] ?? (entry.perKind ? kindGate(verb, declared?.kinds, run) : gate(verb, declared?.support, run))) as AnyFunction
        const untargeted = UNTARGETED.has(verb)
        set(verb, (...args: unknown[]) => listing(options => page(...untargeted ? [] : [args[0]], options), ((untargeted ? args[0] : args[1]) ?? {}) as object))
      }
      else {
        const run = typeof declared?.run === 'function' ? declared.run : declared?.run?.[verb.slice(verb.indexOf('.') + 1)]
        set(verb, entry.perKind ? kindGate(verb, declared?.kinds, run) : gate(verb, declared?.support, run))
      }
    }
  }
  api.webhooks!.events = handlers?.events ?? []

  async function listed<T extends { ref: { id: string } }>(items: AsyncIterable<T>, id: string, what: string): Promise<T> {
    for await (const item of items) {
      if (item.ref.id === id) {
        return item
      }
    }
    throw new NotFoundError(`${what} ${id} not found`, 404, '', origin)
  }

  return trackDeclared<ForgeProvider<HasWeb> & TExtensions>({
    ...declaredSpec.extensions as TExtensions,
    ...api as unknown as Pick<ForgeProvider, 'repos' | 'notifications' | 'threads' | 'webhooks' | 'releases' | 'contents' | 'commits' | 'checks' | 'ci' | 'users' | 'search' | 'securityAlerts' | 'sources' | 'installations' | 'orgs'>,
    forge: definition.forge,
    instance,
    baseUrl,
    authKind,
    request: createRequest(spec.request ?? fetcher, options.readOnly
      ? { readOnly: (method, path) => new ReadOnlyError(`${method} ${path} is a write and this ${definition.forge} provider is read-only; pass \`mutates: false\` if it only reads`, origin) }
      : {}),
    get capabilities() {
      return capabilities
    },
    rateLimits: spec.rateLimits ?? (() => {
      const now = Date.now()
      for (const [resource, budget] of budgets) {
        if (budget.resetAt && budget.resetAt.getTime() <= now) {
          budgets.delete(resource)
        }
      }
      return [...budgets.values()].map(budget => ({ ...budget }))
    }),
    async refreshCapabilities() {
      if (!options.instanceVersion && probeVersion) {
        env.version = await probeVersion()
        capabilities = capabilitiesOf(spec, env, flags)
      }
      return capabilities
    },
    normaliseMarkdown: spec.normaliseMarkdown ?? (body => body),
    scopesFor: verb => spec.scopes?.(verb) ?? {},
    can: (verb, kind) => can(capabilities, verb, kind),
    support: (verb, kind) => support(capabilities, verb, kind),
    urlFor: ((target: UrlTarget) => spec.web ? webUrlFor(spec.web, target) : undefined) as ForgeProvider<HasWeb>['urlFor'],
    webOrigin: (spec.web ? new URL(spec.web.baseUrl).origin : undefined) as HasWeb extends true ? string : string | undefined,
    parseUrl: url => spec.web ? parseWebUrl(spec.web, url, origin) : undefined,
    referenceFor: (ref, referenceOptions) => referenceFor(spec.web, ref, referenceOptions),
    parseReferences: (text, { from }) => parseReferences(spec.web, text, from, origin),
  }, () => capabilitiesOf(spec, env, flags, true))
}

/**
 * Defines a forge provider. Returns the function end users call to create
 * one, for example `github({ auth })`. Nothing touches the network until a
 * method of the provider is called.
 * @param definition The defaults, authentication and setup of the forge.
 */
export function defineForgeProvider<TOptions extends ForgeOptionsBase, TState = undefined, HasWeb extends boolean = boolean, Forge extends ForgeKind = ForgeKind, TExtensions extends object = Record<never, never>>(
  definition: ProviderDefinition<TOptions, TState, HasWeb, TExtensions>,
): ProviderFactoryFunction<TOptions, HasWeb, Forge, ForgeProvider<HasWeb> & TExtensions> {
  return ((options: TOptions = {} as TOptions) => createProvider<TOptions, TState, HasWeb, TExtensions>(definition, options)) as ProviderFactoryFunction<TOptions, HasWeb, Forge, ForgeProvider<HasWeb> & TExtensions>
}

/** The function `defineForgeProvider()` returns. Options are optional when every option is. */
export type ProviderFactoryFunction<TOptions, HasWeb extends boolean = boolean, Forge extends ForgeKind = ForgeKind, TProvider extends ForgeProvider<HasWeb> = ForgeProvider<HasWeb>> = Record<never, never> extends TOptions
  ? (options?: TOptions) => TProvider & { readonly forge: Forge }
  : (options: TOptions) => TProvider & { readonly forge: Forge }
