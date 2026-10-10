import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { BaseOptions, Check, Comment, Cursor, EventKind, ForgeEventInput, ForgeWarning, ListOptions, Notification, NotificationListOptions, Page, PageOptions, Release, Repo, RepoRef, RepoSearchQuery, ResolvedThreadRef, Review, ReviewInput, SearchQuery, Thread, ThreadQuery, ThreadRef, User } from '../model.ts'
import type { AnonymousAuth, BulkNotificationOptions, ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { GiteeBranch, GiteeCheckRun, GiteeComment, GiteeCommit, GiteeCommitFile, GiteeCompare, GiteeContentFile, GiteeHook, GiteeIssue, GiteeLabel, GiteeNotification, GiteeOperateLog, GiteePullRequest, GiteeRelease, GiteeRepository, GiteeTag, GiteeTree, GiteeUser } from './types.ts'
import { fromBase64, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { ForgeError, MergeMethodRequiredError, NotFoundError, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { actorLogin, getManyConcurrently, hasEveryLabel, hexColour, iteratePages, phased, requireIssueOrPull, requireThread, resolveToken, summariseChecks, toDate, toWarning } from '../utils.ts'
import { githubShapedWeb } from '../web.ts'
import { nativeEventsFor } from '../webhooks.ts'
import { FORGE, isConversationComment, toActor, toBranch, toChangedFile, toCheck, toComment, toCommentEvent, toCommit, toIssueThread, toLogEvent, toNotification, toPullThread, toRelease, toRepo, toRepoRef, toTag, toTreeEntry, toWebhook } from './normalise.ts'
import { GITEE_NATIVE_EVENTS } from './webhook-events.ts'
import { giteeWebhooks } from './webhooks.ts'

/** A personal access token or OAuth access token, sent as `Authorization: token`. */
export type GiteeAuth = TokenAuth | AnonymousAuth

/** Options for `gitee()`. */
export interface GiteeOptions extends ForgeOptionsBase {
  /**
   * How to authenticate. Without credentials, only public reads work.
   * @default { type: 'anonymous' }
   */
  auth?: GiteeAuth
  /**
   * Instance root. `/api/v5` is appended.
   * @default https://gitee.com
   */
  baseUrl?: string
}

const PULL = { pull_request: true } as const
const PER_PAGE = 50

function setupGitee({ instance, origin: context, fetcher, baseUrl }: ProviderContext<GiteeOptions, undefined>): ProviderSpec {
  const repoPath = (repo: RepoRef) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  async function readUser(path: string, signal?: AbortSignal): Promise<User> {
    const { data } = await fetcher.json<GiteeUser & { bio?: string | null, company?: string | null, blog?: string | null, created_at?: string, followers?: number, following?: number, public_repos?: number }>(path, { signal })
    return { ...toActor(instance, data)!, bio: data.bio ?? undefined, company: data.company ?? undefined, websiteUrl: data.blog || undefined, createdAt: toDate(data.created_at), followers: data.followers, following: data.following, publicRepos: data.public_repos, raw: data }
  }

  function requirePull(thread: ThreadRef, action: string): ResolvedThreadRef {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError(`Only pull requests can be ${action}`, context)
    }
    return ref
  }

  const threadPath = (ref: ResolvedThreadRef) => `${repoPath(ref.repo)}/${ref.kind === 'pull_request' ? 'pulls' : 'issues'}/${encodeURIComponent(ref.number)}`

  /**
   * Gitee pages by number and reports the page count in `total_page`. The
   * cursor carries the next page's URL, with the same filters.
   */
  async function numberedPage<T>(path: string, query: Record<string, string | number | boolean | undefined>, listOptions: PageOptions): Promise<{ items: T[], cursor?: Cursor }> {
    const perPage = Math.min(listOptions.perPage ?? PER_PAGE, 100)
    const url = listOptions.cursor?.nextUrl ?? fetcher.resolve(path, { ...query, page: 1, per_page: perPage })
    const page = Number(new URL(url).searchParams.get('page') ?? 1)
    const { data, response } = await fetcher.json<T[]>(url, { signal: listOptions.signal })
    const items = data ?? []
    const total = Number(response.headers.get('total_page'))
    const more = Number.isFinite(total) && total > 0 ? page < total : items.length === perPage
    return { items, cursor: more ? { nextUrl: nextPage(url, page) } : undefined }
  }

  function nextPage(url: string, page: number): string {
    const next = new URL(url)
    next.searchParams.set('page', String(page + 1))
    return next.toString()
  }

  function all<T>(path: string, options: BaseOptions = {}): Promise<T[]> {
    return Array.fromAsync(iteratePages<T, PageOptions>(page => numberedPage<T>(path, {}, page), { signal: options.signal }))
  }

  /** Gitee records an approval, with no review object to read back. */
  async function createReview(thread: ThreadRef, input: ReviewInput, options?: BaseOptions): Promise<Review> {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError('Only pull requests can be reviewed', context)
    }
    if (input.event !== 'approve') {
      throw new UnsupportedOperationError('Gitee records approvals only; post anything else as a comment', context)
    }
    if (input.comments?.length) {
      throw new UnsupportedOperationError('Gitee approvals carry no inline comments', context)
    }
    const { data } = await fetcher.json<{ id?: number }>(`${threadPath(ref)}/review`, { method: 'POST', json: input.body ? { body: input.body } : {}, signal: options?.signal })
    return {
      ref: { forge: FORGE, instance, thread: ref, id: String(data?.id ?? 'approval') },
      state: 'approved',
      stateRaw: 'approved',
      body: input.body,
      comments: false,
      raw: data,
    }
  }

  async function headChecks(repo: RepoRef, sha: string, signal?: AbortSignal): Promise<Check[]> {
    const { data } = await fetcher.json<GiteeCheckRun[] | { check_runs?: GiteeCheckRun[] }>(`${repoPath(repo)}/commits/${sha}/check-runs`, { signal })
    return (Array.isArray(data) ? data : data.check_runs ?? []).map(raw => toCheck(repo, raw))
  }

  async function get(thread: ThreadRef, options?: BaseOptions): Promise<Thread> {
    const ref = requireIssueOrPull(thread, context, 'read')
    if (ref.kind === 'issue') {
      return toIssueThread(ref, (await fetcher.json<GiteeIssue>(threadPath(ref), { signal: options?.signal })).data)
    }
    const { data } = await fetcher.json<GiteePullRequest>(threadPath(ref), { signal: options?.signal })
    const result = toPullThread(ref, data)
    if (data.head?.sha) {
      try {
        result.checks = summariseChecks((await headChecks(ref.repo, data.head.sha, options?.signal)).map(check => check.state))
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

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    if (query.kind === 'discussion') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: 'Gitee has no discussions' }] }
    }
    const warnings: ForgeWarning[] = []
    if (!query.cursor) {
      if (query.sort === 'comments') {
        warnings.push({ code: 'sort_unsupported', message: 'Gitee cannot sort by comment count; sorted by creation time' })
      }
      if (query.assignee && query.kind !== 'issue') {
        warnings.push({ code: 'filter_unsupported', message: 'Gitee pull requests have reviewers, not assignees; the assignee filter applies to issues only' })
      }
    }
    const state = query.state ?? 'open'
    const createdAfter = query.createdAfter?.getTime()
    const phases: Array<{ kind: 'issue' | 'pull_request', state: string }> = []
    for (const kind of query.kind ? [query.kind] : ['issue', 'pull_request'] as const) {
      const states = kind === 'issue'
        ? state === 'open' ? ['open', 'progressing'] : state === 'closed' ? ['closed', 'rejected'] : ['all']
        : state === 'closed' ? ['closed', 'merged'] : [state]
      phases.push(...states.map(value => ({ kind, state: value })))
    }
    const page = await phased(phases.map(phase => async (cursor?: Cursor): Promise<Page<Thread>> => {
      const pulls = phase.kind === 'pull_request'
      const result = await numberedPage<GiteeIssue & GiteePullRequest>(`${repoPath(repo)}/${pulls ? 'pulls' : 'issues'}`, {
        state: phase.state,
        labels: query.labels?.join(','),
        sort: query.sort === 'updated' ? 'updated' : 'created',
        direction: query.direction ?? 'desc',
        since: query.since?.toISOString(),
        ...pulls ? { author: query.author } : { creator: query.author, assignee: query.assignee },
      }, { perPage: query.perPage, cursor, signal: query.signal })
      return {
        items: result.items
          .filter(raw => (createdAfter === undefined || (Date.parse(raw.created_at ?? '') || 0) >= createdAfter) && hasEveryLabel(raw.labels, query.labels))
          .map((raw) => {
            const ref: ResolvedThreadRef = { forge: FORGE, instance, repo, kind: phase.kind, number: String(raw.number) }
            return pulls ? toPullThread(ref, raw) : toIssueThread(ref, raw)
          }),
        cursor: result.cursor,
      }
    }), query.cursor)
    return warnings.length ? { ...page, warnings: [...warnings, ...page.warnings ?? []] } : page
  }

  /** Gitee subscribes with one boolean per event group rather than a list of names. */
  function hookFlags(input: { events?: EventKind[], nativeEvents?: string[] }): Record<string, boolean> {
    return Object.fromEntries(nativeEventsFor(GITEE_NATIVE_EVENTS, input.events, input.nativeEvents).map(flag => [flag, true]))
  }

  /** Gitee searches issues only; its pull requests have no search endpoint. */
  async function searchThreadsPage(query: SearchQuery): Promise<Page<Thread>> {
    if (query.kind === 'pull_request') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: 'Gitee has no pull request search' }] }
    }
    const warnings: ForgeWarning[] = []
    if (!query.cursor && query.involves) {
      warnings.push({ code: 'filter_unsupported', message: 'Gitee has no involves filter; it was ignored' })
    }
    if (!query.cursor && query.since) {
      warnings.push({ code: 'filter_unsupported', message: 'Gitee issue search has no update-time filter; it was ignored' })
    }
    const page = await numberedPage<GiteeIssue>('/search/issues', {
      q: query.text ?? '',
      repo: query.repo ? `${query.repo.owner}/${query.repo.name}` : undefined,
      state: query.state && query.state !== 'all' ? query.state : undefined,
      label: query.labels?.join(','),
      author: query.author,
      assignee: query.assignee,
      sort: query.sort === 'updated' ? 'updated_at' : 'created_at',
      order: query.direction ?? 'desc',
    }, { perPage: query.perPage, cursor: query.cursor, signal: query.signal })
    return {
      items: page.items.flatMap((raw) => {
        const repo = query.repo ?? (raw.repository && toRepoRef(instance, raw.repository))
        return repo && hasEveryLabel(raw.labels, query.labels) ? [toIssueThread({ forge: FORGE, instance, repo, kind: 'issue', number: raw.number }, raw)] : []
      }),
      cursor: page.cursor,
      ...warnings.length ? { warnings } : {},
    }
  }

  async function searchReposPage(query: RepoSearchQuery): Promise<Page<Repo>> {
    const page = await numberedPage<GiteeRepository>('/search/repositories', {
      q: query.text ?? '',
      owner: query.owner,
      language: query.language,
      sort: query.sort === 'stars' ? 'stars_count' : query.sort === 'updated' ? 'last_push_at' : undefined,
      order: query.direction ?? 'desc',
    }, { perPage: query.perPage, cursor: query.cursor, signal: query.signal })
    const warnings = query.sort === 'created' && !query.cursor ? [{ code: 'sort_unsupported', message: 'Gitee has no repository search by creation time; sorted by best match' }] : undefined
    return { items: page.items.map(raw => toRepo(instance, raw)), cursor: page.cursor, warnings }
  }

  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireIssueOrPull(thread, context, 'list comments on')
    const page = await numberedPage<GiteeComment>(`${threadPath(ref)}/comments`, {}, listOptions)
    return { items: page.items.filter(isConversationComment).map(raw => toComment(ref, raw)), cursor: page.cursor }
  }

  /** Comments and the operation log, merged and ordered by time, so one complete page. */
  async function eventsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> {
    const ref = requireIssueOrPull(thread, context, 'list events on')
    const logsPath = ref.kind === 'pull_request'
      ? `${threadPath(ref)}/operate_logs`
      : `/repos/${encodeURIComponent(ref.repo.owner)}/issues/${encodeURIComponent(ref.number)}/operate_logs`
    const [comments, { data: logs }] = await Promise.all([
      all<GiteeComment>(`${threadPath(ref)}/comments`, listOptions),
      fetcher.json<GiteeOperateLog[]>(logsPath, { query: ref.kind === 'issue' ? { repo: ref.repo.name } : { sort: 'asc' }, signal: listOptions.signal }),
    ])
    const events = [...comments.map(raw => toCommentEvent(ref, raw)), ...(logs ?? []).map(raw => toLogEvent(ref, raw))]
    return { items: events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()) }
  }

  /** Issue writes are addressed by owner, with the repository in the body. */
  function issueWrite(ref: ResolvedThreadRef, json: Record<string, unknown>, signal?: AbortSignal) {
    return fetcher.json<GiteeIssue>(`/repos/${encodeURIComponent(ref.repo.owner)}/issues/${encodeURIComponent(ref.number)}`, { method: 'PATCH', json: { repo: ref.repo.name, ...json }, signal })
  }

  async function setState(thread: ThreadRef, state: 'open' | 'closed', options?: BaseOptions): Promise<void> {
    const ref = requireIssueOrPull(thread, context, state === 'open' ? 'reopen' : 'close')
    if (ref.kind === 'issue') {
      await issueWrite(ref, { state }, options?.signal)
      return
    }
    await fetcher.raw(threadPath(ref), { method: 'PATCH', json: { state }, signal: options?.signal })
  }

  async function notificationPage(listOptions: NotificationListOptions = {}): Promise<Page<Notification>> {
    const perPage = Math.min(listOptions.perPage ?? PER_PAGE, 100)
    const url = listOptions.cursor?.nextUrl ?? fetcher.resolve('/notifications/threads', { unread: listOptions.all ? undefined : true, since: listOptions.since?.toISOString(), page: 1, per_page: perPage })
    const page = Number(new URL(url).searchParams.get('page') ?? 1)
    const { data, response } = await fetcher.json<{ total_count?: number, list?: GiteeNotification[] }>(url, { signal: listOptions.signal })
    const items = data.list ?? []
    const totalPages = Number(response.headers.get('total_page'))
    const more = Number.isFinite(totalPages) && totalPages > 0
      ? page < totalPages
      : data.total_count !== undefined ? page * perPage < data.total_count : items.length === perPage
    return { items: items.map(raw => toNotification(instance, raw)), cursor: more ? { nextUrl: nextPage(url, page) } : undefined }
  }

  async function releasesPage(repo: RepoRef, listOptions: PageOptions = {}): Promise<Page<Release>> {
    const page = await numberedPage<GiteeRelease>(`${repoPath(repo)}/releases`, {}, listOptions)
    return { items: page.items.map(raw => toRelease(repo, raw)), cursor: page.cursor }
  }

  return {
    checks: {
      list: verb(true, async (repo, sha, options) => ({ items: await headChecks(repo, sha, options?.signal) })),
    },
    traits: { eventKinds: 'native', authKinds: ['token', 'anonymous'] },
    users: {
      get: verb(true, (login, options) => readUser(`/users/${encodeURIComponent(login)}`, options?.signal)),
      me: verb(true, options => readUser('/user', options?.signal)),
    },
    repos: {
      get: verb(true, async (ref, options) => toRepo(instance, (await fetcher.json<GiteeRepository>(repoPath(ref), { signal: options?.signal })).data)),
      listPage: verb(true, async (listOptions = {}) => {
        const page = await numberedPage<GiteeRepository>('/user/repos', {}, listOptions)
        return { items: page.items.map(raw => toRepo(instance, raw)), cursor: page.cursor }
      }),
      labelsPage: verb(true, async (repo, listOptions = {}) => {
        const page = await numberedPage<GiteeLabel>(`${repoPath(repo)}/labels`, {}, listOptions)
        return { items: page.items.map(raw => ({ name: raw.name, colour: raw.color ?? undefined })), cursor: page.cursor }
      }),
      createLabel: verb('unverified', async (repo, label, options) => {
        const { data } = await fetcher.json<GiteeLabel>(`${repoPath(repo)}/labels`, {
          method: 'POST',
          json: { name: label.name, color: hexColour(label.colour) },
          signal: options?.signal,
        })
        return { name: data.name, colour: data.color ?? undefined }
      }),
      collaboratorsPage: verb(true, async (repo, listOptions = {}) => {
        const page = await numberedPage<GiteeUser & { permissions?: { admin?: boolean, push?: boolean, pull?: boolean } }>(`${repoPath(repo)}/collaborators`, {}, listOptions)
        return {
          items: page.items.map(raw => ({
            actor: toActor(instance, raw)!,
            role: raw.permissions?.admin ? 'admin' as const : raw.permissions?.push ? 'write' as const : raw.permissions?.pull ? 'read' as const : 'none' as const,
            raw,
          })),
          cursor: page.cursor,
        }
      }),
    },
    notifications: {
      listPage: verb(true, notificationPage),
      markRead: verb(true, async (ref, options) => {
        await fetcher.raw(`/notifications/threads/${ref.id}`, { method: 'PATCH', signal: options?.signal })
      }),
      markAllRead: verb('unverified', async (bulk: BulkNotificationOptions = {}) => {
        if (bulk.before) {
          throw new UnsupportedOperationError('Gitee marks notifications read without a time bound', context)
        }
        await fetcher.raw(bulk.repo ? `${repoPath(bulk.repo)}/notifications` : '/notifications/threads', { method: 'PUT', signal: bulk.signal })
      }),
      unreadCount: verb(true, async options => (await fetcher.json<{ notification_count?: number, total_count?: number }>('/notifications/count', { query: { unread: true }, signal: options?.signal })).data.notification_count ?? 0),
    },
    contents: {
      file: verb(true, async (repo, path, fileOptions = {}) => {
        const { data } = await fetcher.json<GiteeContentFile>(`${repoPath(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
          query: { ref: fileOptions.ref },
          signal: fileOptions.signal,
        })
        const file = { path: data.path, sha: data.sha, size: data.size, url: data._links?.html }
        return toFileContent(fromBase64(data.content ?? ''), file, fileOptions, context)
      }),
      treePage: verb(true, async (repo, treeOptions = {}) => {
        const ref = treeOptions.ref ?? (await fetcher.json<GiteeRepository>(repoPath(repo), { signal: treeOptions.signal })).data.default_branch ?? 'master'
        const { data } = await fetcher.json<GiteeTree>(`${repoPath(repo)}/git/trees/${encodeURIComponent(ref)}`, {
          query: { recursive: treeOptions.recursive ? 1 : undefined },
          signal: treeOptions.signal,
        })
        const prefix = treeOptions.path?.replace(/^\/|\/$/g, '')
        const entries = (data.tree ?? []).filter(entry => !prefix || entry.path.startsWith(`${prefix}/`))
        return {
          items: entries.map(toTreeEntry),
          ...data.truncated ? { warnings: [{ code: 'tree_truncated' as const, message: 'Gitee truncated the tree; read it directory by directory instead' }] } : {},
        }
      }),
      branchesPage: verb(true, async (repo, listOptions = {}) => {
        const page = await numberedPage<GiteeBranch>(`${repoPath(repo)}/branches`, {}, listOptions)
        return { items: page.items.map(toBranch), cursor: page.cursor }
      }),
      tagsPage: verb(true, async (repo, listOptions = {}) => {
        const { data } = await fetcher.json<GiteeTag[]>(`${repoPath(repo)}/tags`, { signal: listOptions.signal })
        return { items: (data ?? []).map(toTag) }
      }),
      resolveRef: verb(true, async (repo, ref, options) => (await fetcher.json<GiteeCommit>(`${repoPath(repo)}/commits/${encodeURIComponent(ref)}`, { signal: options?.signal })).data.sha),
      commitsPage: verb(true, async (repo, query = {}) => {
        const page = await numberedPage<GiteeCommit>(`${repoPath(repo)}/commits`, {
          sha: query.ref,
          path: query.path,
          author: query.author,
          since: query.since?.toISOString(),
          until: query.until?.toISOString(),
        }, query)
        return { items: page.items.map(raw => toCommit(repo, raw)), cursor: page.cursor }
      }),
      commit: verb(true, async (repo, sha, options) => toCommit(repo, (await fetcher.json<GiteeCommit>(`${repoPath(repo)}/commits/${sha}`, { signal: options?.signal })).data)),
      compare: verb(true, async (repo, base, head, options) => {
        const { data } = await fetcher.json<GiteeCompare>(`${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { signal: options?.signal })
        return {
          base,
          head,
          aheadBy: data.commits?.length,
          commits: (data.commits ?? []).map(raw => toCommit(repo, raw)),
          files: (data.files ?? []).map(toChangedFile),
          raw: data,
        }
      }),
    },
    search: {
      threadsPage: verb(true, searchThreadsPage),
      reposPage: verb(true, searchReposPage),
    },
    releases: {
      listPage: verb(true, releasesPage),
      get: verb(true, async (ref, options) => toRelease(ref.repo, (await fetcher.json<GiteeRelease>(`${repoPath(ref.repo)}/releases/${ref.id}`, { signal: options?.signal })).data)),
      getByTag: verb(true, async (repo, tag, options) => toRelease(repo, (await fetcher.json<GiteeRelease>(`${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`, { signal: options?.signal })).data)),
      latest: verb(true, async (repo, options) => {
        try {
          const latest = toRelease(repo, (await fetcher.json<GiteeRelease>(`${repoPath(repo)}/releases/latest`, { signal: options?.signal })).data)
          if (!latest.isPrerelease) {
            return latest
          }
        }
        catch (error) {
          if (!(error instanceof NotFoundError)) {
            throw error
          }
          return undefined
        }
        return (await releasesPage(repo, { perPage: 20, signal: options?.signal })).items.find(release => !release.isPrerelease)
      }),
    },
    threads: {
      get: perKind({ issue: true, pull_request: true }, get),
      getMany: verb(true, (refs, options) => getManyConcurrently(refs, get, options)),
      listPage: perKind({ issue: true, pull_request: true }, listPage),
      eventsPage: verb(true, eventsPage),
      filesPage: verb(true, async (thread, listOptions = {}) => {
        const ref = requirePull(thread, 'read for changed files')
        const { data } = await fetcher.json<GiteeCommitFile[]>(`${threadPath(ref)}/files`, { signal: listOptions.signal })
        return { items: (data ?? []).map(toChangedFile) }
      }),
      commitsPage: verb(true, async (thread, listOptions = {}) => {
        const ref = requirePull(thread, 'read for commits')
        const { data } = await fetcher.json<GiteeCommit[]>(`${threadPath(ref)}/commits`, { signal: listOptions.signal })
        return { items: (data ?? []).map(raw => toCommit(thread.repo, raw)) }
      }),
      commentsPage: perKind({ issue: true, pull_request: true }, commentsPage),
      comment: perKind({ issue: 'unverified', pull_request: true }, async (thread, body, options) => {
        const ref = requireIssueOrPull(thread, context, 'comment on')
        return toComment(ref, (await fetcher.json<GiteeComment>(`${threadPath(ref)}/comments`, { method: 'POST', json: { body }, signal: options?.signal })).data)
      }),
      editComment: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (ref, body, options) => {
        const kind = ref.thread.kind === 'pull_request' ? 'pulls' : 'issues'
        return toComment(ref.thread, (await fetcher.json<GiteeComment>(`${repoPath(ref.thread.repo)}/${kind}/comments/${ref.id}`, { method: 'PATCH', json: { body }, signal: options?.signal })).data)
      }),
      deleteComment: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (ref, options) => {
        const kind = ref.thread.kind === 'pull_request' ? 'pulls' : 'issues'
        await fetcher.raw(`${repoPath(ref.thread.repo)}/${kind}/comments/${ref.id}`, { method: 'DELETE', signal: options?.signal })
      }),
      create: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (repo, input, options) => {
        const labels = input.labels?.join(',')
        if (input.kind === 'issue') {
          if ((input.assignees?.length ?? 0) > 1) {
            throw new UnsupportedOperationError('Gitee issues take a single assignee', context)
          }
          const { data } = await fetcher.json<GiteeIssue>(`/repos/${encodeURIComponent(repo.owner)}/issues`, {
            method: 'POST',
            json: { repo: repo.name, title: input.title, body: input.body, labels, assignee: input.assignees?.[0] ? actorLogin(input.assignees[0]) : undefined },
            signal: options?.signal,
          })
          return toIssueThread({ forge: FORGE, instance, repo, kind: 'issue', number: data.number }, data)
        }
        if (!input.head || !input.base) {
          throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
        }
        const { data } = await fetcher.json<GiteePullRequest>(`${repoPath(repo)}/pulls`, {
          method: 'POST',
          json: { title: input.title, body: input.body, head: input.head, base: input.base, labels, draft: input.draft, assignees: input.assignees?.map(actorLogin).join(',') },
          signal: options?.signal,
        })
        return toPullThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: String(data.number) }, data)
      }),
      update: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (thread, input, options) => {
        const ref = requireIssueOrPull(thread, context, 'update')
        return ref.kind === 'issue'
          ? toIssueThread(ref, (await issueWrite(ref, { ...input }, options?.signal)).data)
          : toPullThread(ref, (await fetcher.json<GiteePullRequest>(threadPath(ref), { method: 'PATCH', json: input, signal: options?.signal })).data)
      }),
      close: perKind({ issue: 'unverified', pull_request: true }, (ref, options) => setState(ref, 'closed', options)),
      reopen: perKind({ issue: 'unverified', pull_request: true }, (ref, options) => setState(ref, 'open', options)),
      addLabels: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (thread, labels, options) => {
        await fetcher.raw(`${threadPath(requireIssueOrPull(thread, context, 'label'))}/labels`, { method: 'POST', json: labels, signal: options?.signal })
      }),
      removeLabels: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (thread, labels, options) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        for (const label of labels) {
          await fetcher.raw(`${threadPath(ref)}/labels/${encodeURIComponent(label)}`, { method: 'DELETE', signal: options?.signal })
        }
      }),
      setLabels: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (thread, labels, options) => {
        await fetcher.raw(`${threadPath(requireIssueOrPull(thread, context, 'label'))}/labels`, { method: 'PUT', json: labels, signal: options?.signal })
      }),
      setAssignees: perKind({ issue: 'unverified' }, async (thread, assignees, options) => {
        if (assignees.length > 1) {
          throw new UnsupportedOperationError('Gitee issues take a single assignee', context)
        }
        await issueWrite(requireIssueOrPull(thread, context, 'assign'), { assignee: assignees[0] ? actorLogin(assignees[0]) : '' }, options?.signal)
      }),
      requestReview: perKind({ pull_request: 'unverified' }, async (thread, reviewers, options) => {
        await fetcher.raw(`${threadPath(requireThread(thread, context))}/assignees`, { method: 'POST', json: { assignees: reviewers.map(actorLogin).join(',') }, signal: options?.signal })
      }),
      merge: verb(true, async (thread, mergeOptions = {}, hooks = {}) => {
        const ref = requireThread(thread, context)
        if (ref.kind !== 'pull_request') {
          throw new UnsupportedOperationError('Only pull requests can be merged', context)
        }
        if (mergeOptions.whenChecksPass) {
          throw new UnsupportedOperationError('Gitee has no auto-merge through the API', context)
        }
        if (!mergeOptions.method) {
          throw new MergeMethodRequiredError(['merge', 'squash', 'rebase'], context)
        }
        if (!['merge', 'squash', 'rebase'].includes(mergeOptions.method)) {
          throw new UnsupportedOperationError(`Gitee does not support the ${mergeOptions.method} merge method`, context)
        }
        await hooks.beforeMerge?.()
        await fetcher.raw(`${threadPath(ref)}/merge`, { method: 'PUT', json: { merge_method: mergeOptions.method, title: mergeOptions.title, description: mergeOptions.message }, mapError: toMergeError, signal: mergeOptions.signal })
      }),
      checks: perKind(PULL, async (thread, options) => {
        const ref = requireThread(thread, context)
        const { data } = await fetcher.json<GiteePullRequest>(threadPath(ref), { signal: options?.signal })
        return { items: data.head?.sha ? await headChecks(ref.repo, data.head.sha, options?.signal) : [] }
      }),
      createReview: verb('unverified', createReview),
    },
    web: githubShapedWeb(baseUrl.replace(/\/api\/v5$/, ''), { pull: 'pulls', commentFragment: 'note_', file: at => `/blob/${encodeURIComponent(at)}`, lineFragment: line => `L${line}`, pullPrefix: '!' }),
    webhooks: {
      listPage: verb('unverified', async (target, listOptions = {}) => {
        const page = await numberedPage<GiteeHook>(`${repoPath(target)}/hooks`, {}, listOptions)
        return { items: page.items.map(raw => toWebhook(target, raw)), cursor: page.cursor }
      }),
      create: verb('unverified', async (target, input, options) => toWebhook(target, (await fetcher.json<GiteeHook>(`${repoPath(target)}/hooks`, {
        method: 'POST',
        json: { url: input.url, password: input.secret, ...hookFlags(input) },
        signal: options?.signal,
      })).data)),
      update: verb('unverified', async (ref, update, options) => toWebhook(ref.target, (await fetcher.json<GiteeHook>(`${repoPath(ref.target)}/hooks/${ref.id}`, {
        method: 'PATCH',
        json: { ...update.url ? { url: update.url } : {}, ...update.secret ? { password: update.secret } : {}, ...hookFlags(update) },
        signal: options?.signal,
      })).data)),
      delete: verb('unverified', async (ref, options) => {
        await fetcher.raw(`${repoPath(ref.target)}/hooks/${ref.id}`, { method: 'DELETE', signal: options?.signal })
      }),
      rotateSecret: verb('unverified', async (ref, secret, options) => toWebhook(ref.target, (await fetcher.json<GiteeHook>(`${repoPath(ref.target)}/hooks/${ref.id}`, {
        method: 'PATCH',
        json: { password: secret },
        signal: options?.signal,
      })).data)),
    },
    scopes: giteeScopesFor,
  }
}

const GITEE: ProviderDefinition<GiteeOptions> = {
  forge: FORGE,
  baseUrl: 'https://gitee.com',
  anonymous: true,
  apiPath: '/api/v5',
  headers: { accept: 'application/json' },
  authHeaders: ({ options: { auth } }) => auth?.type === 'token' ? async () => ({ authorization: `token ${await resolveToken(auth)}` }) : undefined,
  setup: setupGitee,
}

/** Creates a Gitee provider for gitee.com. The enterprise edition (`e.gitee.com`) is not covered. */
export const gitee: ProviderFactoryFunction<GiteeOptions> = /* @__PURE__ */ defineForgeProvider({ ...GITEE, webhooks: giteeWebhooks })

/** `gitee()` without webhook ingestion, for bundles that never receive a delivery. */
export const giteeLite: ProviderFactoryFunction<GiteeOptions> = /* @__PURE__ */ defineForgeProvider(GITEE)

/** Gitee OAuth scopes, one per resource group. */
export function giteeScopesFor(verb: ForgeVerb): VerbScopes {
  const [group = '', name = ''] = verb.split('.')
  if (group === 'webhooks') {
    return name === 'verify' || name === 'ingest' ? {} : { token: ['hook'] }
  }
  if (group === 'notifications') {
    return { token: ['notes', 'user_info'] }
  }
  if (group === 'users' || group === 'search') {
    return { token: ['user_info'] }
  }
  if (group === 'threads') {
    return { token: ['issues', 'pull_requests', 'notes'] }
  }
  return { token: ['projects'] }
}
