import type { InstallationsSpec, ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type {
  BaseOptions,
  Check,
  CheckRef,
  CheckReportInput,
  CheckState,
  CiJob,
  CiJobRef,
  CiRun,
  CiRunQuery,
  CodeMatch,
  CodeSearchQuery,
  Comment,
  CommentRef,
  Commit,
  CommitCommentRef,
  CommitFilesInput,
  CommitQuery,
  CommitSearchQuery,
  CompareOptions,
  Comparison,
  ContributorStats,
  Cursor,
  EventFeedOptions,
  FileContent,
  FileOptions,
  ForgeEventInput,
  ForgeWarning,
  GetManyResult,
  Installation,
  ListOptions,
  MergeMethod,
  MergeOptions,
  MergeResult,
  Milestone,
  Notification,
  NotificationListOptions,
  NotificationRef,
  OwnerRepoQuery,
  Page,
  PageOptions,
  Reaction,
  ReactionContent,
  Release,
  ReleaseUpdate,
  Repo,
  RepoRef,
  RepoRole,
  RepoSearchQuery,
  RepoTemplate,
  RepoTemplateOptions,
  ResolvedThreadRef,
  Review,
  ReviewEvent,
  ReviewInput,
  ReviewRef,
  SearchQuery,
  SecurityAlert,
  SecurityAlertListOptions,
  SubscriptionState,
  Thread,
  ThreadCreateInput,
  ThreadQuery,
  ThreadRef,
  TreeEntry,
  TreeOptions,
  UpdateBranchOptions,
  UpdateBranchResult,
} from '../model.ts'
import type {
  BulkNotificationOptions,
  CloseOptions,
  CloseReason,
  ForgeOptionsBase,
  ForgeProvider,
  HideCommentReason,
  LockOptions,
  LockReason,
  MilestoneListOptions,
  VerbScopes,
} from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { ReferenceSyntax, WebLinks } from '../web.ts'
import type { AppCredentials, GitHubAuth } from './auth.ts'
import type {
  ClosingReferencesResult,
  CreateCommitOnBranchResult,
  DiscussionCommentsResult,
  DiscussionThreadResult,
  GraphQLComment,
  GraphQLDiscussion,
  NodeReactionsResult,
  RecentDiscussionsResult,
  ReviewThreadsResult,
  SponsorableResult,
  ThreadsBatchResult,
} from './graphql.ts'
import type {
  GitHubAsyncMerge,
  GitHubBlob,
  GitHubBranch,
  GitHubCheckRun,
  GitHubCodeSearchItem,
  GitHubCollaborator,
  GitHubCombinedStatus,
  GitHubComment,
  GitHubCommit,
  GitHubCommitSearchItem,
  GitHubCommitStatus,
  GitHubComparison,
  GitHubContentFile,
  GitHubContributor,
  GitHubContributorStats,
  GitHubFeedEvent,
  GitHubGitCommit,
  GitHubGitRef,
  GitHubHook,
  GitHubHookDelivery,
  GitHubInstallation,
  GitHubIssue,
  GitHubIssueType,
  GitHubLabel,
  GitHubMilestone,
  GitHubNotification,
  GitHubReaction,
  GitHubRelease,
  GitHubRepositoryDetail,
  GitHubReview,
  GitHubReviewComment,
  GitHubTeam,
  GitHubTimelineEntry,
  GitHubTree,
  GitHubUserDetail,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
} from './types.ts'
import { WRITE_VERBS } from '../capabilities.ts'
import { changeBase64, existingFiles, fromBase64, inDirectories, isSha, splitMessage, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, supportOnly, verb } from '../define.ts'
import { BranchMovedError, ForbiddenError, ForgeApiError, ForgeError, ForgeTimeoutError, InsufficientScopeError, MergeBlockedError, MergeConflictError, NotFoundError, RateLimitedError, ReadOnlyError, soleMergeMethod, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { anySignal, sleep } from '../fetch.ts'
import { isNamespaceRef, isResolvedThread, reactionContent } from '../model.ts'
import { actorLogin, createListing, degradesToWarning, forgeIterable, getManyConcurrently, hostOf, isFirstPage, iteratePages, memo, milestoneId, phased, rateLimitPart, requireIssueOrPull, requireThread, resolveToken, summariseChecks, teamOrg, toDate, toPage, toWarning, versionAtLeast } from '../utils.ts'
import { githubShapedWeb, OWNER_NAME } from '../web.ts'
import { nativeEventsFor } from '../webhooks.ts'
import { createAppCredentials, createAuthHeaders, tokenKindOf } from './auth.ts'
import { createGraphQLClient, graphqlError, graphqlOperations, graphqlUrl } from './graphql-client.ts'
import {
  FORGE,
  repoRefFromApiUrl,
  toActor,
  toBranch,
  toChangedFile,
  toCheckRun,
  toCodeScanningAlert,
  toCollaborator,
  toComment,
  toCommit,
  toCommitComment,
  toContributor,
  toContributorStats,
  toDependabotAlert,
  toEvent,
  toGitCommit,
  toIssueType,
  toLabel,
  toLabels,
  toMilestone,
  toNotification,
  toRelease,
  toRepo,
  toRepoRef,
  toRepositoryAdvisory,
  toReview,
  toReviewComment,
  toRole,
  toSecretScanningAlert,
  toStatusCheck,
  toTag,
  toTeam,
  toThread,
  toTreeEntry,
  toUser,
  toWebhook,
  toWebhookDelivery,
  toWorkflowJob,
  toWorkflowRun,
} from './normalise.ts'
import { GITHUB_NATIVE_EVENTS } from './webhook-events.ts'
import { githubWebhooks } from './webhooks.ts'

const DISCUSSION_CLOSE_REASONS: Partial<Record<CloseReason, string>> = { completed: 'resolved', duplicate: 'duplicate' }
const COLLABORATOR_PERMISSIONS: Partial<Record<RepoRole, string>> = { read: 'pull', write: 'push' }

export type { GitHubAuth, GitHubTokenAuth, GitHubTokenKind } from './auth.ts'

/** Options for `github()`. */
export interface GitHubOptions extends ForgeOptionsBase {
  /**
   * How to authenticate. Without credentials, only public reads work.
   * @default { type: 'anonymous' }
   */
  auth?: GitHubAuth
}

/**
 * A GraphQL document that carries the types of its result and variables, such as a `TypedDocumentString`
 * from GraphQL Code Generator with `documentMode: 'string'`.
 */
export interface TypedGraphQLDocument<TResult, TVariables> {
  /** The text of the document. */
  valueOf: () => string
  /** Carries the types; it has no value at runtime. */
  __apiType?: (variables: TVariables) => TResult
}

/** `provider.graphql()`: the result type comes from a {@link TypedGraphQLDocument}, or from the type argument of a plain string. */
export interface GitHubGraphQL {
  <TResult, TVariables>(document: TypedGraphQLDocument<TResult, TVariables>, ...args: Record<string, never> extends TVariables
    ? [variables?: TVariables, options?: BaseOptions]
    : [variables: TVariables, options?: BaseOptions]): Promise<TResult>
  <T = unknown>(query: string, variables?: Record<string, unknown>, options?: BaseOptions): Promise<T>
}

/** A provider that `github()` creates: every {@link ForgeProvider} member, and GitHub's GraphQL API. */
export interface GitHubProvider extends ForgeProvider<true> {
  /**
   * Runs a GraphQL query or mutation against the provider's GitHub API and returns its `data`. A read-only provider
   * runs queries and rejects mutations with `ReadOnlyError`. Variables are required when the document is typed
   * and declares a required variable.
   * @throws {InsufficientScopeError} When the token lacks a scope that a field needs.
   * @throws {RateLimitedError} When the response reports a rate limit, which GitHub sends with a `200`.
   * @throws {ForgeApiError} When the response carries other errors or no data.
   * @example
   * ```ts
   * const { viewer } = await provider.graphql<{ viewer: { login: string } }>('query { viewer { login } }')
   * ```
   */
  graphql: GitHubGraphQL
}

type GitHubExtensions = Pick<GitHubProvider, 'graphql'>

/** GitHub Enterprise Server versions that support marking a notification done. */
const GHES_MARK_DONE = '3.13'
/** GitHub Enterprise Server versions with the Dependabot alerts REST API. */
const GHES_DEPENDABOT_ALERTS = '3.8'
const GRAPHQL_BATCH = 20
const LOCK_REASONS: Record<LockReason, string> = { off_topic: 'off-topic', too_heated: 'too heated', resolved: 'resolved', spam: 'spam' }
const REVIEW_CONTEXT_TTL = 5 * 60_000
const POLL_DELAYS = [500, 1000, 2000]
const CONTRIBUTOR_STATS_DELAYS = [500, 1000, 2000, 4000, 8000]

const GITHUB_RESERVED_PATHS = ['about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise', 'enterprises', 'events', 'explore', 'features', 'gist', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'signup', 'site', 'sponsors', 'stars', 'topics', 'trending', 'users', 'watching']

const ISSUE_LIKE = { issue: true, pull_request: true, discussion: true } as const

function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

function branchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/')
}

const ZERO_OID = '0'.repeat(40)

/**
 * GitHub's refusal to move a branch that is no longer at the commit a write built on, as a 409 `BranchMovedError`,
 * and to delete a file that does not exist, as a 404 `NotFoundError`, whatever the status of the response.
 */
function commitError(error: unknown): unknown {
  if (!(error instanceof ForgeApiError) || error.constructor !== ForgeApiError) {
    return error
  }
  const text = `${error.message} ${error.body}`
  const context = { forge: error.forge, instance: error.instance, url: error.url, method: error.method }
  if (/Expected branch to point to|not a fast[- ]forward/i.test(text)) {
    return new BranchMovedError('The branch no longer points at the commit the change was made on', 409, error.body, context, { cause: error })
  }
  if (/requested for deletion which does not exist/i.test(text)) {
    return new NotFoundError('A file to delete does not exist', 404, error.body, context, { cause: error })
  }
  return error
}

/** GitHub's `422` for a head that moved since `expected_head_sha`, as `BranchMovedError`, and for a conflict, as `MergeConflictError`. */
function updateBranchError(error: unknown): unknown {
  if (!(error instanceof ForgeApiError) || error.constructor !== ForgeApiError || error.status !== 422) {
    return error
  }
  const context = { forge: error.forge, instance: error.instance, url: error.url, method: error.method }
  if (/expected head sha/i.test(error.body)) {
    return new BranchMovedError('The head branch no longer points at the expected sha', error.status, error.body, context, { cause: error })
  }
  if (/conflict/i.test(error.body)) {
    return new MergeConflictError('The head branch conflicts with its base', error.status, error.body, context, { cause: error })
  }
  return error
}

function threadPath(ref: ResolvedThreadRef): string {
  switch (ref.kind) {
    case 'pull_request':
      return `${repoPath(ref.repo)}/pulls/${encodeURIComponent(ref.number)}`
    default:
      return `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}`
  }
}

function isGheCom(host: string): boolean {
  return /^api\.[^.]+\.ghe\.com$/.test(host)
}

const GITHUB_REFERENCES: ReferenceSyntax = { threads: [{ prefix: '#', kind: 'issue' }, { prefix: 'GH-', kind: 'issue', sameRepo: true }], repo: OWNER_NAME, commits: true }

/** The web host for an API host: `api.github.com` and `api.<name>.ghe.com` drop the `api.` prefix. */
function webHost(host: string): string {
  return host === 'api.github.com' || isGheCom(host) ? host.slice(4) : host
}

function installationId(installation: Installation | string): string {
  return typeof installation === 'string' ? installation : installation.id
}

/**
 * Free text as legacy search reads it: advanced search parses parentheses and
 * an unclosed quote as syntax, so those are dropped outside quoted phrases.
 */
function advancedFreeText(text: string): string {
  const parts = text.split('"')
  if (parts.length % 2 === 0) {
    const unclosed = parts.pop()!
    parts.push(`${parts.pop()} ${unclosed}`)
  }
  return parts.map((part, index) => index % 2 ? part : part.replace(/[()\s]+/g, ' ')).join('"').trim()
}

function setupGitHub({ options, baseUrl, instance, origin: context, fetcher, createFetcher, derive, state: credentials }: ProviderContext<GitHubOptions, AppCredentials | undefined>): ProviderSpec<GitHubExtensions> & { web: WebLinks } {
  const list = createListing(fetcher, 'per_page')
  const auth = options.auth ?? { type: 'anonymous' as const }
  /** GitHub GraphQL needs a credential, so anonymous providers stay on REST. */
  const anonymous = auth.type === 'anonymous'
  /** An app without an installation reaches only the `/app` endpoints. */
  const appItself = auth.type === 'app' && auth.installationId === undefined
  const tokenKind = auth.type === 'token' ? tokenKindOf(auth) : undefined
  /** An installation, whether from app credentials or its token, acts as no account. */
  const installation = auth.type === 'app' || tokenKind === 'installation'
  /** GitHub serves notifications only to classic personal access tokens and OAuth app tokens. */
  const notificationsAuth = auth.type === 'token' && (tokenKind === undefined || tokenKind === 'classic')
  const host = hostOf(baseUrl)
  /** GitHub Enterprise Server; `ghe.com` data residency hosts follow github.com. */
  const enterprise = host !== 'api.github.com' && !isGheCom(host)
  const graphql = createGraphQLClient(fetcher, graphqlUrl(baseUrl), { instance })

  /**
   * Discussion notification subjects carry no URL. The repo's most recently
   * updated discussions are listed and matched on an exact, unique title.
   */
  async function resolveDiscussionNumbers(items: Notification[]): Promise<ForgeWarning[]> {
    const pending = items.filter(item => item.subject.type === 'thread' && item.subject.thread.kind === 'discussion' && !item.subject.thread.number)
    if (!pending.length) {
      return []
    }
    const repos = [...new Map(pending.map((item) => {
      const repo = (item.subject as { thread: ThreadRef }).thread.repo
      return [`${repo.owner}/${repo.name}`, repo]
    })).values()]
    let result: RecentDiscussionsResult
    try {
      const { query, variables } = (await import('./graphql.ts')).recentDiscussionsQuery(repos)
      result = await graphql<RecentDiscussionsResult>({ query }, variables)
    }
    catch (error) {
      if (error instanceof InsufficientScopeError || (error instanceof ForgeApiError && error.status === 200)) {
        return [toWarning('discussion_unresolved', error)]
      }
      throw error
    }
    for (const item of pending) {
      const thread = (item.subject as { thread: ThreadRef }).thread
      const index = repos.findIndex(repo => repo.owner === thread.repo.owner && repo.name === thread.repo.name)
      const matches = (result[`r${index}`]?.discussions.nodes ?? []).filter(node => node.title === item.title)
      if (matches.length === 1) {
        item.subject = { type: 'thread', thread: { ...thread, number: String(matches[0]!.number), externalId: matches[0]!.id } }
      }
    }
    return []
  }

  /** When each polled path may be read again, from GitHub's `X-Poll-Interval`. */
  const nextPoll = new Map<string, number>()

  function throttledPage<T>(path: string, listOptions: { cursor?: Cursor, force?: boolean }, subject: string): Page<T> | undefined {
    const at = nextPoll.get(path) ?? 0
    const wait = at - Date.now()
    if (!isFirstPage(listOptions.cursor) || listOptions.force || wait <= 0) {
      return undefined
    }
    const warning = { code: 'feed_throttled', message: `GitHub asked to wait ${Math.ceil(wait / 1000)}s more before reading ${subject} again; no request was sent. Read it later, or pass force: true` }
    return { items: [], throttled: true, nextPollAt: new Date(at), warnings: [warning], ...listOptions.cursor?.etag ? { etag: listOptions.cursor.etag } : {} }
  }

  function recordPoll(path: string, cursor: Cursor | undefined, response: Response): { nextPollAt?: Date } {
    const interval = Number(response.headers.get('x-poll-interval'))
    if (!isFirstPage(cursor) || !(interval > 0)) {
      return {}
    }
    const at = Date.now() + interval * 1000
    nextPoll.set(path, at)
    return { nextPollAt: new Date(at) }
  }

  async function notificationPage(listOptions: NotificationListOptions = {}): Promise<Page<Notification>> {
    const throttled = throttledPage<Notification>('/notifications', listOptions, 'notifications')
    if (throttled) {
      return throttled
    }
    const result = await fetcher.json<GitHubNotification[]>(listOptions.cursor?.nextUrl ?? '/notifications', {
      query: listOptions.cursor?.nextUrl
        ? undefined
        : {
            all: listOptions.all ?? false,
            since: listOptions.since?.toISOString(),
            per_page: listOptions.perPage,
          },
      etag: listOptions.cursor?.nextUrl ? undefined : listOptions.cursor?.etag,
      signal: listOptions.signal,
    })
    const items = (result.data ?? []).map(raw => toNotification(instance, raw))
    const warnings = await resolveDiscussionNumbers(items)
    const etag = listOptions.cursor?.nextUrl ? undefined : result.cursor?.etag ?? listOptions.cursor?.etag
    return {
      items,
      cursor: result.cursor?.nextUrl ? result.cursor : undefined,
      ...etag ? { etag } : {},
      notModified: result.notModified,
      warnings: warnings.length ? warnings : undefined,
      ...recordPoll('/notifications', listOptions.cursor, result.response),
      ...rateLimitPart(result.response),
    }
  }

  async function discussionId(ref: ResolvedThreadRef, options?: BaseOptions): Promise<string> {
    if (ref.externalId) {
      return ref.externalId
    }
    return (await getDiscussion(ref, options)).ref.externalId!
  }

  async function getDiscussion(ref: ResolvedThreadRef, options?: BaseOptions): Promise<Thread> {
    const data = await graphql<DiscussionThreadResult>('DISCUSSION_THREAD', {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: Number(ref.number),
    }, options)
    const discussion = data.repository?.discussion
    if (!discussion) {
      throw new NotFoundError(`Discussion ${ref.number} not found`, 404, '', context)
    }
    return (await import('./graphql.ts')).toDiscussionThread(ref, discussion)
  }

  async function discussionCommentPage(ref: ResolvedThreadRef, listOptions: PageOptions): Promise<Page<{ comment: GraphQLComment, isReply: boolean }>> {
    const data: DiscussionCommentsResult = await graphql<DiscussionCommentsResult>('DISCUSSION_COMMENTS', {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: Number(ref.number),
      after: listOptions.cursor?.token ?? null,
    }, listOptions)
    const comments = data.repository?.discussion?.comments
    return {
      items: (comments?.nodes ?? []).flatMap(comment => [{ comment, isReply: false }, ...(comment.replies?.nodes ?? []).map(reply => ({ comment: reply, isReply: true }))]),
      cursor: comments?.pageInfo.hasNextPage && comments.pageInfo.endCursor ? { token: comments.pageInfo.endCursor } : undefined,
    }
  }

  async function get(thread: ThreadRef, options?: BaseOptions): Promise<Thread> {
    const ref = requireThread(thread, context)
    if (ref.kind === 'discussion') {
      return getDiscussion(ref, options)
    }
    const { data } = await fetcher.json<GitHubIssue>(threadPath(ref), { signal: options?.signal })
    const result = toThread(ref, data)
    if (ref.kind === 'pull_request' && data.head?.sha) {
      try {
        const checks = await headChecks(ref.repo, data.head.sha, options?.signal)
        result.checks = summariseChecks(checks.items.map(check => check.state), data.html_url ? `${data.html_url}/checks` : undefined)
        if (checks.warnings?.length) {
          result.warnings = [...result.warnings ?? [], ...checks.warnings]
        }
      }
      catch (error) {
        if (!degradesToWarning(error)) {
          throw error
        }
        result.warnings = [...result.warnings ?? [], toWarning('checks_unreadable', error, ref.number)]
      }
    }
    return result
  }

  async function headChecks(repo: RepoRef, sha: string, signal?: AbortSignal): Promise<Page<Check>> {
    let checkRunTotal: number | undefined
    const [runs, status] = await Promise.allSettled([
      Array.fromAsync(fetcher.items<GitHubCheckRun>(`${repoPath(repo)}/commits/${sha}/check-runs`, {
        query: { per_page: 100 },
        select: (body, next) => {
          const { check_runs, total_count } = body as { check_runs: GitHubCheckRun[], total_count?: number }
          checkRunTotal = total_count
          return { items: check_runs, next }
        },
        signal,
      }), raw => toCheckRun(repo, raw)),
      Array.fromAsync(fetcher.items<GitHubCombinedStatus['statuses'][number]>(`${repoPath(repo)}/commits/${sha}/status`, {
        query: { per_page: 100 },
        select: (body, next) => ({ items: (body as GitHubCombinedStatus).statuses, next }),
        signal,
      }), raw => toStatusCheck(repo, raw)),
    ])
    if (signal?.aborted) {
      throw signal.reason
    }
    if (runs.status === 'rejected' && status.status === 'rejected') {
      throw runs.reason
    }
    for (const result of [runs, status]) {
      if (result.status === 'rejected' && !degradesToWarning(result.reason)) {
        throw result.reason
      }
    }
    const statuses = status.status === 'fulfilled' ? status.value : []
    // Only a complete read reports a total: check-runs report their own count,
    // and the older commit statuses add to it.
    const total = runs.status === 'fulfilled' && status.status === 'fulfilled' && checkRunTotal !== undefined ? checkRunTotal + statuses.length : undefined
    return {
      items: [
        ...runs.status === 'fulfilled' ? runs.value : [],
        ...statuses,
      ],
      ...total !== undefined ? { total } : {},
      warnings: [
        ...runs.status === 'rejected' ? [toWarning('checks_unreadable', runs.reason, 'check-runs')] : [],
        ...status.status === 'rejected' ? [toWarning('checks_unreadable', status.reason, 'statuses')] : [],
      ],
    }
  }

  async function getMany(refs: ThreadRef[], options?: BaseOptions): Promise<GetManyResult[]> {
    if (anonymous) {
      return getManyConcurrently(refs, (ref, getOptions) => ref.kind === 'discussion'
        ? Promise.reject(new UnsupportedOperationError('github does not read discussions without credentials', context))
        : get(ref, getOptions), options)
    }
    const results: GetManyResult[] = Array.from({ length: refs.length })
    const batchable: Array<{ index: number, ref: ResolvedThreadRef }> = []
    for (const [index, ref] of refs.entries()) {
      if (!isResolvedThread(ref)) {
        results[index] = { ok: false, ref, warning: toWarning('thread_unresolved', new Error('Thread ref has no number'), ref.number) }
      }
      else {
        batchable.push({ index, ref })
      }
    }
    if (!batchable.length) {
      return results
    }
    const g = await import('./graphql.ts')
    for (let start = 0; start < batchable.length; start += GRAPHQL_BATCH) {
      const chunk = batchable.slice(start, start + GRAPHQL_BATCH)
      const { query, variables } = g.threadsBatchQuery(chunk.map(item => item.ref))
      const url = graphqlUrl(baseUrl)
      const { data, response } = await fetcher.json<{ data?: ThreadsBatchResult, errors?: Array<{ message: string, type?: string, path?: Array<string | number> }> }>(url, {
        method: 'POST',
        json: { query, variables, operationName: 'ThreadsBatch' },
        signal: options?.signal,
      })
      const failure = data.data ? undefined : graphqlError('ThreadsBatch', data.errors, url, { instance }, response)
      if (failure instanceof RateLimitedError) {
        throw failure
      }
      chunk.forEach(({ index, ref }, offset) => {
        const node = data.data?.[`t${offset}`]
        const discussion = ref.kind === 'discussion' ? node?.discussion : undefined
        const issueOrPullRequest = ref.kind === 'discussion' ? undefined : node?.issueOrPullRequest
        if (failure) {
          results[index] = { ok: false, ref, warning: toWarning(failure instanceof InsufficientScopeError ? 'insufficient_scope' : 'thread_unreadable', failure, ref.number) }
          return
        }
        if (!discussion && !issueOrPullRequest) {
          const error = data.errors?.find(error => error.path?.[0] === `t${offset}`)
          if (error?.type === 'INSUFFICIENT_SCOPES') {
            results[index] = { ok: false, ref, warning: toWarning('insufficient_scope', graphqlError('ThreadsBatch', [error], url, { instance }), ref.number) }
            return
          }
          results[index] = { ok: false, ref, warning: { code: 'thread_unreadable', message: error?.message ?? 'Not found', subject: ref.number } }
          return
        }
        results[index] = { ok: true, ref, thread: discussion ? g.toDiscussionThread(ref, discussion) : g.toGraphQLThread(ref, issueOrPullRequest!) }
      })
    }
    return results
  }

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    const state = query.state ?? 'open'
    const direction = query.direction ?? 'desc'
    const createdAfter = query.createdAfter?.getTime()
    if (query.kind === 'discussion') {
      if (query.assignee) {
        return { items: [], warnings: [{ code: 'filter_unsupported', message: 'Discussions have no assignees' }] }
      }
      if (query.milestone && query.milestone !== 'none') {
        return { items: [], warnings: [{ code: 'filter_unsupported', message: 'Discussions have no milestones' }] }
      }
      const warnings: ForgeWarning[] = isFirstPage(query.cursor) && query.sort === 'comments'
        ? [{ code: 'sort_unsupported', message: 'Discussions cannot be sorted by comments; sorted by update time' }]
        : []
      for (const filter of ['involves', 'mentions'] as const) {
        if (isFirstPage(query.cursor) && query[filter]) {
          warnings.push({ code: 'filter_unsupported', message: `GitHub lists discussions without a ${filter} filter; it was ignored` })
        }
      }
      const data: { repository: { discussions: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: GraphQLDiscussion[] } } | null } = await graphql('DISCUSSIONS_LIST', {
        owner: repo.owner,
        name: repo.name,
        first: Math.min(query.perPage ?? 50, 100),
        after: query.cursor?.token ?? null,
        field: query.sort === 'created' || !query.sort ? 'CREATED_AT' : 'UPDATED_AT',
        direction: direction.toUpperCase(),
      }, query)
      const { toDiscussionThread } = await import('./graphql.ts')
      const discussions = data.repository?.discussions
      const items = (discussions?.nodes ?? [])
        .map(node => toDiscussionThread({ forge: FORGE, instance, repo, kind: 'discussion', number: String(node.number) }, node))
        .filter(thread => (state === 'all' || thread.state === state)
          && (!query.author || thread.author?.login === query.author)
          && (!query.labels?.length || query.labels.every(label => thread.labels.some(item => item.name === label)))
          && (!query.since || (thread.updatedAt?.getTime() ?? 0) >= query.since.getTime())
          && (createdAfter === undefined || (thread.createdAt?.getTime() ?? 0) >= createdAfter))
      return {
        items,
        cursor: discussions?.pageInfo.hasNextPage && discussions.pageInfo.endCursor ? { token: discussions.pageInfo.endCursor } : undefined,
        ...warnings.length ? { warnings } : {},
      }
    }
    if (state === 'merged') {
      const page = await searchThreadsPage({
        repo,
        kind: 'pull_request',
        labels: query.labels,
        author: query.author,
        assignee: query.assignee,
        involves: query.involves,
        since: query.since,
        queryRaw: [
          'is:merged',
          query.createdAfter && `created:>=${query.createdAfter.toISOString()}`,
          query.mentions && `mentions:${query.mentions}`,
          query.milestone && (query.milestone === 'none' ? 'no:milestone' : `milestone:"${query.milestone.replaceAll('"', '')}"`),
        ].filter(Boolean).join(' '),
        sort: query.sort ?? 'created',
        direction,
        perPage: query.perPage,
        cursor: query.cursor,
        signal: query.signal,
      })
      await withPullChecks(page, query)
      return page
    }
    const milestone = query.milestone === undefined || query.milestone === 'none' || !isFirstPage(query.cursor)
      ? query.milestone
      : await milestoneNumber(repo, query.milestone, query)
    if (milestone === null) {
      return { items: [] }
    }
    const warnings: ForgeWarning[] = isFirstPage(query.cursor) && query.involves
      ? [{ code: 'filter_unsupported', message: 'GitHub lists issues and pull requests without an involves filter; it was ignored. search.threads() has one' }]
      : []
    // `/pulls` returns full pages but has no label, author, assignee, mention, milestone or since filter.
    const pullsOnly = query.kind === 'pull_request' && !query.labels?.length && !query.author && !query.assignee && !query.mentions && !query.milestone && !query.since && query.sort !== 'comments'
    const result = await fetcher.page<GitHubIssue>(`${repoPath(repo)}/${pullsOnly ? 'pulls' : 'issues'}`, {
      query: {
        state,
        labels: query.labels?.join(','),
        creator: query.author,
        assignee: query.assignee,
        mentioned: query.mentions,
        milestone,
        since: query.since?.toISOString(),
        sort: query.sort ?? 'created',
        direction,
        per_page: query.perPage,
      },
      cursor: query.cursor,
      signal: query.signal,
    })
    const older = (raw: GitHubIssue) => createdAfter !== undefined && (Date.parse(raw.created_at ?? '') || 0) < createdAfter
    const page = toPage(result, (raw) => {
      const isPull = Boolean(raw.pull_request || raw.head)
      if ((query.kind === 'issue' && isPull) || (query.kind === 'pull_request' && !isPull) || older(raw)) {
        return undefined
      }
      return toThread({ forge: FORGE, instance, repo, kind: isPull ? 'pull_request' : 'issue', number: String(raw.number) }, raw)
    })
    const ordered = (query.sort ?? 'created') === 'created' && direction === 'desc'
    await withPullChecks(page, query)
    const listed = warnings.length ? { ...page, warnings: [...warnings, ...page.warnings ?? []] } : page
    return ordered && (result.data ?? []).some(older) ? { ...listed, cursor: undefined } : listed
  }

  /** The number of the milestone titled `title`, or `null` when the repository has none by that title. */
  async function milestoneNumber(repo: RepoRef, title: string, options: BaseOptions): Promise<string | null> {
    for await (const milestone of iteratePages<Milestone, MilestoneListOptions>(page => milestonesPage(repo, page), { state: 'all', signal: options.signal })) {
      if (milestone.title === title) {
        return milestone.id
      }
    }
    return null
  }

  /** Fills `checks`, and a missing `commentCount`, on every pull in the page with one batched read. */
  async function withPullChecks(page: Page<Thread>, options: BaseOptions): Promise<void> {
    const pulls = page.items.filter(thread => thread.kind === 'pull_request')
    if (!pulls.length || anonymous) {
      return
    }
    try {
      const results = await getMany(pulls.map(thread => thread.ref), options)
      for (const [index, result] of results.entries()) {
        if (result.ok) {
          pulls[index]!.checks = result.thread.checks ?? pulls[index]!.checks
          pulls[index]!.commentCount ??= result.thread.commentCount
          pulls[index]!.mergedBy ??= result.thread.mergedBy
        }
      }
    }
    catch (error) {
      if (!degradesToWarning(error)) {
        throw error
      }
      page.warnings = [...page.warnings ?? [], toWarning('checks_unreadable', error)]
    }
  }

  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireThread(thread, context)
    if (ref.kind === 'discussion') {
      const [page, { toDiscussionComment }] = await Promise.all([discussionCommentPage(ref, listOptions), import('./graphql.ts')])
      return { ...page, items: page.items.map(({ comment }) => toDiscussionComment(ref, comment)) }
    }
    return list(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/comments`, listOptions, (raw: GitHubComment) => toComment(ref, raw), { query: { since: listOptions.since?.toISOString() } })
  }

  /** Discussion comment ids are node ids already; other comments are read for theirs. */
  async function commentNodeId(ref: CommentRef | CommitCommentRef, options?: BaseOptions): Promise<string> {
    if ('thread' in ref && ref.thread.kind === 'discussion') {
      return ref.id
    }
    const { data } = await fetcher.json<GitHubComment>('commit' in ref ? commitCommentPath(ref) : commentPath(ref), { signal: options?.signal })
    if (!data.node_id) {
      throw new NotFoundError(`Comment ${ref.id} has no node id`, 404, '', context)
    }
    return data.node_id
  }

  function commentPath(ref: CommentRef): string {
    return `${repoPath(ref.thread.repo)}/issues/comments/${encodeURIComponent(ref.id)}`
  }

  function commitCommentPath(ref: CommitCommentRef): string {
    return `${repoPath(ref.commit.repo)}/comments/${encodeURIComponent(ref.id)}`
  }

  async function setState(thread: ThreadRef, state: 'open' | 'closed', options_: CloseOptions = {}): Promise<Thread> {
    const ref = requireThread(thread, context)
    if (ref.kind === 'discussion') {
      const reason = options_.reasonRaw ?? (options_.reason && DISCUSSION_CLOSE_REASONS[options_.reason])
      if (state === 'closed' && options_.reason && !reason) {
        throw new UnsupportedOperationError(`GitHub discussions have no ${options_.reason} close reason; pass reasonRaw: 'outdated'`, context)
      }
      const id = await discussionId(ref, options_)
      const data = state === 'closed'
        ? (await graphql<{ closeDiscussion: { discussion: GraphQLDiscussion } }>('CLOSE_DISCUSSION', { id, reason: reason?.toUpperCase() ?? null }, options_)).closeDiscussion
        : (await graphql<{ reopenDiscussion: { discussion: GraphQLDiscussion } }>('REOPEN_DISCUSSION', { id }, options_)).reopenDiscussion
      return (await import('./graphql.ts')).toDiscussionThread(ref, data.discussion)
    }
    const reason = options_.reasonRaw ?? options_.reason
    const { data } = await fetcher.json<GitHubIssue>(threadPath(ref), {
      method: 'PATCH',
      json: ref.kind === 'issue' && state === 'closed' && reason ? { state, state_reason: reason } : { state },
      signal: options_.signal,
    })
    return toThread(ref, data)
  }

  async function merge(thread: ThreadRef, options_: MergeOptions = {}): Promise<MergeResult> {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError('Only pull requests can be merged', context)
    }
    if (options_.whenChecksPass) {
      throw new UnsupportedOperationError('GitHub auto-merge is not available through the REST API', context)
    }
    if (options_.method === 'rebase_merge' || options_.method === 'fast_forward_only') {
      throw new UnsupportedOperationError(`GitHub does not support the ${options_.method} merge method`, context)
    }
    let method: MergeMethod | undefined = options_.method
    if (!method) {
      const { data: repo } = await fetcher.json<{
        allow_merge_commit?: boolean
        allow_squash_merge?: boolean
        allow_rebase_merge?: boolean
      }>(repoPath(ref.repo), { signal: options_.signal })
      method = soleMergeMethod({ merge: repo.allow_merge_commit, squash: repo.allow_squash_merge, rebase: repo.allow_rebase_merge }, context)
    }
    return directMerge(ref, method, options_)
  }

  async function directMerge(ref: ResolvedThreadRef, method: MergeMethod, mergeOptions: MergeOptions): Promise<MergeResult> {
    const path = `${threadPath(ref)}/merge`
    const { sha, title, message } = mergeOptions
    const body = { merge_method: method, sha, commit_title: title, commit_message: message }
    const timeout = options.timeout ?? 30_000
    const budget = new AbortController()
    const signal = mergeOptions.signal ? anySignal([budget.signal, mergeOptions.signal]) : budget.signal
    const timer = setTimeout(() => budget.abort(new DOMException('Merge timed out', 'TimeoutError')), timeout)
    const timedOut = (url: string, requestMethod: string, cause: unknown, uuid?: string) => new ForgeTimeoutError(
      uuid
        ? `Merge request ${uuid} for pull request ${ref.number} was still pending after ${timeout}ms; GitHub may still complete it`
        : `Merge of pull request ${ref.number} got no response within ${timeout}ms; GitHub may still complete it`,
      timeout,
      { ...context, url, method: requestMethod },
      { cause },
    )
    let url = fetcher.resolve(`${path}-async`)
    let requestMethod = 'PUT'
    let uuid: string | undefined
    try {
      let state: GitHubAsyncMerge
      let status: number
      try {
        const { data, response } = await fetcher.json<GitHubAsyncMerge>(`${path}-async`, { method: 'PUT', json: { ...body, merge_action: 'direct_merge' }, signal })
        state = data
        status = response.status
      }
      catch (error) {
        if (budget.signal.aborted) {
          throw error
        }
        if (enterprise && error instanceof NotFoundError) {
          url = fetcher.resolve(path)
          const { data } = await fetcher.json<{ sha?: string } | undefined>(path, { method: 'PUT', json: body, mapError: toMergeError, signal })
          return { status: 'merged', sha: data?.sha, raw: data }
        }
        state = pendingMergeFrom(error, method, sha, title, message)
        status = 409
      }
      for (let attempt = 0; state.status === 'pending'; attempt++) {
        uuid = state.details?.uuid
        if (!uuid) {
          throw new ForgeApiError('GitHub reported a pending merge without a request id', status, JSON.stringify(state).slice(0, 512), { ...context, url, method: requestMethod })
        }
        const poll = `${path}-async/${encodeURIComponent(uuid)}`
        url = fetcher.resolve(poll)
        requestMethod = 'GET'
        await sleep(POLL_DELAYS[Math.min(attempt, POLL_DELAYS.length - 1)]!, signal)
        const { data, response } = await fetcher.json<GitHubAsyncMerge>(poll, { signal })
        state = data
        status = response.status
      }
      const errorContext = { ...context, url, method: requestMethod }
      const excerpt = JSON.stringify(state).slice(0, 512)
      switch (state.status as string) {
        case 'merged':
          return { status: 'merged', sha: state.details?.sha, raw: state }
        case 'enqueued':
          throw new MergeBlockedError('Pull request was added to a merge queue and has not merged', status, excerpt, errorContext)
        case 'failed':
          throw new MergeBlockedError(state.details?.message || 'GitHub could not merge the pull request', status, excerpt, errorContext)
        default:
          throw new ForgeApiError(`GitHub reported an unknown merge status ${JSON.stringify(state.status)}`, status, excerpt, errorContext)
      }
    }
    catch (error) {
      throw budget.signal.aborted ? timedOut(url, requestMethod, error, uuid) : error
    }
    finally {
      clearTimeout(timer)
    }
  }

  function pendingMergeFrom(error: unknown, method: MergeMethod, sha: string | undefined, title: string | undefined, message: string | undefined): GitHubAsyncMerge {
    if (!(error instanceof ForgeApiError)) {
      throw error
    }
    if (isPlainApiError(error, 400)) {
      throw new MergeBlockedError('Pull request cannot be merged in its current state', 400, error.body, { ...context, url: error.url, method: error.method }, { cause: error })
    }
    if (!isPlainApiError(error, 409)) {
      throw toMergeError(error)
    }
    let pending: GitHubAsyncMerge | undefined
    try {
      pending = JSON.parse(error.body) as GitHubAsyncMerge
    }
    catch {}
    const details = pending?.details
    if (!details?.uuid) {
      throw toMergeError(error)
    }
    if (title !== undefined || message !== undefined || details.merge_action !== 'direct_merge' || details.merge_method !== method || details.bypass_rules || (sha !== undefined && details.expected_head_sha !== sha)) {
      throw new MergeBlockedError('Another merge request is pending whose options do not match or cannot be verified', 409, error.body, { ...context, url: error.url, method: error.method }, { cause: error })
    }
    return { status: 'pending', details }
  }

  function isPlainApiError(error: unknown, status: number): boolean {
    return error instanceof ForgeApiError && error.constructor === ForgeApiError && error.status === status
  }

  /** A merge goes through REST, which takes no method; a rebase goes through GraphQL, after a read for the pull request's node id. */
  async function updateBranch(thread: ThreadRef, updateOptions: UpdateBranchOptions = {}): Promise<UpdateBranchResult> {
    const ref = requirePull(thread, 'updated')
    const { sha, signal } = updateOptions
    if (updateOptions.method === 'rebase') {
      const { data: pull } = await fetcher.json<GitHubIssue>(threadPath(ref), { signal })
      if (sha !== undefined && pull.head?.sha !== sha) {
        throw new BranchMovedError(`Head branch of pull request ${ref.number} is at ${pull.head?.sha}, not ${sha}`, 409, '', context)
      }
      const data = await graphql<{ updatePullRequestBranch: unknown }>('UPDATE_PULL_REQUEST_BRANCH', { id: pull.node_id, sha: sha ?? null, method: 'REBASE' }, updateOptions)
      return { status: 'queued', raw: data.updatePullRequestBranch }
    }
    const { data } = await fetcher.json<{ message?: string, url?: string }>(`${threadPath(ref)}/update-branch`, {
      method: 'PUT',
      json: sha === undefined ? {} : { expected_head_sha: sha },
      mapError: updateBranchError,
      signal,
    })
    return { status: 'queued', raw: data }
  }

  const REVIEW_EVENTS: Record<ReviewEvent, string> = { approve: 'APPROVE', request_changes: 'REQUEST_CHANGES', comment: 'COMMENT' }

  function requirePull(thread: ThreadRef, action: string): ResolvedThreadRef {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError(`Only pull requests can be ${action}`, context)
    }
    return ref
  }

  function reviewCommentInput(comments: ReviewInput['comments']) {
    return comments?.map(comment => ({
      path: comment.path,
      body: comment.body,
      line: comment.line,
      start_line: comment.startLine,
      side: comment.side?.toUpperCase(),
    }))
  }

  /** Resolvable conversations, by the id of each comment in them; empty when GraphQL is unreachable. */
  async function reviewThreadsByComment(ref: ResolvedThreadRef, options?: BaseOptions): Promise<Map<string, { id: string, resolved: boolean }>> {
    const byComment = new Map<string, { id: string, resolved: boolean }>()
    if (anonymous) {
      return byComment
    }
    let data: ReviewThreadsResult
    try {
      data = await graphql<ReviewThreadsResult>('REVIEW_THREADS', { owner: ref.repo.owner, name: ref.repo.name, number: Number(ref.number) }, options)
    }
    catch (error) {
      if (error instanceof ForgeError) {
        return byComment
      }
      throw error
    }
    for (const node of data.repository?.pullRequest?.reviewThreads.nodes ?? []) {
      for (const comment of node.comments.nodes) {
        if (comment.databaseId !== null) {
          byComment.set(String(comment.databaseId), { id: node.id, resolved: node.isResolved })
        }
      }
    }
    return byComment
  }

  /** Review comments and conversations read for a pull's first page of reviews, reused by its later pages. */
  const reviewContext = new Map<string, { at: number, read: Promise<[GitHubReviewComment[], Map<string, { id: string, resolved: boolean }>]> }>()

  async function reviewsPage(thread: ThreadRef, listOptions: PageOptions = {}): Promise<Page<Review>> {
    const ref = requirePull(thread, 'reviewed')
    const result = await fetcher.page<GitHubReview>(`${threadPath(ref)}/reviews`, {
      query: { per_page: listOptions.perPage },
      cursor: listOptions.cursor,
      signal: listOptions.signal,
      conditional: false,
    })
    const now = Date.now()
    for (const [path, entry] of reviewContext) {
      if (now - entry.at >= REVIEW_CONTEXT_TTL) {
        reviewContext.delete(path)
      }
    }
    const key = threadPath(ref)
    const kept = (!isFirstPage(listOptions.cursor) && reviewContext.get(key)) || {
      at: now,
      read: Promise.all([
        Array.fromAsync(fetcher.items<GitHubReviewComment>(`${key}/comments`, { query: { per_page: 100 }, signal: listOptions.signal })),
        reviewThreadsByComment(ref, listOptions),
      ]),
    }
    reviewContext.delete(key)
    const [comments, byComment] = await kept.read
    if (result.cursor) {
      reviewContext.set(key, kept)
    }
    return toPage(result, raw => toReview(
      ref,
      raw,
      comments.filter(comment => String(comment.pull_request_review_id ?? '') === String(raw.id))
        .map(comment => toReviewComment(ref, comment, byComment.get(String(comment.id)))),
    ))
  }

  async function createReview(thread: ThreadRef, input: ReviewInput, options?: BaseOptions): Promise<Review> {
    const ref = requirePull(thread, 'reviewed')
    const { data } = await fetcher.json<GitHubReview>(`${threadPath(ref)}/reviews`, {
      method: 'POST',
      json: {
        event: input.event ? REVIEW_EVENTS[input.event] : undefined,
        body: input.body,
        comments: reviewCommentInput(input.comments),
      },
      signal: options?.signal,
    })
    return toReview(ref, data, [])
  }

  async function getComment(ref: CommentRef, options?: BaseOptions): Promise<Comment> {
    const thread = requireThread(ref.thread, context)
    if (thread.kind === 'discussion') {
      const data = await graphql<{ node: GraphQLComment | null }>('GET_DISCUSSION_COMMENT', { id: ref.id }, options)
      if (!data.node?.id) {
        throw new NotFoundError(`Comment ${ref.id} not found`, 404, '', context)
      }
      return (await import('./graphql.ts')).toDiscussionComment(thread, data.node)
    }
    const { data } = await fetcher.json<GitHubComment>(commentPath(ref), { signal: options?.signal })
    return toComment(thread, data)
  }

  async function getReview(ref: ReviewRef, options?: BaseOptions): Promise<Review> {
    const pull = requirePull(ref.thread, 'reviewed')
    const path = `${threadPath(pull)}/reviews/${encodeURIComponent(ref.id)}`
    const [{ data }, comments, byComment] = await Promise.all([
      fetcher.json<GitHubReview>(path, { signal: options?.signal }),
      Array.fromAsync(fetcher.items<GitHubReviewComment>(`${path}/comments`, { query: { per_page: 100 }, signal: options?.signal })),
      reviewThreadsByComment(pull, options),
    ])
    return toReview(pull, data, comments.map(comment => toReviewComment(pull, comment, byComment.get(String(comment.id)))))
  }

  async function getCheck(ref: CheckRef, options?: BaseOptions): Promise<Check> {
    if (ref.type !== 'check_run') {
      throw new UnsupportedOperationError(`GitHub cannot read a ${ref.type} by id; only check runs can be read on their own`, context)
    }
    const { data } = await fetcher.json<GitHubCheckRun>(`${repoPath(ref.repo)}/check-runs/${encodeURIComponent(ref.id)}`, { signal: options?.signal })
    return toCheckRun(ref.repo, data)
  }

  async function getJob(ref: CiJobRef, options?: BaseOptions): Promise<CiJob> {
    const { data } = await fetcher.json<GitHubWorkflowJob>(`${repoPath(ref.repo)}/actions/jobs/${encodeURIComponent(ref.id)}`, { signal: options?.signal })
    const run = ref.run ?? (data.run_id === undefined ? undefined : { forge: FORGE, instance, repo: ref.repo, id: String(data.run_id) })
    if (!run) {
      throw new UnsupportedOperationError(`GitHub returned job ${ref.id} without its run, and the ref names no run`, context)
    }
    return toWorkflowJob(run, data)
  }

  async function subscriptionNode(thread: ThreadRef, options?: BaseOptions): Promise<{ id: string, state: string }> {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'issue' && ref.kind !== 'pull_request' && ref.kind !== 'discussion') {
      throw new UnsupportedOperationError(`GitHub has no subscription for a ${ref.kind}`, context)
    }
    const data = await graphql<{ repository: { issueOrPullRequest?: { id: string, viewerSubscription: string } | null, discussion?: { id: string, viewerSubscription: string } | null } | null }>('SUBSCRIPTION_STATE', {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: Number(ref.number),
      discussion: ref.kind === 'discussion',
    }, options)
    const node = ref.kind === 'discussion' ? data.repository?.discussion : data.repository?.issueOrPullRequest
    if (!node) {
      throw new NotFoundError(`Thread ${ref.number} not found`, 404, '', context)
    }
    return { id: node.id, state: node.viewerSubscription }
  }

  async function closingPage(ref: ResolvedThreadRef, document: 'CLOSING_ISSUES' | 'CLOSING_PULL_REQUESTS', listOptions: PageOptions): Promise<Page<Thread>> {
    const [data, { toGraphQLThread }] = await Promise.all([graphql<ClosingReferencesResult>(document, {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: Number(ref.number),
      first: Math.min(listOptions.perPage ?? 50, 100),
      after: listOptions.cursor?.token ?? null,
    }, listOptions), import('./graphql.ts')])
    const references = data.repository?.thread?.references
    if (!references) {
      throw new NotFoundError(`Thread ${ref.number} not found`, 404, '', context)
    }
    return {
      items: references.nodes.map((node) => {
        const repo = { forge: FORGE, instance, owner: node.repository.owner.login, name: node.repository.name, externalId: node.repository.databaseId === undefined ? undefined : String(node.repository.databaseId) }
        return toGraphQLThread({ forge: FORGE, instance, repo, kind: node.__typename === 'PullRequest' ? 'pull_request' : 'issue', number: String(node.number) }, node)
      }),
      cursor: references.pageInfo.hasNextPage && references.pageInfo.endCursor ? { token: references.pageInfo.endCursor } : undefined,
    }
  }

  async function setSubscription(thread: ThreadRef, state: 'SUBSCRIBED' | 'UNSUBSCRIBED', options?: BaseOptions): Promise<void> {
    const { id } = await subscriptionNode(thread, options)
    await graphql('UPDATE_SUBSCRIPTION', { id, state }, options)
  }

  async function reposPage(repoFetcher: typeof fetcher, path: string, wrapped: boolean, listOptions: PageOptions = {}): Promise<Page<Repo>> {
    return toPage(
      await repoFetcher.page<GitHubRepositoryDetail>(path, {
        query: { per_page: listOptions.perPage },
        cursor: listOptions.cursor,
        signal: listOptions.signal,
        select: wrapped ? (body, next) => ({ items: (body as { repositories: GitHubRepositoryDetail[] }).repositories, next }) : undefined,
      }),
      raw => toRepo(instance, raw),
    )
  }

  /** The authenticated login, read once and reused; reactions are deleted by id, so removing one needs it. */
  const viewerLogin = memo(async () => (await fetcher.json<GitHubUserDetail>('/user')).data.login)

  /** `/users/{owner}/repos` serves organisations too, but lists only public repositories. */
  async function ownerReposPage(owner: RepoRef, query: OwnerRepoQuery = {}): Promise<Page<Repo>> {
    const visibility = query.visibility === 'all' ? undefined : query.visibility
    const read = (path: string, params: Record<string, string | undefined>) => list(path, query, (raw: GitHubRepositoryDetail) => toRepo(instance, raw), {
      query: { ...params, sort: query.sort === 'name' ? 'full_name' : query.sort, direction: query.direction },
    })
    const userRepos = () => read(`/users/${encodeURIComponent(owner.owner)}/repos`, { type: 'owner' })
    if (visibility === 'public') {
      return userRepos()
    }
    try {
      return await read(`/orgs/${encodeURIComponent(owner.owner)}/repos`, { type: visibility === 'internal' ? undefined : visibility })
    }
    catch (error) {
      if (!(error instanceof NotFoundError) || !isFirstPage(query.cursor)) {
        throw error
      }
    }
    if (auth.type === 'token' && !installation && (await viewerLogin()).toLowerCase() === owner.owner.toLowerCase()) {
      return read('/user/repos', { affiliation: 'owner', visibility: visibility === 'internal' ? undefined : visibility })
    }
    if (visibility) {
      return { items: [], warnings: [{ code: 'filter_unsupported', message: 'GitHub lists only the public repositories of another user' }] }
    }
    return userRepos()
  }

  /** Repository hooks, or organisation hooks for a namespace ref. */
  function hooksPath(target: RepoRef): string {
    return isNamespaceRef(target) ? `/orgs/${encodeURIComponent(target.owner)}/hooks` : `${repoPath(target)}/hooks`
  }

  function hookConfig(input: { url?: string, contentType?: 'json' | 'form', secret?: string }): Record<string, string> {
    return {
      ...input.url ? { url: input.url } : {},
      content_type: input.contentType ?? 'json',
      ...input.secret ? { secret: input.secret } : {},
    }
  }

  /**
   * The hook endpoints respond with `404` when the credential lacks
   * `admin:repo_hook` or `admin:org_hook`, so the status alone is misleading.
   */
  function scopeIs404(error: unknown): unknown {
    if (error instanceof NotFoundError) {
      return new ForbiddenError(
        'GitHub responded with 404 for a webhook endpoint, which it also does when the credential lacks admin:repo_hook or admin:org_hook',
        404,
        error.body,
        'resource_protected',
        { forge: error.forge, instance: error.instance, url: error.url, method: error.method, reasonRaw: 'hook_scope_404' },
        { cause: error },
      )
    }
    return error
  }

  /** GitHub responds with `422` to a change of the tag, target or draft state of an immutable release. */
  function immutableReleaseIs422(error: unknown): unknown {
    if (!(error instanceof ForgeApiError) || error.constructor !== ForgeApiError || error.status !== 422) {
      return error
    }
    const reasonRaw = error.body.match(/\w+ cannot be changed when release is immutable/)?.[0]
    if (!reasonRaw) {
      return error
    }
    return new ForbiddenError('GitHub refused the change because the release is immutable', error.status, error.body, 'immutable_release', { forge: error.forge, instance: error.instance, url: error.url, method: error.method, reasonRaw }, { cause: error })
  }

  /** GitHub search qualifiers, in the order the docs list them. */
  function searchQualifiers(query: SearchQuery): string[] {
    const qualifiers: string[] = []
    const advanced = !query.kind
    /** In advanced search a bare `OR` binds looser than the other qualifiers, so caller syntax is grouped. */
    const group = (value: string) => advanced ? `(${value})` : value
    const text = advanced && query.text ? advancedFreeText(query.text) : query.text
    if (text) {
      qualifiers.push(group(text))
    }
    if (query.repo) {
      qualifiers.push(`repo:${query.repo.owner}/${query.repo.name}`)
    }
    else if (query.owner) {
      qualifiers.push(`user:${query.owner}`)
    }
    qualifiers.push(query.kind ? query.kind === 'pull_request' ? 'is:pr' : 'is:issue' : '(is:issue OR is:pr)')
    if (query.state && query.state !== 'all') {
      qualifiers.push(`state:${query.state}`)
    }
    for (const [name, value] of [['author', query.author], ['involves', query.involves], ['assignee', query.assignee]] as const) {
      if (value) {
        qualifiers.push(`${name}:${value}`)
      }
    }
    for (const label of query.labels ?? []) {
      qualifiers.push(`label:"${label}"`)
    }
    if (query.since) {
      qualifiers.push(`updated:>=${query.since.toISOString()}`)
    }
    if (query.queryRaw) {
      qualifiers.push(group(query.queryRaw))
    }
    return qualifiers
  }

  /**
   * GitHub requires a kind in issue search; naming both needs advanced search.
   * GitHub Enterprise Server may predate it, and GitHub App user access tokens
   * can't search both kinds at once, so those read issues, then pull requests.
   */
  async function searchThreadsPage(query: SearchQuery): Promise<Page<Thread>> {
    if (!query.kind && (enterprise || (auth.type === 'token' && tokenKindOf(auth, await resolveToken(auth)) === 'app-user'))) {
      return phased((['issue', 'pull_request'] as const).map(kind => (cursor?: Cursor) => searchIssuesPage({ ...query, kind, cursor })), query.cursor)
    }
    return searchIssuesPage(query)
  }

  async function searchIssuesPage(query: SearchQuery): Promise<Page<Thread>> {
    const result = await fetcher.page<GitHubIssue>('/search/issues', {
      query: {
        q: searchQualifiers(query).join(' '),
        advanced_search: query.kind ? undefined : 'true',
        sort: query.sort && query.sort !== 'relevance' ? query.sort : undefined,
        order: query.direction,
        per_page: query.perPage,
      },
      cursor: query.cursor,
      signal: query.signal,
      select: (body, next) => {
        const { items, total_count } = body as { items: GitHubIssue[], total_count?: number }
        return { items, next, total: total_count }
      },
    })
    return toPage(result, (raw) => {
      const repo = query.repo ?? repoRefFromApiUrl(instance, raw.repository_url)
      if (!repo) {
        return undefined
      }
      const isPull = Boolean(raw.pull_request)
      return toThread({ forge: FORGE, instance, repo, kind: isPull ? 'pull_request' : 'issue', number: String(raw.number) }, raw)
    })
  }

  function milestonesPage(repo: RepoRef, listOptions: MilestoneListOptions = {}) {
    return list(`${repoPath(repo)}/milestones`, listOptions, (raw: GitHubMilestone) => toMilestone(raw)!, { query: { state: listOptions.state ?? 'open' } })
  }

  async function contributorStats(repo: RepoRef, statsOptions: BaseOptions = {}): Promise<ContributorStats[]> {
    const path = `${repoPath(repo)}/stats/contributors`
    for (let attempt = 0; ; attempt++) {
      const { data, response } = await fetcher.json<GitHubContributorStats[] | undefined>(path, { signal: statsOptions.signal })
      if (response.status !== 202) {
        return (data ?? []).map(raw => toContributorStats(instance, raw))
      }
      if (attempt >= CONTRIBUTOR_STATS_DELAYS.length) {
        throw new ForgeApiError(`GitHub is still computing the contributor statistics of ${repo.owner}/${repo.name}`, 202, '', { ...context, url: fetcher.resolve(path), method: 'GET' })
      }
      await sleep(CONTRIBUTOR_STATS_DELAYS[attempt]!, statsOptions.signal)
    }
  }

  const REPO_SEARCH_SORTS: Partial<Record<NonNullable<RepoSearchQuery['sort']>, string>> = { updated: 'updated', stars: 'stars' }

  async function searchReposPage(query: RepoSearchQuery): Promise<Page<Repo>> {
    const qualifiers = [query.text, query.owner && `user:${query.owner}`, query.language && `language:${query.language}`, query.queryRaw].filter(Boolean)
    const warnings: ForgeWarning[] = query.sort === 'created'
      ? [{ code: 'sort_unsupported', message: 'GitHub repository search cannot sort by creation time; sorted by relevance' }]
      : []
    const result = await fetcher.page<GitHubRepositoryDetail>('/search/repositories', {
      query: {
        q: qualifiers.join(' '),
        sort: query.sort ? REPO_SEARCH_SORTS[query.sort] : undefined,
        order: query.direction,
        per_page: query.perPage,
      },
      cursor: query.cursor,
      signal: query.signal,
      select: (body, next) => {
        const { items, total_count } = body as { items: GitHubRepositoryDetail[], total_count?: number }
        return { items, next, total: total_count }
      },
    })
    return toPage(result, raw => toRepo(instance, raw), warnings)
  }

  const COMMIT_SEARCH_SORTS: Record<NonNullable<CommitSearchQuery['sort']>, string> = { author_date: 'author-date', committer_date: 'committer-date' }

  async function searchCommitsPage(query: CommitSearchQuery): Promise<Page<Commit>> {
    const qualifiers = [
      query.text,
      query.repo && `repo:${query.repo.owner}/${query.repo.name}`,
      query.author && `author:${query.author}`,
      query.committer && `committer:${query.committer}`,
      query.since && `author-date:>=${query.since.toISOString()}`,
      query.until && `author-date:<=${query.until.toISOString()}`,
      query.queryRaw,
    ].filter(Boolean)
    const result = await fetcher.page<GitHubCommitSearchItem>('/search/commits', {
      query: {
        q: qualifiers.join(' '),
        sort: query.sort && COMMIT_SEARCH_SORTS[query.sort],
        order: query.direction,
        per_page: query.perPage,
      },
      cursor: query.cursor,
      signal: query.signal,
      select: (body, next) => {
        const { items, total_count } = body as { items: GitHubCommitSearchItem[], total_count?: number }
        return { items, next, total: total_count }
      },
    })
    return toPage(result, (raw) => {
      const repo = query.repo ?? (raw.repository && toRepoRef(instance, raw.repository))
      return repo && toCommit(repo, raw)
    })
  }

  /** The excerpts only come with the text match media type. */
  async function searchCodePage(query: CodeSearchQuery): Promise<Page<CodeMatch>> {
    const qualifiers = [
      query.text,
      query.repo ? `repo:${query.repo.owner}/${query.repo.name}` : query.owner && `user:${query.owner}`,
      query.queryRaw,
    ].filter(Boolean)
    let incomplete = false
    const result = await fetcher.page<GitHubCodeSearchItem>('/search/code', {
      query: { q: qualifiers.join(' '), per_page: query.perPage },
      headers: { accept: 'application/vnd.github.text-match+json' },
      cursor: query.cursor,
      signal: query.signal,
      select: (body, next) => {
        const { items, incomplete_results, total_count } = body as { items: GitHubCodeSearchItem[], incomplete_results?: boolean, total_count?: number }
        incomplete = incomplete_results === true
        return { items, next, total: total_count }
      },
    })
    const warnings: ForgeWarning[] = incomplete
      ? [{ code: 'search_incomplete', message: 'GitHub stopped the search before it finished; the page may be missing matches' }]
      : []
    return toPage(result, raw => ({
      repo: query.repo ?? toRepoRef(instance, raw.repository),
      path: raw.path,
      ref: new URL(raw.url).searchParams.get('ref') ?? undefined,
      fragments: (raw.text_matches ?? []).filter(match => match.property === 'content').map(match => ({ text: match.fragment })),
      url: raw.html_url,
      raw,
    }), warnings)
  }

  async function feedPage(path: string, listOptions: EventFeedOptions = {}): Promise<Page<ForgeEventInput>> {
    const throttled = throttledPage<ForgeEventInput>(path, listOptions, 'this feed')
    if (throttled) {
      return throttled
    }
    const result = await fetcher.page<GitHubFeedEvent>(path, {
      query: { per_page: listOptions.perPage },
      cursor: listOptions.cursor,
      signal: listOptions.signal,
    })
    const poll = recordPoll(path, listOptions.cursor, result.response)
    const { toFeedEvents } = await import('./events.ts')
    const page = toPage(result, raw => toFeedEvents(instance, raw))
    return { ...page, items: page.items.flat(), ...poll }
  }

  function createInstallationsApi(app: AppCredentials): InstallationsSpec {
    const appFetcher = createFetcher({ baseUrl, authHeaders: async () => ({ authorization: `Bearer ${await app.appJwt()}` }) })
    const auth = options.auth as Extract<GitHubAuth, { type: 'app' }>

    function toInstallation(raw: GitHubInstallation): Installation {
      return {
        forge: FORGE,
        instance,
        id: String(raw.id),
        account: toActor(instance, raw.account),
        targetTypeRaw: raw.target_type,
        repositorySelectionRaw: raw.repository_selection,
        raw,
      }
    }

    function provider(installation: Installation | string): ForgeProvider {
      return derive({ ...options, auth: { ...auth, installationId: installationId(installation) } }, app)
    }

    async function listPage(listOptions: PageOptions = {}): Promise<Page<Installation>> {
      return toPage(
        await appFetcher.page<GitHubInstallation>('/app/installations', { query: { per_page: listOptions.perPage }, cursor: listOptions.cursor, signal: listOptions.signal }),
        toInstallation,
      )
    }

    return {
      listPage,
      async get(installation, options) {
        return toInstallation((await appFetcher.json<GitHubInstallation>(`/app/installations/${installationId(installation)}`, { signal: options?.signal })).data)
      },
      token: (installation, options) => app.installationTokenDetails(installationId(installation), options),
      reposPage(installation, listOptions) {
        const id = installationId(installation)
        const installationFetcher = createFetcher({ baseUrl, authHeaders: async () => ({ authorization: `Bearer ${await app.installationToken(id)}` }) })
        return reposPage(installationFetcher, '/installation/repositories', true, listOptions)
      },
      provider,
      providers() {
        return forgeIterable(async function* () {
          for await (const installation of iteratePages(listPage)) {
            yield { installation, provider: provider(installation) }
          }
        })
      },
    }
  }

  async function readFile(repo: RepoRef, path: string, fileOptions: FileOptions = {}): Promise<FileContent> {
    const { data } = await fetcher.json<GitHubContentFile>(`${repoPath(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      query: { ref: fileOptions.ref },
      signal: fileOptions.signal,
    })
    const file = { path: data.path, sha: data.sha, size: data.size, url: data.html_url ?? undefined }
    // Files over 1 MB arrive with `encoding: 'none'` and no content; the blob endpoint serves them up to 100 MB.
    const content = data.encoding === 'base64' && data.content !== undefined
      ? data.content
      : (await fetcher.json<GitHubBlob>(`${repoPath(repo)}/git/blobs/${data.sha}`, { signal: fileOptions.signal })).data.content
    return toFileContent(fromBase64(content), file, fileOptions, context)
  }

  async function templates(repo: RepoRef, options: RepoTemplateOptions = {}): Promise<RepoTemplate[]> {
    const signal = options.signal
    return (await import('./templates.ts')).readTemplates(repo, options.kind ? [options.kind] : ['issue', 'pull_request'], {
      list: async (ref, path) => {
        const { data } = await fetcher.json<GitHubContentFile[] | GitHubContentFile>(`${repoPath(ref)}/contents${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`, { signal })
        return Array.isArray(data) ? data : []
      },
      read: async (ref, path) => (await readFile(ref, path, { as: 'text', signal })).content as string,
      repository: async ref => (await fetcher.json<GitHubRepositoryDetail>(repoPath(ref), { signal })).data,
    })
  }

  async function treePage(repo: RepoRef, treeOptions: TreeOptions = {}): Promise<Page<TreeEntry>> {
    const ref = treeOptions.ref ?? 'HEAD'
    const target = treeOptions.path ? `${ref}:${treeOptions.path.replace(/^\/|\/$/g, '')}` : ref
    const { data, response } = await fetcher.json<GitHubTree>(`${repoPath(repo)}/git/trees/${encodeURIComponent(target)}`, {
      query: treeOptions.recursive ? { recursive: '1' } : {},
      signal: treeOptions.signal,
    })
    const warnings = data.truncated
      ? [{ code: 'tree_truncated' as const, message: 'GitHub truncated the tree; read it directory by directory instead', subject: target }]
      : []
    return toPage({ data: data.tree, response, notModified: false }, toTreeEntry, warnings)
  }

  async function compare(repo: RepoRef, base: string, head: string, options: CompareOptions = {}): Promise<Comparison> {
    const path = `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    const limit = options.commitLimit
    const perPage = limit === undefined ? undefined : Math.min(100, Math.max(1, limit))
    const { data } = await fetcher.json<GitHubComparison>(path, { query: { per_page: perPage }, signal: options.signal })
    let commits = data.commits ?? []
    const total = data.total_commits ?? data.ahead_by
    if (limit !== undefined && perPage !== undefined && total !== undefined && total > commits.length) {
      const first = Math.floor(Math.max(0, total - limit) / perPage) + 1
      const pages = Array.from({ length: Math.ceil(total / perPage) - first + 1 }, (_, index) => first + index)
      commits = (await Promise.all(pages.map(async page => page === 1
        ? commits
        : (await fetcher.json<GitHubComparison>(path, { query: { per_page: perPage, page }, signal: options.signal })).data.commits ?? []))).flat()
    }
    return {
      base,
      head,
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      mergeBaseSha: data.merge_base_commit?.sha,
      commits: commits.map(raw => toCommit(repo, raw)).toReversed(),
      files: (data.files ?? []).map(toChangedFile),
      raw: data,
    }
  }

  async function commitsPage(repo: RepoRef, query: CommitQuery = {}): Promise<Page<Commit>> {
    return list(`${repoPath(repo)}/commits`, query, (raw: GitHubCommit) => toCommit(repo, raw), { query: { sha: query.ref, path: query.path, author: query.author, since: query.since?.toISOString(), until: query.until?.toISOString() } })
  }

  async function releasesPage(repo: RepoRef, listOptions: PageOptions = {}): Promise<Page<Release>> {
    return list(`${repoPath(repo)}/releases`, listOptions, (raw: GitHubRelease) => toRelease(repo, raw))
  }

  /** The commit that `input` builds on: `createFrom` resolved, `expectedHead`, or the head of the branch. */
  async function commitParent(repo: RepoRef, input: CommitFilesInput, options?: BaseOptions): Promise<string> {
    if (input.createFrom !== undefined) {
      return isSha(input.createFrom) ? input.createFrom : (await fetcher.json<GitHubCommit>(`${repoPath(repo)}/commits/${encodeURIComponent(input.createFrom)}`, { signal: options?.signal })).data.sha
    }
    return input.expectedHead ?? (await fetcher.json<GitHubGitRef>(`${repoPath(repo)}/git/ref/heads/${branchPath(input.branch)}`, { signal: options?.signal })).data.object.sha
  }

  /** Moves `branch` from `before` to `after` only if it is still at `before`. The zero oid stands for a branch that does not exist. */
  async function swapBranch(repo: RepoRef, branch: string, before: string, after: string, options?: BaseOptions): Promise<void> {
    const { repository } = await graphql<{ repository: { id: string } | null }>('REPOSITORY_ID', { owner: repo.owner, name: repo.name }, options)
    if (!repository) {
      throw new NotFoundError(`${repo.owner}/${repo.name} does not exist`, 404, '', context)
    }
    await graphql('UPDATE_REFS', { input: { repositoryId: repository.id, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: before, afterOid: after }] } }, options)
  }

  /** One `createCommitOnBranch` mutation, which GitHub signs and attributes to the credential's account. */
  async function commitOnBranch(repo: RepoRef, input: CommitFilesInput, options?: BaseOptions): Promise<Commit> {
    const head = await commitParent(repo, input, options)
    if (input.createFrom !== undefined) {
      await fetcher.json(`${repoPath(repo)}/git/refs`, { method: 'POST', json: { ref: `refs/heads/${input.branch}`, sha: head }, signal: options?.signal })
    }
    const fileChanges = {
      additions: input.changes.flatMap(change => change.content === null ? [] : [{ path: change.path, contents: changeBase64(change.content) }]),
      deletions: input.changes.flatMap(change => change.content === null ? [{ path: change.path }] : []),
    }
    try {
      const [data, { toGraphQLCommit }] = await Promise.all([
        graphql<CreateCommitOnBranchResult>('CREATE_COMMIT_ON_BRANCH', {
          input: { branch: { repositoryNameWithOwner: `${repo.owner}/${repo.name}`, branchName: input.branch }, expectedHeadOid: head, message: splitMessage(input.message), fileChanges },
        }, options),
        import('./graphql.ts'),
      ])
      return toGraphQLCommit(repo, data.createCommitOnBranch.commit)
    }
    catch (error) {
      if (input.createFrom !== undefined) {
        await swapBranch(repo, input.branch, head, ZERO_OID).catch(() => {})
      }
      throw commitError(error)
    }
  }

  /** Blobs, a tree, a commit and a ref update through the Git database API, which can name an author. */
  async function commitTree(repo: RepoRef, input: CommitFilesInput, options?: BaseOptions): Promise<Commit> {
    const signal = options?.signal
    const parent = await commitParent(repo, input, options)
    const tree = async (directory: string) => (await fetcher.json<GitHubTree>(`${repoPath(repo)}/git/trees/${encodeURIComponent(directory ? `${parent}:${directory}` : parent)}`, { signal })).data
    const root = memo(() => tree(''))
    const existing = await existingFiles(input.changes, inDirectories(async (directory) => {
      try {
        const data = directory ? await tree(directory) : await root()
        return new Map(data.tree.filter(entry => entry.type === 'blob').map(entry => [directory ? `${directory}/${entry.path}` : entry.path, entry]))
      }
      catch (error) {
        if (error instanceof NotFoundError) {
          return undefined
        }
        throw error
      }
    }), context)
    const entries = await Promise.all(input.changes.map(async ({ path, content }) => {
      const mode = existing.get(path)?.mode ?? '100644'
      if (content === null || typeof content === 'string') {
        return { path, mode, type: 'blob', ...content === null ? { sha: null } : { content } }
      }
      const { data } = await fetcher.json<{ sha: string }>(`${repoPath(repo)}/git/blobs`, { method: 'POST', json: { content: changeBase64(content), encoding: 'base64' }, signal })
      return { path, mode, type: 'blob', sha: data.sha }
    }))
    const { data: created } = await fetcher.json<GitHubTree>(`${repoPath(repo)}/git/trees`, { method: 'POST', json: { base_tree: (await root()).sha, tree: entries }, signal })
    const { data: commit } = await fetcher.json<GitHubGitCommit>(`${repoPath(repo)}/git/commits`, {
      method: 'POST',
      json: { message: input.message, tree: created.sha, parents: [parent], author: input.author },
      signal,
    })
    try {
      await swapBranch(repo, input.branch, input.createFrom === undefined ? parent : ZERO_OID, commit.sha, options)
    }
    catch (error) {
      if (input.createFrom !== undefined) {
        throw error
      }
      // GitHub reports a stale `beforeOid` only as an internal error, so the branch is read again to tell.
      const { data } = await fetcher.json<GitHubGitRef>(`${repoPath(repo)}/git/ref/heads/${branchPath(input.branch)}`, { signal })
      if (data.object.sha !== parent && error instanceof ForgeApiError) {
        throw new BranchMovedError(`${input.branch} is at ${data.object.sha}, not ${parent}`, 409, error.body, context, { cause: error })
      }
      throw error
    }
    return toGitCommit(repo, commit)
  }

  async function writeRelease(repo: RepoRef, path: string, method: 'POST' | 'PATCH', input: ReleaseUpdate, options?: BaseOptions): Promise<Release> {
    const { data } = await fetcher.json<GitHubRelease>(path, {
      method,
      json: { tag_name: input.tag, target_commitish: input.target, name: input.name, body: input.body, draft: input.draft, prerelease: input.prerelease },
      mapError: immutableReleaseIs422,
      signal: options?.signal,
    })
    return toRelease(repo, data)
  }

  const ALERT_SOURCES = {
    dependency: {
      path: 'dependabot/alerts',
      states: { open: 'open', closed: 'fixed,dismissed,auto_dismissed' },
      map: toDependabotAlert,
    },
    code_scanning: {
      path: 'code-scanning/alerts',
      states: { open: 'open', closed: 'closed' },
      map: toCodeScanningAlert,
    },
    secret: {
      path: 'secret-scanning/alerts',
      states: { open: 'open', closed: 'resolved' },
      map: toSecretScanningAlert,
    },
    advisory: {
      path: 'security-advisories',
      states: { open: undefined, closed: undefined },
      map: toRepositoryAdvisory,
    },
  } as const

  async function alertsPage(repo: RepoRef, listOptions: SecurityAlertListOptions = {}): Promise<Page<SecurityAlert>> {
    const kinds = listOptions.kind ? [listOptions.kind] : Object.keys(ALERT_SOURCES) as Array<keyof typeof ALERT_SOURCES>
    return phased(kinds.map(kind => async (cursor?: Cursor): Promise<Page<SecurityAlert>> => {
      const source = ALERT_SOURCES[kind as keyof typeof ALERT_SOURCES]
      const state = listOptions.state ?? 'open'
      const filter = state === 'all' ? undefined : source.states[state]
      try {
        const result = await fetcher.page<never>(`${repoPath(repo)}/${source.path}`, {
          query: { state: filter, per_page: listOptions.perPage },
          cursor,
          signal: listOptions.signal,
        })
        return toPage(result, (raw) => {
          const alert = source.map(repo, raw)
          return filter || state === 'all' || (alert.state === 'open') === (state === 'open') ? alert : undefined
        })
      }
      catch (error) {
        if (!listOptions.kind && (error instanceof InsufficientScopeError || error instanceof NotFoundError)) {
          return { items: [], warnings: [toWarning(error instanceof InsufficientScopeError ? 'insufficient_scope' : 'alerts_unavailable', error, kind)] }
        }
        throw error
      }
    }), listOptions.cursor)
  }

  /** The GraphQL node id of an issue, pull request or discussion. */
  async function nodeId(thread: ThreadRef, options?: BaseOptions): Promise<string> {
    const ref = requireThread(thread, context)
    return ref.externalId ?? (await subscriptionNode(ref, options)).id
  }

  function reactionPath(target: ThreadRef | CommentRef): string {
    if ('thread' in target) {
      return `${repoPath(target.thread.repo)}/issues/comments/${encodeURIComponent(target.id)}/reactions`
    }
    const ref = requireIssueOrPull(target, context, 'react to')
    return `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/reactions`
  }

  async function reactionsPage(target: ThreadRef | CommentRef, listOptions: ListOptions = {}): Promise<Page<Reaction>> {
    const thread = 'thread' in target ? target.thread : target
    if (thread.kind === 'discussion') {
      const id = 'thread' in target ? target.id : await nodeId(thread, listOptions)
      const [data, { toGraphQLActor, GRAPHQL_REACTIONS }] = await Promise.all([graphql<NodeReactionsResult>('NODE_REACTIONS', { id, after: listOptions.cursor?.token ?? null }, listOptions), import('./graphql.ts')])
      const reactions = data.node?.reactions
      return {
        items: (reactions?.nodes ?? []).flatMap((raw) => {
          const actor = toGraphQLActor(instance, raw.user)
          return actor ? [{ content: reactionContent(GRAPHQL_REACTIONS[raw.content] ?? raw.content), contentRaw: raw.content, actor, createdAt: toDate(raw.createdAt), raw }] : []
        }),
        cursor: reactions?.pageInfo.hasNextPage && reactions.pageInfo.endCursor ? { token: reactions.pageInfo.endCursor } : undefined,
        ...reactions?.totalCount !== undefined ? { total: reactions.totalCount } : {},
      }
    }
    const result = await fetcher.page<GitHubReaction>(reactionPath(target), {
      query: { per_page: listOptions.perPage },
      cursor: listOptions.cursor,
      signal: listOptions.signal,
    })
    return toPage(result, (raw) => {
      const actor = toActor(instance, raw.user)
      return actor && { content: reactionContent(raw.content), contentRaw: raw.content, actor, createdAt: toDate(raw.created_at), raw }
    })
  }

  async function react(target: ThreadRef | CommentRef, reaction: ReactionContent, options?: BaseOptions): Promise<void> {
    const thread = 'thread' in target ? target.thread : target
    if (thread.kind === 'discussion') {
      await graphql('ADD_REACTION', { id: 'thread' in target ? target.id : await nodeId(thread, options), content: (await import('./graphql.ts')).REACTION_CONTENT[reaction] }, options)
      return
    }
    await fetcher.raw(reactionPath(target), { method: 'POST', json: { content: reaction }, signal: options?.signal })
  }

  async function unreact(target: ThreadRef | CommentRef, reaction: ReactionContent, options?: BaseOptions): Promise<void> {
    const thread = 'thread' in target ? target.thread : target
    if (thread.kind === 'discussion') {
      await graphql('REMOVE_REACTION', { id: 'thread' in target ? target.id : await nodeId(thread, options), content: (await import('./graphql.ts')).REACTION_CONTENT[reaction] }, options)
      return
    }
    const path = reactionPath(target)
    const { data } = await fetcher.json<GitHubReaction[]>(path, { query: { content: reaction, per_page: 100 }, signal: options?.signal })
    const login = await viewerLogin()
    const mine = data.find(item => item.content === reaction && item.user?.login === login)
    if (mine) {
      await fetcher.raw(`${path}/${encodeURIComponent(mine.id)}`, { method: 'DELETE', signal: options?.signal })
    }
  }

  async function issuePatch(thread: ThreadRef, json: Record<string, unknown>, action: string, signal?: AbortSignal): Promise<GitHubIssue> {
    const ref = requireIssueOrPull(thread, context, action)
    return (await fetcher.json<GitHubIssue>(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}`, { method: 'PATCH', json, signal })).data
  }

  /** Check runs need an installation credential; a token writes a commit status instead. */
  const canWriteCheckRuns = auth.type === 'app' && auth.installationId !== undefined

  const STATUS_STATES: Record<CheckState, string> = { pending: 'pending', success: 'success', failure: 'failure', neutral: 'success', unknown: 'pending' }
  const CHECK_RUN_CONCLUSIONS: Partial<Record<CheckState, string>> = { success: 'success', failure: 'failure', neutral: 'neutral' }

  async function report(repo: RepoRef, sha: string, input: CheckReportInput, options?: BaseOptions): Promise<Check> {
    if (canWriteCheckRuns) {
      const conclusion = CHECK_RUN_CONCLUSIONS[input.state]
      const { data } = await fetcher.json<GitHubCheckRun>(`${repoPath(repo)}/check-runs`, {
        method: 'POST',
        json: {
          name: input.name,
          head_sha: sha,
          status: conclusion ? 'completed' : 'in_progress',
          conclusion,
          details_url: input.url,
          external_id: input.externalId,
          output: input.description ? { title: input.name, summary: input.description } : undefined,
        },
        signal: options?.signal,
      })
      return toCheckRun(repo, data)
    }
    const { data } = await fetcher.json<GitHubCommitStatus>(`${repoPath(repo)}/statuses/${sha}`, {
      method: 'POST',
      json: { state: STATUS_STATES[input.state], context: input.name, description: input.description, target_url: input.url },
      signal: options?.signal,
    })
    return toStatusCheck(repo, data)
  }

  async function runsPage(repo: RepoRef, query: CiRunQuery = {}): Promise<Page<CiRun>> {
    const result = await fetcher.page<GitHubWorkflowRun>(`${repoPath(repo)}/actions/runs`, {
      query: {
        branch: query.branch,
        status: query.state === 'pending' ? 'in_progress' : query.state === 'success' ? 'success' : query.state === 'failure' ? 'failure' : undefined,
        per_page: query.perPage,
      },
      cursor: query.cursor,
      signal: query.signal,
      select: (body, next) => {
        const { workflow_runs, total_count } = body as { workflow_runs: GitHubWorkflowRun[], total_count?: number }
        return { items: workflow_runs, next, total: total_count }
      },
    })
    return toPage(result, raw => toWorkflowRun(repo, raw))
  }

  const spec: ProviderSpec<GitHubExtensions> & { web: WebLinks } = {
    extensions: {
      graphql: ((document: string | TypedGraphQLDocument<unknown, unknown>, variables: Record<string, unknown> = {}, graphqlOptions?: BaseOptions) => {
        const query = String(document)
        return options.readOnly && graphqlOperations(query).some(({ type }) => type === 'mutation')
          ? Promise.reject(new ReadOnlyError('GraphQL mutations are writes and this github provider is read-only', context))
          : graphql({ query }, variables, graphqlOptions)
      }) as GitHubGraphQL,
    },
    checks: {
      list: verb(true, (repo, sha, options) => headChecks(repo, sha, options?.signal)),
      get: verb(true, getCheck),
      report: verb(true, report),
      rerun: verb(true, async (ref, options) => {
        if (ref.type !== 'check_run') {
          throw new UnsupportedOperationError(`GitHub cannot re-run a ${ref.type}; only check runs can be re-requested`, context)
        }
        try {
          await fetcher.raw(`${repoPath(ref.repo)}/check-runs/${encodeURIComponent(ref.id)}/rerequest`, { method: 'POST', signal: options?.signal })
        }
        catch (error) {
          // Only the app that created a check run can re-request it; an Actions check run is re-run as its job.
          if (!(error instanceof ForgeApiError) || error.status !== 422) {
            throw error
          }
          try {
            await fetcher.raw(`${repoPath(ref.repo)}/actions/jobs/${encodeURIComponent(ref.id)}/rerun`, { method: 'POST', signal: options?.signal })
          }
          catch (rerunError) {
            throw rerunError instanceof NotFoundError ? error : rerunError
          }
        }
      }),
    },
    ci: {
      runsPage: verb(true, runsPage),
      getRun: verb(true, async (ref, options) => toWorkflowRun(ref.repo, (await fetcher.json<GitHubWorkflowRun>(`${repoPath(ref.repo)}/actions/runs/${encodeURIComponent(ref.id)}`, { signal: options?.signal })).data)),
      jobsPage: verb(true, (ref, listOptions = {}) => list(`${repoPath(ref.repo)}/actions/runs/${encodeURIComponent(ref.id)}/jobs`, listOptions, (raw: GitHubWorkflowJob) => toWorkflowJob(ref, raw), {
        select: (body, next) => {
          const { jobs, total_count } = body as { jobs: GitHubWorkflowJob[], total_count?: number }
          return { items: jobs, next, total: total_count }
        },
      })),
      getJob: verb(true, getJob),
      log: verb(!anonymous, async (ref, options) => (await fetcher.stream(`${repoPath(ref.repo)}/actions/jobs/${encodeURIComponent(ref.id)}/logs`, { signal: options?.signal })).body),
    },
    contents: {
      getFile: verb(true, readFile),
      treePage: verb(true, treePage),
      branchesPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/branches`, listOptions, (raw: GitHubBranch) => toBranch(raw))),
      tagsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/tags`, listOptions, toTag)),
      resolveRef: verb(true, async (repo, ref, options) => (await fetcher.json<GitHubCommit>(`${repoPath(repo)}/commits/${encodeURIComponent(ref)}`, { signal: options?.signal })).data.sha),
      commitFiles: verb(true, (repo, input, options) => input.author ? commitTree(repo, input, options) : commitOnBranch(repo, input, options)),
      compare: verb(true, compare),
    },
    commits: {
      listPage: verb(true, commitsPage),
      get: verb(true, async ({ repo, sha }, options) => toCommit(repo, (await fetcher.json<GitHubCommit>(`${repoPath(repo)}/commits/${sha}`, { signal: options?.signal })).data)),
      commentsPage: verb(true, (commit, listOptions = {}) => list(`${repoPath(commit.repo)}/commits/${encodeURIComponent(commit.sha)}/comments`, listOptions, (raw: GitHubComment) => toCommitComment(commit, raw))),
      getComment: verb(anonymous ? 'unverified' : true, async (ref, options) => {
        const { data } = await fetcher.json<GitHubComment>(commitCommentPath(ref), { signal: options?.signal })
        return toCommitComment(ref.commit, data)
      }),
      createComment: verb(true, async (commit, body, options) => {
        const { data } = await fetcher.json<GitHubComment>(`${repoPath(commit.repo)}/commits/${encodeURIComponent(commit.sha)}/comments`, { method: 'POST', json: { body }, signal: options?.signal })
        return toCommitComment(commit, data)
      }),
      updateComment: verb(true, async (ref, body, options) => {
        const { data } = await fetcher.json<GitHubComment>(commitCommentPath(ref), { method: 'PATCH', json: { body }, signal: options?.signal })
        return toCommitComment(ref.commit, data)
      }),
      deleteComment: verb(true, async (ref, options) => {
        await fetcher.raw(commitCommentPath(ref), { method: 'DELETE', signal: options?.signal })
      }),
      commentHiding: verb(true, {
        hideComment: async (ref, reason, options) => {
          await graphql('MINIMIZE_COMMENT', { id: await commentNodeId(ref, options), classifier: reason.toUpperCase() }, options)
        },
        unhideComment: async (ref, options) => {
          await graphql('UNMINIMIZE_COMMENT', { id: await commentNodeId(ref, options) }, options)
        },
      }),
    },
    search: {
      threadsPage: verb(true, searchThreadsPage),
      reposPage: verb(true, searchReposPage),
      commitsPage: verb(true, searchCommitsPage),
      codePage: verb(!anonymous, searchCodePage),
      queryRaw: true,
    },
    releases: {
      listPage: verb(true, releasesPage),
      get: verb(true, async (ref, options) => toRelease(ref.repo, (await fetcher.json<GitHubRelease>(`${repoPath(ref.repo)}/releases/${encodeURIComponent(ref.id)}`, { signal: options?.signal })).data)),
      getByTag: verb(true, async (repo, tag, options) => toRelease(repo, (await fetcher.json<GitHubRelease>(`${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`, { signal: options?.signal })).data)),
      downloadAsset: verb(true, async (ref, downloadOptions = {}) => (await fetcher.stream(`${repoPath(ref.repo)}/releases/assets/${encodeURIComponent(ref.id)}`, {
        headers: { accept: 'application/octet-stream' },
        signal: downloadOptions.signal,
      })).body),
      latest: verb(true, async (repo, options) => {
        try {
          return toRelease(repo, (await fetcher.json<GitHubRelease>(`${repoPath(repo)}/releases/latest`, { signal: options?.signal })).data)
        }
        catch (error) {
          if (error instanceof NotFoundError) {
            return undefined
          }
          throw error
        }
      }),
      create: verb(true, (repo, input, options) => writeRelease(repo, `${repoPath(repo)}/releases`, 'POST', input, options)),
      update: verb(true, (ref, update, options) => writeRelease(ref.repo, `${repoPath(ref.repo)}/releases/${encodeURIComponent(ref.id)}`, 'PATCH', update, options)),
    },
    securityAlerts: {
      kinds: {
        dependency: !anonymous && (enterprise ? ({ version }) => versionAtLeast(version, GHES_DEPENDABOT_ALERTS) && 'unverified' : true),
        code_scanning: !anonymous,
        secret: !anonymous,
        advisory: !anonymous && !enterprise,
      },
      listPage: alertsPage,
    },
    traits: { eventKinds: 'native', authKinds: ['token', 'app', 'anonymous'], limits: { bodyLength: 65536, commentLength: 65536, labelLength: 50 } },
    probeVersion: enterprise ? async () => (await fetcher.json<{ installed_version?: string }>('/meta')).data.installed_version : undefined,
    installations: credentials ? verb(true, createInstallationsApi(credentials)) : undefined,
    web: githubShapedWeb(enterprise ? baseUrl.replace(/\/api\/v3$/, '') : `https://${webHost(host)}`, { pull: 'pull', discussions: true, ...host === 'api.github.com' ? { rawOrigin: 'https://raw.githubusercontent.com' } : {}, commentFragment: 'issuecomment-', file: at => `/blob/${encodeURIComponent(at)}`, lineFragment: line => `L${line}`, reserved: GITHUB_RESERVED_PATHS, references: GITHUB_REFERENCES }),
    webhooks: {
      listPage: verb(true, (target, listOptions = {}) => list(hooksPath(target), listOptions, (raw: GitHubHook) => toWebhook(target, raw), { mapError: scopeIs404 })),
      create: verb(true, async (target, input, options) => toWebhook(target, (await fetcher.json<GitHubHook>(hooksPath(target), {
        method: 'POST',
        json: {
          name: 'web',
          active: input.active ?? true,
          events: nativeEventsFor(GITHUB_NATIVE_EVENTS, input.events, input.nativeEvents),
          config: hookConfig(input),
        },
        mapError: scopeIs404,
        signal: options?.signal,
      })).data)),
      update: verb(true, async (ref, update, options) => toWebhook(ref.target, (await fetcher.json<GitHubHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, {
        method: 'PATCH',
        json: {
          ...update.active === undefined ? {} : { active: update.active },
          ...update.events || update.nativeEvents ? { events: nativeEventsFor(GITHUB_NATIVE_EVENTS, update.events, update.nativeEvents) } : {},
          ...update.url || update.secret || update.contentType ? { config: hookConfig(update) } : {},
        },
        mapError: scopeIs404,
        signal: options?.signal,
      })).data)),
      delete: verb(true, async (ref, options) => {
        await fetcher.raw(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, { method: 'DELETE', mapError: scopeIs404, signal: options?.signal })
      }),
      rotateSecret: verb(true, async (ref, secret, options) => {
        const current = toWebhook(ref.target, (await fetcher.json<GitHubHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, { mapError: scopeIs404, signal: options?.signal })).data)
        const { data } = await fetcher.json<GitHubHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, {
          method: 'PATCH',
          json: { config: hookConfig({ url: current.url, contentType: current.contentType, secret }) },
          mapError: scopeIs404,
          signal: options?.signal,
        })
        return toWebhook(ref.target, data)
      }),
      deliveriesPage: verb(true, (ref, listOptions = {}) => list(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}/deliveries`, listOptions, (raw: GitHubHookDelivery) => toWebhookDelivery(ref, raw), { mapError: scopeIs404 })),
      redeliver: verb(true, async (ref, options) => {
        await fetcher.raw(`${hooksPath(ref.hook.target)}/${encodeURIComponent(ref.hook.id)}/deliveries/${encodeURIComponent(ref.id)}/attempts`, { method: 'POST', mapError: scopeIs404, signal: options?.signal })
      }),
    },
    scopes: githubScopesFor,
    users: {
      get: verb(true, async (login, options) => toUser(instance, (await fetcher.json<GitHubUserDetail>(`/users/${encodeURIComponent(login)}`, { signal: options?.signal })).data)),
      me: verb(auth.type === 'token' && !installation, async options => toUser(instance, (await fetcher.json<GitHubUserDetail>('/user', { signal: options?.signal })).data)),
      sponsorable: verb(!enterprise && !anonymous, async (login, options) => {
        const data = await graphql<SponsorableResult>('SPONSORABLE', { login }, options)
        if (!data.repositoryOwner) {
          throw new NotFoundError(`Account ${login} not found`, 404, '', context)
        }
        return data.repositoryOwner.hasSponsorsListing
      }),
      eventsPage: verb(true, (login, listOptions) => feedPage(`/users/${encodeURIComponent(login)}/events`, listOptions)),
      blocking: verb(auth.type === 'token' && !installation && (enterprise ? 'unverified' : true), {
        block: async (login, options) => {
          await fetcher.raw(`/user/blocks/${encodeURIComponent(login)}`, { method: 'PUT', signal: options?.signal })
        },
        unblock: async (login, options) => {
          await fetcher.raw(`/user/blocks/${encodeURIComponent(login)}`, { method: 'DELETE', signal: options?.signal })
        },
      }),
    },
    repos: {
      get: verb(true, async (ref, options) => {
        return toRepo(instance, (await fetcher.json<GitHubRepositoryDetail>(repoPath(ref), { signal: options?.signal })).data)
      }),
      listPage: verb(!anonymous, (listOptions = {}) => installation
        ? reposPage(fetcher, '/installation/repositories', true, listOptions)
        : reposPage(fetcher, '/user/repos', false, listOptions)),
      byOwnerPage: verb(true, ownerReposPage),
      labelsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/labels`, listOptions, toLabel)),
      createLabel: verb(true, async (repo, label, options) => toLabel((await fetcher.json<GitHubLabel>(`${repoPath(repo)}/labels`, {
        method: 'POST',
        json: { name: label.name, color: label.colour, description: label.description },
        signal: options?.signal,
      })).data)),
      milestonesPage: verb(true, milestonesPage),
      issueTypes: verb(!anonymous && !enterprise, async (repo, options) => {
        const { data } = await fetcher.json<GitHubIssueType[]>(`${repoPath(repo)}/issue-types`, { signal: options?.signal })
        return data.map(raw => toIssueType(raw)!)
      }),
      collaboratorsPage: verb(!anonymous, (repo, listOptions = {}) => list(`${repoPath(repo)}/collaborators`, listOptions, (raw: GitHubCollaborator) => toCollaborator(instance, raw))),
      contributorsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/contributors`, listOptions, (raw: GitHubContributor) => toContributor(instance, raw), { query: { anon: 1 } })),
      contributorStats: verb(true, contributorStats),
      templates: verb(true, templates),
      permissionFor: verb(!anonymous, async (repo, actor, options) => {
        const { data } = await fetcher.json<{ permission?: string, role_name?: string, user?: GitHubCollaborator }>(
          `${repoPath(repo)}/collaborators/${encodeURIComponent(actorLogin(actor))}/permission`,
          { signal: options?.signal },
        )
        return toRole({ role_name: data.role_name ?? (data.permission === 'none' ? undefined : data.permission), permissions: data.user?.permissions })
      }),
      addCollaborator: verb(true, async (repo, actor, role, options) => {
        const response = await fetcher.raw(`${repoPath(repo)}/collaborators/${encodeURIComponent(actorLogin(actor))}`, { method: 'PUT', json: { permission: COLLABORATOR_PERMISSIONS[role] ?? role }, signal: options?.signal })
        return { status: response.status === 201 ? 'invited' : 'added' }
      }),
      assignableUsersPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/assignees`, listOptions, (raw: GitHubUserDetail) => toActor(instance, raw)!)),
      reviewerCandidatesPage: verb(!anonymous && 'emulated', async (thread, listOptions = {}) => {
        const ref = requireThread(thread, context)
        const page = await fetcher.page<GitHubCollaborator>(`${repoPath(ref.repo)}/collaborators`, {
          query: { per_page: listOptions.perPage },
          cursor: listOptions.cursor,
          signal: listOptions.signal,
        })
        const author = page.notModified ? undefined : (await get(ref, listOptions)).author?.login
        return toPage(page, raw => raw.login === author ? undefined : toActor(instance, raw)!)
      }),
      eventsPage: verb(true, (repo, listOptions) => feedPage(`${repoPath(repo)}/events`, listOptions)),
    },
    orgs: {
      teamsPage: verb(!anonymous, (org, listOptions = {}) => list(
        `/orgs/${encodeURIComponent(org.owner)}/teams`,
        listOptions,
        (raw: GitHubTeam) => toTeam(instance, teamOrg(org), raw),
      )),
      teamMembersPage: verb(!anonymous, (team, listOptions = {}) => list(
        `/orgs/${encodeURIComponent(team.org.owner)}/teams/${encodeURIComponent(team.slug)}/members`,
        listOptions,
        (raw: GitHubUserDetail) => toActor(instance, raw)!,
      )),
      blocking: verb(enterprise ? 'unverified' : true, {
        block: async (org, login, options) => {
          await fetcher.raw(`/orgs/${encodeURIComponent(org.owner)}/blocks/${encodeURIComponent(login)}`, { method: 'PUT', signal: options?.signal })
        },
        unblock: async (org, login, options) => {
          await fetcher.raw(`/orgs/${encodeURIComponent(org.owner)}/blocks/${encodeURIComponent(login)}`, { method: 'DELETE', signal: options?.signal })
        },
      }),
    },
    notifications: {
      listPage: verb(notificationsAuth, notificationPage),
      markRead: verb(notificationsAuth, async (ref: NotificationRef, options) => {
        await fetcher.raw(`/notifications/threads/${encodeURIComponent(ref.id)}`, { method: 'PATCH', signal: options?.signal })
      }),
      markDone: verb(notificationsAuth && (enterprise ? ({ version }) => versionAtLeast(version, GHES_MARK_DONE) : true), async (ref: NotificationRef, options) => {
        await fetcher.raw(`/notifications/threads/${encodeURIComponent(ref.id)}`, { method: 'DELETE', signal: options?.signal })
      }),
      unsubscribe: verb(notificationsAuth, async (ref: NotificationRef, options) => {
        await fetcher.raw(`/notifications/threads/${encodeURIComponent(ref.id)}/subscription`, { method: 'DELETE', signal: options?.signal })
      }),
      markAllRead: verb(notificationsAuth, async (bulk: BulkNotificationOptions = {}) => {
        await fetcher.raw(bulk.repo ? `${repoPath(bulk.repo)}/notifications` : '/notifications', {
          method: 'PUT',
          ...bulk.before ? { json: { last_read_at: bulk.before.toISOString() } } : {},
          signal: bulk.signal,
        })
      }),
    },
    threads: {
      get: perKind({ issue: true, pull_request: true, discussion: !anonymous }, get),
      getMany: verb(true, getMany),
      listPage: perKind({ ...ISSUE_LIKE, discussion: !anonymous }, listPage),
      listFilters: ['involves', 'mentions', 'milestone'],
      eventsPage: verb(true, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> => {
        const ref = requireThread(thread, context)
        if (ref.kind === 'discussion') {
          const [page, { toDiscussionCommentEvent }] = await Promise.all([discussionCommentPage(ref, listOptions), import('./graphql.ts')])
          return { ...page, items: page.items.map(({ comment, isReply }) => toDiscussionCommentEvent(ref, comment, isReply)) }
        }
        return list(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/timeline`, listOptions, (entry: GitHubTimelineEntry) => toEvent(instance, ref, entry))
      }),
      commentsPage: perKind({ issue: true, pull_request: true, discussion: !anonymous }, commentsPage),
      getComment: perKind({ issue: anonymous ? 'unverified' : true, pull_request: true, discussion: !anonymous }, getComment),
      reviewsPage: verb(true, reviewsPage),
      getReview: verb(anonymous ? 'unverified' : true, getReview),
      filesPage: verb(true, (ref, listOptions = {}) => list(`${threadPath(requirePull(ref, 'read for changed files'))}/files`, listOptions, toChangedFile)),
      commitsPage: verb(true, (ref, listOptions = {}) => list(`${threadPath(requirePull(ref, 'read for commits'))}/commits`, listOptions, (raw: GitHubCommit) => toCommit(ref.repo, raw))),
      createReview: verb(true, createReview),
      submitReview: verb(true, async (ref, event, body, options) => {
        const pull = requirePull(ref.thread, 'reviewed')
        const { data } = await fetcher.json<GitHubReview>(`${threadPath(pull)}/reviews/${encodeURIComponent(ref.id)}/events`, {
          method: 'POST',
          json: { event: REVIEW_EVENTS[event], body },
          signal: options?.signal,
        })
        return toReview(pull, data, [])
      }),
      replyToReviewComment: verb(true, async (thread, comment, body, options) => {
        const pull = requirePull(thread, 'reviewed')
        const id = comment.inReplyTo ?? comment.ref?.id
        if (id === undefined) {
          throw new UnsupportedOperationError('GitHub replies to a review comment by its id; pass the comment with its `ref`', context)
        }
        const { data } = await fetcher.json<GitHubReviewComment>(`${threadPath(pull)}/comments/${encodeURIComponent(id)}/replies`, {
          method: 'POST',
          json: { body },
          signal: options?.signal,
        })
        return toReviewComment(pull, data, comment.thread)
      }),
      reviewThreads: verb(true, {
        resolveReviewThread: async (_ref, id, options) => {
          await graphql('RESOLVE_REVIEW_THREAD', { id }, options)
        },
        unresolveReviewThread: async (_ref, id, options) => {
          await graphql('UNRESOLVE_REVIEW_THREAD', { id }, options)
        },
      }),
      checks: perKind({ pull_request: true }, async (thread, options) => {
        const ref = requireThread(thread, context)
        const { data } = await fetcher.json<GitHubIssue>(threadPath(ref), { signal: options?.signal })
        return data.head?.sha ? headChecks(ref.repo, data.head.sha, options?.signal) : { items: [] }
      }),
      createComment: perKind({ issue: true, pull_request: true, discussion: true }, async (thread, body, options) => {
        const ref = requireThread(thread, context)
        if (ref.kind === 'discussion') {
          const data = await graphql<{ addDiscussionComment: { comment: GraphQLComment } }>('ADD_DISCUSSION_COMMENT', { id: await discussionId(ref, options), body }, options)
          return (await import('./graphql.ts')).toDiscussionComment(ref, data.addDiscussionComment.comment)
        }
        const { data } = await fetcher.json<GitHubComment>(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/comments`, { method: 'POST', json: { body }, signal: options?.signal })
        return toComment(ref, data)
      }),
      updateComment: perKind({ issue: true, pull_request: true, discussion: true }, async (ref, body, options) => {
        const thread = requireThread(ref.thread, context)
        if (thread.kind === 'discussion') {
          const data = await graphql<{ updateDiscussionComment: { comment: GraphQLComment } }>('UPDATE_DISCUSSION_COMMENT', { id: ref.id, body }, options)
          return (await import('./graphql.ts')).toDiscussionComment(thread, data.updateDiscussionComment.comment)
        }
        const { data } = await fetcher.json<GitHubComment>(commentPath(ref), { method: 'PATCH', json: { body }, signal: options?.signal })
        return toComment(thread, data)
      }),
      deleteComment: perKind({ issue: true, pull_request: true, discussion: true }, async (ref, options) => {
        if (ref.thread.kind === 'discussion') {
          await graphql('DELETE_DISCUSSION_COMMENT', { id: ref.id }, options)
          return
        }
        await fetcher.raw(commentPath(ref), { method: 'DELETE', signal: options?.signal })
      }),
      create: perKind({ issue: true, pull_request: true }, async (repo, input: ThreadCreateInput, options) => {
        const assignees = input.assignees?.map(actorLogin)
        if (input.kind === 'issue') {
          const { data } = await fetcher.json<GitHubIssue>(`${repoPath(repo)}/issues`, {
            method: 'POST',
            json: { title: input.title, body: input.body, labels: input.labels, assignees },
            signal: options?.signal,
          })
          return toThread({ forge: FORGE, instance, repo, kind: 'issue', number: String(data.number) }, data)
        }
        if (input.kind !== 'pull_request') {
          throw new UnsupportedOperationError('GitHub discussions cannot be created through this API yet', context)
        }
        if (!input.head || !input.base) {
          throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
        }
        const { data: pull } = await fetcher.json<GitHubIssue>(`${repoPath(repo)}/pulls`, {
          method: 'POST',
          json: { title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft },
          signal: options?.signal,
        })
        const ref: ResolvedThreadRef = { forge: FORGE, instance, repo, kind: 'pull_request', number: String(pull.number) }
        if (!input.labels?.length && !assignees?.length) {
          return toThread(ref, pull)
        }
        const { data: issue } = await fetcher.json<GitHubIssue>(`${repoPath(repo)}/issues/${encodeURIComponent(pull.number)}`, {
          method: 'PATCH',
          json: { labels: input.labels, assignees },
          signal: options?.signal,
        })
        return toThread(ref, { ...pull, labels: issue.labels, assignees: issue.assignees })
      }),
      /** The pulls endpoint takes no labels or assignees, so a pull request with them is edited as an issue. */
      update: perKind({ issue: true, pull_request: true, discussion: true }, async (thread, input, options) => {
        const ref = requireThread(thread, context)
        if (ref.kind === 'discussion') {
          if (input.labels || input.assignees) {
            throw new UnsupportedOperationError('Setting labels or assignees on a GitHub discussion is not supported', context)
          }
          const id = await discussionId(ref, options)
          const changed = input.state && await setState({ ...ref, externalId: id }, input.state, options)
          if (input.title === undefined && input.body === undefined) {
            return changed || getDiscussion(ref, options)
          }
          const data = await graphql<{ updateDiscussion: { discussion: GraphQLDiscussion } }>('UPDATE_DISCUSSION', { id, title: input.title, body: input.body }, options)
          return (await import('./graphql.ts')).toDiscussionThread(ref, data.updateDiscussion.discussion)
        }
        const target = requireIssueOrPull(ref, context, 'update')
        const json = { title: input.title, body: input.body, state: input.state, labels: input.labels, assignees: input.assignees?.map(actorLogin) }
        if (target.kind === 'pull_request' && (input.labels || input.assignees)) {
          await issuePatch(target, json, 'update', options?.signal)
          return toThread(target, (await fetcher.json<GitHubIssue>(threadPath(target), { signal: options?.signal })).data)
        }
        const { data } = await fetcher.json<GitHubIssue>(threadPath(target), { method: 'PATCH', json, signal: options?.signal })
        return toThread(target, data)
      }),
      addLabels: perKind({ issue: true, pull_request: true }, async (thread, labels, options) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        return toLabels((await fetcher.json<GitHubIssue['labels']>(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/labels`, { method: 'POST', json: { labels }, signal: options?.signal })).data)
      }),
      removeLabels: perKind({ issue: true, pull_request: true }, async (thread, labels, options) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        const path = `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/labels`
        let remaining: GitHubIssue['labels'] | undefined
        for (const label of labels) {
          try {
            remaining = (await fetcher.json<GitHubIssue['labels']>(`${path}/${encodeURIComponent(label)}`, { method: 'DELETE', signal: options?.signal })).data
          }
          catch (error) {
            if (!(error instanceof NotFoundError && error.body.includes('Label does not exist'))) {
              throw error
            }
          }
        }
        return toLabels(remaining ?? (await fetcher.json<GitHubIssue['labels']>(path, { query: { per_page: 100 }, signal: options?.signal })).data)
      }),
      setMilestone: perKind({ issue: true, pull_request: true }, async (thread, milestone, options) => toMilestone((await issuePatch(
        thread,
        { milestone: milestone === undefined ? null : await milestoneId(milestone, page => milestonesPage(requireThread(thread, context).repo, page), context, options) },
        'set the milestone of',
        options?.signal,
      )).milestone)),
      setIssueType: perKind({ issue: enterprise ? 'unverified' : true }, async (thread, issueType, options) => toIssueType((await issuePatch(
        thread,
        { type: typeof issueType === 'object' ? issueType.name : issueType ?? null },
        'set the type of',
        options?.signal,
      )).type)),
      reactions: perKind({ issue: true, pull_request: true, discussion: true }, { react, unreact }),
      locking: perKind({ issue: true, pull_request: true, discussion: true }, {
        lock: async (thread: ThreadRef, options: LockOptions = {}) => {
          const ref = requireThread(thread, context)
          if (ref.kind === 'discussion') {
            await graphql('LOCK_LOCKABLE', { id: await nodeId(ref, options) }, options)
            return
          }
          await fetcher.raw(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/lock`, {
            method: 'PUT',
            json: options.reason ? { lock_reason: LOCK_REASONS[options.reason] } : {},
            signal: options.signal,
          })
        },
        unlock: async (thread: ThreadRef, options?: BaseOptions) => {
          const ref = requireThread(thread, context)
          if (ref.kind === 'discussion') {
            await graphql('UNLOCK_LOCKABLE', { id: await nodeId(ref, options) }, options)
            return
          }
          await fetcher.raw(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/lock`, { method: 'DELETE', signal: options?.signal })
        },
      }),
      hiding: perKind({ issue: true, pull_request: true, discussion: true }, {
        hideComment: async (ref: CommentRef, reason: HideCommentReason, options?: BaseOptions) => {
          await graphql('MINIMIZE_COMMENT', { id: await commentNodeId(ref, options), classifier: reason.toUpperCase() }, options)
        },
        unhideComment: async (ref: CommentRef, options?: BaseOptions) => {
          await graphql('UNMINIMIZE_COMMENT', { id: await commentNodeId(ref, options) }, options)
        },
      }),
      reactionsPage: perKind({ issue: true, pull_request: true, discussion: !anonymous }, reactionsPage),
      transfer: verb(true, async (thread, repo, options) => {
        const ref = requireThread(thread, context)
        if (ref.kind !== 'issue') {
          throw new UnsupportedOperationError('GitHub transfers issues only', context)
        }
        const target = await graphql<{ repository: { id: string } | null }>('REPOSITORY_ID', { owner: repo.owner, name: repo.name }, options)
        if (!target.repository) {
          throw new NotFoundError(`Repository ${repo.owner}/${repo.name} not found`, 404, '', context)
        }
        const data = await graphql<{ transferIssue: { issue: { id: string, number: number } } }>('TRANSFER_ISSUE', { issue: await nodeId(ref, options), repo: target.repository.id }, options)
        return { forge: FORGE, instance, repo, kind: 'issue', number: String(data.transferIssue.issue.number), externalId: data.transferIssue.issue.id }
      }),
      markDuplicate: verb(true, async (thread, canonical, options) => {
        await graphql('MARK_DUPLICATE', { canonical: await nodeId(canonical, options), duplicate: await nodeId(thread, options) }, options)
      }),
      setLabels: perKind({ issue: true, pull_request: true }, async (thread, labels, options) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        return toLabels((await fetcher.json<GitHubIssue['labels']>(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/labels`, { method: 'PUT', json: { labels }, signal: options?.signal })).data)
      }),
      setAssignees: perKind({ issue: true, pull_request: true }, async (thread, assignees, options) => {
        const data = await issuePatch(thread, { assignees: assignees.map(actorLogin) }, 'assign', options?.signal)
        return (data.assignees ?? []).flatMap(user => toActor(instance, user) ?? [])
      }),
      requestReview: perKind({ pull_request: true }, async (thread, reviewers, options) => {
        const ref = requireThread(thread, context)
        if (ref.kind !== 'pull_request') {
          throw new UnsupportedOperationError('Only pull requests have reviewers', context)
        }
        const teams = reviewers.filter(reviewer => typeof reviewer !== 'string' && reviewer.typeRaw === 'Team').map(actorLogin)
        const users = reviewers.filter(reviewer => typeof reviewer === 'string' || reviewer.typeRaw !== 'Team').map(actorLogin)
        await fetcher.raw(`${threadPath(ref)}/requested_reviewers`, {
          method: 'POST',
          json: { reviewers: users, ...teams.length ? { team_reviewers: teams } : {} },
          signal: options?.signal,
        })
      }),
      close: perKind(ISSUE_LIKE, (ref, options_) => setState(ref, 'closed', options_)),
      reopen: perKind({ issue: true, pull_request: true, discussion: true }, (ref, options) => setState(ref, 'open', options)),
      merge: verb(true, merge),
      updateBranch: verb(true, updateBranch),
      closingIssuesPage: verb(!anonymous, async (thread, listOptions = {}) => closingPage(requirePull(thread, 'read for the issues they close'), 'CLOSING_ISSUES', listOptions)),
      closingPullRequestsPage: verb(!anonymous, async (thread, listOptions = {}) => {
        const ref = requireThread(thread, context)
        if (ref.kind !== 'issue') {
          throw new UnsupportedOperationError('Only issues are closed by pull requests', context)
        }
        return closingPage(ref, 'CLOSING_PULL_REQUESTS', listOptions)
      }),
      subscriptions: perKind(ISSUE_LIKE, {
        subscription: async (thread, options): Promise<SubscriptionState> => {
          const { state } = await subscriptionNode(thread, options)
          return state === 'SUBSCRIBED' ? 'subscribed' : state === 'IGNORED' ? 'ignored' : 'none'
        },
        subscribe: (thread, options) => setSubscription(thread, 'SUBSCRIBED', options),
        unsubscribe: (thread, options) => setSubscription(thread, 'UNSUBSCRIBED', options),
      }),
    },
  }
  return appItself ? supportOnly(spec, ['installations']) : spec
}

const GITHUB: ProviderDefinition<GitHubOptions, AppCredentials | undefined, true, GitHubExtensions> = {
  forge: FORGE,
  hasWeb: true,
  baseUrl: 'https://api.github.com',
  anonymous: true,
  instance: webHost,
  headers: { 'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  prepare: ({ options, baseUrl, headers, state }) => options.auth?.type === 'app'
    ? state ?? createAppCredentials(options.auth, { baseUrl, fetch: options.fetch, timeout: options.timeout, onRetry: options.onRetry, onRateLimit: options.onRateLimit, headers })
    : undefined,
  authHeaders: ({ options, state }) => createAuthHeaders(options.auth, state),
  webhooks: githubWebhooks,
  setup: setupGitHub,
}

/** Creates a GitHub provider for github.com or a GitHub Enterprise Server instance. */
export const github: ProviderFactoryFunction<GitHubOptions, true, 'github', GitHubProvider> = /* @__PURE__ */ defineForgeProvider(GITHUB)

/**
 * Token scopes and fine-grained permissions GitHub documents per endpoint
 * group. Classic scopes are the ones an OAuth consent screen asks for; the
 * permissions are the fine-grained token and app equivalents.
 */
export function githubScopesFor(verb: ForgeVerb): VerbScopes {
  const [group = '', name = ''] = verb.split('.')
  if (group === 'webhooks') {
    return name === 'verify' || name === 'ingest'
      ? {}
      : { token: ['admin:repo_hook', 'admin:org_hook'], permissions: { webhooks: 'admin' } }
  }
  if (group === 'notifications') {
    return { token: ['notifications'], note: 'Notifications need a classic personal access token or an OAuth app token; fine-grained tokens and GitHub Apps have no access to them' }
  }
  if (group === 'securityAlerts') {
    return {
      token: ['security_events', 'repo'],
      permissions: { vulnerability_alerts: 'read', secret_scanning_alerts: 'read', code_scanning_alerts: 'read', repository_advisories: 'read' },
      note: 'Drafts and private vulnerability reports need a security manager, an administrator, or a collaborator on the advisory',
    }
  }
  if (group === 'installations') {
    return { note: 'App credentials: an app JWT signed with the app private key' }
  }
  if (verb === 'users.block' || verb === 'users.unblock') {
    return { token: ['user'], permissions: { blocking: 'write' }, note: 'Needs a user token: a GitHub App installation cannot block for an account' }
  }
  if (verb === 'orgs.block' || verb === 'orgs.unblock') {
    return { token: ['admin:org'], permissions: { organization_user_blocking: 'write' } }
  }
  if (group === 'users' || group === 'search') {
    return { token: ['read:user'], permissions: {} }
  }
  if (group === 'orgs') {
    return { token: ['read:org'], permissions: { members: 'read' } }
  }
  if (group === 'ci' || (group === 'checks' && name !== 'report')) {
    return { token: ['repo'], permissions: { actions: 'read', checks: name === 'rerun' ? 'write' : 'read' } }
  }
  if (verb === 'checks.report') {
    return { token: ['repo:status'], permissions: { checks: 'write', statuses: 'write' } }
  }
  if (verb === 'threads.updateBranch') {
    return { token: ['repo', 'public_repo'], permissions: { pull_requests: 'write', contents: 'write' }, note: 'A GitHub App needs `contents: write` on the head repository' }
  }
  if (verb === 'repos.issueTypes') {
    return { token: ['repo'], permissions: { metadata: 'read' } }
  }
  if (verb === 'threads.setIssueType') {
    return { token: ['repo', 'public_repo'], permissions: { issues: 'write' }, note: 'Needs push access: without it, GitHub leaves the type unchanged' }
  }
  const write = WRITE_VERBS.has(verb)
  if (group === 'threads') {
    return { token: ['repo', 'public_repo'], permissions: { issues: write ? 'write' : 'read', pull_requests: write ? 'write' : 'read' } }
  }
  if (group === 'repos' || group === 'contents' || group === 'releases') {
    return { token: ['repo', 'public_repo'], permissions: { contents: write ? 'write' : 'read', metadata: 'read' } }
  }
  return {}
}
