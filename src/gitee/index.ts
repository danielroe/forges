import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { Check, Comment, Cursor, EventKind, ForgeEventInput, ForgeWarning, ListOptions, Notification, NotificationListOptions, Page, Release, Repo, RepoRef, RepoSearchQuery, ResolvedThreadRef, Review, ReviewInput, SearchQuery, Thread, ThreadQuery, ThreadRef } from '../model.ts'
import type { AnonymousAuth, BulkNotificationOptions, ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { GiteeBranch, GiteeCheckRun, GiteeComment, GiteeCommit, GiteeCommitFile, GiteeCompare, GiteeContentFile, GiteeHook, GiteeIssue, GiteeLabel, GiteeNotification, GiteeOperateLog, GiteePullRequest, GiteeRelease, GiteeRepository, GiteeTag, GiteeTree, GiteeUser } from './types.ts'
import { fromBase64, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { ForgeApiError, ForgeError, MergeMethodRequiredError, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { actorLogin, getManyConcurrently, hasEveryLabel, hexColour, iteratePages, phased, requireIssueOrPull, requireThread, summariseChecks, toDate, toWarning } from '../utils.ts'
import { githubShapedWeb } from '../web.ts'
import { nativeEventsFor } from '../webhooks.ts'
import { FORGE, isConversationComment, toActor, toBranch, toChangedFile, toCheck, toComment, toCommentEvent, toCommit, toIssueThread, toLogEvent, toNotification, toPullThread, toRelease, toRepo, toRepoRef, toTag, toTreeEntry, toWebhook } from './normalise.ts'
import { GITEE_NATIVE_EVENTS } from './webhook-events.ts'
import { giteeWebhooks } from './webhooks.ts'

/** A personal access token or OAuth access token, sent as `Authorization: token`. */
export type GiteeAuth = TokenAuth | AnonymousAuth

export interface GiteeOptions extends ForgeOptionsBase {
  /** Defaults to `{ type: 'anonymous' }`: public reads only. */
  auth?: GiteeAuth
  /** Instance root. Defaults to `https://gitee.com`; `/api/v5` is appended. */
  baseUrl?: string
}

const ISSUE_AND_PULL = { issue: true, pull_request: true } as const
const PULL = { pull_request: true } as const
const PER_PAGE = 50

function setupGitee({ instance, origin: context, fetcher, baseUrl }: ProviderContext<GiteeOptions, undefined>): ProviderSpec {
  const repoPath = (repo: RepoRef) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
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
  async function numberedPage<T>(path: string, query: Record<string, string | number | boolean | undefined>, listOptions: { perPage?: number, cursor?: Cursor, signal?: AbortSignal }): Promise<{ items: T[], cursor?: Cursor }> {
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

  function all<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
    return Array.fromAsync(iteratePages(page => numberedPage<T>(path, query, page)))
  }

  /** Gitee records an approval, with no review object to read back. */
  async function createReview(thread: ThreadRef, input: ReviewInput): Promise<Review> {
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
    const { data } = await fetcher.json<{ id?: number }>(`${threadPath(ref)}/review`, { method: 'POST', json: input.body ? { body: input.body } : {} })
    return {
      ref: { forge: FORGE, instance, thread: ref, id: String(data?.id ?? 'approval') },
      state: 'approved',
      stateRaw: 'approved',
      body: input.body,
      comments: false,
      raw: data,
    }
  }

  async function headChecks(repo: RepoRef, sha: string): Promise<Check[]> {
    const { data } = await fetcher.json<GiteeCheckRun[] | { check_runs?: GiteeCheckRun[] }>(`${repoPath(repo)}/commits/${sha}/check-runs`)
    return (Array.isArray(data) ? data : data.check_runs ?? []).map(raw => toCheck(repo, raw))
  }

  async function get(thread: ThreadRef): Promise<Thread> {
    const ref = requireIssueOrPull(thread, context, 'read')
    if (ref.kind === 'issue') {
      return toIssueThread(ref, (await fetcher.json<GiteeIssue>(threadPath(ref))).data)
    }
    const { data } = await fetcher.json<GiteePullRequest>(threadPath(ref))
    const result = toPullThread(ref, data)
    if (data.head?.sha) {
      try {
        result.checks = summariseChecks((await headChecks(ref.repo, data.head.sha)).map(check => check.state))
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
      sort: query.sort === 'stars' ? 'stars_count' : query.sort === 'updated' ? 'last_push_at' : 'created_at',
      order: query.direction ?? 'desc',
    }, { perPage: query.perPage, cursor: query.cursor, signal: query.signal })
    return { items: page.items.map(raw => toRepo(instance, raw)), cursor: page.cursor }
  }

  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireIssueOrPull(thread, context, 'list comments on')
    const page = await numberedPage<GiteeComment>(`${threadPath(ref)}/comments`, {}, listOptions)
    return { items: page.items.filter(isConversationComment).map(raw => toComment(ref, raw)), cursor: page.cursor }
  }

  /** Comments and the operation log, merged and ordered by time, so one complete page. */
  async function eventsPage(thread: ThreadRef): Promise<Page<ForgeEventInput>> {
    const ref = requireIssueOrPull(thread, context, 'list events on')
    const logsPath = ref.kind === 'pull_request'
      ? `${threadPath(ref)}/operate_logs`
      : `/repos/${encodeURIComponent(ref.repo.owner)}/issues/${encodeURIComponent(ref.number)}/operate_logs`
    const [comments, { data: logs }] = await Promise.all([
      all<GiteeComment>(`${threadPath(ref)}/comments`),
      fetcher.json<GiteeOperateLog[]>(logsPath, { query: ref.kind === 'issue' ? { repo: ref.repo.name } : { sort: 'asc' } }),
    ])
    const events = [...comments.map(raw => toCommentEvent(ref, raw)), ...(logs ?? []).map(raw => toLogEvent(ref, raw))]
    return { items: events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()) }
  }

  /** Issue writes are addressed by owner, with the repository in the body. */
  function issueWrite(ref: ResolvedThreadRef, json: Record<string, unknown>) {
    return fetcher.json<GiteeIssue>(`/repos/${encodeURIComponent(ref.repo.owner)}/issues/${encodeURIComponent(ref.number)}`, { method: 'PATCH', json: { repo: ref.repo.name, ...json } })
  }

  async function setState(thread: ThreadRef, state: 'open' | 'closed'): Promise<void> {
    const ref = requireIssueOrPull(thread, context, state === 'open' ? 'reopen' : 'close')
    if (ref.kind === 'issue') {
      await issueWrite(ref, { state })
      return
    }
    await fetcher.raw(threadPath(ref), { method: 'PATCH', json: { state } })
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

  async function releasesPage(repo: RepoRef, listOptions: { perPage?: number, cursor?: Cursor, signal?: AbortSignal } = {}): Promise<Page<Release>> {
    const page = await numberedPage<GiteeRelease>(`${repoPath(repo)}/releases`, {}, listOptions)
    return { items: page.items.map(raw => toRelease(repo, raw)), cursor: page.cursor }
  }

  return {
    checks: {
      list: verb('experimental', async (repo, sha) => ({ items: await headChecks(repo, sha) })),
    },
    traits: { poll: true, eventKinds: 'native', auth: ['token', 'anonymous'] },
    users: {
      get: verb('experimental', async (login) => {
        const { data } = await fetcher.json<GiteeUser & { bio?: string | null, company?: string | null, blog?: string | null, created_at?: string, followers?: number, following?: number, public_repos?: number }>(`/users/${encodeURIComponent(login)}`)
        return { ...toActor(instance, data)!, bio: data.bio ?? undefined, company: data.company ?? undefined, websiteUrl: data.blog || undefined, createdAt: toDate(data.created_at), followers: data.followers, following: data.following, publicRepos: data.public_repos, raw: data }
      }),
    },
    repos: {
      get: verb(true, async ref => toRepo(instance, (await fetcher.json<GiteeRepository>(repoPath(ref))).data)),
      listPage: verb('experimental', async (listOptions = {}) => {
        const page = await numberedPage<GiteeRepository>('/user/repos', {}, listOptions)
        return { items: page.items.map(raw => toRepo(instance, raw)), cursor: page.cursor }
      }),
      labelsPage: verb('experimental', async (repo, listOptions = {}) => {
        const page = await numberedPage<GiteeLabel>(`${repoPath(repo)}/labels`, {}, listOptions)
        return { items: page.items.map(raw => ({ name: raw.name, colour: raw.color ?? undefined })), cursor: page.cursor }
      }),
      createLabel: verb('experimental', async (repo, label) => {
        const { data } = await fetcher.json<GiteeLabel>(`${repoPath(repo)}/labels`, {
          method: 'POST',
          json: { name: label.name, color: hexColour(label.colour) },
        })
        return { name: data.name, colour: data.color ?? undefined }
      }),
      collaboratorsPage: verb('experimental', async (repo, listOptions = {}) => {
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
      markRead: verb(true, async (ref) => {
        await fetcher.raw(`/notifications/threads/${ref.id}`, { method: 'PATCH' })
      }),
      markAllRead: verb('experimental', async (bulk: BulkNotificationOptions = {}) => {
        if (bulk.before) {
          throw new UnsupportedOperationError('Gitee marks notifications read without a time bound', context)
        }
        await fetcher.raw(bulk.repo ? `${repoPath(bulk.repo)}/notifications` : '/notifications/threads', { method: 'PUT' })
      }),
      unreadCount: verb('experimental', async () => (await fetcher.json<{ notification_count?: number, total_count?: number }>('/notifications/count', { query: { unread: true } })).data.notification_count ?? 0),
    },
    contents: {
      file: verb('experimental', async (repo, path, fileOptions = {}) => {
        const { data } = await fetcher.json<GiteeContentFile>(`${repoPath(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
          query: { ref: fileOptions.ref },
          signal: fileOptions.signal,
        })
        const file = { path: data.path, sha: data.sha, size: data.size, url: data._links?.html }
        return toFileContent(fromBase64(data.content ?? ''), file, fileOptions, context)
      }),
      treePage: verb('experimental', async (repo, treeOptions = {}) => {
        const ref = treeOptions.ref ?? (await fetcher.json<GiteeRepository>(repoPath(repo))).data.default_branch ?? 'master'
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
      branchesPage: verb('experimental', async (repo, listOptions = {}) => {
        const page = await numberedPage<GiteeBranch>(`${repoPath(repo)}/branches`, {}, listOptions)
        return { items: page.items.map(toBranch), cursor: page.cursor }
      }),
      tagsPage: verb('experimental', async (repo, listOptions = {}) => {
        const { data } = await fetcher.json<GiteeTag[]>(`${repoPath(repo)}/tags`, { signal: listOptions.signal })
        return { items: (data ?? []).map(toTag) }
      }),
      resolveRef: verb('experimental', async (repo, ref) => (await fetcher.json<GiteeCommit>(`${repoPath(repo)}/commits/${encodeURIComponent(ref)}`)).data.sha),
      commitsPage: verb('experimental', async (repo, query = {}) => {
        const page = await numberedPage<GiteeCommit>(`${repoPath(repo)}/commits`, {
          sha: query.ref,
          path: query.path,
          author: query.author,
          since: query.since?.toISOString(),
          until: query.until?.toISOString(),
        }, query)
        return { items: page.items.map(raw => toCommit(repo, raw)), cursor: page.cursor }
      }),
      commit: verb('experimental', async (repo, sha) => toCommit(repo, (await fetcher.json<GiteeCommit>(`${repoPath(repo)}/commits/${sha}`)).data)),
      compare: verb('experimental', async (repo, base, head) => {
        const { data } = await fetcher.json<GiteeCompare>(`${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
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
      threadsPage: verb('experimental', searchThreadsPage),
      reposPage: verb('experimental', searchReposPage),
    },
    releases: {
      listPage: verb(true, releasesPage),
      get: verb(true, async ref => toRelease(ref.repo, (await fetcher.json<GiteeRelease>(`${repoPath(ref.repo)}/releases/${ref.id}`)).data)),
      getByTag: verb('experimental', async (repo, tag) => toRelease(repo, (await fetcher.json<GiteeRelease>(`${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`)).data)),
      latest: verb(true, async (repo) => {
        try {
          const latest = toRelease(repo, (await fetcher.json<GiteeRelease>(`${repoPath(repo)}/releases/latest`)).data)
          if (!latest.isPrerelease) {
            return latest
          }
        }
        catch (error) {
          if (!(error instanceof ForgeApiError && error.status === 404)) {
            throw error
          }
          return undefined
        }
        return (await releasesPage(repo, { perPage: 20 })).items.find(release => !release.isPrerelease)
      }),
    },
    threads: {
      get: perKind({ issue: 'experimental', pull_request: true }, get),
      getMany: verb(true, refs => getManyConcurrently(refs, get)),
      listPage: perKind({ issue: 'experimental', pull_request: true }, listPage),
      eventsPage: verb(true, eventsPage),
      filesPage: verb('experimental', async (thread, listOptions = {}) => {
        const ref = requirePull(thread, 'read for changed files')
        const { data } = await fetcher.json<GiteeCommitFile[]>(`${threadPath(ref)}/files`, { signal: listOptions.signal })
        return { items: (data ?? []).map(toChangedFile) }
      }),
      commitsPage: verb('experimental', async (thread, listOptions = {}) => {
        const ref = requirePull(thread, 'read for commits')
        const { data } = await fetcher.json<GiteeCommit[]>(`${threadPath(ref)}/commits`, { signal: listOptions.signal })
        return { items: (data ?? []).map(raw => toCommit(thread.repo, raw)) }
      }),
      commentsPage: perKind({ issue: 'experimental', pull_request: true }, commentsPage),
      comment: perKind({ issue: 'experimental', pull_request: true }, async (thread, body) => {
        const ref = requireIssueOrPull(thread, context, 'comment on')
        return toComment(ref, (await fetcher.json<GiteeComment>(`${threadPath(ref)}/comments`, { method: 'POST', json: { body } })).data)
      }),
      editComment: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (ref, body) => {
        const kind = ref.thread.kind === 'pull_request' ? 'pulls' : 'issues'
        return toComment(ref.thread, (await fetcher.json<GiteeComment>(`${repoPath(ref.thread.repo)}/${kind}/comments/${ref.id}`, { method: 'PATCH', json: { body } })).data)
      }),
      deleteComment: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (ref) => {
        const kind = ref.thread.kind === 'pull_request' ? 'pulls' : 'issues'
        await fetcher.raw(`${repoPath(ref.thread.repo)}/${kind}/comments/${ref.id}`, { method: 'DELETE' })
      }),
      create: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (repo, input) => {
        const labels = input.labels?.join(',')
        if (input.kind === 'issue') {
          if ((input.assignees?.length ?? 0) > 1) {
            throw new UnsupportedOperationError('Gitee issues take a single assignee', context)
          }
          const { data } = await fetcher.json<GiteeIssue>(`/repos/${encodeURIComponent(repo.owner)}/issues`, {
            method: 'POST',
            json: { repo: repo.name, title: input.title, body: input.body, labels, assignee: input.assignees?.[0] ? actorLogin(input.assignees[0]) : undefined },
          })
          return toIssueThread({ forge: FORGE, instance, repo, kind: 'issue', number: data.number }, data)
        }
        if (!input.head || !input.base) {
          throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
        }
        const { data } = await fetcher.json<GiteePullRequest>(`${repoPath(repo)}/pulls`, {
          method: 'POST',
          json: { title: input.title, body: input.body, head: input.head, base: input.base, labels, draft: input.draft, assignees: input.assignees?.map(actorLogin).join(',') },
        })
        return toPullThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: String(data.number) }, data)
      }),
      update: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, input) => {
        const ref = requireIssueOrPull(thread, context, 'update')
        return ref.kind === 'issue'
          ? toIssueThread(ref, (await issueWrite(ref, { ...input })).data)
          : toPullThread(ref, (await fetcher.json<GiteePullRequest>(threadPath(ref), { method: 'PATCH', json: input })).data)
      }),
      close: perKind(ISSUE_AND_PULL, ref => setState(ref, 'closed')),
      reopen: perKind({ issue: 'experimental', pull_request: true }, ref => setState(ref, 'open')),
      addLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
        await fetcher.raw(`${threadPath(requireIssueOrPull(thread, context, 'label'))}/labels`, { method: 'POST', json: labels })
      }),
      removeLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        for (const label of labels) {
          await fetcher.raw(`${threadPath(ref)}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' })
        }
      }),
      setLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
        await fetcher.raw(`${threadPath(requireIssueOrPull(thread, context, 'label'))}/labels`, { method: 'PUT', json: labels })
      }),
      setAssignees: perKind({ issue: 'experimental' }, async (thread, assignees) => {
        if (assignees.length > 1) {
          throw new UnsupportedOperationError('Gitee issues take a single assignee', context)
        }
        await issueWrite(requireIssueOrPull(thread, context, 'assign'), { assignee: assignees[0] ? actorLogin(assignees[0]) : '' })
      }),
      requestReview: perKind({ pull_request: 'experimental' }, async (thread, reviewers) => {
        await fetcher.raw(`${threadPath(requireThread(thread, context))}/assignees`, { method: 'POST', json: { assignees: reviewers.map(actorLogin).join(',') } })
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
        await fetcher.raw(`${threadPath(ref)}/merge`, { method: 'PUT', json: { merge_method: mergeOptions.method, description: mergeOptions.message }, mapError: toMergeError })
      }),
      checks: perKind(PULL, async (thread) => {
        const ref = requireThread(thread, context)
        const { data } = await fetcher.json<GiteePullRequest>(threadPath(ref))
        return { items: data.head?.sha ? await headChecks(ref.repo, data.head.sha) : [] }
      }),
      createReview: verb('emulated', createReview),
    },
    web: githubShapedWeb(baseUrl.replace(/\/api\/v5$/, ''), { pull: 'pulls', commentFragment: 'note_', file: at => `/blob/${encodeURIComponent(at)}`, lineFragment: line => `L${line}`, pullPrefix: '!' }),
    webhooks: {
      listPage: verb('experimental', async (target, listOptions = {}) => {
        const page = await numberedPage<GiteeHook>(`${repoPath(target)}/hooks`, {}, listOptions)
        return { items: page.items.map(raw => toWebhook(target, raw)), cursor: page.cursor }
      }),
      create: verb('experimental', async (target, input) => toWebhook(target, (await fetcher.json<GiteeHook>(`${repoPath(target)}/hooks`, {
        method: 'POST',
        json: { url: input.url, password: input.secret, ...hookFlags(input) },
      })).data)),
      update: verb('experimental', async (ref, update) => toWebhook(ref.target, (await fetcher.json<GiteeHook>(`${repoPath(ref.target)}/hooks/${ref.id}`, {
        method: 'PATCH',
        json: { ...update.url ? { url: update.url } : {}, ...update.secret ? { password: update.secret } : {}, ...hookFlags(update) },
      })).data)),
      delete: verb('experimental', async (ref) => {
        await fetcher.raw(`${repoPath(ref.target)}/hooks/${ref.id}`, { method: 'DELETE' })
      }),
      rotateSecret: verb('experimental', async (ref, secret) => toWebhook(ref.target, (await fetcher.json<GiteeHook>(`${repoPath(ref.target)}/hooks/${ref.id}`, {
        method: 'PATCH',
        json: { password: secret },
      })).data)),
    },
    scopes: giteeScopesFor,
  }
}

const GITEE: ProviderDefinition<GiteeOptions> = {
  kind: FORGE,
  experimental: true,
  baseUrl: 'https://gitee.com',
  anonymous: true,
  apiPath: '/api/v5',
  headers: { accept: 'application/json' },
  authHeaders: ({ options: { auth } }) => auth?.type === 'token' ? () => ({ authorization: `token ${auth.token}` }) : undefined,
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
