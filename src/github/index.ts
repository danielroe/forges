import type { MergeHooks, ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type {
  Check,
  CheckReportInput,
  CheckState,
  CiRun,
  CiRunQuery,
  Comment,
  CommentRef,
  Commit,
  CommitQuery,
  CommitSearchQuery,
  Cursor,
  FileContent,
  FileOptions,
  ForgeEventInput,
  ForgeWarning,
  GetManyResult,
  Installation,
  ListOptions,
  MergeMethod,
  MergeOptions,
  Notification,
  NotificationListOptions,
  NotificationRef,
  Page,
  PageOptions,
  Reaction,
  ReactionContent,
  Release,
  Repo,
  RepoRef,
  RepoSearchQuery,
  ResolvedThreadRef,
  Review,
  ReviewEvent,
  ReviewInput,
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
} from '../model.ts'
import type {
  BulkNotificationOptions,
  CloseOptions,
  CloseReason,
  ForgeOptionsBase,
  ForgeProvider,
  InstallationsApi,
  MilestoneListOptions,
  VerbScopes,
} from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { AppCredentials, GitHubAuth } from './auth.ts'
import type {
  DiscussionCommentsResult,
  DiscussionThreadResult,
  GraphQLComment,
  GraphQLDiscussion,
  NodeReactionsResult,
  RecentDiscussionsResult,
  ReviewThreadsResult,
  ThreadsBatchResult,
} from './graphql.ts'
import type {
  GitHubAsyncMerge,
  GitHubBlob,
  GitHubBranch,
  GitHubCheckRun,
  GitHubCollaborator,
  GitHubCombinedStatus,
  GitHubComment,
  GitHubCommit,
  GitHubCommitSearchItem,
  GitHubCommitStatus,
  GitHubComparison,
  GitHubContentFile,
  GitHubHook,
  GitHubHookDelivery,
  GitHubInstallation,
  GitHubIssue,
  GitHubLabel,
  GitHubMilestone,
  GitHubNotification,
  GitHubReaction,
  GitHubRelease,
  GitHubRepositoryDetail,
  GitHubReview,
  GitHubReviewComment,
  GitHubTimelineEntry,
  GitHubTree,
  GitHubUserDetail,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
} from './types.ts'
import { fromBase64, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { ForbiddenError, ForgeApiError, ForgeError, ForgeTimeoutError, InsufficientScopeError, MergeBlockedError, NotFoundError, soleMergeMethod, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { sleep } from '../fetch.ts'
import { isNamespaceRef, isResolvedThread, reactionContent } from '../model.ts'
import { actorLogin, createListing, forgeIterable, getManyConcurrently, hostOf, iteratePages, memo, milestoneId, phased, requireIssueOrPull, requireThread, resolveToken, summariseChecks, toDate, toPage, toWarning, versionAtLeast } from '../utils.ts'
import { githubShapedWeb } from '../web.ts'
import { nativeEventsFor } from '../webhooks.ts'
import { createAppCredentials, createAuthHeaders } from './auth.ts'
import { createGraphQLClient, graphqlUrl } from './graphql-client.ts'
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
  toDependabotAlert,
  toEvent,
  toLabel,
  toMilestone,
  toNotification,
  toRelease,
  toRepo,
  toRepoRef,
  toReview,
  toReviewComment,
  toRole,
  toSecretScanningAlert,
  toStatusCheck,
  toTag,
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

export type { GitHubAuth } from './auth.ts'

export interface GitHubOptions extends ForgeOptionsBase {
  /** Defaults to `{ type: 'anonymous' }`: public reads only. */
  auth?: GitHubAuth
}

/** GitHub Enterprise Server versions that support marking a notification done. */
const GHES_MARK_DONE = '3.13'
/** GitHub Enterprise Server versions with the Dependabot alerts REST API. */
const GHES_DEPENDABOT_ALERTS = '3.8'
const GRAPHQL_BATCH = 20
const REVIEW_CONTEXT_TTL = 5 * 60_000
const POLL_DELAYS = [500, 1000, 2000]

const GITHUB_RESERVED_PATHS = ['about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise', 'enterprises', 'events', 'explore', 'features', 'gist', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'signup', 'site', 'sponsors', 'stars', 'topics', 'trending', 'users', 'watching']

const ISSUE_LIKE = { issue: true, pull_request: true, discussion: true } as const

function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

function threadPath(ref: ResolvedThreadRef): string {
  switch (ref.kind) {
    case 'pull_request':
      return `${repoPath(ref.repo)}/pulls/${encodeURIComponent(ref.number)}`
    case 'commit':
      return `${repoPath(ref.repo)}/commits/${encodeURIComponent(ref.number)}`
    default:
      return `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}`
  }
}

function isGheCom(host: string): boolean {
  return /^api\.[^.]+\.ghe\.com$/.test(host)
}

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

function setupGitHub({ options, baseUrl, instance, origin: context, fetcher, createFetcher, derive, state: credentials }: ProviderContext<GitHubOptions, AppCredentials | undefined>): ProviderSpec {
  const list = createListing(fetcher, 'per_page')
  const auth = options.auth ?? { type: 'anonymous' as const }
  /** GitHub GraphQL needs a credential, so anonymous providers stay on REST. */
  const anonymous = auth.type === 'anonymous'
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

  async function notificationPage(listOptions: NotificationListOptions = {}): Promise<Page<Notification>> {
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
    }
  }

  async function discussionId(ref: ResolvedThreadRef): Promise<string> {
    if (ref.externalId) {
      return ref.externalId
    }
    return (await getDiscussion(ref)).ref.externalId!
  }

  async function getDiscussion(ref: ResolvedThreadRef): Promise<Thread> {
    const data = await graphql<DiscussionThreadResult>('DISCUSSION_THREAD', {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: Number(ref.number),
    })
    const discussion = data.repository?.discussion
    if (!discussion) {
      throw new NotFoundError(`Discussion ${ref.number} not found`, 404, '', context)
    }
    return (await import('./graphql.ts')).toDiscussionThread(ref, discussion)
  }

  async function discussionCommentPage(ref: ResolvedThreadRef, cursor?: Cursor): Promise<Page<{ comment: GraphQLComment, isReply: boolean }>> {
    const data: DiscussionCommentsResult = await graphql<DiscussionCommentsResult>('DISCUSSION_COMMENTS', {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: Number(ref.number),
      after: cursor?.token ?? null,
    })
    const comments = data.repository?.discussion?.comments
    return {
      items: (comments?.nodes ?? []).flatMap(comment => [{ comment, isReply: false }, ...(comment.replies?.nodes ?? []).map(reply => ({ comment: reply, isReply: true }))]),
      cursor: comments?.pageInfo.hasNextPage && comments.pageInfo.endCursor ? { token: comments.pageInfo.endCursor } : undefined,
    }
  }

  async function get(thread: ThreadRef): Promise<Thread> {
    const ref = requireThread(thread, context)
    if (ref.kind === 'discussion') {
      return getDiscussion(ref)
    }
    const { data } = await fetcher.json<GitHubIssue>(threadPath(ref))
    const result = toThread(ref, data)
    if (ref.kind === 'pull_request' && data.head?.sha) {
      try {
        const checks = await headChecks(ref.repo, data.head.sha)
        result.checks = summariseChecks(checks.items.map(check => check.state), data.html_url ? `${data.html_url}/checks` : undefined)
        if (checks.warnings?.length) {
          result.warnings = [...result.warnings ?? [], ...checks.warnings]
        }
      }
      catch (error) {
        if (!(error instanceof ForgeError)) {
          throw error
        }
        result.warnings = [...result.warnings ?? [], toWarning('checks_unreadable', error, ref.number)]
      }
    }
    return result
  }

  async function headChecks(repo: RepoRef, sha: string): Promise<Page<Check>> {
    const [runs, status] = await Promise.allSettled([
      Array.fromAsync(fetcher.items<GitHubCheckRun>(`${repoPath(repo)}/commits/${sha}/check-runs`, {
        query: { per_page: 100 },
        select: (body, next) => ({ items: (body as { check_runs: GitHubCheckRun[] }).check_runs, next }),
      }), raw => toCheckRun(repo, raw)),
      fetcher.json<GitHubCombinedStatus>(`${repoPath(repo)}/commits/${sha}/status`, { query: { per_page: 100 } }),
    ])
    if (runs.status === 'rejected' && status.status === 'rejected') {
      throw runs.reason
    }
    return {
      items: [
        ...runs.status === 'fulfilled' ? runs.value : [],
        ...status.status === 'fulfilled' ? status.value.data.statuses.map(raw => toStatusCheck(repo, raw)) : [],
      ],
      warnings: [
        ...runs.status === 'rejected' ? [toWarning('checks_unreadable', runs.reason, 'check-runs')] : [],
        ...status.status === 'rejected' ? [toWarning('checks_unreadable', status.reason, 'statuses')] : [],
      ],
    }
  }

  async function getMany(refs: ThreadRef[]): Promise<GetManyResult[]> {
    if (anonymous) {
      return getManyConcurrently(refs, get)
    }
    const results: GetManyResult[] = Array.from({ length: refs.length })
    const batchable: Array<{ index: number, ref: ResolvedThreadRef }> = []
    const commits: number[] = []
    for (const [index, ref] of refs.entries()) {
      if (!isResolvedThread(ref) || ref.kind === 'other') {
        results[index] = { ok: false, ref, warning: toWarning('thread_unresolved', new Error('Thread ref has no number'), ref.number) }
      }
      else if (ref.kind === 'commit') {
        commits.push(index)
      }
      else {
        batchable.push({ index, ref })
      }
    }
    const read = await getManyConcurrently(commits.map(index => refs[index]!), get)
    commits.forEach((index, position) => {
      results[index] = read[position]!
    })
    if (!batchable.length) {
      return results
    }
    const g = await import('./graphql.ts')
    for (let start = 0; start < batchable.length; start += GRAPHQL_BATCH) {
      const chunk = batchable.slice(start, start + GRAPHQL_BATCH)
      const { query, variables } = g.threadsBatchQuery(chunk.map(item => item.ref))
      const { data } = await fetcher.json<{ data?: ThreadsBatchResult, errors?: Array<{ message: string, path?: Array<string | number> }> }>(graphqlUrl(baseUrl), {
        method: 'POST',
        json: { query, variables, operationName: 'ThreadsBatch' },
      })
      chunk.forEach(({ index, ref }, offset) => {
        const node = data.data?.[`t${offset}`]
        const discussion = ref.kind === 'discussion' ? node?.discussion : undefined
        const issueOrPullRequest = ref.kind === 'discussion' ? undefined : node?.issueOrPullRequest
        if (!discussion && !issueOrPullRequest) {
          const message = data.errors?.find(error => error.path?.[0] === `t${offset}`)?.message ?? 'Not found'
          results[index] = { ok: false, ref, warning: { code: 'thread_unreadable', message, subject: ref.number } }
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
      const warnings: ForgeWarning[] = !query.cursor && query.sort === 'comments'
        ? [{ code: 'sort_unsupported', message: 'Discussions cannot be sorted by comments; sorted by update time' }]
        : []
      const data: { repository: { discussions: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: GraphQLDiscussion[] } } | null } = await graphql('DISCUSSIONS_LIST', {
        owner: repo.owner,
        name: repo.name,
        first: Math.min(query.perPage ?? 50, 100),
        after: query.cursor?.token ?? null,
        field: query.sort === 'created' || !query.sort ? 'CREATED_AT' : 'UPDATED_AT',
        direction: direction.toUpperCase(),
      })
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
        queryRaw: `is:merged${query.createdAfter ? ` created:>=${query.createdAfter.toISOString()}` : ''}`,
        sort: query.sort ?? 'created',
        direction,
        perPage: query.perPage,
        cursor: query.cursor,
        signal: query.signal,
      })
      await withPullChecks(page)
      return page
    }
    // `/pulls` returns full pages but has no label, author, assignee or since filter.
    const pullsOnly = query.kind === 'pull_request' && !query.labels?.length && !query.author && !query.assignee && !query.since && query.sort !== 'comments'
    const result = await fetcher.page<GitHubIssue>(`${repoPath(repo)}/${pullsOnly ? 'pulls' : 'issues'}`, {
      query: {
        state,
        labels: query.labels?.join(','),
        creator: query.author,
        assignee: query.assignee,
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
    await withPullChecks(page)
    return ordered && (result.data ?? []).some(older) ? { ...page, cursor: undefined } : page
  }

  /** Fills `checks`, and a missing `commentCount`, on every pull in the page with one batched read. */
  async function withPullChecks(page: Page<Thread>): Promise<void> {
    const pulls = page.items.filter(thread => thread.kind === 'pull_request')
    if (!pulls.length || anonymous) {
      return
    }
    try {
      const results = await getMany(pulls.map(thread => thread.ref))
      for (const [index, result] of results.entries()) {
        if (result.ok) {
          pulls[index]!.checks = result.thread.checks ?? pulls[index]!.checks
          pulls[index]!.commentCount ??= result.thread.commentCount
        }
      }
    }
    catch (error) {
      if (!(error instanceof ForgeError)) {
        throw error
      }
      page.warnings = [...page.warnings ?? [], toWarning('checks_unreadable', error)]
    }
  }

  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireThread(thread, context)
    if (ref.kind === 'discussion') {
      const [page, { toDiscussionComment }] = await Promise.all([discussionCommentPage(ref, listOptions.cursor), import('./graphql.ts')])
      return { ...page, items: page.items.map(({ comment }) => toDiscussionComment(ref, comment)) }
    }
    const path = ref.kind === 'commit'
      ? `${repoPath(ref.repo)}/commits/${encodeURIComponent(ref.number)}/comments`
      : `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/comments`
    return list(path, listOptions, (raw: GitHubComment) => toComment(ref, raw))
  }

  function commentPath(ref: CommentRef): string {
    return ref.thread.kind === 'commit'
      ? `${repoPath(ref.thread.repo)}/comments/${encodeURIComponent(ref.id)}`
      : `${repoPath(ref.thread.repo)}/issues/comments/${encodeURIComponent(ref.id)}`
  }

  async function setState(thread: ThreadRef, state: 'open' | 'closed', options_: CloseOptions = {}): Promise<void> {
    const ref = requireThread(thread, context)
    if (ref.kind === 'commit') {
      throw new UnsupportedOperationError('Commits have no open or closed state', context)
    }
    if (ref.kind === 'discussion') {
      const reason = options_.reasonRaw ?? (options_.reason && DISCUSSION_CLOSE_REASONS[options_.reason])
      if (state === 'closed' && options_.reason && !reason) {
        throw new UnsupportedOperationError(`GitHub discussions have no ${options_.reason} close reason; pass reasonRaw: 'outdated'`, context)
      }
      const id = await discussionId(ref)
      await (state === 'closed'
        ? graphql('CLOSE_DISCUSSION', { id, reason: reason?.toUpperCase() ?? null })
        : graphql('REOPEN_DISCUSSION', { id }))
      return
    }
    const reason = options_.reasonRaw ?? options_.reason
    await fetcher.raw(threadPath(ref), {
      method: 'PATCH',
      json: ref.kind === 'issue' && state === 'closed' && reason ? { state, state_reason: reason } : { state },
    })
  }

  async function merge(thread: ThreadRef, options_: MergeOptions = {}, hooks: MergeHooks = {}): Promise<void> {
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
      }>(repoPath(ref.repo))
      method = soleMergeMethod({ merge: repo.allow_merge_commit, squash: repo.allow_squash_merge, rebase: repo.allow_rebase_merge }, context)
    }
    await hooks.beforeMerge?.()
    await directMerge(ref, method, options_)
  }

  async function directMerge(ref: ResolvedThreadRef, method: MergeMethod, mergeOptions: MergeOptions): Promise<void> {
    const path = `${threadPath(ref)}/merge`
    const { sha, message } = mergeOptions
    const body = { merge_method: method, sha, commit_message: message }
    const timeout = options.timeout ?? 30_000
    const budget = new AbortController()
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
        const { data, response } = await fetcher.json<GitHubAsyncMerge>(`${path}-async`, { method: 'PUT', json: { ...body, merge_action: 'direct_merge' }, signal: budget.signal })
        state = data
        status = response.status
      }
      catch (error) {
        if (budget.signal.aborted) {
          throw error
        }
        if (enterprise && error instanceof NotFoundError) {
          url = fetcher.resolve(path)
          await fetcher.raw(path, { method: 'PUT', json: body, mapError: toMergeError, signal: budget.signal })
          return
        }
        state = pendingMergeFrom(error, method, sha, message)
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
        await sleep(POLL_DELAYS[Math.min(attempt, POLL_DELAYS.length - 1)]!, budget.signal)
        const { data, response } = await fetcher.json<GitHubAsyncMerge>(poll, { signal: budget.signal })
        state = data
        status = response.status
      }
      const errorContext = { ...context, url, method: requestMethod }
      const excerpt = JSON.stringify(state).slice(0, 512)
      switch (state.status as string) {
        case 'merged':
          return
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

  function pendingMergeFrom(error: unknown, method: MergeMethod, sha: string | undefined, message: string | undefined): GitHubAsyncMerge {
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
    if (message !== undefined || details.merge_action !== 'direct_merge' || details.merge_method !== method || details.bypass_rules || (sha !== undefined && details.expected_head_sha !== sha)) {
      throw new MergeBlockedError('Another merge request is pending whose options do not match or cannot be verified', 409, error.body, { ...context, url: error.url, method: error.method }, { cause: error })
    }
    return { status: 'pending', details }
  }

  function isPlainApiError(error: unknown, status: number): boolean {
    return error instanceof ForgeApiError && error.constructor === ForgeApiError && error.status === status
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
  async function reviewThreadsByComment(ref: ResolvedThreadRef): Promise<Map<string, { id: string, resolved: boolean }>> {
    const byComment = new Map<string, { id: string, resolved: boolean }>()
    if (anonymous) {
      return byComment
    }
    let data: ReviewThreadsResult
    try {
      data = await graphql<ReviewThreadsResult>('REVIEW_THREADS', { owner: ref.repo.owner, name: ref.repo.name, number: Number(ref.number) })
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
    })
    const now = Date.now()
    for (const [path, entry] of reviewContext) {
      if (now - entry.at >= REVIEW_CONTEXT_TTL) {
        reviewContext.delete(path)
      }
    }
    const key = threadPath(ref)
    const kept = (listOptions.cursor && reviewContext.get(key)) || {
      at: now,
      read: Promise.all([
        Array.fromAsync(fetcher.items<GitHubReviewComment>(`${key}/comments`, { query: { per_page: 100 } })),
        reviewThreadsByComment(ref),
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

  async function createReview(thread: ThreadRef, input: ReviewInput): Promise<Review> {
    const ref = requirePull(thread, 'reviewed')
    const { data } = await fetcher.json<GitHubReview>(`${threadPath(ref)}/reviews`, {
      method: 'POST',
      json: {
        event: input.event ? REVIEW_EVENTS[input.event] : undefined,
        body: input.body,
        comments: reviewCommentInput(input.comments),
      },
    })
    return toReview(ref, data, [])
  }

  async function subscriptionNode(thread: ThreadRef): Promise<{ id: string, state: string }> {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'issue' && ref.kind !== 'pull_request' && ref.kind !== 'discussion') {
      throw new UnsupportedOperationError(`GitHub has no subscription for a ${ref.kind}`, context)
    }
    const data = await graphql<{ repository: { issueOrPullRequest?: { id: string, viewerSubscription: string } | null, discussion?: { id: string, viewerSubscription: string } | null } | null }>('SUBSCRIPTION_STATE', {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: Number(ref.number),
      discussion: ref.kind === 'discussion',
    })
    const node = ref.kind === 'discussion' ? data.repository?.discussion : data.repository?.issueOrPullRequest
    if (!node) {
      throw new NotFoundError(`Thread ${ref.number} not found`, 404, '', context)
    }
    return { id: node.id, state: node.viewerSubscription }
  }

  async function setSubscription(thread: ThreadRef, state: 'SUBSCRIBED' | 'UNSUBSCRIBED'): Promise<void> {
    const { id } = await subscriptionNode(thread)
    await graphql('UPDATE_SUBSCRIPTION', { id, state })
  }

  async function reposPage(repoFetcher: typeof fetcher, path: string, wrapped: boolean, listOptions: { perPage?: number, cursor?: Cursor, signal?: AbortSignal } = {}): Promise<Page<Repo>> {
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
    if (!query.kind && (enterprise || (auth.type === 'token' && (await resolveToken(auth)).startsWith('ghu_')))) {
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
      select: (body, next) => ({ items: (body as { items: GitHubIssue[] }).items, next }),
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
      select: (body, next) => ({ items: (body as { items: GitHubRepositoryDetail[] }).items, next }),
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
      select: (body, next) => ({ items: (body as { items: GitHubCommitSearchItem[] }).items, next }),
    })
    return toPage(result, (raw) => {
      const repo = query.repo ?? (raw.repository && toRepoRef(instance, raw.repository))
      return repo && toCommit(repo, raw)
    })
  }

  function createInstallationsApi(app: AppCredentials): Omit<InstallationsApi, 'list' | 'repos'> {
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
      async get(installation) {
        return toInstallation((await appFetcher.json<GitHubInstallation>(`/app/installations/${installationId(installation)}`)).data)
      },
      token: installation => app.installationTokenDetails(installationId(installation)),
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

  async function commitsPage(repo: RepoRef, query: CommitQuery = {}): Promise<Page<Commit>> {
    return list(`${repoPath(repo)}/commits`, query, (raw: GitHubCommit) => toCommit(repo, raw), { query: { sha: query.ref, path: query.path, author: query.author, since: query.since?.toISOString(), until: query.until?.toISOString() } })
  }

  async function releasesPage(repo: RepoRef, listOptions: PageOptions = {}): Promise<Page<Release>> {
    return list(`${repoPath(repo)}/releases`, listOptions, (raw: GitHubRelease) => toRelease(repo, raw))
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
  } as const

  async function alertsPage(repo: RepoRef, listOptions: SecurityAlertListOptions = {}): Promise<Page<SecurityAlert>> {
    const kinds = listOptions.kind ? [listOptions.kind] : Object.keys(ALERT_SOURCES) as Array<keyof typeof ALERT_SOURCES>
    return phased(kinds.map(kind => async (cursor?: Cursor): Promise<Page<SecurityAlert>> => {
      const source = ALERT_SOURCES[kind as keyof typeof ALERT_SOURCES]
      const state = listOptions.state ?? 'open'
      try {
        const result = await fetcher.page<never>(`${repoPath(repo)}/${source.path}`, {
          query: { state: state === 'all' ? undefined : source.states[state], per_page: listOptions.perPage },
          cursor,
          signal: listOptions.signal,
        })
        return toPage(result, raw => source.map(repo, raw))
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
  async function nodeId(thread: ThreadRef): Promise<string> {
    const ref = requireThread(thread, context)
    return ref.externalId ?? (await subscriptionNode(ref)).id
  }

  function reactionPath(target: ThreadRef | CommentRef): string {
    if ('thread' in target) {
      return target.thread.kind === 'commit'
        ? `${repoPath(target.thread.repo)}/comments/${encodeURIComponent(target.id)}/reactions`
        : `${repoPath(target.thread.repo)}/issues/comments/${encodeURIComponent(target.id)}/reactions`
    }
    const ref = requireIssueOrPull(target, context, 'react to')
    return `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/reactions`
  }

  /** The authenticated login, read once and reused; reactions are deleted by id, so removing one needs it. */
  const viewerLogin = memo(async () => (await fetcher.json<GitHubUserDetail>('/user')).data.login)

  async function reactionsPage(target: ThreadRef | CommentRef, listOptions: ListOptions = {}): Promise<Page<Reaction>> {
    const thread = 'thread' in target ? target.thread : target
    if (thread.kind === 'discussion') {
      const id = 'thread' in target ? target.id : await nodeId(thread)
      const [data, { toGraphQLActor, GRAPHQL_REACTIONS }] = await Promise.all([graphql<NodeReactionsResult>('NODE_REACTIONS', { id, after: listOptions.cursor?.token ?? null }), import('./graphql.ts')])
      const reactions = data.node?.reactions
      return {
        items: (reactions?.nodes ?? []).flatMap((raw) => {
          const actor = toGraphQLActor(instance, raw.user)
          return actor ? [{ content: reactionContent(GRAPHQL_REACTIONS[raw.content] ?? raw.content), contentRaw: raw.content, actor, createdAt: toDate(raw.createdAt), raw }] : []
        }),
        cursor: reactions?.pageInfo.hasNextPage && reactions.pageInfo.endCursor ? { token: reactions.pageInfo.endCursor } : undefined,
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

  async function react(target: ThreadRef | CommentRef, reaction: ReactionContent): Promise<void> {
    const thread = 'thread' in target ? target.thread : target
    if (thread.kind === 'discussion') {
      await graphql('ADD_REACTION', { id: 'thread' in target ? target.id : await nodeId(thread), content: (await import('./graphql.ts')).REACTION_CONTENT[reaction] })
      return
    }
    await fetcher.raw(reactionPath(target), { method: 'POST', json: { content: reaction } })
  }

  async function unreact(target: ThreadRef | CommentRef, reaction: ReactionContent): Promise<void> {
    const thread = 'thread' in target ? target.thread : target
    if (thread.kind === 'discussion') {
      await graphql('REMOVE_REACTION', { id: 'thread' in target ? target.id : await nodeId(thread), content: (await import('./graphql.ts')).REACTION_CONTENT[reaction] })
      return
    }
    const path = reactionPath(target)
    const { data } = await fetcher.json<GitHubReaction[]>(path, { query: { content: reaction, per_page: 100 } })
    const login = await viewerLogin()
    const mine = data.find(item => item.content === reaction && item.user?.login === login)
    if (mine) {
      await fetcher.raw(`${path}/${encodeURIComponent(mine.id)}`, { method: 'DELETE' })
    }
  }

  async function issuePatch(thread: ThreadRef, json: Record<string, unknown>, action: string): Promise<void> {
    const ref = requireIssueOrPull(thread, context, action)
    await fetcher.raw(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}`, { method: 'PATCH', json })
  }

  /** Check runs need an installation credential; a token writes a commit status instead. */
  const canWriteCheckRuns = auth.type === 'app' && auth.installationId !== undefined

  const STATUS_STATES: Record<CheckState, string> = { pending: 'pending', success: 'success', failure: 'failure', neutral: 'success', unknown: 'pending' }
  const CHECK_RUN_CONCLUSIONS: Partial<Record<CheckState, string>> = { success: 'success', failure: 'failure', neutral: 'neutral' }

  async function report(repo: RepoRef, sha: string, input: CheckReportInput): Promise<Check> {
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
      })
      return toCheckRun(repo, data)
    }
    const { data } = await fetcher.json<GitHubCommitStatus>(`${repoPath(repo)}/statuses/${sha}`, {
      method: 'POST',
      json: { state: STATUS_STATES[input.state], context: input.name, description: input.description, target_url: input.url },
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
      select: (body, next) => ({ items: (body as { workflow_runs: GitHubWorkflowRun[] }).workflow_runs, next }),
    })
    return toPage(result, raw => toWorkflowRun(repo, raw))
  }

  return {
    checks: {
      list: verb(true, (repo, sha) => headChecks(repo, sha)),
      report: verb(true, report),
      rerun: verb(true, async (ref) => {
        if (ref.type !== 'check_run') {
          throw new UnsupportedOperationError(`GitHub cannot re-run a ${ref.type}; only check runs can be re-requested`, context)
        }
        await fetcher.raw(`${repoPath(ref.repo)}/check-runs/${encodeURIComponent(ref.id)}/rerequest`, { method: 'POST' })
      }),
    },
    ci: {
      runsPage: verb(true, runsPage),
      run: verb(true, async ref => toWorkflowRun(ref.repo, (await fetcher.json<GitHubWorkflowRun>(`${repoPath(ref.repo)}/actions/runs/${encodeURIComponent(ref.id)}`)).data)),
      jobsPage: verb(true, (ref, listOptions = {}) => list(`${repoPath(ref.repo)}/actions/runs/${encodeURIComponent(ref.id)}/jobs`, listOptions, (raw: GitHubWorkflowJob) => toWorkflowJob(ref, raw), { select: (body, next) => ({ items: (body as { jobs: GitHubWorkflowJob[] }).jobs, next }) })),
      log: verb(!anonymous, async ref => (await fetcher.stream(`${repoPath(ref.repo)}/actions/jobs/${encodeURIComponent(ref.id)}/logs`)).body),
    },
    contents: {
      file: verb(true, readFile),
      treePage: verb(true, treePage),
      branchesPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/branches`, listOptions, (raw: GitHubBranch) => toBranch(raw))),
      tagsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/tags`, listOptions, toTag)),
      resolveRef: verb(true, async (repo, ref) => (await fetcher.json<GitHubCommit>(`${repoPath(repo)}/commits/${encodeURIComponent(ref)}`)).data.sha),
      commitsPage: verb(true, commitsPage),
      commit: verb(true, async (repo, sha) => toCommit(repo, (await fetcher.json<GitHubCommit>(`${repoPath(repo)}/commits/${sha}`)).data)),
      compare: verb(true, async (repo, base, head) => {
        const { data } = await fetcher.json<GitHubComparison>(`${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
        return {
          base,
          head,
          aheadBy: data.ahead_by,
          behindBy: data.behind_by,
          mergeBaseSha: data.merge_base_commit?.sha,
          commits: (data.commits ?? []).map(raw => toCommit(repo, raw)),
          files: (data.files ?? []).map(toChangedFile),
          raw: data,
        }
      }),
    },
    search: {
      threadsPage: verb(true, searchThreadsPage),
      reposPage: verb(true, searchReposPage),
      commitsPage: verb(true, searchCommitsPage),
      queryRaw: true,
    },
    releases: {
      listPage: verb(true, releasesPage),
      get: verb(true, async ref => toRelease(ref.repo, (await fetcher.json<GitHubRelease>(`${repoPath(ref.repo)}/releases/${encodeURIComponent(ref.id)}`)).data)),
      getByTag: verb(true, async (repo, tag) => toRelease(repo, (await fetcher.json<GitHubRelease>(`${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`)).data)),
      downloadAsset: verb(true, async (ref, downloadOptions = {}) => (await fetcher.stream(`${repoPath(ref.repo)}/releases/assets/${encodeURIComponent(ref.id)}`, {
        headers: { accept: 'application/octet-stream' },
        signal: downloadOptions.signal,
      })).body),
      latest: verb(true, async (repo) => {
        try {
          return toRelease(repo, (await fetcher.json<GitHubRelease>(`${repoPath(repo)}/releases/latest`)).data)
        }
        catch (error) {
          if (error instanceof NotFoundError) {
            return undefined
          }
          throw error
        }
      }),
    },
    securityAlerts: {
      kinds: {
        dependency: enterprise ? ({ version }) => versionAtLeast(version, GHES_DEPENDABOT_ALERTS) && 'experimental' : 'experimental',
        code_scanning: 'experimental',
        secret: 'experimental',
      },
      listPage: alertsPage,
    },
    traits: { poll: true, eventKinds: 'native', authKinds: ['token', 'app', 'anonymous'], limits: { bodyLength: 65536, commentLength: 65536, labelLength: 50 } },
    probeVersion: enterprise ? async () => (await fetcher.json<{ installed_version?: string }>('/meta')).data.installed_version : undefined,
    installations: credentials ? verb(true, createInstallationsApi(credentials)) : undefined,
    web: githubShapedWeb(enterprise ? baseUrl.replace(/\/api\/v3$/, '') : `https://${webHost(host)}`, { pull: 'pull', discussions: true, commentFragment: 'issuecomment-', file: at => `/blob/${encodeURIComponent(at)}`, lineFragment: line => `L${line}`, reserved: GITHUB_RESERVED_PATHS }),
    webhooks: {
      listPage: verb(true, (target, listOptions = {}) => list(hooksPath(target), listOptions, (raw: GitHubHook) => toWebhook(target, raw), { mapError: scopeIs404 })),
      create: verb(true, async (target, input) => toWebhook(target, (await fetcher.json<GitHubHook>(hooksPath(target), {
        method: 'POST',
        json: {
          name: 'web',
          active: input.active ?? true,
          events: nativeEventsFor(GITHUB_NATIVE_EVENTS, input.events, input.nativeEvents),
          config: hookConfig(input),
        },
        mapError: scopeIs404,
      })).data)),
      update: verb(true, async (ref, update) => toWebhook(ref.target, (await fetcher.json<GitHubHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, {
        method: 'PATCH',
        json: {
          ...update.active === undefined ? {} : { active: update.active },
          ...update.events || update.nativeEvents ? { events: nativeEventsFor(GITHUB_NATIVE_EVENTS, update.events, update.nativeEvents) } : {},
          ...update.url || update.secret || update.contentType ? { config: hookConfig(update) } : {},
        },
        mapError: scopeIs404,
      })).data)),
      delete: verb(true, async (ref) => {
        await fetcher.raw(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, { method: 'DELETE', mapError: scopeIs404 })
      }),
      rotateSecret: verb('experimental', async (ref, secret) => {
        const current = toWebhook(ref.target, (await fetcher.json<GitHubHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, { mapError: scopeIs404 })).data)
        const { data } = await fetcher.json<GitHubHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, {
          method: 'PATCH',
          json: { config: hookConfig({ url: current.url, contentType: current.contentType, secret }) },
          mapError: scopeIs404,
        })
        return toWebhook(ref.target, data)
      }),
      deliveriesPage: verb(true, (ref, listOptions = {}) => list(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}/deliveries`, listOptions, (raw: GitHubHookDelivery) => toWebhookDelivery(ref, raw), { mapError: scopeIs404 })),
      redeliver: verb(true, async (ref) => {
        await fetcher.raw(`${hooksPath(ref.hook.target)}/${encodeURIComponent(ref.hook.id)}/deliveries/${encodeURIComponent(ref.id)}/attempts`, { method: 'POST', mapError: scopeIs404 })
      }),
    },
    scopes: githubScopesFor,
    users: {
      get: verb(true, async login => toUser(instance, (await fetcher.json<GitHubUserDetail>(`/users/${encodeURIComponent(login)}`)).data)),
      me: verb(auth.type === 'token', async () => toUser(instance, (await fetcher.json<GitHubUserDetail>('/user')).data)),
    },
    repos: {
      get: verb(true, async (ref) => {
        return toRepo(instance, (await fetcher.json<GitHubRepositoryDetail>(repoPath(ref))).data)
      }),
      listPage: verb(auth.type === 'token' || (auth.type === 'app' && auth.installationId !== undefined), async (listOptions = {}) => {
        if (auth.type === 'app') {
          if (auth.installationId === undefined) {
            throw new UnsupportedOperationError('An app without an installation has no repositories; use installations.repos()', context)
          }
          return reposPage(fetcher, '/installation/repositories', true, listOptions)
        }
        return reposPage(fetcher, '/user/repos', false, listOptions)
      }),
      labelsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/labels`, listOptions, toLabel)),
      createLabel: verb('experimental', async (repo, label) => toLabel((await fetcher.json<GitHubLabel>(`${repoPath(repo)}/labels`, {
        method: 'POST',
        json: { name: label.name, color: label.colour, description: label.description },
      })).data)),
      milestonesPage: verb(true, milestonesPage),
      collaboratorsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/collaborators`, listOptions, (raw: GitHubCollaborator) => toCollaborator(instance, raw))),
      permissionFor: verb(true, async (repo, actor) => {
        const { data } = await fetcher.json<{ permission?: string, role_name?: string, user?: GitHubCollaborator }>(
          `${repoPath(repo)}/collaborators/${encodeURIComponent(actorLogin(actor))}/permission`,
        )
        return toRole({ role_name: data.role_name ?? (data.permission === 'none' ? undefined : data.permission), permissions: data.user?.permissions })
      }),
      addCollaborator: verb('experimental', async (repo, actor, role) => {
        await fetcher.raw(`${repoPath(repo)}/collaborators/${encodeURIComponent(actorLogin(actor))}`, { method: 'PUT', json: { permission: role } })
      }),
      assignableUsersPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/assignees`, listOptions, (raw: GitHubUserDetail) => toActor(instance, raw)!)),
      reviewerCandidatesPage: verb('emulated', async (thread, listOptions = {}) => {
        const ref = requireThread(thread, context)
        const page = await fetcher.page<GitHubCollaborator>(`${repoPath(ref.repo)}/collaborators`, {
          query: { per_page: listOptions.perPage },
          cursor: listOptions.cursor,
          signal: listOptions.signal,
        })
        const author = (await get(ref)).author?.login
        return toPage(page, raw => raw.login === author ? undefined : toActor(instance, raw)!)
      }),
    },
    notifications: {
      listPage: verb(true, notificationPage),
      markRead: verb(true, async (ref: NotificationRef) => {
        await fetcher.raw(`/notifications/threads/${encodeURIComponent(ref.id)}`, { method: 'PATCH' })
      }),
      markDone: verb(enterprise ? ({ version }) => versionAtLeast(version, GHES_MARK_DONE) : true, async (ref: NotificationRef) => {
        await fetcher.raw(`/notifications/threads/${encodeURIComponent(ref.id)}`, { method: 'DELETE' })
      }),
      unsubscribe: verb(true, async (ref: NotificationRef) => {
        await fetcher.raw(`/notifications/threads/${encodeURIComponent(ref.id)}/subscription`, { method: 'DELETE' })
      }),
      markAllRead: verb(true, async (bulk: BulkNotificationOptions = {}) => {
        await fetcher.raw(bulk.repo ? `${repoPath(bulk.repo)}/notifications` : '/notifications', {
          method: 'PUT',
          ...bulk.before ? { json: { last_read_at: bulk.before.toISOString() } } : {},
        })
      }),
    },
    threads: {
      get: perKind({ issue: true, pull_request: true, discussion: !anonymous, commit: 'experimental' }, get),
      getMany: verb(true, getMany),
      listPage: perKind({ ...ISSUE_LIKE, discussion: !anonymous }, listPage),
      eventsPage: verb(true, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> => {
        const ref = requireThread(thread, context)
        if (ref.kind === 'discussion') {
          const [page, { toDiscussionCommentEvent }] = await Promise.all([discussionCommentPage(ref, listOptions.cursor), import('./graphql.ts')])
          return { ...page, items: page.items.map(({ comment, isReply }) => toDiscussionCommentEvent(ref, comment, isReply)) }
        }
        if (ref.kind === 'commit') {
          return list(`${repoPath(ref.repo)}/commits/${encodeURIComponent(ref.number)}/comments`, listOptions, (comment: GitHubTimelineEntry) => toEvent(instance, ref, { ...comment, event: 'commented' }))
        }
        return list(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/timeline`, listOptions, (entry: GitHubTimelineEntry) => toEvent(instance, ref, entry))
      }),
      commentsPage: perKind({ issue: true, pull_request: true, discussion: !anonymous, commit: 'experimental' }, commentsPage),
      reviewsPage: verb(true, reviewsPage),
      filesPage: verb(true, (ref, listOptions = {}) => list(`${threadPath(requirePull(ref, 'read for changed files'))}/files`, listOptions, toChangedFile)),
      commitsPage: verb(true, (ref, listOptions = {}) => list(`${threadPath(requirePull(ref, 'read for commits'))}/commits`, listOptions, (raw: GitHubCommit) => toCommit(ref.repo, raw))),
      createReview: verb(true, createReview),
      submitReview: verb(true, async (ref, event, body) => {
        const pull = requirePull(ref.thread, 'reviewed')
        const { data } = await fetcher.json<GitHubReview>(`${threadPath(pull)}/reviews/${encodeURIComponent(ref.id)}/events`, {
          method: 'POST',
          json: { event: REVIEW_EVENTS[event], body },
        })
        return toReview(pull, data, [])
      }),
      reviewThreads: verb(true, {
        resolveReviewThread: async (_ref, id) => {
          await graphql('RESOLVE_REVIEW_THREAD', { id })
        },
        unresolveReviewThread: async (_ref, id) => {
          await graphql('UNRESOLVE_REVIEW_THREAD', { id })
        },
      }),
      checks: perKind({ pull_request: true }, async (thread) => {
        const ref = requireThread(thread, context)
        const { data } = await fetcher.json<GitHubIssue>(threadPath(ref))
        return data.head?.sha ? headChecks(ref.repo, data.head.sha) : { items: [] }
      }),
      comment: perKind({ issue: 'experimental', pull_request: true, discussion: true, commit: 'experimental' }, async (thread, body) => {
        const ref = requireThread(thread, context)
        if (ref.kind === 'discussion') {
          const data = await graphql<{ addDiscussionComment: { comment: GraphQLComment } }>('ADD_DISCUSSION_COMMENT', { id: await discussionId(ref), body })
          return (await import('./graphql.ts')).toDiscussionComment(ref, data.addDiscussionComment.comment)
        }
        const path = ref.kind === 'commit'
          ? `${repoPath(ref.repo)}/commits/${encodeURIComponent(ref.number)}/comments`
          : `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/comments`
        const { data } = await fetcher.json<GitHubComment>(path, { method: 'POST', json: { body } })
        return toComment(ref, data)
      }),
      editComment: perKind({ issue: 'experimental', pull_request: true, discussion: 'experimental', commit: 'experimental' }, async (ref, body) => {
        if (ref.thread.kind === 'discussion') {
          const data = await graphql<{ updateDiscussionComment: { comment: GraphQLComment } }>('UPDATE_DISCUSSION_COMMENT', { id: ref.id, body })
          return (await import('./graphql.ts')).toDiscussionComment(ref.thread, data.updateDiscussionComment.comment)
        }
        const { data } = await fetcher.json<GitHubComment>(commentPath(ref), { method: 'PATCH', json: { body } })
        return toComment(ref.thread, data)
      }),
      deleteComment: perKind({ issue: 'experimental', pull_request: true, discussion: 'experimental', commit: 'experimental' }, async (ref) => {
        if (ref.thread.kind === 'discussion') {
          await graphql('DELETE_DISCUSSION_COMMENT', { id: ref.id })
          return
        }
        await fetcher.raw(commentPath(ref), { method: 'DELETE' })
      }),
      create: perKind({ issue: true, pull_request: 'experimental' }, async (repo, input: ThreadCreateInput) => {
        const assignees = input.assignees?.map(actorLogin)
        if (input.kind === 'issue') {
          const { data } = await fetcher.json<GitHubIssue>(`${repoPath(repo)}/issues`, {
            method: 'POST',
            json: { title: input.title, body: input.body, labels: input.labels, assignees },
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
        })
        const ref: ResolvedThreadRef = { forge: FORGE, instance, repo, kind: 'pull_request', number: String(pull.number) }
        if (!input.labels?.length && !assignees?.length) {
          return toThread(ref, pull)
        }
        const { data: issue } = await fetcher.json<GitHubIssue>(`${repoPath(repo)}/issues/${encodeURIComponent(pull.number)}`, {
          method: 'PATCH',
          json: { labels: input.labels, assignees },
        })
        return toThread(ref, { ...pull, labels: issue.labels, assignees: issue.assignees })
      }),
      update: perKind({ issue: 'experimental', pull_request: true, discussion: 'experimental' }, async (thread, input) => {
        const ref = requireThread(thread, context)
        if (ref.kind === 'discussion') {
          const data = await graphql<{ updateDiscussion: { discussion: GraphQLDiscussion } }>('UPDATE_DISCUSSION', { id: await discussionId(ref), title: input.title, body: input.body })
          return (await import('./graphql.ts')).toDiscussionThread(ref, data.updateDiscussion.discussion)
        }
        const target = requireIssueOrPull(ref, context, 'update')
        const { data } = await fetcher.json<GitHubIssue>(threadPath(target), { method: 'PATCH', json: input })
        return toThread(target, data)
      }),
      addLabels: perKind({ issue: 'experimental', pull_request: true }, async (thread, labels) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        await fetcher.raw(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/labels`, { method: 'POST', json: { labels } })
      }),
      removeLabels: perKind({ issue: 'experimental', pull_request: true }, async (thread, labels) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        for (const label of labels) {
          await fetcher.raw(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' })
        }
      }),
      setMilestone: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, milestone) => issuePatch(
        thread,
        { milestone: milestone === undefined ? null : await milestoneId(milestone, page => milestonesPage(requireThread(thread, context).repo, page), context) },
        'set the milestone of',
      )),
      reactions: perKind({ issue: 'experimental', pull_request: true, discussion: 'experimental' }, { react, unreact }),
      reactionsPage: perKind({ issue: true, pull_request: true, discussion: !anonymous }, reactionsPage),
      transfer: verb('experimental', async (thread, repo) => {
        const ref = requireThread(thread, context)
        if (ref.kind !== 'issue') {
          throw new UnsupportedOperationError('GitHub transfers issues only', context)
        }
        const target = await graphql<{ repository: { id: string } | null }>('REPOSITORY_ID', { owner: repo.owner, name: repo.name })
        if (!target.repository) {
          throw new NotFoundError(`Repository ${repo.owner}/${repo.name} not found`, 404, '', context)
        }
        const data = await graphql<{ transferIssue: { issue: { id: string, number: number } } }>('TRANSFER_ISSUE', { issue: await nodeId(ref), repo: target.repository.id })
        return { forge: FORGE, instance, repo, kind: 'issue', number: String(data.transferIssue.issue.number), externalId: data.transferIssue.issue.id }
      }),
      markDuplicate: verb('experimental', async (thread, canonical) => {
        await graphql('MARK_DUPLICATE', { canonical: await nodeId(canonical), duplicate: await nodeId(thread) })
      }),
      setLabels: perKind({ issue: 'experimental', pull_request: true }, async (thread, labels) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        await fetcher.raw(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/labels`, { method: 'PUT', json: { labels } })
      }),
      setAssignees: perKind({ issue: 'experimental', pull_request: true }, async (thread, assignees) => {
        const ref = requireIssueOrPull(thread, context, 'assign')
        await fetcher.raw(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}`, { method: 'PATCH', json: { assignees: assignees.map(actorLogin) } })
      }),
      requestReview: perKind({ pull_request: true }, async (thread, reviewers) => {
        const ref = requireThread(thread, context)
        if (ref.kind !== 'pull_request') {
          throw new UnsupportedOperationError('Only pull requests have reviewers', context)
        }
        const teams = reviewers.filter(reviewer => typeof reviewer !== 'string' && reviewer.typeRaw === 'Team').map(actorLogin)
        const users = reviewers.filter(reviewer => typeof reviewer === 'string' || reviewer.typeRaw !== 'Team').map(actorLogin)
        await fetcher.raw(`${threadPath(ref)}/requested_reviewers`, {
          method: 'POST',
          json: { reviewers: users, ...teams.length ? { team_reviewers: teams } : {} },
        })
      }),
      close: perKind(ISSUE_LIKE, (ref, options_) => setState(ref, 'closed', options_)),
      reopen: perKind({ issue: 'experimental', pull_request: true, discussion: true }, ref => setState(ref, 'open')),
      merge: verb(true, merge),
      subscriptions: perKind(ISSUE_LIKE, {
        subscription: async (thread): Promise<SubscriptionState> => {
          const { state } = await subscriptionNode(thread)
          return state === 'SUBSCRIBED' ? 'subscribed' : state === 'IGNORED' ? 'ignored' : 'none'
        },
        subscribe: thread => setSubscription(thread, 'SUBSCRIBED'),
        unsubscribe: thread => setSubscription(thread, 'UNSUBSCRIBED'),
      }),
    },
  }
}

const GITHUB: ProviderDefinition<GitHubOptions, AppCredentials | undefined> = {
  forge: FORGE,
  baseUrl: 'https://api.github.com',
  anonymous: true,
  instance: webHost,
  headers: { 'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  prepare: ({ options, baseUrl, headers, state }) => options.auth?.type === 'app'
    ? state ?? createAppCredentials(options.auth, { baseUrl, fetch: options.fetch, timeout: options.timeout, headers })
    : undefined,
  authHeaders: ({ options, state }) => createAuthHeaders(options.auth, state),
  setup: setupGitHub,
}

/** Creates a GitHub provider for github.com or a GitHub Enterprise Server instance. */
export const github: ProviderFactoryFunction<GitHubOptions> = /* @__PURE__ */ defineForgeProvider({ ...GITHUB, webhooks: githubWebhooks })

/** `github()` without webhook ingestion, for bundles that never receive a delivery. */
export const githubLite: ProviderFactoryFunction<GitHubOptions> = /* @__PURE__ */ defineForgeProvider(GITHUB)

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
    return { token: ['notifications'], permissions: { notifications: name.startsWith('mark') || name === 'unsubscribe' ? 'write' : 'read' } }
  }
  if (group === 'securityAlerts') {
    return { token: ['security_events', 'repo'], permissions: { vulnerability_alerts: 'read', secret_scanning_alerts: 'read', code_scanning_alerts: 'read' } }
  }
  if (group === 'installations') {
    return { note: 'App credentials: an app JWT signed with the app private key' }
  }
  if (group === 'users' || group === 'search') {
    return { token: ['read:user'], permissions: {} }
  }
  if (group === 'ci' || (group === 'checks' && name !== 'report')) {
    return { token: ['repo'], permissions: { actions: 'read', checks: name === 'rerun' ? 'write' : 'read' } }
  }
  if (verb === 'checks.report') {
    return { token: ['repo:status'], permissions: { checks: 'write', statuses: 'write' } }
  }
  const writes = new Set(['comment', 'upsertComment', 'editComment', 'deleteComment', 'create', 'update', 'close', 'reopen', 'setLabels', 'addLabels', 'removeLabels', 'setMilestone', 'react', 'unreact', 'setAssignees', 'requestReview', 'merge', 'approveAndMerge', 'createReview', 'submitReview', 'approve', 'transfer', 'markDuplicate', 'resolveReviewThread', 'unresolveReviewThread', 'createLabel', 'addCollaborator', 'subscribe', 'unsubscribe'])
  const write = writes.has(name)
  if (group === 'threads') {
    return { token: ['repo', 'public_repo'], permissions: { issues: write ? 'write' : 'read', pull_requests: write ? 'write' : 'read' } }
  }
  if (group === 'repos' || group === 'contents' || group === 'releases') {
    return { token: ['repo', 'public_repo'], permissions: { contents: write ? 'write' : 'read', metadata: 'read' } }
  }
  return {}
}
