import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { Check, Comment, Cursor, ForgeEventInput, ForgeWarning, Installation, ListOptions, MergeMethod, Page, PageOptions, Repo, RepoRef, ResolvedThreadRef, Review, ReviewEvent, ReviewInput, Thread, ThreadQuery, ThreadRef } from '../model.ts'
import type { ForgeOptionsBase, InstallationsApi } from '../provider.ts'
import type { CursorOriginAuth, OriginAppCredentials } from './auth.ts'
import type { OriginBlob, OriginBranch, OriginCheckRun, OriginComment, OriginCommit, OriginCommitFile, OriginComparison, OriginContent, OriginGitRef, OriginInstallation, OriginPullRequest, OriginRepo, OriginReview, OriginTree } from './types.ts'
import { fromBase64, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { ForgeError, soleMergeMethod, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { createFetcher as createFetcherBase } from '../fetch.ts'
import { forgeIterable, getManyConcurrently, iteratePages, phased, requireThread, summariseChecks, toWarning } from '../utils.ts'
import { createOriginAppCredentials } from './auth.ts'
import { FORGE, isConversationComment, toBranch, toChangedFile, toCheck, toComment, toCommentEvent, toCommit, toRepo, toReview, toReviewEvent, toTag, toThread, toTreeEntry } from './normalise.ts'
import { cursorOriginWebhooks } from './webhooks.ts'

export type { CursorOriginAuth } from './auth.ts'

/** The Origin API version this provider was built against. See `docs/providers/cursor-origin.md`. */
export const ORIGIN_API_VERSION = 'v1alpha1'

export interface CursorOriginOptions extends ForgeOptionsBase {
  auth: CursorOriginAuth
  /** API root. Defaults to `https://api.cursor.com`; `/v1/origin` is appended. */
  baseUrl?: string
}

const PULL = { pull_request: true } as const
const PAGE_SIZE = 50
function installationId(installation: Installation | string): string {
  return typeof installation === 'string' ? installation : installation.id
}

function setupOrigin({ options, baseUrl, instance, origin: context, fetcher, createFetcher, derive, state: credentials }: ProviderContext<CursorOriginOptions, OriginAppCredentials | undefined>): ProviderSpec {
  const repoPath = (repo: RepoRef) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  const pullPath = (ref: ResolvedThreadRef) => `${repoPath(ref.repo)}/pulls/${ref.number}`

  async function tokenPage<T>(path: string, field: string, listOptions: { perPage?: number, cursor?: Cursor, signal?: AbortSignal, query?: Record<string, string | number | boolean | undefined> }, from = fetcher): Promise<{ items: T[], cursor?: Cursor }> {
    const { data } = await from.json<Record<string, unknown>>(path, {
      query: { ...listOptions.query, pageSize: Math.min(listOptions.perPage ?? PAGE_SIZE, 100), pageToken: listOptions.cursor?.token },
      signal: listOptions.signal,
    })
    const next = data.nextPageToken as string | undefined
    return { items: (data[field] ?? []) as T[], cursor: next ? { token: next } : undefined }
  }

  function all<T>(path: string, field: string, query?: Record<string, string>): Promise<T[]> {
    return Array.fromAsync(iteratePages(page => tokenPage<T>(path, field, { ...page, query })))
  }

  async function headChecks(repo: RepoRef, sha: string): Promise<Check[]> {
    return (await all<OriginCheckRun>(`${repoPath(repo)}/commits/${sha}/check-runs`, 'checkRuns')).map(raw => toCheck(repo, raw))
  }

  async function get(thread: ThreadRef): Promise<Thread> {
    const ref = requireThread(thread, context)
    const { data } = await fetcher.json<OriginPullRequest>(pullPath(ref))
    const result = toThread(ref, data)
    const sha = data.version?.headSha ?? data.head?.sha
    if (sha) {
      try {
        result.checks = summariseChecks((await headChecks(ref.repo, sha)).map(check => check.state))
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

  const VERDICTS: Record<ReviewEvent, OriginReview['verdict']> = { approve: 'approve', request_changes: 'request_changes', comment: 'comment' }

  async function createReview(thread: ThreadRef, input: ReviewInput): Promise<Review> {
    const ref = requireThread(thread, context)
    if (!input.event) {
      throw new UnsupportedOperationError('Cursor Origin has no pending reviews; pass an event', context)
    }
    if (input.comments?.length) {
      throw new UnsupportedOperationError('Cursor Origin takes inline comments as their own requests, not with a review', context)
    }
    const { data } = await fetcher.json<OriginReview>(`${pullPath(ref)}/reviews`, {
      method: 'POST',
      json: { verdict: VERDICTS[input.event], body: input.body ?? '' },
    })
    return toReview(ref, data)
  }

  async function setThreadResolved(id: string, resolved: boolean): Promise<void> {
    await fetcher.raw(`/pulls/threads/${encodeURIComponent(id)}`, { method: 'PATCH', json: { resolved } })
  }

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    if (query.kind === 'issue' || query.kind === 'discussion') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: `Cursor Origin has pull requests only, no ${query.kind}s` }] }
    }
    const warnings: ForgeWarning[] = []
    if (!query.cursor) {
      if (query.labels?.length || query.assignee) {
        warnings.push({ code: 'filter_unsupported', message: 'Cursor Origin cannot filter pull requests by label or assignee; those filters were ignored' })
      }
      if (query.sort === 'comments') {
        warnings.push({ code: 'sort_unsupported', message: 'Cursor Origin cannot sort by comment count; sorted by creation time' })
      }
    }
    const page = await tokenPage<OriginPullRequest>(`${repoPath(repo)}/pulls`, 'pullRequests', {
      ...query,
      query: {
        state: query.state ?? 'open',
        author: query.author,
        sortBy: query.sort === 'updated' ? 'updated' : 'created',
        direction: query.direction ?? 'desc',
        since: query.createdAfter?.toISOString(),
      },
    })
    const since = query.since?.getTime()
    return {
      items: page.items
        .map(raw => toThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: raw.number }, raw))
        .filter(thread => since === undefined || (thread.updatedAt?.getTime() ?? 0) >= since),
      cursor: page.cursor,
      ...warnings.length ? { warnings } : {},
    }
  }

  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireThread(thread, context)
    const page = await tokenPage<OriginComment>(`${pullPath(ref)}/comments`, 'comments', listOptions)
    return { items: page.items.filter(isConversationComment).map(raw => toComment(ref, raw)), cursor: page.cursor }
  }

  async function eventsPage(thread: ThreadRef): Promise<Page<ForgeEventInput>> {
    const ref = requireThread(thread, context)
    const [comments, reviews] = await Promise.all([
      all<OriginComment>(`${pullPath(ref)}/comments`, 'comments'),
      all<OriginReview>(`${pullPath(ref)}/reviews`, 'reviews'),
    ])
    const events = [...comments.map(raw => toCommentEvent(ref, raw)), ...reviews.filter(review => review.submittedAt).map(raw => toReviewEvent(ref, raw))]
    return { items: events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()) }
  }

  async function reposPage(listOptions: { perPage?: number, cursor?: Cursor, signal?: AbortSignal } = {}, from = fetcher): Promise<Page<Repo>> {
    const page = await tokenPage<OriginRepo>('/installation/repos', 'repositories', listOptions, from)
    return { items: page.items.map(raw => toRepo(instance, raw)), cursor: page.cursor }
  }

  /** A user token has no single repository listing, so each namespace the user belongs to is listed in turn. */
  async function userReposPage(listOptions: { perPage?: number, cursor?: Cursor, signal?: AbortSignal } = {}): Promise<Page<Repo>> {
    const namespaces = await all<{ slug: string }>('/namespaces', 'namespaces')
    if (!namespaces.length) {
      return { items: [] }
    }
    return phased(namespaces.map(namespace => async (cursor?: Cursor): Promise<Page<Repo>> => {
      const page = await tokenPage<OriginRepo>(`/repos/${encodeURIComponent(namespace.slug)}`, 'repositories', { ...listOptions, cursor })
      return { items: page.items.map(raw => toRepo(instance, raw)), cursor: page.cursor }
    }), listOptions.cursor)
  }

  function createInstallationsApi(app: OriginAppCredentials): Omit<InstallationsApi, 'list' | 'repos'> {
    const appFetcher = createFetcher({ baseUrl, authHeaders: async () => ({ authorization: `Bearer ${await app.appJwt()}` }) })
    const auth = options.auth as Extract<CursorOriginAuth, { type: 'app' }>
    const toInstallation = (raw: OriginInstallation): Installation => ({
      forge: FORGE,
      instance,
      id: raw.id,
      targetTypeRaw: raw.target?.type,
      repositorySelectionRaw: raw.repoSelectionMode,
      ...raw.target ? { account: { forge: FORGE, instance, login: raw.target.slug, id: raw.target.id ?? raw.target.slug, typeRaw: raw.target.type, isBotHint: false } } : {},
      raw,
    })
    const provider = (installation: Installation | string) => derive({ ...options, auth: { ...auth, installationId: installationId(installation) } }, app)
    const listPage = async (listOptions: PageOptions = {}): Promise<Page<Installation>> => {
      const page = await tokenPage<OriginInstallation>('/app/installations', 'installations', listOptions, appFetcher)
      return { items: page.items.map(toInstallation), cursor: page.cursor }
    }
    return {
      listPage,
      get: async installation => toInstallation((await appFetcher.json<OriginInstallation>(`/app/installations/${installationId(installation)}`)).data),
      token: installation => app.installationTokenDetails(installationId(installation)),
      reposPage(installation, listOptions) {
        const id = installationId(installation)
        return reposPage(listOptions, createFetcher({ baseUrl, authHeaders: async () => ({ authorization: `Bearer ${await app.installationToken(id)}` }) }))
      },
      provider,
      providers: () => forgeIterable(async function* () {
        for await (const installation of iteratePages(listPage)) {
          yield { installation, provider: provider(installation) }
        }
      }),
    }
  }

  const auth = options.auth
  const repoAccess = auth.type === 'token' || auth.installationId !== undefined

  return {
    checks: {
      list: verb('experimental', async (repo, sha) => ({ items: await headChecks(repo, sha) })),
    },
    contents: {
      file: verb('experimental', async (repo, path, fileOptions = {}) => {
        const { data } = await fetcher.json<OriginContent>(`${repoPath(repo)}/contents`, {
          query: { path, ref: fileOptions.ref },
          signal: fileOptions.signal,
        })
        const file = { path: data.path, sha: data.sha, size: data.size === undefined ? undefined : Number(data.size) }
        // Origin rejects inline contents over 1 MiB; the blob endpoint serves up to 4 MiB.
        const content = data.content ?? (data.sha
          ? (await fetcher.json<OriginBlob>(`${repoPath(repo)}/git/blobs/${data.sha}`, { signal: fileOptions.signal })).data.content
          : '')
        return toFileContent(fromBase64(content), file, fileOptions, context)
      }),
      treePage: verb('experimental', async (repo, treeOptions = {}) => {
        const ref = treeOptions.ref ?? 'HEAD'
        const { data } = await fetcher.json<OriginTree>(`${repoPath(repo)}/git/trees/${encodeURIComponent(ref)}`, {
          query: { recursive: treeOptions.recursive ? 'true' : undefined },
          signal: treeOptions.signal,
        })
        const prefix = treeOptions.path?.replace(/^\/|\/$/g, '')
        const entries = (data.tree ?? []).filter(entry => !prefix || entry.path.startsWith(`${prefix}/`))
        return {
          items: entries.map(toTreeEntry),
          ...data.truncated ? { warnings: [{ code: 'tree_truncated' as const, message: 'Origin truncated the tree; read subtrees non-recursively instead', subject: ref }] } : {},
        }
      }),
      branchesPage: verb('experimental', async (repo, listOptions = {}) => {
        const page = await tokenPage<OriginBranch>(`${repoPath(repo)}/branches`, 'branches', listOptions)
        return { items: page.items.map(toBranch), cursor: page.cursor }
      }),
      tagsPage: verb('experimental', async (repo, listOptions = {}) => {
        const { data } = await fetcher.json<OriginGitRef[]>(`${repoPath(repo)}/git/matching-refs`, { query: { ref: 'tags/' }, signal: listOptions.signal })
        return { items: (data ?? []).map(toTag) }
      }),
      resolveRef: verb('experimental', async (repo, ref) => (await fetcher.json<OriginCommit>(`${repoPath(repo)}/commits/${encodeURIComponent(ref)}`)).data.sha),
      commitsPage: verb('experimental', async (repo, query = {}) => {
        const page = await tokenPage<OriginCommit>(`${repoPath(repo)}/commits`, 'commits', {
          ...query,
          query: { sha: query.ref, authorEmails: query.author, since: query.since?.toISOString() },
        })
        return { items: page.items.map(raw => toCommit(repo, raw)), cursor: page.cursor }
      }),
      commit: verb('experimental', async (repo, sha) => {
        const [commit, files] = await Promise.all([
          fetcher.json<OriginCommit>(`${repoPath(repo)}/commits/${sha}`),
          all<OriginCommitFile>(`${repoPath(repo)}/commits/${sha}/files`, 'files'),
        ])
        return toCommit(repo, commit.data, files.map(toChangedFile))
      }),
      compare: verb('experimental', async (repo, base, head) => {
        const basehead = encodeURIComponent(`${base}...${head}`)
        const [comparison, files] = await Promise.all([
          fetcher.json<OriginComparison>(`${repoPath(repo)}/compare/${basehead}`),
          all<OriginCommitFile>(`${repoPath(repo)}/compare/${basehead}/files`, 'files'),
        ])
        return {
          base,
          head,
          aheadBy: comparison.data.aheadBy,
          behindBy: comparison.data.behindBy,
          mergeBaseSha: comparison.data.mergeBaseCommit?.sha,
          commits: [],
          files: files.map(toChangedFile),
          raw: comparison.data,
        }
      }),
    },
    traits: { poll: false, eventKinds: 'native', auth: ['token', 'app'] },
    repos: {
      get: verb(true, async ref => toRepo(instance, (await fetcher.json<OriginRepo>(repoPath(ref))).data)),
      listPage: verb(repoAccess && 'experimental', async (listOptions = {}) => {
        if (auth.type === 'app') {
          if (auth.installationId === undefined) {
            throw new UnsupportedOperationError('An app without an installation has no repositories; use installations.repos()', context)
          }
          return reposPage(listOptions)
        }
        return userReposPage(listOptions)
      }),
    },
    installations: credentials && auth.type === 'app' && auth.installationId === undefined ? verb(true, createInstallationsApi(credentials)) : undefined,
    threads: {
      get: perKind(PULL, get),
      getMany: verb(true, refs => getManyConcurrently(refs, get)),
      listPage: perKind(PULL, listPage),
      eventsPage: verb(true, eventsPage),
      filesPage: verb('experimental', async (thread, listOptions = {}) => {
        const page = await tokenPage<OriginCommitFile>(`${pullPath(requireThread(thread, context))}/files`, 'files', listOptions)
        return { items: page.items.map(toChangedFile), cursor: page.cursor }
      }),
      commitsPage: verb('experimental', async (thread, listOptions = {}) => {
        const page = await tokenPage<OriginCommit>(`${pullPath(requireThread(thread, context))}/commits`, 'commits', listOptions)
        return { items: page.items.map(raw => toCommit(thread.repo, raw)), cursor: page.cursor }
      }),
      commentsPage: perKind(PULL, commentsPage),
      comment: perKind(PULL, async (thread, body) => {
        const ref = requireThread(thread, context)
        return toComment(ref, (await fetcher.json<OriginComment>(`${pullPath(ref)}/comments`, { method: 'POST', json: { body } })).data)
      }),
      editComment: perKind({ pull_request: 'experimental' }, async (ref, body) => toComment(ref.thread, (await fetcher.json<OriginComment>(`${repoPath(ref.thread.repo)}/pulls/comments/${ref.id}`, { method: 'PATCH', json: { body } })).data)),
      deleteComment: perKind({ pull_request: 'experimental' }, async (ref) => {
        await fetcher.raw(`${repoPath(ref.thread.repo)}/pulls/comments/${ref.id}`, { method: 'DELETE' })
      }),
      create: perKind({ pull_request: 'experimental' }, async (repo, input) => {
        if (input.assignees?.length) {
          throw new UnsupportedOperationError('Cursor Origin pull requests have no assignees', context)
        }
        if (!input.head || !input.base) {
          throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
        }
        const { data } = await fetcher.json<OriginPullRequest>(`${repoPath(repo)}/pulls`, {
          method: 'POST',
          json: { title: input.title, body: input.body ?? '', head: input.head, base: input.base, draft: input.draft ?? false },
        })
        const ref: ResolvedThreadRef = { forge: FORGE, instance, repo, kind: 'pull_request', number: data.number }
        if (input.labels?.length) {
          await fetcher.raw(`${pullPath(ref)}/labels`, { method: 'PUT', json: { labels: input.labels } })
        }
        return toThread(ref, data)
      }),
      update: perKind({ pull_request: 'experimental' }, async (thread, input) => {
        const ref = requireThread(thread, context)
        return toThread(ref, (await fetcher.json<OriginPullRequest>(pullPath(ref), { method: 'PATCH', json: input })).data)
      }),
      close: perKind(PULL, async (thread) => {
        await fetcher.raw(pullPath(requireThread(thread, context)), { method: 'PATCH', json: { state: 'closed' } })
      }),
      reopen: perKind(PULL, async (thread) => {
        await fetcher.raw(pullPath(requireThread(thread, context)), { method: 'PATCH', json: { state: 'open' } })
      }),
      setLabels: perKind({ pull_request: 'experimental' }, async (thread, labels) => {
        await fetcher.raw(`${pullPath(requireThread(thread, context))}/labels`, { method: 'PUT', json: { labels } })
      }),
      requestReview: perKind({ pull_request: 'experimental' }, async (thread, reviewers) => {
        const users = reviewers.map(reviewer => typeof reviewer === 'string' ? reviewer : reviewer.id)
        await fetcher.raw(`${pullPath(requireThread(thread, context))}/requested_reviewers`, { method: 'POST', json: { users } })
      }),
      merge: verb(true, async (thread, mergeOptions = {}, hooks = {}) => {
        const ref = requireThread(thread, context)
        if (mergeOptions.whenChecksPass) {
          throw new UnsupportedOperationError('Cursor Origin has no merge queue or auto-merge', context)
        }
        if (mergeOptions.message) {
          throw new UnsupportedOperationError('Cursor Origin does not take a merge commit message', context)
        }
        if (mergeOptions.method && mergeOptions.method !== 'merge' && mergeOptions.method !== 'squash') {
          throw new UnsupportedOperationError(`Cursor Origin does not support the ${mergeOptions.method} merge method`, context)
        }
        let method: MergeMethod | undefined = mergeOptions.method
        if (!method) {
          const { data: repo } = await fetcher.json<OriginRepo>(repoPath(ref.repo))
          method = soleMergeMethod({ merge: repo.allowMergeCommit, squash: repo.allowSquashMerge }, context)
        }
        await hooks.beforeMerge?.()
        await fetcher.raw(`${pullPath(ref)}/merge`, { method: 'POST', json: { mergeMethod: method, expectedHeadSha: mergeOptions.sha }, mapError: toMergeError })
      }),
      reviewsPage: verb(true, async (thread, listOptions: PageOptions = {}) => {
        const ref = requireThread(thread, context)
        const page = await tokenPage<OriginReview>(`${pullPath(ref)}/reviews`, 'reviews', listOptions)
        return { items: page.items.map(raw => toReview(ref, raw)), cursor: page.cursor }
      }),
      createReview: verb('experimental', createReview),
      reviewThreads: verb('experimental', {
        resolveReviewThread: (_thread, id) => setThreadResolved(id, true),
        unresolveReviewThread: (_thread, id) => setThreadResolved(id, false),
      }),
      checks: perKind(PULL, async (thread) => {
        const ref = requireThread(thread, context)
        const { data } = await fetcher.json<OriginPullRequest>(pullPath(ref))
        const sha = data.version?.headSha ?? data.head?.sha
        return { items: sha ? await headChecks(ref.repo, sha) : [] }
      }),
    },
    webhooks: {
    },
    scopes: () => ({ note: 'An Origin app installation token; Origin has no per-verb scopes' }),
  }
}

const ORIGIN: ProviderDefinition<CursorOriginOptions, OriginAppCredentials | undefined> = {
  kind: FORGE,
  experimental: true,
  baseUrl: 'https://api.cursor.com',
  apiPath: '/v1/origin',
  instance: host => host === 'api.cursor.com' ? 'origin.cursor.com' : host,
  headers: { accept: 'application/json' },
  prepare: ({ options, state, baseUrl, headers }) => options.auth.type === 'app'
    ? state ?? createOriginAppCredentials(options.auth, authHeaders => createFetcherFor(baseUrl, headers, options, authHeaders))
    : undefined,
  authHeaders: ({ options, state }) => {
    const auth = options.auth
    if (auth.type === 'token') {
      return () => ({ authorization: `Bearer ${auth.token}` })
    }
    const app = state!
    return auth.installationId === undefined
      ? async () => ({ authorization: `Bearer ${await app.appJwt()}` })
      : async () => ({ authorization: `Bearer ${await app.installationToken(String(auth.installationId))}` })
  },
  setup: setupOrigin,
}

/**
 * Creates a Cursor Origin provider. Experimental: built against the
 * `v1alpha1` API, which Cursor publishes as Early Beta.
 */
export const cursorOrigin: ProviderFactoryFunction<CursorOriginOptions> = /* @__PURE__ */ defineForgeProvider({ ...ORIGIN, webhooks: cursorOriginWebhooks })

/** `cursorOrigin()` without webhook ingestion, for bundles that never receive a delivery. */
export const cursorOriginLite: ProviderFactoryFunction<CursorOriginOptions> = /* @__PURE__ */ defineForgeProvider(ORIGIN)

function createFetcherFor(baseUrl: string, headers: Record<string, string>, options: CursorOriginOptions, authHeaders: () => Promise<Record<string, string>>) {
  return createFetcherBase({ baseUrl, headers, fetch: options.fetch, timeout: options.timeout, authHeaders, context: { forge: FORGE } })
}
