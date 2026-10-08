import type { MergeHooks, ProviderDefinition, ProviderFactoryFunction } from '../define.ts'
import type {
  Actor,
  Check,
  CheckState,
  Comment,
  CommentRef,
  Cursor,
  ForgeEventInput,
  ForgeWarning,
  ListOptions,
  MergeMethod,
  MergeOptions,
  Page,
  PageOptions,
  Repo,
  RepoRef,
  RepoSearchQuery,
  ResolvedThreadRef,
  Review,
  ReviewInput,
  SearchQuery,
  Thread,
  ThreadQuery,
  ThreadRef,
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
  BitbucketCommit,
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
import { toFileContent } from '../contents.ts'
import { toBase64 } from '../crypto.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { ForgeError, MergeConflictError, soleMergeMethod, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { isNamespaceRef } from '../model.ts'
import { createListing, getManyConcurrently, hostOf, phased, requireThread, resolveToken, summariseChecks, syntheticReview, toPage, toWarning } from '../utils.ts'
import { nativeEventsFor } from '../webhooks.ts'
import {
  FORGE,
  normaliseMarkdown,
  toActivityEvent,
  toActor,
  toBranch,
  toChangedFile,
  toComment,
  toCommentEvent,
  toCommit,
  toCommitThread,
  toMergeMethod,
  toPullThread,
  toRepo,
  toStatusCheck,
  toStrategy,
  toTag,
  toTreeEntry,
  toWebhook,
} from './normalise.ts'
import { bitbucketWeb } from './web.ts'
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
const BITBUCKET: ProviderDefinition<BitbucketOptions> = {
  forge: FORGE,

  baseUrl: 'https://api.bitbucket.org/2.0',
  anonymous: true,
  instance: host => host === 'api.bitbucket.org' ? 'bitbucket.org' : host,
  headers: { accept: 'application/json' },
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
  setup({ instance, origin: context, fetcher, baseUrl }) {
    const list = createListing(fetcher, 'pagelen', 50)
    function repoPath(ref: ResolvedThreadRef): string {
      return `/repositories/${encodeURIComponent(ref.repo.owner)}/${encodeURIComponent(ref.repo.name)}`
    }

    function threadPath(ref: ResolvedThreadRef): string {
      switch (ref.kind) {
        case 'pull_request':
          return `${repoPath(ref)}/pullrequests/${ref.number}`
        case 'commit':
          return `${repoPath(ref)}/commit/${ref.number}`
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

    async function resolveMergeMethod(ref: ResolvedThreadRef, pull: BitbucketPullRequest | undefined): Promise<MergeMethod> {
      const branch = pull?.destination?.branch?.name
        ?? (await fetcher.json<BitbucketPullRequest>(threadPath(ref))).data.destination?.branch?.name
      const { data } = await fetcher.json<BitbucketBranch>(`${repoPath(ref)}/refs/branches/${encodeURIComponent(branch ?? '')}`)
      return soleMergeMethod(Object.fromEntries((data.merge_strategies ?? [])
        .map(toMergeMethod)
        .filter((method): method is MergeMethod => method !== undefined)
        .map(method => [method, true])), context)
    }

    async function merge(thread: ThreadRef, mergeOptions: MergeOptions = {}, hooks: MergeHooks = {}): Promise<void> {
      const ref = requireThread(thread, context)
      if (ref.kind !== 'pull_request') {
        throw new UnsupportedOperationError('Only pull requests can be merged', context)
      }
      if (mergeOptions.whenChecksPass) {
        throw new UnsupportedOperationError('Bitbucket Cloud cannot queue a merge until checks pass through the API', context)
      }
      let pull: BitbucketPullRequest | undefined
      if (mergeOptions.sha) {
        pull = (await fetcher.json<BitbucketPullRequest>(threadPath(ref))).data
        const head = pull.source?.commit?.hash ?? ''
        if (!head || !(mergeOptions.sha.startsWith(head) || head.startsWith(mergeOptions.sha))) {
          throw new MergeConflictError(`Pull request head is ${head || 'unknown'}, not ${mergeOptions.sha}`, 409, '', context)
        }
      }
      const method = mergeOptions.method ?? await resolveMergeMethod(ref, pull)
      await hooks.beforeMerge?.()
      await fetcher.raw(`${threadPath(ref)}/merge`, {
        method: 'POST',
        json: { merge_strategy: toStrategy(method), message: mergeOptions.message },
        mapError: toMergeError,
      })
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

    /** Bitbucket's source endpoints need an explicit commit or branch, so the main branch stands in. */
    async function mainBranch(repo: RepoRef): Promise<string> {
      const { data } = await fetcher.json<BitbucketRepositoryDetail>(repoPathOf(repo))
      return data.mainbranch?.name ?? 'HEAD'
    }

    async function get(thread: ThreadRef): Promise<Thread> {
      const ref = requireThread(thread, context)
      switch (ref.kind) {
        case 'pull_request': {
          const result = toPullThread(ref, (await fetcher.json<BitbucketPullRequest>(threadPath(ref))).data)
          try {
            result.checks = summariseChecks((await pullChecks(ref)).map(check => check.state))
          }
          catch (error) {
            if (!(error instanceof ForgeError)) {
              throw error
            }
            result.warnings = [...result.warnings ?? [], toWarning('checks_unreadable', error, ref.number)]
          }
          return result
        }
        case 'commit':
          return toCommitThread(ref, (await fetcher.json<BitbucketCommit>(threadPath(ref))).data)
        default:
          throw new UnsupportedOperationError(`Bitbucket has no ${ref.kind} threads`, context)
      }
    }

    async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
      if (query.kind && query.kind !== 'pull_request') {
        return { items: [], warnings: [{ code: 'kind_unsupported', message: `Bitbucket Cloud has no ${query.kind === 'issue' ? 'issues' : 'discussions'}` }] }
      }
      const warnings: ForgeWarning[] = []
      if (!query.cursor) {
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

    /**
     * Bitbucket indexes issues and pull requests per repository, so search is
     * the same `q=` filter language scoped to one repository.
     */
    async function searchThreadsPage(query: SearchQuery): Promise<Page<Thread>> {
      if (!query.repo) {
        throw new UnsupportedOperationError('Bitbucket has no cross-repository issue or pull request search; pass `repo`', context)
      }
      const warnings: ForgeWarning[] = []
      if (!query.cursor) {
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
        return [syntheticReview(ref, `participant:${participant.user?.uuid ?? actor?.login ?? ''}`, state, { author: actor, stateRaw, raw: participant })]
      })
    }

    async function createReview(thread: ThreadRef, input: ReviewInput): Promise<Review> {
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
        { method: 'POST' },
      )
      return toParticipantReviews(ref, { participants: [data] } as BitbucketPullRequest)[0]
        ?? { ref: { forge: FORGE, instance, thread: ref, id: 'participant:' }, state: 'unknown', comments: false, raw: data }
    }

    function pullChecks(ref: ResolvedThreadRef): Promise<Check[]> {
      return Array.fromAsync(all<BitbucketCommitStatus>(`${threadPath(ref)}/statuses`), status => toStatusCheck(ref.repo, status))
    }

    function commentsPath(ref: ResolvedThreadRef): string {
      return `${threadPath(ref)}/comments`
    }

    function commentPath(ref: CommentRef): string {
      return `${commentsPath(requireThread(ref.thread, context))}/${ref.id}`
    }

    return {
      traits: { poll: false, eventKinds: 'native', authKinds: ['token', 'basic', 'anonymous'] },
      normaliseMarkdown,
      users: {
        me: verb(true, async () => {
          const { data } = await fetcher.json<BitbucketUser>('/user')
          return { ...toActor(instance, data)!, raw: data }
        }),
      },
      web: bitbucketWeb(hostOf(baseUrl) === 'api.bitbucket.org' ? 'https://bitbucket.org' : baseUrl.replace(/\/2\.0$/, '')),
      webhooks: {
        listPage: verb('experimental', (target, listOptions = {}) => list(hooksPath(target), listOptions, (raw: BitbucketHook) => toWebhook(target, raw), { select: page<BitbucketHook> })),
        create: verb('experimental', async (target, input) => toWebhook(target, (await fetcher.json<BitbucketHook>(hooksPath(target), {
          method: 'POST',
          json: {
            url: input.url,
            description: 'forges',
            active: input.active ?? true,
            events: nativeEventsFor(BITBUCKET_NATIVE_EVENTS, input.events, input.nativeEvents),
            ...input.secret ? { secret: input.secret } : {},
          },
        })).data)),
        update: verb('experimental', async (ref, update) => toWebhook(ref.target, (await fetcher.json<BitbucketHook>(`${hooksPath(ref.target)}/${ref.id}`, {
          method: 'PUT',
          json: {
            ...update.url ? { url: update.url } : {},
            ...update.active === undefined ? {} : { active: update.active },
            ...update.events || update.nativeEvents ? { events: nativeEventsFor(BITBUCKET_NATIVE_EVENTS, update.events, update.nativeEvents) } : {},
            ...update.secret ? { secret: update.secret } : {},
          },
        })).data)),
        delete: verb('experimental', async (ref) => {
          await fetcher.raw(`${hooksPath(ref.target)}/${ref.id}`, { method: 'DELETE' })
        }),
        rotateSecret: verb('experimental', async (ref, secret) => toWebhook(ref.target, (await fetcher.json<BitbucketHook>(`${hooksPath(ref.target)}/${ref.id}`, {
          method: 'PUT',
          json: { secret },
        })).data)),
      },
      scopes: bitbucketScopesFor,
      repos: {
        get: verb(true, async (ref) => {
          return toRepo(instance, (await fetcher.json<BitbucketRepositoryDetail>(repoPathOf(ref))).data)
        }),
        listPage: verb('experimental', (listOptions = {}) => memberRepos(listOptions)),
      },
      search: {
        threadsPage: verb('experimental', searchThreadsPage),
        reposPage: verb('experimental', searchReposPage),
      },
      contents: {
        file: verb(true, async (repo, path, fileOptions = {}) => {
          const ref = fileOptions.ref ?? await mainBranch(repo)
          const target = `${repoPathOf(repo)}/src/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`
          const [meta, raw] = await Promise.all([
            fetcher.json<BitbucketSrcEntry>(target, { query: { format: 'meta' }, signal: fileOptions.signal }),
            fetcher.raw(target, { signal: fileOptions.signal }),
          ])
          const file = { path: meta.data.path, sha: meta.data.commit?.hash, size: meta.data.size, url: meta.data.links?.html?.href }
          return toFileContent(new Uint8Array(await raw.arrayBuffer()), file, fileOptions, context)
        }),
        treePage: verb(true, async (repo, treeOptions = {}) => {
          const ref = treeOptions.ref ?? await mainBranch(repo)
          const path = treeOptions.path?.replace(/^\/|\/$/g, '') ?? ''
          return list(`${repoPathOf(repo)}/src/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`, treeOptions, toTreeEntry, { query: { max_depth: treeOptions.recursive ? 100 : undefined }, select: page<BitbucketSrcEntry> })
        }),
        branchesPage: verb(true, (repo, listOptions = {}) => list(`${repoPathOf(repo)}/refs/branches`, listOptions, (raw: BitbucketRef) => toBranch(raw), { select: page<BitbucketRef> })),
        tagsPage: verb(true, (repo, listOptions = {}) => list(`${repoPathOf(repo)}/refs/tags`, listOptions, toTag, { select: page<BitbucketRef> })),
        resolveRef: verb(true, async (repo, ref) => (await fetcher.json<BitbucketCommitDetail>(`${repoPathOf(repo)}/commit/${encodeURIComponent(ref)}`)).data.hash),
        commitsPage: verb(true, (repo, query = {}) => list(`${repoPathOf(repo)}/commits${query.ref ? `/${encodeURIComponent(query.ref)}` : ''}`, query, (raw: BitbucketCommitDetail) => toCommit(repo, raw), { query: { path: query.path }, select: page<BitbucketCommitDetail> })),
        commit: verb(true, async (repo, sha) => {
          const [commit, files] = await Promise.all([
            fetcher.json<BitbucketCommitDetail>(`${repoPathOf(repo)}/commit/${sha}`),
            Array.fromAsync(all<BitbucketDiffStat>(`${repoPathOf(repo)}/diffstat/${sha}`), toChangedFile),
          ])
          return toCommit(repo, commit.data, files)
        }),
        compare: verb(true, async (repo, base, head) => {
          const [files, commits] = await Promise.all([
            Array.fromAsync(all<BitbucketDiffStat>(`${repoPathOf(repo)}/diffstat/${encodeURIComponent(head)}..${encodeURIComponent(base)}`), toChangedFile),
            Array.fromAsync(
              fetcher.items<BitbucketCommitDetail>(`${repoPathOf(repo)}/commits`, {
                query: { include: head, exclude: base, pagelen: 50 },
                select: page<BitbucketCommitDetail>,
              }),
              raw => toCommit(repo, raw),
            ),
          ])
          return { base, head, aheadBy: commits.length, commits, files, raw: { files, commits } }
        }),
      },
      checks: {
        list: verb(true, async (repo, sha) => ({ items: await Array.fromAsync(all<BitbucketCommitStatus>(`${repoPathOf(repo)}/commit/${sha}/statuses`), raw => toStatusCheck(repo, raw)) })),
        report: verb('experimental', async (repo, sha, input) => toStatusCheck(repo, (await fetcher.json<BitbucketCommitStatus>(`${repoPathOf(repo)}/commit/${sha}/statuses/build`, {
          method: 'POST',
          json: {
            key: input.externalId ?? input.name,
            name: input.name,
            state: STATUS_STATES[input.state],
            description: input.description,
            url: input.url,
          },
        })).data)),
      },
      threads: {
        filesPage: verb(true, (thread, listOptions = {}) => list(`${threadPath(requirePull(thread, 'read for changed files'))}/diffstat`, listOptions, toChangedFile, { select: page<BitbucketDiffStat> })),
        commitsPage: verb(true, (thread, listOptions = {}) => list(`${threadPath(requirePull(thread, 'read for commits'))}/commits`, listOptions, (raw: BitbucketCommitDetail) => toCommit(thread.repo, raw), { select: page<BitbucketCommitDetail> })),
        checks: perKind({ pull_request: true }, async thread => ({ items: await pullChecks(requireThread(thread, context)) })),
        reviewsPage: verb('emulated', async (thread) => {
          const ref = requireThread(thread, context)
          if (ref.kind !== 'pull_request') {
            throw new UnsupportedOperationError('Only pull requests have participants', context)
          }
          return { items: toParticipantReviews(ref, (await fetcher.json<BitbucketPullRequest>(threadPath(ref))).data) }
        }),
        createReview: verb('emulated', createReview),
        get: perKind({ pull_request: true, commit: 'experimental' }, get),
        getMany: verb(true, refs => getManyConcurrently(refs, get)),
        listPage: perKind({ pull_request: true }, listPage),
        eventsPage: verb(true, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> => {
          const ref = requireThread(thread, context)
          const events: ForgeEventInput[] = []
          if (ref.kind === 'pull_request') {
            let index = 0
            for await (const entry of all<BitbucketActivity>(`${threadPath(ref)}/activity`, listOptions)) {
              events.push(toActivityEvent(ref, entry, index++))
            }
          }
          else {
            for await (const comment of all<BitbucketComment>(commentsPath(ref), listOptions)) {
              events.push(toCommentEvent(ref, comment))
            }
          }
          return { items: events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()) }
        }),
        commentsPage: perKind({ pull_request: true, commit: 'experimental' }, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> => {
          const ref = requireThread(thread, context)
          return list(commentsPath(ref), listOptions, (comment: BitbucketComment) => toComment(ref, comment), { select: page<BitbucketComment> })
        }),
        comment: perKind({ pull_request: true, commit: 'experimental' }, async (thread, body) => {
          const ref = requireThread(thread, context)
          const { data } = await fetcher.json<BitbucketComment>(commentsPath(ref), {
            method: 'POST',
            json: { content: { raw: body } },
          })
          return toComment(ref, data)
        }),
        editComment: perKind({ pull_request: 'experimental', commit: 'experimental' }, async (ref, body) => {
          const { data } = await fetcher.json<BitbucketComment>(commentPath(ref), { method: 'PUT', json: { content: { raw: body } } })
          return toComment(ref.thread, data)
        }),
        deleteComment: perKind({ pull_request: 'experimental', commit: 'experimental' }, async (ref) => {
          await fetcher.raw(commentPath(ref), { method: 'DELETE' })
        }),
        create: perKind({ pull_request: 'experimental' }, async (repo, input) => {
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
          })
          return toPullThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: String(data.id) }, data)
        }),
        update: perKind({ pull_request: 'experimental' }, async (thread, input) => {
          const ref = requirePull(thread, 'updated')
          const { data } = await fetcher.json<BitbucketPullRequest>(threadPath(ref), { method: 'PUT', json: { title: input.title, description: input.body } })
          return toPullThread(ref, data)
        }),
        requestReview: perKind({ pull_request: 'experimental' }, async (thread, reviewers) => {
          const ref = requireThread(thread, context)
          if (ref.kind !== 'pull_request') {
            throw new UnsupportedOperationError('Only pull requests have reviewers', context)
          }
          const { data } = await fetcher.json<BitbucketPullRequest>(threadPath(ref))
          const uuids = new Set([...(data.reviewers ?? []).flatMap(user => user.uuid ?? []), ...reviewers.map(reviewer => accountRef(reviewer).uuid)])
          await fetcher.raw(threadPath(ref), {
            method: 'PUT',
            json: { title: data.title, reviewers: [...uuids].map(uuid => ({ uuid })) },
          })
        }),
        close: perKind({ pull_request: true }, async (thread) => {
          await fetcher.raw(`${threadPath(requirePull(thread, 'declined'))}/decline`, { method: 'POST' })
        }),
        merge: verb(true, merge),
      },
    }
  },
}

/** Creates a Bitbucket Cloud provider. */
export const bitbucket: ProviderFactoryFunction<BitbucketOptions> = /* @__PURE__ */ defineForgeProvider({ ...BITBUCKET, webhooks: bitbucketWebhooks })

/** `bitbucket()` without webhook ingestion, for bundles that never receive a delivery. */
export const bitbucketLite: ProviderFactoryFunction<BitbucketOptions> = /* @__PURE__ */ defineForgeProvider(BITBUCKET)

/** Bitbucket Cloud scopes, as an app password or OAuth consumer grants them. */
export function bitbucketScopesFor(verb: ForgeVerb): VerbScopes {
  const [group = '', name = ''] = verb.split('.')
  if (group === 'webhooks') {
    return name === 'verify' || name === 'ingest' ? {} : { token: ['webhook'] }
  }
  const writes = new Set(['comment', 'upsertComment', 'editComment', 'deleteComment', 'create', 'update', 'close', 'reopen', 'merge', 'approveAndMerge', 'approve', 'createReview', 'submitReview', 'setAssignees', 'requestReview', 'report'])
  const write = writes.has(name)
  if (group === 'threads') {
    return { token: [write ? 'issue:write' : 'issue', write ? 'pullrequest:write' : 'pullrequest'] }
  }
  if (group === 'users' || group === 'search') {
    return { token: ['account'] }
  }
  return { token: [write ? 'repository:write' : 'repository'] }
}
