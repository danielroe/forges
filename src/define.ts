import type { Fetcher, FetcherOptions } from './fetch.ts'
import type { ApproveAndMergeOptions, Check, Comment, Cursor, ForgeEventInput, ForgeInstance, ForgeKind, Installation, ListOptions, MergeOptions, Notification, NotificationListOptions, Page, RepoRef, SecurityAlertKind, SecurityAlertListOptions, TextLimits, ThreadKind, ThreadQuery, ThreadRef, UpsertCommentInput, UpsertCommentResult, WebhookEventType } from './model.ts'
import type {
  AuthKind,
  ChecksApi,
  CiApi,
  ContentsApi,
  ForgeCapabilities,
  ForgeIterable,
  ForgeOptionsBase,
  ForgeProvider,
  ForgeProviderFactory,
  InstallationsApi,
  NotificationsApi,
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
import type { WebLinks } from './web.ts'
import { ALERT_KINDS, approveAndMergeSupport, capabilitiesOf, KINDS, resolve, restrict, upsertKinds, WRITE_VERBS } from './capabilities.ts'
import { CAPABILITY_TABLE } from './capability-table.ts'
import { isSha } from './contents.ts'
import { ReadOnlyError, UnsupportedOperationError, WebhookVerificationError } from './errors.ts'
import { completeEvent } from './events.ts'
import { createFetcher, createRequest } from './fetch.ts'
import { commentMarker, hasCommentMarker } from './model.ts'
import { supportOf, supports } from './supports.ts'
import { forgeIterable, hostOf, iteratePages, memo } from './utils.ts'
import { parseWebUrl, referenceFor, webUrlFor } from './web.ts'

/** What support can depend on once the provider exists. */
export interface CapabilityEnv {
  /** Instance version from `instanceVersion` or `refreshCapabilities()`, when known. */
  version?: string
}

/** A fixed support level, or one computed from the instance version. */
export type SupportInput = boolean | 'emulated' | 'experimental' | ((env: CapabilityEnv) => boolean | 'emulated' | 'experimental')

export type VerbKind = Exclude<ThreadKind, 'other'>

export type AlertKind = Exclude<SecurityAlertKind, 'other'>

/** A verb whose support does not depend on the thread kind. */
export interface Verb<F> {
  support: SupportInput
  run: F
}

/** A verb whose support depends on the thread kind it is called with. Kinds not listed are unsupported. */
export interface KindVerb<F> {
  kinds: Partial<Record<VerbKind, SupportInput>>
  run: F
}

export function verb<F>(support: SupportInput, run: F): Verb<F> {
  return { support, run }
}

export function perKind<F>(kinds: Partial<Record<VerbKind, SupportInput>>, run: F): KindVerb<F> {
  return { kinds, run }
}

type ThreadVerb<K extends keyof ThreadsApi> = KindVerb<NonNullable<ThreadsApi[K]>>

/** Everything a provider declares. Methods and capabilities are both derived from it. */
export interface ProviderSpec {
  /** Capabilities that no single verb carries. */
  traits: {
    /** Whether notifications can be polled; usually the notifications list support. */
    poll: boolean | 'emulated' | 'experimental'
    eventKinds: ForgeCapabilities['eventKinds']
    authKinds: readonly AuthKind[]
    limits?: TextLimits
  }
  /** Listings are declared as pages; core derives the iterables. */
  repos: {
    get: Verb<ReposApi['get']>
    listPage: Verb<ReposApi['listPage']>
    labelsPage?: Verb<ReposApi['labelsPage']>
    createLabel?: Verb<ReposApi['createLabel']>
    milestonesPage?: Verb<ReposApi['milestonesPage']>
    collaboratorsPage?: Verb<ReposApi['collaboratorsPage']>
    permissionFor?: Verb<ReposApi['permissionFor']>
    addCollaborator?: Verb<ReposApi['addCollaborator']>
    assignableUsersPage?: Verb<ReposApi['assignableUsersPage']>
    reviewerCandidatesPage?: Verb<ReposApi['reviewerCandidatesPage']>
  }
  /** `get` is omitted when the forge cannot read an account by login. */
  users?: { get?: Verb<UsersApi['get']>, me?: Verb<UsersApi['me']> }
  threads: {
    get: ThreadVerb<'get'>
    listPage: ThreadVerb<'listPage'>
    getMany: Verb<ThreadsApi['getMany']>
    eventsPage: Verb<(ref: ThreadRef, options?: ListOptions) => Promise<Page<ForgeEventInput>>>
    commentsPage: ThreadVerb<'commentsPage'>
    comment?: ThreadVerb<'comment'>
    editComment?: ThreadVerb<'editComment'>
    deleteComment?: ThreadVerb<'deleteComment'>
    close?: ThreadVerb<'close'>
    reopen?: ThreadVerb<'reopen'>
    create?: ThreadVerb<'create'>
    update?: ThreadVerb<'update'>
    setLabels?: ThreadVerb<'setLabels'>
    addLabels?: ThreadVerb<'addLabels'>
    removeLabels?: ThreadVerb<'removeLabels'>
    setMilestone?: ThreadVerb<'setMilestone'>
    /** One capability covers reacting and removing a reaction. */
    reactions?: KindVerb<{ [K in 'react' | 'unreact']: NonNullable<ThreadsApi[K]> }>
    /** Listing the reactions on a thread or one of its comments. */
    reactionsPage?: KindVerb<ThreadsApi['reactionsPage']>
    transfer?: Verb<ThreadsApi['transfer']>
    markDuplicate?: Verb<ThreadsApi['markDuplicate']>
    setAssignees?: ThreadVerb<'setAssignees'>
    requestReview?: ThreadVerb<'requestReview'>
    /** `beforeMerge` runs once the merge is validated, just before it is sent. */
    merge?: Verb<(ref: ThreadRef, options?: MergeOptions, hooks?: MergeHooks) => Promise<void>>
    /** Optional support override; approval and merging must also be supported. */
    approveAndMerge?: { support: SupportInput }
    /** One capability covers reading and changing the subscription. */
    subscriptions?: KindVerb<{ [K in 'subscription' | 'subscribe' | 'unsubscribe']: NonNullable<ThreadsApi[K]> }>
    checks?: KindVerb<(ref: ThreadRef) => Promise<Page<Check>>>
    reviewsPage?: Verb<ThreadsApi['reviewsPage']>
    createReview?: Verb<ThreadsApi['createReview']>
    submitReview?: Verb<ThreadsApi['submitReview']>
    /** Omit to derive approval from `createReview`. */
    approve?: Verb<ThreadsApi['approve']>
    filesPage?: Verb<ThreadsApi['filesPage']>
    commitsPage?: Verb<ThreadsApi['commitsPage']>
    /** One capability covers resolving and unresolving. */
    reviewThreads?: Verb<Pick<ThreadsApi, 'resolveReviewThread' | 'unresolveReviewThread'>>
  }
  /** Commit-level checks, beside the pull-level `threads.checks`. */
  checks?: {
    list?: Verb<ChecksApi['list']>
    report?: Verb<ChecksApi['report']>
    rerun?: Verb<ChecksApi['rerun']>
  }
  /** Read-only CI. Listings are declared as pages; core derives the iterables. */
  ci?: {
    runsPage?: Verb<CiApi['runsPage']>
    run?: Verb<CiApi['run']>
    jobsPage?: Verb<CiApi['jobsPage']>
    log?: Verb<CiApi['log']>
  }
  /** Repository contents. Listings are declared as pages; core derives the iterables. */
  contents?: {
    file?: Verb<ContentsApi['file']>
    treePage?: Verb<ContentsApi['treePage']>
    branchesPage?: Verb<ContentsApi['branchesPage']>
    tagsPage?: Verb<ContentsApi['tagsPage']>
    /** Omit where a sha lookup is impossible; core still short-circuits a 40-hex ref. */
    resolveRef?: Verb<ContentsApi['resolveRef']>
    commitsPage?: Verb<ContentsApi['commitsPage']>
    commit?: Verb<ContentsApi['commit']>
    compare?: Verb<ContentsApi['compare']>
  }
  /** Cross-repository search. Listings are declared as pages; core derives the iterables. */
  search?: {
    threadsPage?: Verb<SearchApi['threadsPage']>
    reposPage?: Verb<SearchApi['reposPage']>
    commitsPage?: Verb<SearchApi['commitsPage']>
    /** The searches pass `queryRaw` on; without this, core drops it with a warning. */
    queryRaw?: boolean
  }
  releases?: {
    listPage: Verb<ReleasesApi['listPage']>
    get: Verb<ReleasesApi['get']>
    latest: Verb<ReleasesApi['latest']>
    getByTag?: Verb<ReleasesApi['getByTag']>
    downloadAsset?: Verb<ReleasesApi['downloadAsset']>
  }
  /** Support per alert kind; `listPage` is called with `kind` unset to list every supported kind. */
  securityAlerts?: {
    kinds: Partial<Record<AlertKind, SupportInput>>
    listPage: SecurityAlertsApi['listPage']
  }
  /** Omit when the forge has no notifications. `list` is derived from `page`. */
  notifications?: {
    listPage: Verb<(options?: NotificationListOptions) => Promise<Page<Notification>>>
  } & { [K in Exclude<keyof NotificationsApi, 'list' | 'listPage'>]?: Verb<NonNullable<NotificationsApi[K]>> }
  installations?: Verb<Omit<InstallationsApi, 'list' | 'repos'>>
  sources?: { subscribe: Verb<(options?: SubscribeOptions) => AsyncIterable<{ event: ForgeEventInput, cursor: string }>> }
  /** Managing registered hooks. Listings are declared as pages; core derives the iterables. */
  webhooks: {
    listPage?: Verb<WebhooksApi['listPage']>
    create?: Verb<WebhooksApi['create']>
    update?: Verb<WebhooksApi['update']>
    delete?: Verb<WebhooksApi['delete']>
    rotateSecret?: Verb<WebhooksApi['rotateSecret']>
    deliveriesPage?: Verb<WebhooksApi['deliveriesPage']>
    redeliver?: Verb<WebhooksApi['redeliver']>
  }
  /** Token scopes or app permissions per verb, for `provider.scopesFor()`. */
  scopes?: (verb: ForgeVerb) => VerbScopes
  normaliseMarkdown?: (body: string) => string
  /** How the forge's web pages are laid out; omit when they have no stable pattern. */
  web?: WebLinks
  /** Fetcher behind `request()`, when it differs from the context fetcher. */
  request?: Fetcher
  /** Reads the instance version for `refreshCapabilities()`. Omit when capabilities never depend on it. */
  probeVersion?: () => Promise<string | undefined>
}

export interface MergeHooks {
  beforeMerge?: () => Promise<void>
}

export interface ProviderBase<TOptions, TState> {
  options: TOptions
  forge: ForgeKind
  instance: ForgeInstance
  /** API base after defaults and the API path are applied. */
  baseUrl: string
  /** Default headers: the definition's, plus `user-agent`. */
  headers: Record<string, string>
  /** Error context for this provider. */
  origin: { forge: ForgeKind, instance: ForgeInstance }
  /** State passed to `derive()`, or created by `prepare()`. */
  state: TState
}

export interface ProviderContext<TOptions, TState> extends ProviderBase<TOptions, TState> {
  /** Authenticated with the definition's `authHeaders`. */
  fetcher: Fetcher
  /** Another fetcher with the same timeout, `fetch` and error context. */
  createFetcher: (overrides: Partial<FetcherOptions> & { baseUrl: string }) => Fetcher
  /** Another provider from the same definition, for example one per app installation. */
  derive: (options: TOptions, state?: TState) => ForgeProvider
}

export interface ProviderDefinition<TOptions extends ForgeOptionsBase, TState = undefined> {
  forge: ForgeKind
  experimental?: true
  /**
   * Accepts a missing `auth` as `{ type: 'anonymous' }`: core then sends no
   * credentials and marks writes, notifications, subscriptions, installations
   * and the account's repository list unsupported.
   */
  anonymous?: true
  /** Default `baseUrl` when the caller passes none. */
  baseUrl: string
  /** Appended to `baseUrl` unless already present, for example `/api/v4`. */
  apiPath?: string
  /** Maps the API host to the instance host, for example `api.github.com` to `github.com`. */
  instance?: (host: string) => string
  headers?: Record<string, string>
  /** Builds per-provider state once; receives the state given to `derive()`, if any. */
  prepare?: (base: ProviderBase<TOptions, TState | undefined>) => TState
  authHeaders?: (base: ProviderBase<TOptions, TState>) => FetcherOptions['authHeaders']
  /** Query parameters for every request, such as an API version; see `FetcherOptions.query`. */
  query?: Record<string, string>
  setup: (ctx: ProviderContext<TOptions, TState>) => ProviderSpec
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
const UNTARGETED = new Set(['repos.list', 'notifications.list', 'installations.list', 'search.threads', 'search.repos', 'search.commits'])

/** The thread kind a per-kind verb is called for, read from its arguments. */
function kindOf(name: string, args: unknown[]): string | undefined {
  const first = args[0] as { kind?: string, thread?: { kind?: string } } | undefined
  if (name === 'create' || name === 'listPage') {
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

function createProvider<TOptions extends ForgeOptionsBase, TState>(
  definition: ProviderDefinition<TOptions, TState>,
  givenOptions: TOptions,
  givenState?: TState,
): ForgeProvider {
  const givenAuth = (givenOptions as { auth?: { type: string } }).auth
  const anonymous = Boolean(definition.anonymous) && (!givenAuth || givenAuth.type === 'anonymous')
  const options = anonymous && !givenAuth ? { ...givenOptions, auth: { type: 'anonymous' } } as TOptions : givenOptions
  const root = (options.baseUrl ?? definition.baseUrl).replace(/\/$/, '')
  const baseUrl = definition.apiPath && !root.endsWith(definition.apiPath) ? `${root}${definition.apiPath}` : root
  const host = instanceHost(baseUrl, definition.forge)
  const instance = options.instance ?? definition.instance?.(host) ?? host
  const origin = { forge: definition.forge, instance }
  const headers = { ...definition.headers, 'user-agent': options.userAgent ?? 'forges' }
  const prepared = { options, forge: definition.forge, instance, baseUrl, headers, origin, state: givenState }
  const state = (definition.prepare ? definition.prepare(prepared) : givenState) as TState
  const base: ProviderBase<TOptions, TState> = { ...prepared, state }
  const makeFetcher = (overrides: Partial<FetcherOptions> & { baseUrl: string }) => createFetcher({
    fetch: options.fetch,
    timeout: options.timeout,
    onRetry: options.onRetry,
    headers,
    query: definition.query,
    context: origin,
    ...overrides,
  })
  const fetcher = makeFetcher({ baseUrl, authHeaders: anonymous ? undefined : definition.authHeaders?.(base) })
  const ctx: ProviderContext<TOptions, TState> = {
    ...base,
    fetcher,
    createFetcher: makeFetcher,
    derive: (derivedOptions, derivedState) => createProvider(definition, derivedOptions, derivedState ?? state),
  }
  const declaredSpec = definition.setup(ctx)
  const handlers = definition.webhooks?.(ctx)
  const spec = anonymous || options.readOnly ? restrict(declaredSpec, anonymous) : declaredSpec
  const authKind = anonymous ? 'anonymous' : (givenAuth?.type ?? spec.traits.authKinds[0] ?? 'anonymous') as AuthKind

  const env: CapabilityEnv = { version: options.instanceVersion }
  const probeVersion = spec.probeVersion && memo(spec.probeVersion)
  const flags = { experimental: Boolean(definition.experimental), readOnly: Boolean(options.readOnly), webhook: Boolean(handlers) }
  let capabilities = capabilitiesOf(spec, env, flags)

  const unsupported = (verb: string) => options.readOnly && WRITE_VERBS.has(verb)
    ? new ReadOnlyError(`${verb} is a write and this ${definition.forge} provider is read-only`, origin)
    : new UnsupportedOperationError(`${definition.forge} does not support ${verb}`, origin)
  /** An iterable that rejects on first read, for listings the forge does not have. */
  const emptyIterable = <T>(verb: string): ForgeIterable<T> => forgeIterable<T>(async function* () {
    throw unsupported(verb)
  })

  /** Support is resolved at call time, so a version gate is honoured once the version is known. */
  function gate(verb: string, support: SupportInput | undefined, run: AnyFunction | undefined): AnyFunction {
    return (...args) => run && resolve(support, env) ? run(...args) : Promise.reject(unsupported(verb))
  }

  /** A per-kind verb: rejects for kinds it does not support, or entirely when undeclared. */
  function kindGate(verb: string, kinds: Partial<Record<VerbKind, SupportInput>> | undefined, run: AnyFunction | undefined): AnyFunction {
    const name = verb.slice(verb.indexOf('.') + 1)
    return (...args) => {
      if (!run || (options.readOnly && WRITE_VERBS.has(verb))) {
        return Promise.reject(unsupported(verb))
      }
      const kind = kindOf(name, args)
      if (kind && (KINDS as string[]).includes(kind) && !resolve(kinds?.[kind as VerbKind], env)) {
        return Promise.reject(new UnsupportedOperationError(`${definition.forge} does not support ${verb} for a ${kind.replace('_', ' ')}`, origin))
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

  const subscriptions = spec.threads.subscriptions
  const createReview = spec.threads.createReview
  const approve = spec.threads.approve ?? (createReview && {
    support: createReview.support,
    run: async (ref: ThreadRef, body?: string) => {
      await createReview.run(ref, { event: 'approve', body })
    },
  })
  const declaredSubscribe = spec.sources?.subscribe
  const alerts = spec.securityAlerts
  const declaredInstallations = spec.installations
  const installationsSupported = () => Boolean(declaredInstallations && resolve(declaredInstallations.support, env))

  const listThreads = kindGate('threads.listPage', spec.threads.listPage.kinds, spec.threads.listPage.run)
  const native = spec.search?.queryRaw
  const search = (name: 'threadsPage' | 'reposPage' | 'commitsPage') => {
    const run = gate(`search.${name}`, spec.search?.[name]?.support, spec.search?.[name]?.run)
    return async ({ queryRaw, ...query }: { queryRaw?: string, cursor?: unknown } = {}) => {
      const page = await run(native ? { queryRaw, ...query } : query) as Page<unknown>
      return !queryRaw || native || query.cursor ? page : { ...page, warnings: [{ code: 'filter_unsupported', message: 'This search has no query syntax; queryRaw was ignored' }, ...page.warnings ?? []] }
    }
  }
  const special: Record<string, unknown> = {
    'search.threadsPage': search('threadsPage'),
    'search.reposPage': search('reposPage'),
    'search.commitsPage': search('commitsPage'),
    'threads.listPage': async (repo: RepoRef, query: ThreadQuery = {}) => {
      if (query.state === 'merged' && query.kind && query.kind !== 'pull_request') {
        return { items: [] }
      }
      const run = (cursor: Cursor | undefined) => listThreads(repo, { ...query, ...query.state === 'merged' ? { kind: 'pull_request' } : {}, cursor })
      return nonEmptyPage(run, query.cursor)
    },
    'threads.eventsPage': async (ref: ThreadRef, listOptions?: ListOptions) => {
      const page = await gate('threads.eventsPage', spec.threads.eventsPage.support, spec.threads.eventsPage.run)(ref, listOptions) as Page<ForgeEventInput>
      return { ...page, items: page.items.map(completeEvent) }
    },
    'threads.upsertComment': kindGate(
      'threads.upsertComment',
      Object.fromEntries(KINDS.map(kind => [kind, (kindEnv: CapabilityEnv) => upsertKinds(spec, kindEnv)[kind]])),
      upsertComment,
    ),
    'threads.subscribe': kindGate('threads.subscribe', subscriptions?.kinds, subscriptions?.run.subscribe),
    'threads.unsubscribe': kindGate('threads.unsubscribe', subscriptions?.kinds, subscriptions?.run.unsubscribe),
    'threads.approve': gate('threads.approve', approve?.support, approve?.run),
    'threads.approveAndMerge': gate('threads.approveAndMerge', (mergeEnv: CapabilityEnv) => approveAndMergeSupport(spec, mergeEnv), async (ref: ThreadRef, { body, ...mergeOptions }: ApproveAndMergeOptions = {}) => {
      await spec.threads.merge!.run(ref, mergeOptions, { beforeMerge: () => call('threads.approve')(ref, body) })
    }),
    'contents.resolveRef': (repo: RepoRef, ref: string) => isSha(ref)
      ? Promise.resolve(ref.toLowerCase())
      : gate('contents.resolveRef', spec.contents?.resolveRef?.support, spec.contents?.resolveRef?.run)(repo, ref),
    'webhooks.verify': handlers ? handlers.verify : () => Promise.reject(unsupported('webhooks.verify')),
    'webhooks.ingest': async (delivery: WebhookDelivery) => {
      if (!handlers) {
        throw unsupported('webhooks.ingest')
      }
      if (!await handlers.verify(delivery)) {
        throw new WebhookVerificationError('Webhook signature verification failed', origin)
      }
      return (await handlers.translate(delivery)).map(completeEvent)
    },
    'sources.subscribe': (subscribeOptions?: SubscribeOptions) => declaredSubscribe && resolve(declaredSubscribe.support, env)
      ? completeItems(declaredSubscribe.run(subscribeOptions))
      : emptyIterable('sources.subscribe'),
    'securityAlerts.listPage': (repo: RepoRef, listOptions: SecurityAlertListOptions = {}) => {
      const supported = alerts && (listOptions.kind ? resolve(alerts.kinds[listOptions.kind as AlertKind], env) : ALERT_KINDS.some(kind => resolve(alerts.kinds[kind], env)))
      if (!supported) {
        return Promise.reject(listOptions.kind
          ? new UnsupportedOperationError(`${definition.forge} cannot list ${listOptions.kind.replace('_', ' ')} alerts`, origin)
          : unsupported('securityAlerts.list'))
      }
      return alerts.listPage(repo, listOptions)
    },
    'installations.provider': (installation: Installation | string) => {
      if (!installationsSupported()) {
        throw unsupported('installations.provider')
      }
      return declaredInstallations!.run.provider(installation)
    },
    'installations.providers': () => installationsSupported() ? declaredInstallations!.run.providers() : emptyIterable('installations.providers'),
  }

  for (const entry of CAPABILITY_TABLE) {
    const declared = entry.spec ? readPath(spec, entry.spec) : undefined
    for (const verb of entry.verbs ?? []) {
      if (verb in special) {
        set(verb, special[verb])
      }
      else if (entry.verbs!.includes(`${verb}Page`)) {
        const untargeted = UNTARGETED.has(verb)
        set(verb, (...args: unknown[]) => {
          const listOptions = (untargeted ? args[0] : args[1]) ?? {}
          return iteratePages(page => call(`${verb}Page`)(...untargeted ? [] : [args[0]], page), listOptions as ListOptions)
        })
      }
      else {
        const run = typeof declared?.run === 'function' ? declared.run : declared?.run?.[verb.slice(verb.indexOf('.') + 1)]
        set(verb, entry.perKind ? kindGate(verb, declared?.kinds, run) : gate(verb, declared?.support, run))
      }
    }
  }
  api.webhooks!.events = handlers?.events ?? []

  const threads = api.threads as unknown as ThreadsApi

  async function upsertComment(ref: ThreadRef, input: UpsertCommentInput): Promise<UpsertCommentResult> {
    const body = hasCommentMarker(input.body, input.key) ? input.body : `${input.body}\n\n${commentMarker(input.key)}`
    let existing: Comment | undefined
    for await (const candidate of threads.comments(ref)) {
      if (hasCommentMarker(candidate.body, input.key)) {
        existing = candidate
      }
    }
    return existing
      ? { comment: await threads.editComment(existing.ref, body), created: false }
      : { comment: await threads.comment(ref, body), created: true }
  }

  return {
    ...api as unknown as Pick<ForgeProvider, 'repos' | 'notifications' | 'threads' | 'webhooks' | 'releases' | 'contents' | 'checks' | 'ci' | 'users' | 'search' | 'securityAlerts' | 'sources' | 'installations'>,
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
    async refreshCapabilities() {
      if (!options.instanceVersion && probeVersion) {
        env.version = await probeVersion()
        capabilities = capabilitiesOf(spec, env, flags)
      }
      return capabilities
    },
    normaliseMarkdown: spec.normaliseMarkdown ?? (body => body),
    scopesFor: verb => spec.scopes?.(verb) ?? {},
    can: (verb, kind) => supports(capabilities, verb, kind),
    support: (verb, kind) => supportOf(capabilities, verb, kind),
    urlFor: target => spec.web ? webUrlFor(spec.web, target) : undefined,
    parseUrl: url => spec.web ? parseWebUrl(spec.web, url, origin) : undefined,
    referenceTo: (ref, referenceOptions) => referenceFor(spec.web, ref, referenceOptions),
  }
}

/**
 * Defines a forge provider. Returns the factory end users call, for example
 * `github({ auth })`. Nothing touches the network until `create()`.
 */
export function defineForgeProvider<TOptions extends ForgeOptionsBase, TState = undefined>(
  definition: ProviderDefinition<TOptions, TState>,
): ProviderFactoryFunction<TOptions> {
  return ((options: TOptions = {} as TOptions) => ({
    forge: definition.forge,
    ...definition.experimental ? { experimental: true as const } : {},
    create: () => createProvider(definition, options),
  })) as ProviderFactoryFunction<TOptions>
}

/** The function `defineForgeProvider()` returns. Options are optional when every option is. */
export type ProviderFactoryFunction<TOptions> = Record<never, never> extends TOptions
  ? (options?: TOptions) => ForgeProviderFactory<ForgeProvider>
  : (options: TOptions) => ForgeProviderFactory<ForgeProvider>
