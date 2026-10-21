import type { ProviderDefinition, ProviderFactoryFunction } from '../define.ts'
import type {
  Actor,
  BaseOptions,
  Check,
  CheckState,
  Comment,
  CommentRef,
  Commit,
  CommitCommentRef,
  CommitFilesInput,
  CommitRef,
  Cursor,
  ForgeEventInput,
  ForgeWarning,
  ListOptions,
  MergeMethod,
  MergeOptions,
  MergeResult,
  OwnerRepoQuery,
  Page,
  PageOptions,
  Repo,
  RepoRef,
  RepoSearchQuery,
  ResolvedThreadRef,
  Review,
  ReviewInput,
  Thread,
  ThreadQuery,
  ThreadRef,
  ThreadSearchQuery,
  Webhook,
  WebhookRef,
} from '../model.ts'
import type {
  AnonymousAuth,
  BasicAuth,
  ForgeOptionsBase,
  TokenAuth,
  VerbScopes,
} from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { ListingExtras } from '../utils.ts'
import type {
  BitbucketActivity,
  BitbucketBranch,
  BitbucketComment,
  BitbucketCommitDetail,
  BitbucketCommitStatus,
  BitbucketDiffStat,
  BitbucketHook,
  BitbucketPage,
  BitbucketPullRequest,
  BitbucketRef,
  BitbucketRepositoryDetail,
  BitbucketSrcEntry,
  BitbucketUser,
} from './types.ts'
import { WRITE_VERBS } from '../capabilities.ts'
import { changeBytes, existingFiles, toFileContent } from '../contents.ts'
import { toBase64 } from '../crypto.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { BranchMovedError, ForgeApiError, ForgeError, MergeConflictError, NotFoundError, soleMergeMethod, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { isNamespaceRef } from '../model.ts'
import { createListing, getManyConcurrently, isFirstPage, mergeCommitMessage, phased, rateLimitPart, requireThread, resolveToken, summariseChecks, syntheticReview, toPage, toWarning } from '../utils.ts'
import { nativeEventsFor } from '../webhooks.ts'
import {
  FORGE,
  normaliseMarkdown,
  participantReviewId,
  toActivityEvent,
  toActor,
  toBranch,
  toChangedFile,
  toComment,
  toCommit,
  toCommitComment,
  toMergeMethod,
  toPullThread,
  toRepo,
  toStatusCheck,
  toStrategy,
  toTag,
  toTreeEntry,
  toWebhook,
} from './normalise.ts'
import { BITBUCKET_WEB, bitbucketInstance } from './web.ts'
import { BITBUCKET_NATIVE_EVENTS } from './webhook-events.ts'
import { bitbucketWebhooks } from './webhooks.ts'

/**
 * Bitbucket Cloud credentials.
 *
 * - `token`: an OAuth access token or a repository, project or workspace
 *   access token, sent as a bearer token.
 * - `basic`: an Atlassian account email and API token.
 */
export type BitbucketAuth = TokenAuth | BasicAuth | AnonymousAuth

/** Options for `bitbucket()`. */
export interface BitbucketOptions extends ForgeOptionsBase {
  /**
   * How to authenticate. Without credentials, only public reads work.
   * @default { type: 'anonymous' }
   */
  auth?: BitbucketAuth
  /**
   * API base.
   * @default https://api.bitbucket.org/2.0
   */
  baseUrl?: string
}

const PULL_STATES = { open: ['OPEN'], merged: ['MERGED'], closed: ['MERGED', 'DECLINED', 'SUPERSEDED'], all: ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] } as const

/** A BBQL string literal. */
function bbql(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function accountRef(actor: string | Actor): { uuid: string } {
  return { uuid: typeof actor === 'string' ? actor : actor.id }
}

function page<T>(body: unknown) {
  const { values, next } = body as BitbucketPage<T>
  return { items: values, next }
}

/** Creates a Bitbucket Cloud provider. Bitbucket Data Center has a different API and is not supported. */
const BITBUCKET: ProviderDefinition<BitbucketOptions, undefined, true> = {
  forge: FORGE,
  hasWeb: true,

  baseUrl: 'https://api.bitbucket.org/2.0',
  anonymous: true,
  instance: bitbucketInstance,
  headers: { accept: 'application/json' },
  webhooks: bitbucketWebhooks,
  authHeaders({ options: { auth } }) {
    if (!auth || auth.type === 'anonymous') {
      return undefined
    }
    if (auth.type === 'token') {
      return async () => ({ authorization: `Bearer ${await resolveToken(auth)}` })
    }
    const authorization = `Basic ${toBase64(new TextEncoder().encode(`${auth.username}:${auth.password}`))}`
    return () => ({ authorization })
  },
  setup({ options, instance, origin: context, fetcher, baseUrl }) {
    const list = createListing(fetcher, 'pagelen', 50)
    const web = BITBUCKET_WEB.links({ baseUrl, instance })
    /** Repository search covers the signed-in account's workspaces. */
    const anonymous = options.auth?.type === 'anonymous'
    function repoPath(ref: ResolvedThreadRef): string {
      return `/repositories/${encodeURIComponent(ref.repo.owner)}/${encodeURIComponent(ref.repo.name)}`
    }

    function threadPath(ref: ResolvedThreadRef): string {
      switch (ref.kind) {
        case 'pull_request':
          return `${repoPath(ref)}/pullrequests/${ref.number}`
        default:
          throw new UnsupportedOperationError(`Bitbucket has no ${ref.kind} threads`, context)
      }
    }

    function all<T>(path: string, listOptions: ListOptions = {}): AsyncGenerator<T> {
      return fetcher.items<T>(path, {
        query: { pagelen: listOptions.perPage ?? 50 },
        signal: listOptions.signal,
        select: page<T>,
      })
    }

    /** The commits in `head` and not in `base`, up to `limit`, and whether that is all of them. */
    async function compareCommits(repo: RepoRef, base: string, head: string, limit: number | undefined, signal: AbortSignal | undefined): Promise<{ commits: Commit[], complete: boolean }> {
      const commits: Commit[] = []
      const wanted = limit ?? Infinity
      let cursor: Cursor | undefined
      do {
        const result = await fetcher.page<BitbucketCommitDetail>(`${repoPathOf(repo)}/commits`, {
          query: { include: head, exclude: base, pagelen: Math.min(50, Math.max(1, wanted)) },
          select: page<BitbucketCommitDetail>,
          cursor,
          signal,
        })
        commits.push(...result.data.map(raw => toCommit(repo, raw)))
        cursor = result.cursor
      } while (cursor?.nextUrl && commits.length < wanted)
      return { commits, complete: !cursor?.nextUrl }
    }

    async function resolveMergeMethod(ref: ResolvedThreadRef, pull: BitbucketPullRequest | undefined, signal?: AbortSignal): Promise<MergeMethod> {
      const branch = pull?.destination?.branch?.name
        ?? (await fetcher.json<BitbucketPullRequest>(threadPath(ref), { signal })).data.destination?.branch?.name
      const { data } = await fetcher.json<BitbucketBranch>(`${repoPath(ref)}/refs/branches/${encodeURIComponent(branch ?? '')}`, { signal })
      return soleMergeMethod(Object.fromEntries((data.merge_strategies ?? [])
        .map(toMergeMethod)
        .filter((method): method is MergeMethod => method !== undefined)
        .map(method => [method, true])), context)
    }

    /** A merge that outlasts Bitbucket's own timeout responds with `202` and finishes in the background. */
    async function merge(thread: ThreadRef, mergeOptions: MergeOptions = {}): Promise<MergeResult> {
      const ref = requireThread(thread, context)
      if (ref.kind !== 'pull_request') {
        throw new UnsupportedOperationError('Only pull requests can be merged', context)
      }
      if (mergeOptions.whenChecksPass) {
        throw new UnsupportedOperationError('Bitbucket Cloud cannot queue a merge until checks pass through the API', context)
      }
      let pull: BitbucketPullRequest | undefined
      if (mergeOptions.sha) {
        pull = (await fetcher.json<BitbucketPullRequest>(threadPath(ref), { signal: mergeOptions.signal })).data
        const head = pull.source?.commit?.hash ?? ''
        if (!head || !(mergeOptions.sha.startsWith(head) || head.startsWith(mergeOptions.sha))) {
          throw new MergeConflictError(`Pull request head is ${head || 'unknown'}, not ${mergeOptions.sha}`, 409, '', context)
        }
      }
      const method = mergeOptions.method ?? await resolveMergeMethod(ref, pull, mergeOptions.signal)
      const { data, response } = await fetcher.json<BitbucketPullRequest | undefined>(`${threadPath(ref)}/merge`, {
        method: 'POST',
        json: { merge_strategy: toStrategy(method), message: mergeCommitMessage(mergeOptions) },
        mapError: toMergeError,
        signal: mergeOptions.signal,
      })
      return response.status === 202 || data?.state !== 'MERGED'
        ? { status: 'queued', raw: data }
        : { status: 'merged', sha: data.merge_commit?.hash, raw: data }
    }

    const STATUS_STATES: Record<CheckState, string> = { pending: 'INPROGRESS', success: 'SUCCESSFUL', failure: 'FAILED', neutral: 'STOPPED', unknown: 'INPROGRESS' }

    function repoPathOf(repo: RepoRef): string {
      return `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
    }

    function requirePull(thread: ThreadRef, action: string): ResolvedThreadRef {
      const ref = requireThread(thread, context)
      if (ref.kind !== 'pull_request') {
        throw new UnsupportedOperationError(`Only pull requests can be ${action}`, context)
      }
      return ref
    }

    /**
     * Bitbucket creates a branch that does not exist, and commits on top of the `parents` it is given, refusing
     * when the branch is elsewhere. So the branch is read first and its head always named. File fields start with `/`,
     * so that a file cannot replace `message` or `branch`. The response names the commit only in `location`.
     */
    async function commitFiles(repo: RepoRef, input: CommitFilesInput, options?: BaseOptions): Promise<Commit> {
      const signal = options?.signal
      const branch = () => fetcher.json<BitbucketRef>(`${repoPathOf(repo)}/refs/branches/${encodeURIComponent(input.branch)}`, { signal }).then(result => result.data)
      let parent: string | undefined
      if (input.createFrom === undefined) {
        parent = (await branch()).target?.hash
        if (input.expectedHead !== undefined && parent !== input.expectedHead.toLowerCase()) {
          throw new BranchMovedError(`${input.branch} is at ${parent}, not ${input.expectedHead}`, 409, '', context)
        }
      }
      else {
        const existing = await branch().catch((error: unknown) => error instanceof NotFoundError ? undefined : Promise.reject(error))
        if (existing) {
          throw new ForgeApiError(`${input.branch} already exists`, 409, '', context)
        }
        parent = (await fetcher.json<BitbucketCommitDetail>(`${repoPathOf(repo)}/commit/${encodeURIComponent(input.createFrom)}`, { signal })).data.hash
      }
      const deletions = input.changes.filter(change => change.content === null)
      await existingFiles(deletions, async (path) => {
        try {
          return await fetcher.json(`${repoPathOf(repo)}/src/${encodeURIComponent(parent ?? input.branch)}/${path.split('/').map(encodeURIComponent).join('/')}`, { query: { format: 'meta' }, signal })
        }
        catch (error) {
          if (error instanceof NotFoundError) {
            return undefined
          }
          throw error
        }
      }, context)
      const form = new FormData()
      form.set('message', input.message)
      form.set('branch', input.branch)
      if (parent) {
        form.set('parents', parent)
      }
      if (input.author) {
        form.set('author', `${input.author.name} <${input.author.email}>`)
      }
      for (const { path, content } of input.changes) {
        if (content === null) {
          form.append('files', path)
        }
        else {
          form.set(`/${path}`, new Blob([changeBytes(content) as Uint8Array<ArrayBuffer>]), path.slice(path.lastIndexOf('/') + 1))
        }
      }
      const response = await fetcher.raw(`${repoPathOf(repo)}/src`, {
        method: 'POST',
        body: form,
        mapError: error => input.createFrom === undefined && error instanceof ForgeApiError && /is not the head of branch/i.test(error.body)
          ? new BranchMovedError(`${input.branch} is no longer at ${parent}`, error.status, error.body, context, { cause: error })
          : error,
        signal,
      })
      await response.body?.cancel()
      const sha = /\/commit\/(?<sha>[0-9a-f]+)$/i.exec(response.headers.get('location') ?? '')?.groups?.sha
      if (!sha) {
        throw new ForgeError('Bitbucket did not say which commit it made', context)
      }
      return toCommit(repo, (await fetcher.json<BitbucketCommitDetail>(`${repoPathOf(repo)}/commit/${sha}`, { signal })).data)
    }

    /** Bitbucket's source endpoints need an explicit commit or branch, so the main branch stands in. */
    async function mainBranch(repo: RepoRef, options?: BaseOptions): Promise<string> {
      const { data } = await fetcher.json<BitbucketRepositoryDetail>(repoPathOf(repo), { signal: options?.signal })
      return data.mainbranch?.name ?? 'HEAD'
    }

    async function get(thread: ThreadRef, options?: BaseOptions): Promise<Thread> {
      const ref = requireThread(thread, context)
      switch (ref.kind) {
        case 'pull_request': {
          const result = toPullThread(ref, (await fetcher.json<BitbucketPullRequest>(threadPath(ref), { signal: options?.signal })).data)
          try {
            result.checks = summariseChecks((await pullChecks(ref, options?.signal)).map(check => check.state))
          }
          catch (error) {
            if (!(error instanceof ForgeError)) {
              throw error
            }
            result.warnings = [...result.warnings ?? [], toWarning('checks_unreadable', error, ref.number)]
          }
          return result
        }
        default:
          throw new UnsupportedOperationError(`Bitbucket has no ${ref.kind} threads`, context)
      }
    }

    async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
      if (query.kind && query.kind !== 'pull_request') {
        return { items: [], warnings: [{ code: 'kind_unsupported', message: `Bitbucket Cloud has no ${query.kind === 'issue' ? 'issues' : 'discussions'}` }] }
      }
      const warnings: ForgeWarning[] = []
      if (isFirstPage(query.cursor)) {
        if (query.labels?.length) {
          warnings.push({ code: 'filter_unsupported', message: 'Bitbucket has no labels; the labels filter was ignored' })
        }
        if (query.sort === 'comments') {
          warnings.push({ code: 'sort_unsupported', message: 'Bitbucket cannot sort by comment count; sorted by creation time' })
        }
        if (query.assignee) {
          warnings.push({ code: 'filter_unsupported', message: 'Bitbucket pull requests have no assignees; the assignee filter was ignored' })
        }
      }
      const field = query.sort === 'updated' ? 'updated_on' : 'created_on'
      const clauses: string[] = []
      if (query.since) {
        clauses.push(`updated_on >= ${query.since.toISOString()}`)
      }
      if (query.createdAfter) {
        clauses.push(`created_on >= ${query.createdAfter.toISOString()}`)
      }
      if (query.author) {
        clauses.push(`author.nickname = ${bbql(query.author)}`)
      }
      const params = new URLSearchParams({ sort: `${(query.direction ?? 'desc') === 'desc' ? '-' : ''}${field}`, pagelen: String(query.perPage ?? 50) })
      for (const value of PULL_STATES[query.state ?? 'open']) {
        params.append('state', value)
      }
      if (clauses.length) {
        params.set('q', clauses.join(' AND '))
      }
      const result = await fetcher.page<BitbucketPullRequest>(`${repoPathOf(repo)}/pullrequests?${params}`, { signal: query.signal, cursor: query.cursor, select: page<BitbucketPullRequest> })
      return toPage(result, raw => toPullThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: String(raw.id) }, raw), warnings.length ? warnings : undefined)
    }

    /** Repository hooks, or workspace hooks for a namespace ref. */
    function hooksPath(target: RepoRef): string {
      return isNamespaceRef(target)
        ? `/workspaces/${encodeURIComponent(target.owner)}/hooks`
        : `${repoPathOf(target)}/hooks`
    }

    /** Bitbucket replaces a hook whole, so a change is merged into the hook as it is. */
    async function putHook(ref: WebhookRef, changes: Partial<BitbucketHook> & { secret?: string }, options?: BaseOptions): Promise<Webhook> {
      const path = `${hooksPath(ref.target)}/${ref.id}`
      const { data: current } = await fetcher.json<BitbucketHook>(path, { signal: options?.signal })
      const { data } = await fetcher.json<BitbucketHook>(path, {
        method: 'PUT',
        json: { url: current.url, description: current.description, active: current.active, events: current.events, ...changes },
        signal: options?.signal,
      })
      return toWebhook(ref.target, data)
    }

    /**
     * Bitbucket indexes issues and pull requests per repository, so search is
     * the same `q=` filter language scoped to one repository.
     */
    async function searchThreadsPage(query: ThreadSearchQuery): Promise<Page<Thread>> {
      if (!query.repo) {
        throw new UnsupportedOperationError('Bitbucket has no cross-repository issue or pull request search; pass `repo`', context)
      }
      const warnings: ForgeWarning[] = []
      if (isFirstPage(query.cursor)) {
        if (query.labels?.length) {
          warnings.push({ code: 'filter_unsupported', message: 'Bitbucket has no labels; the label filter was ignored' })
        }
        if (query.involves) {
          warnings.push({ code: 'filter_unsupported', message: 'Bitbucket has no involves filter; it was ignored' })
        }
        if (query.sort === 'comments') {
          warnings.push({ code: 'sort_unsupported', message: 'Bitbucket cannot sort by comment count; sorted by update time' })
        }
      }
      const page = await listPage(query.repo, {
        kind: query.kind,
        state: query.state ?? 'all',
        author: query.author,
        assignee: query.assignee,
        since: query.since,
        sort: query.sort === 'created' ? 'created' : 'updated',
        direction: query.direction,
        perPage: query.perPage,
        cursor: query.cursor,
        signal: query.signal,
      })
      const text = query.text?.toLowerCase()
      const items = text
        ? page.items.filter(thread => thread.title.toLowerCase().includes(text) || (thread.body ?? '').toLowerCase().includes(text))
        : page.items
      const all = [...warnings, ...page.warnings ?? []]
      return { ...page, items, ...all.length ? { warnings: all } : {} }
    }

    async function searchReposPage(query: RepoSearchQuery): Promise<Page<Repo>> {
      const clauses = [
        ...query.text ? [`name ~ ${bbql(query.text)}`] : [],
        ...query.language ? [`language = ${bbql(query.language)}`] : [],
      ]
      const field = query.sort === 'created' ? 'created_on' : 'updated_on'
      const extras = {
        query: { q: clauses.length ? clauses.join(' AND ') : undefined, sort: `${(query.direction ?? 'desc') === 'desc' ? '-' : ''}${field}` },
        warnings: query.sort === 'stars' ? [{ code: 'sort_unsupported', message: 'Bitbucket has no stars; sorted by update time' }] : undefined,
      }
      return query.owner
        ? list(`/repositories/${encodeURIComponent(query.owner)}`, query, (raw: BitbucketRepositoryDetail) => toRepo(instance, raw), { ...extras, select: page<BitbucketRepositoryDetail> })
        : memberRepos(query, extras)
    }

    async function ownerReposPage(owner: RepoRef, query: OwnerRepoQuery = {}): Promise<Page<Repo>> {
      if (query.visibility === 'internal') {
        return { items: [], warnings: [{ code: 'filter_unsupported', message: 'Bitbucket has no internal repositories' }] }
      }
      const field = query.sort === 'created' ? 'created_on' : query.sort === 'name' ? 'name' : query.sort && 'updated_on'
      return list(`/repositories/${encodeURIComponent(owner.owner)}`, query, (raw: BitbucketRepositoryDetail) => toRepo(instance, raw), {
        query: {
          q: query.visibility === 'public' || query.visibility === 'private' ? `is_private = ${query.visibility === 'private'}` : undefined,
          sort: field && `${(query.direction ?? (field === 'name' ? 'asc' : 'desc')) === 'desc' ? '-' : ''}${field}`,
        },
        warnings: query.sort === 'pushed' && isFirstPage(query.cursor) ? [{ code: 'sort_unsupported', message: 'Bitbucket does not report pushes; sorted by update time' }] : undefined,
        select: page<BitbucketRepositoryDetail>,
      })
    }

    /** One phase per workspace the account belongs to; Bitbucket lists repositories by workspace only. */
    async function memberRepos(listOptions: PageOptions, extras: ListingExtras = {}): Promise<Page<Repo>> {
      const workspaces = await Array.fromAsync(fetcher.items<{ workspace: { slug: string } }>('/user/workspaces', { query: { pagelen: 100 }, select: page, signal: listOptions.signal }))
      if (!workspaces.length) {
        return { items: [] }
      }
      return phased(workspaces.map(({ workspace }) => (cursor?: Cursor) => list(
        `/repositories/${encodeURIComponent(workspace.slug)}`,
        { ...listOptions, cursor },
        (raw: BitbucketRepositoryDetail) => toRepo(instance, raw),
        { ...extras, query: { ...extras.query, role: 'member' }, select: page<BitbucketRepositoryDetail> },
      )), listOptions.cursor)
    }

    /** Bitbucket has participants, not reviews: one synthesised review per participant who has voted. */
    function toParticipantReviews(ref: ResolvedThreadRef, pull: BitbucketPullRequest): Review[] {
      return (pull.participants ?? []).flatMap((participant) => {
        const stateRaw = participant.state ?? (participant.approved ? 'approved' : undefined)
        if (!stateRaw) {
          return []
        }
        const actor = toActor(instance, participant.user)
        const state = stateRaw === 'approved' ? 'approved' : stateRaw === 'changes_requested' ? 'changes_requested' : 'unknown'
        return [syntheticReview(ref, participantReviewId(instance, participant.user), state, { author: actor, stateRaw, raw: participant })]
      })
    }

    async function createReview(thread: ThreadRef, input: ReviewInput, options?: BaseOptions): Promise<Review> {
      const ref = requireThread(thread, context)
      if (ref.kind !== 'pull_request') {
        throw new UnsupportedOperationError('Only pull requests can be reviewed', context)
      }
      if (input.event !== 'approve' && input.event !== 'request_changes') {
        throw new UnsupportedOperationError('Bitbucket records approve and request-changes votes, not review bodies', context)
      }
      if (input.body || input.comments?.length) {
        throw new UnsupportedOperationError('Bitbucket votes carry no body or inline comments; post them as comments', context)
      }
      const { data } = await fetcher.json<NonNullable<BitbucketPullRequest['participants']>[number]>(
        `${threadPath(ref)}/${input.event === 'approve' ? 'approve' : 'request-changes'}`,
        { method: 'POST', signal: options?.signal },
      )
      return toParticipantReviews(ref, { participants: [data] } as BitbucketPullRequest)[0]
        ?? { ref: { forge: FORGE, instance, thread: ref, id: 'participant:' }, state: 'unknown', comments: false, raw: data }
    }

    function pullChecks(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<Check[]> {
      return Array.fromAsync(all<BitbucketCommitStatus>(`${threadPath(ref)}/statuses`, { signal }), status => toStatusCheck(ref.repo, status))
    }

    function commentsPath(ref: ResolvedThreadRef): string {
      return `${threadPath(ref)}/comments`
    }

    function commentPath(ref: CommentRef): string {
      return `${commentsPath(requireThread(ref.thread, context))}/${ref.id}`
    }

    function commitCommentsPath(commit: CommitRef): string {
      return `${repoPathOf(commit.repo)}/commit/${encodeURIComponent(commit.sha)}/comments`
    }

    function commitCommentPath(ref: CommitCommentRef): string {
      return `${commitCommentsPath(ref.commit)}/${encodeURIComponent(ref.id)}`
    }

    return {
      traits: { eventKinds: 'native', authKinds: ['token', 'basic', 'anonymous'] },
      notApplicable: [
        'repos.labels',
        'repos.createLabel',
        'repos.milestones',
        'notifications.list',
        'notifications.markRead',
        'notifications.markDone',
        'notifications.unsubscribe',
        'notifications.markAllRead',
        'notifications.markAllDone',
        'notifications.unreadCount',
        'threads.reactions',
        'threads.setLabels',
        'threads.addLabels',
        'threads.removeLabels',
        'threads.setMilestone',
        'threads.react',
        'releases.list',
        'releases.get',
        'releases.latest',
        'releases.getByTag',
        'releases.downloadAsset',
        'releases.create',
        'releases.update',
        'webhooks.deliveries',
        'webhooks.redeliver',
        'users.block',
        'orgs.block',
        'repos.templates',
        'threads.hideComment',
        'threads.lock',
        'threads.updateBranch',
        'repos.issueTypes',
        'threads.setIssueType',
      ],
      normaliseMarkdown,
      users: {
        me: verb(true, async (options) => {
          const { data } = await fetcher.json<BitbucketUser>('/user', { signal: options?.signal })
          return { ...toActor(instance, data)!, raw: data }
        }),
      },
      web,
      webhooks: {
        listPage: verb(true, (target, listOptions = {}) => list(hooksPath(target), listOptions, (raw: BitbucketHook) => toWebhook(target, raw), { select: page<BitbucketHook> })),
        create: verb(true, async (target, input, options) => toWebhook(target, (await fetcher.json<BitbucketHook>(hooksPath(target), {
          method: 'POST',
          json: {
            url: input.url,
            description: 'forges',
            active: input.active ?? true,
            events: nativeEventsFor(BITBUCKET_NATIVE_EVENTS, input.events, input.nativeEvents),
            ...input.secret ? { secret: input.secret } : {},
          },
          signal: options?.signal,
        })).data)),
        update: verb(true, async (ref, update, options) => putHook(ref, {
          ...update.url ? { url: update.url } : {},
          ...update.active === undefined ? {} : { active: update.active },
          ...update.events || update.nativeEvents ? { events: nativeEventsFor(BITBUCKET_NATIVE_EVENTS, update.events, update.nativeEvents) } : {},
          ...update.secret ? { secret: update.secret } : {},
        }, options)),
        delete: verb(true, async (ref, options) => {
          await fetcher.raw(`${hooksPath(ref.target)}/${ref.id}`, { method: 'DELETE', signal: options?.signal })
        }),
        rotateSecret: verb(true, async (ref, secret, options) => putHook(ref, { secret }, options)),
      },
      scopes: bitbucketScopesFor,
      repos: {
        get: verb(true, async (ref, options) => {
          return toRepo(instance, (await fetcher.json<BitbucketRepositoryDetail>(repoPathOf(ref), { signal: options?.signal })).data)
        }),
        listPage: verb(true, (listOptions = {}) => memberRepos(listOptions)),
        byOwnerPage: verb(true, ownerReposPage),
      },
      search: {
        threadsPage: verb(true, searchThreadsPage),
        reposPage: verb(!anonymous, searchReposPage),
      },
      contents: {
        getFile: verb(true, async (repo, path, fileOptions = {}) => {
          const ref = fileOptions.ref ?? await mainBranch(repo, fileOptions)
          const target = `${repoPathOf(repo)}/src/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`
          const [meta, raw] = await Promise.all([
            fileOptions.metadata === false ? undefined : fetcher.json<BitbucketSrcEntry>(target, { query: { format: 'meta' }, signal: fileOptions.signal }),
            fetcher.raw(target, { signal: fileOptions.signal }),
          ])
          const bytes = new Uint8Array(await raw.arrayBuffer())
          const file = meta
            ? { path: meta.data.path, sha: meta.data.commit?.hash, size: meta.data.size, url: meta.data.links?.html?.href }
            : { path, size: bytes.byteLength }
          return toFileContent(bytes, file, fileOptions, context)
        }),
        treePage: verb(true, async (repo, treeOptions = {}) => {
          const ref = treeOptions.ref ?? await mainBranch(repo, treeOptions)
          const path = treeOptions.path?.replace(/^\/|\/$/g, '') ?? ''
          return list(`${repoPathOf(repo)}/src/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`, treeOptions, toTreeEntry, { query: { max_depth: treeOptions.recursive ? 100 : undefined }, select: page<BitbucketSrcEntry> })
        }),
        branchesPage: verb(true, (repo, listOptions = {}) => list(`${repoPathOf(repo)}/refs/branches`, listOptions, (raw: BitbucketRef) => toBranch(raw), { select: page<BitbucketRef> })),
        tagsPage: verb(true, (repo, listOptions = {}) => list(`${repoPathOf(repo)}/refs/tags`, listOptions, toTag, { select: page<BitbucketRef> })),
        resolveRef: verb(true, async (repo, ref, options) => (await fetcher.json<BitbucketCommitDetail>(`${repoPathOf(repo)}/commit/${encodeURIComponent(ref)}`, { signal: options?.signal })).data.hash),
        compare: verb(true, async (repo, base, head, options) => {
          const [files, { commits, complete }] = await Promise.all([
            options?.files === false ? [] : Array.fromAsync(all<BitbucketDiffStat>(`${repoPathOf(repo)}/diffstat/${encodeURIComponent(head)}..${encodeURIComponent(base)}`, { signal: options?.signal }), toChangedFile),
            compareCommits(repo, base, head, options?.commitLimit, options?.signal),
          ])
          return { base, head, ...complete ? { aheadBy: commits.length } : {}, commits, files, raw: { files, commits } }
        }),
        commitFiles: verb(true, commitFiles),
      },
      commits: {
        listPage: verb(true, (repo, query = {}) => list(`${repoPathOf(repo)}/commits${query.ref ? `/${encodeURIComponent(query.ref)}` : ''}`, query, (raw: BitbucketCommitDetail) => toCommit(repo, raw), { query: { path: query.path }, select: page<BitbucketCommitDetail> })),
        get: verb(true, async ({ repo, sha }, options) => {
          const [commit, files] = await Promise.all([
            fetcher.json<BitbucketCommitDetail>(`${repoPathOf(repo)}/commit/${sha}`, { signal: options?.signal }),
            Array.fromAsync(all<BitbucketDiffStat>(`${repoPathOf(repo)}/diffstat/${sha}`, { signal: options?.signal }), toChangedFile),
          ])
          return toCommit(repo, commit.data, files)
        }),
        commentsPage: verb(true, (commit, listOptions = {}) => list(commitCommentsPath(commit), listOptions, (comment: BitbucketComment) => toCommitComment(commit, comment), { select: page<BitbucketComment> })),
        createComment: verb(true, async (commit, body, options) => {
          const { data } = await fetcher.json<BitbucketComment>(commitCommentsPath(commit), { method: 'POST', json: { content: { raw: body } }, signal: options?.signal })
          return toCommitComment(commit, data)
        }),
        updateComment: verb(true, async (ref, body, options) => {
          const { data } = await fetcher.json<BitbucketComment>(commitCommentPath(ref), { method: 'PUT', json: { content: { raw: body } }, signal: options?.signal })
          return toCommitComment(ref.commit, data)
        }),
        deleteComment: verb(true, async (ref, options) => {
          await fetcher.raw(commitCommentPath(ref), { method: 'DELETE', signal: options?.signal })
        }),
      },
      checks: {
        list: verb(true, async (repo, sha, options) => ({ items: await Array.fromAsync(all<BitbucketCommitStatus>(`${repoPathOf(repo)}/commit/${sha}/statuses`, { signal: options?.signal }), raw => toStatusCheck(repo, raw)) })),
        report: verb(true, async (repo, sha, input, options) => toStatusCheck(repo, (await fetcher.json<BitbucketCommitStatus>(`${repoPathOf(repo)}/commit/${sha}/statuses/build`, {
          method: 'POST',
          json: {
            key: input.externalId ?? input.name,
            name: input.name,
            state: STATUS_STATES[input.state],
            description: input.description,
            // Bitbucket requires a link; without one, the status links to the commit.
            url: input.url ?? `${web.baseUrl}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${sha}`,
          },
          signal: options?.signal,
        })).data)),
      },
      emulated: { getComment: { pull_request: anonymous ? 'unverified' : 'emulated' }, getCommitComment: anonymous ? 'unverified' : 'emulated' },
      threads: {
        filesPage: verb(true, (thread, listOptions = {}) => list(`${threadPath(requirePull(thread, 'read for changed files'))}/diffstat`, listOptions, toChangedFile, { select: page<BitbucketDiffStat> })),
        commitsPage: verb(true, (thread, listOptions = {}) => list(`${threadPath(requirePull(thread, 'read for commits'))}/commits`, listOptions, (raw: BitbucketCommitDetail) => toCommit(thread.repo, raw), { select: page<BitbucketCommitDetail> })),
        checks: perKind({ pull_request: true }, async (thread, options) => ({ items: await pullChecks(requireThread(thread, context), options?.signal) })),
        reviewsPage: verb('emulated', async (thread, listOptions) => {
          const ref = requireThread(thread, context)
          if (ref.kind !== 'pull_request') {
            throw new UnsupportedOperationError('Only pull requests have participants', context)
          }
          const { data, response } = await fetcher.json<BitbucketPullRequest>(threadPath(ref), { signal: listOptions?.signal })
          return { items: toParticipantReviews(ref, data), ...rateLimitPart(response) }
        }),
        createReview: verb('emulated', createReview),
        get: perKind({ pull_request: true }, get),
        getMany: verb(true, (refs, options) => getManyConcurrently(refs, get, options)),
        listPage: perKind({ pull_request: true }, listPage),
        eventsPage: verb(true, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> => {
          const ref = requireThread(thread, context)
          const events: ForgeEventInput[] = []
          let index = 0
          for await (const entry of all<BitbucketActivity>(`${threadPath(ref)}/activity`, listOptions)) {
            events.push(toActivityEvent(ref, entry, index++))
          }
          return { items: events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()) }
        }),
        commentsPage: perKind({ pull_request: true }, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> => {
          const ref = requireThread(thread, context)
          return list(commentsPath(ref), listOptions, (comment: BitbucketComment) => toComment(ref, comment), { select: page<BitbucketComment> })
        }),
        createComment: perKind({ pull_request: true }, async (thread, body, options) => {
          const ref = requireThread(thread, context)
          const { data } = await fetcher.json<BitbucketComment>(commentsPath(ref), {
            method: 'POST',
            json: { content: { raw: body } },
            signal: options?.signal,
          })
          return toComment(ref, data)
        }),
        updateComment: perKind({ pull_request: true }, async (ref, body, options) => {
          const thread = requireThread(ref.thread, context)
          const { data } = await fetcher.json<BitbucketComment>(commentPath(ref), { method: 'PUT', json: { content: { raw: body } }, signal: options?.signal })
          return toComment(thread, data)
        }),
        deleteComment: perKind({ pull_request: true }, async (ref, options) => {
          await fetcher.raw(commentPath(ref), { method: 'DELETE', signal: options?.signal })
        }),
        create: perKind({ pull_request: true }, async (repo, input, options) => {
          if (input.labels?.length) {
            throw new UnsupportedOperationError('Bitbucket has no labels', context)
          }
          if (!input.head || !input.base) {
            throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
          }
          if (input.assignees?.length) {
            throw new UnsupportedOperationError('Bitbucket pull requests have no assignees', context)
          }
          const { data } = await fetcher.json<BitbucketPullRequest>(`${repoPathOf(repo)}/pullrequests`, {
            method: 'POST',
            json: {
              title: input.title,
              description: input.body,
              source: { branch: { name: input.head } },
              destination: { branch: { name: input.base } },
              draft: input.draft,
            },
            signal: options?.signal,
          })
          return toPullThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: String(data.id) }, data)
        }),
        /** Declining is a separate call, so an edit goes first and the decline response carries both. */
        update: perKind({ pull_request: true }, async (thread, input, options) => {
          const ref = requirePull(thread, 'updated')
          if (input.labels) {
            throw new UnsupportedOperationError('Bitbucket has no labels', context)
          }
          if (input.assignees) {
            throw new UnsupportedOperationError('Bitbucket pull requests have no assignees', context)
          }
          const edit = { title: input.title, description: input.body }
          if (input.state === 'open') {
            const { data } = await fetcher.json<BitbucketPullRequest>(threadPath(ref), { signal: options?.signal })
            if (data.state !== 'OPEN') {
              throw new UnsupportedOperationError(`Bitbucket cannot reopen a ${data.state.toLowerCase()} pull request`, context)
            }
            if (input.title === undefined && input.body === undefined) {
              return toPullThread(ref, data)
            }
          }
          if (input.state !== 'closed') {
            return toPullThread(ref, (await fetcher.json<BitbucketPullRequest>(threadPath(ref), { method: 'PUT', json: edit, signal: options?.signal })).data)
          }
          if (input.title !== undefined || input.body !== undefined) {
            await fetcher.raw(threadPath(ref), { method: 'PUT', json: edit, signal: options?.signal })
          }
          return toPullThread(ref, (await fetcher.json<BitbucketPullRequest>(`${threadPath(ref)}/decline`, { method: 'POST', signal: options?.signal })).data)
        }),
        requestReview: perKind({ pull_request: true }, async (thread, reviewers, options) => {
          const ref = requireThread(thread, context)
          if (ref.kind !== 'pull_request') {
            throw new UnsupportedOperationError('Only pull requests have reviewers', context)
          }
          const { data } = await fetcher.json<BitbucketPullRequest>(threadPath(ref), { signal: options?.signal })
          const uuids = new Set([...(data.reviewers ?? []).flatMap(user => user.uuid ?? []), ...reviewers.map(reviewer => accountRef(reviewer).uuid)])
          await fetcher.raw(threadPath(ref), {
            method: 'PUT',
            json: { title: data.title, reviewers: [...uuids].map(uuid => ({ uuid })) },
            signal: options?.signal,
          })
        }),
        close: perKind({ pull_request: true }, async (thread, options) => {
          const ref = requirePull(thread, 'declined')
          return toPullThread(ref, (await fetcher.json<BitbucketPullRequest>(`${threadPath(ref)}/decline`, { method: 'POST', signal: options?.signal })).data)
        }),
        merge: verb(true, merge),
      },
    }
  },
}

/** Creates a Bitbucket Cloud provider. */
export const bitbucket: ProviderFactoryFunction<BitbucketOptions, true, 'bitbucket'> = /* @__PURE__ */ defineForgeProvider(BITBUCKET)

/** Bitbucket Cloud scopes, as an app password or OAuth consumer grants them. */
function bitbucketScopesFor(verb: ForgeVerb): VerbScopes {
  const [group = '', name = ''] = verb.split('.')
  if (group === 'webhooks') {
    return name === 'verify' || name === 'ingest' ? {} : { token: ['webhook'] }
  }
  const write = WRITE_VERBS.has(verb)
  if (group === 'threads') {
    return { token: [write ? 'issue:write' : 'issue', write ? 'pullrequest:write' : 'pullrequest'] }
  }
  if (group === 'users' || group === 'search') {
    return { token: ['account'] }
  }
  return { token: [write ? 'repository:write' : 'repository'] }
}
