import type { MergeHooks, ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type {
  Check,
  CheckState,
  Comment,
  CommentRef,
  ForgeEventInput,
  ForgeWarning,
  ListOptions,
  MergeMethod,
  MergeOptions,
  Notification,
  NotificationListOptions,
  NotificationRef,
  Page,
  PageOptions,
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
  SubscriptionState,
  Thread,
  ThreadQuery,
  ThreadRef,
  User,
} from '../model.ts'
import type {
  AnonymousAuth,
  BulkNotificationOptions,
  ForgeOptionsBase,
  NotificationWriteOptions,
  TokenAuth,
  VerbScopes,
} from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type {
  ForgejoCombinedStatus,
  ForgejoComment,
  ForgejoCommit,
  ForgejoCommitStatus,
  ForgejoCompare,
  ForgejoContentFile,
  ForgejoHook,
  ForgejoIssue,
  ForgejoLabel,
  ForgejoMilestone,
  ForgejoNotification,
  ForgejoReaction,
  ForgejoRelease,
  ForgejoRepositoryDetail,
  ForgejoReview,
  ForgejoReviewComment,
  ForgejoTimelineEntry,
  ForgejoTree,
  ForgejoUser,
} from './types.ts'
import type { WebhookHeaderNames } from './webhook-events.ts'
import { fromBase64, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { ForgeError, NotFoundError, soleMergeMethod, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { isNamespaceRef, reactionContent } from '../model.ts'
import { actorLogin, createListing, getManyConcurrently, hasEveryLabel, hexColour, memo, memoBy, requireIssueOrPull, requireThread, resolveToken, summariseChecks, toDate, toPage, toWarning } from '../utils.ts'
import { githubShapedWeb } from '../web.ts'
import { nativeEventsFor } from '../webhooks.ts'
import { numberFromUrl, toActor, toBranch, toChangedFile, toComment, toCommit, toEvent, toLabel, toMilestone, toNotification, toRelease, toRepo, toReview, toReviewComment, toRole, toStatusCheck, toStatusChecks, toTag, toThread, toThreadKind, toTreeEntry, toWebhook } from './normalise.ts'
import { FORGEJO_HEADERS, FORGEJO_NATIVE_EVENTS } from './webhook-events.ts'
import { forgejoWebhooks } from './webhooks.ts'

/** Forgejo and Gitea have no app-installation credential, so only tokens are accepted. */
export type ForgejoAuth = TokenAuth | AnonymousAuth

export interface ForgejoOptions extends ForgeOptionsBase {
  /** Defaults to `{ type: 'anonymous' }`: public reads only. */
  auth?: ForgejoAuth
  /** Instance root, for example `https://codeberg.org`. */
  baseUrl?: string
}

/** What distinguishes a deployment family sharing the Forgejo implementation. */
export interface ForgejoProfile {
  forge: 'forgejo' | 'gitea'
  defaultBaseUrl: string
  headers: WebhookHeaderNames
}

export const FORGEJO_PROFILE: ForgejoProfile = {
  forge: 'forgejo',
  defaultBaseUrl: 'https://codeberg.org',
  headers: FORGEJO_HEADERS,
}

const ISSUE_AND_PULL = { issue: true, pull_request: true } as const

const FORGEJO_RESERVED_PATHS = ['-', '.well-known', 'admin', 'api', 'assets', 'attachments', 'avatars', 'captcha', 'explore', 'issues', 'login', 'milestones', 'notifications', 'org', 'pulls', 'repo', 'repo-avatars', 'search', 'user']

/** The Forgejo implementation for one deployment family. Shared by `forgejo()` and `gitea()`. */
export function forgejoDefinition(profile: ForgejoProfile): ProviderDefinition<ForgejoOptions> {
  return {
    forge: profile.forge,
    baseUrl: profile.defaultBaseUrl,
    anonymous: true,
    apiPath: '/api/v1',
    headers: { accept: 'application/json' },
    authHeaders: ({ options: { auth } }) => auth?.type === 'token' ? async () => ({ authorization: `token ${await resolveToken(auth)}` }) : undefined,
    setup: ctx => setupForgejo(ctx, profile),
  }
}

function setupForgejo({ origin, fetcher, baseUrl }: ProviderContext<ForgejoOptions, undefined>, profile: ForgejoProfile): ProviderSpec {
  const context = origin

  const list = createListing(fetcher, 'limit')

  async function readUser(path: string): Promise<User> {
    const { data } = await fetcher.json<ForgejoUser & { description?: string, location?: string, website?: string, created?: string, followers_count?: number, following_count?: number }>(path)
    return { ...toActor(origin, data)!, bio: data.description || undefined, location: data.location || undefined, websiteUrl: data.website || undefined, createdAt: toDate(data.created), followers: data.followers_count, following: data.following_count, raw: data }
  }

  function repoPath(repo: Pick<RepoRef, 'owner' | 'name'>): string {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  }

  function threadPath(ref: ResolvedThreadRef): string {
    switch (ref.kind) {
      case 'pull_request':
        return `${repoPath(ref.repo)}/pulls/${encodeURIComponent(ref.number)}`
      case 'commit':
        return `${repoPath(ref.repo)}/git/commits/${encodeURIComponent(ref.number)}`
      case 'discussion':
        throw new UnsupportedOperationError(`${profile.forge} has no discussions`, context)
      default:
        return `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}`
    }
  }

  const currentUser = memo(() => fetcher.json<ForgejoUser>('/user').then(result => result.data))

  /** Labels are addressed by id in writes, so names are resolved once per repo. */
  /** Forgejo and Gitea address reactions on issues and on comments with the same body. */
  function reactionPath(target: ThreadRef | CommentRef): string {
    return 'thread' in target
      ? `${repoPath(target.thread.repo)}/issues/comments/${encodeURIComponent(target.id)}/reactions`
      : `${issuePath(requireIssueOrPull(target, context, 'react to'))}/reactions`
  }

  async function setReaction(target: ThreadRef | CommentRef, reaction: ReactionContent, method: 'POST' | 'DELETE'): Promise<void> {
    await fetcher.raw(reactionPath(target), { method, json: { content: reaction } })
  }

  const labelIdsOf = memoBy(async (path: string) => {
    const map = new Map<string, number>()
    for await (const label of fetcher.items<{ id: number, name: string }>(`${path}/labels`, { query: { limit: 50 } })) {
      map.set(label.name, label.id)
    }
    return map
  })

  async function resolveLabels(repo: RepoRef, names: string[]): Promise<number[]> {
    const map = await labelIdsOf(repoPath(repo))
    return names.map((name) => {
      const id = map.get(name)
      if (id === undefined) {
        throw new UnsupportedOperationError(`No label named ${name} in ${repo.owner}/${repo.name}`, context)
      }
      return id
    })
  }

  async function notificationPage(listOptions: NotificationListOptions = {}): Promise<Page<Notification>> {
    const result = await fetcher.json<ForgejoNotification[]>(listOptions.cursor?.nextUrl ?? '/notifications', {
      query: listOptions.cursor?.nextUrl
        ? undefined
        : {
            all: listOptions.all ?? false,
            since: listOptions.since?.toISOString(),
            limit: listOptions.perPage,
          },
      signal: listOptions.signal,
    })
    return {
      items: (result.data ?? []).map(raw => toNotification(origin, raw)),
      cursor: result.cursor,
      notModified: result.notModified,
    }
  }

  async function setStatus(ref: NotificationRef, status: 'read' | 'unread' | 'pinned'): Promise<void> {
    await fetcher.raw(`/notifications/threads/${encodeURIComponent(ref.id)}`, {
      method: 'PATCH',
      query: { 'to-status': status },
    })
  }

  async function issueTarget(ref: NotificationRef, thread?: ThreadRef): Promise<{ owner: string, name: string, number: string }> {
    if (thread) {
      const resolved = requireThread(thread, context)
      if (resolved.kind !== 'issue' && resolved.kind !== 'pull_request') {
        throw new UnsupportedOperationError('Only issue and pull request threads can be unsubscribed from', context)
      }
      return { owner: resolved.repo.owner, name: resolved.repo.name, number: resolved.number }
    }
    const { data } = await fetcher.json<ForgejoNotification>(`/notifications/threads/${encodeURIComponent(ref.id)}`)
    const number = numberFromUrl(data.subject.url)
    if (!number || toThreadKind(data.subject.type) === 'commit') {
      throw new UnsupportedOperationError('Only issue and pull request threads can be unsubscribed from', context)
    }
    const [owner = '', name = ''] = data.repository.full_name.split('/')
    return { owner, name, number }
  }

  async function subscriptionPath(target: { owner: string, name: string, number: string }): Promise<string> {
    const user = await currentUser()
    return `${repoPath(target)}/issues/${encodeURIComponent(target.number)}/subscriptions/${encodeURIComponent(user.login)}`
  }

  async function unsubscribe(ref: NotificationRef, writeOptions: NotificationWriteOptions = {}): Promise<void> {
    await fetcher.raw(await subscriptionPath(await issueTarget(ref, writeOptions.thread)), { method: 'DELETE' })
  }

  function issuePath(ref: ResolvedThreadRef): string {
    return `${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}`
  }

  async function setState(thread: ThreadRef, state: 'open' | 'closed'): Promise<void> {
    await fetcher.raw(issuePath(requireIssueOrPull(thread, context, state === 'open' ? 'reopen' : 'close')), {
      method: 'PATCH',
      json: { state },
    })
  }

  async function merge(thread: ThreadRef, mergeOptions: MergeOptions = {}, hooks: MergeHooks = {}): Promise<void> {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError('Only pull requests can be merged', context)
    }
    const pull = `${repoPath(ref.repo)}/pulls/${encodeURIComponent(ref.number)}`
    let method: MergeMethod | undefined = mergeOptions.method
    if (!method) {
      const { data: repo } = await fetcher.json<{
        allow_merge_commits?: boolean
        allow_rebase?: boolean
        allow_rebase_explicit?: boolean
        allow_squash_merge?: boolean
        allow_fast_forward_only_merge?: boolean
      }>(repoPath(ref.repo))
      method = soleMergeMethod({
        merge: repo.allow_merge_commits,
        rebase: repo.allow_rebase,
        rebase_merge: repo.allow_rebase_explicit,
        squash: repo.allow_squash_merge,
        fast_forward_only: repo.allow_fast_forward_only_merge,
      }, context)
    }
    await hooks.beforeMerge?.()
    await fetcher.raw(`${pull}/merge`, {
      method: 'POST',
      json: {
        Do: method.replaceAll('_', '-'),
        MergeMessageField: mergeOptions.message,
        head_commit_id: mergeOptions.sha,
        merge_when_checks_succeed: mergeOptions.whenChecksPass,
      },
      mapError: toMergeError,
    })
  }

  const REVIEW_EVENTS: Record<ReviewEvent, string> = { approve: 'APPROVED', request_changes: 'REQUEST_CHANGES', comment: 'COMMENT' }

  function requirePull(thread: ThreadRef, action: string): ResolvedThreadRef {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError(`Only pull requests can be ${action}`, context)
    }
    return ref
  }

  function pullPath(ref: ResolvedThreadRef): string {
    return `${repoPath(ref.repo)}/pulls/${encodeURIComponent(ref.number)}`
  }

  function reviewCommentInput(comments: ReviewInput['comments']) {
    return comments?.map(comment => ({
      path: comment.path,
      body: comment.body,
      ...comment.side === 'left' ? { old_position: comment.line } : { new_position: comment.line },
    }))
  }

  async function createReview(thread: ThreadRef, input: ReviewInput): Promise<Review> {
    const ref = requirePull(thread, 'reviewed')
    const { data } = await fetcher.json<ForgejoReview>(`${pullPath(ref)}/reviews`, {
      method: 'POST',
      json: {
        event: input.event ? REVIEW_EVENTS[input.event] : undefined,
        body: input.body ?? '',
        comments: reviewCommentInput(input.comments),
      },
    })
    return toReview(ref, data, [])
  }

  async function get(thread: ThreadRef): Promise<Thread> {
    const ref = requireThread(thread, context)
    const { data } = await fetcher.json<ForgejoIssue>(threadPath(ref))
    const result = toThread(ref, data)
    if (ref.kind === 'pull_request' && data.head?.sha) {
      try {
        const checks = await statusChecks(ref.repo, data.head.sha)
        result.checks = summariseChecks(checks.map(check => check.state))
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

  const STATUS_STATES: Record<CheckState, string> = { pending: 'pending', success: 'success', failure: 'failure', neutral: 'success', unknown: 'pending' }

  async function statusChecks(repo: RepoRef, sha: string): Promise<Check[]> {
    const { data } = await fetcher.json<ForgejoCombinedStatus>(`${repoPath(repo)}/commits/${sha}/status`)
    return toStatusChecks(repo, data)
  }

  async function releasesPage(repo: RepoRef, listOptions: PageOptions = {}): Promise<Page<Release>> {
    return list(`${repoPath(repo)}/releases`, listOptions, (raw: ForgejoRelease) => toRelease(repo, raw))
  }

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    const warnings: ForgeWarning[] = []
    if (query.kind === 'discussion') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: `${profile.forge} has no discussions` }] }
    }
    const sort = query.sort ?? 'created'
    const direction = query.direction ?? 'desc'
    if (!query.cursor && (sort !== 'created' || direction !== 'desc')) {
      warnings.push({ code: 'sort_unsupported', message: `${profile.forge} lists repository issues newest first only` })
    }
    const createdAfter = query.createdAfter?.getTime()
    const result = await fetcher.page<ForgejoIssue>(`${repoPath(repo)}/issues`, {
      query: {
        state: query.state === 'merged' ? 'closed' : query.state ?? 'open',
        type: query.kind === 'pull_request' ? 'pulls' : query.kind === 'issue' ? 'issues' : undefined,
        labels: query.labels?.join(','),
        created_by: query.author,
        assigned_by: query.assignee,
        since: query.since?.toISOString(),
        limit: query.perPage,
      },
      cursor: query.cursor,
      signal: query.signal,
    })
    const older = (raw: ForgejoIssue) => createdAfter !== undefined && (Date.parse(raw.created_at ?? '') || 0) < createdAfter
    const unmerged = (raw: ForgejoIssue) => query.state === 'merged' && !raw.pull_request?.merged
    const page = toPage(result, raw => older(raw) || unmerged(raw) || !hasEveryLabel(raw.labels, query.labels) ? undefined : toThread({ ...origin, repo, kind: raw.pull_request ? 'pull_request' : 'issue', number: String(raw.number) }, raw), warnings)
    return (result.data ?? []).some(older) ? { ...page, cursor: undefined } : page
  }

  /** Repository hooks, or organisation hooks for a namespace ref. */
  function hooksPath(target: RepoRef): string {
    return isNamespaceRef(target) ? `/orgs/${encodeURIComponent(target.owner)}/hooks` : `${repoPath(target)}/hooks`
  }

  async function searchThreadsPage(query: SearchQuery): Promise<Page<Thread>> {
    const warnings: ForgeWarning[] = []
    if (!query.cursor && query.involves) {
      warnings.push({ code: 'filter_unsupported', message: `${profile.forge} has no involves filter; it was ignored` })
    }
    if (!query.cursor && query.sort && query.sort !== 'relevance') {
      warnings.push({ code: 'sort_unsupported', message: `${profile.forge} searches issues newest first only` })
    }
    const result = await fetcher.page<ForgejoIssue>('/repos/issues/search', {
      query: {
        q: query.text,
        type: query.kind === 'pull_request' ? 'pulls' : query.kind === 'issue' ? 'issues' : undefined,
        state: query.state ?? 'all',
        labels: query.labels?.join(','),
        created_by: query.author,
        assigned_by: query.assignee,
        since: query.since?.toISOString(),
        owner: query.repo?.owner,
        limit: query.perPage,
      },
      cursor: query.cursor,
      signal: query.signal,
    })
    return toPage(result, (raw) => {
      const [owner = '', name = ''] = raw.repository?.full_name.split('/') ?? []
      const repo = query.repo ?? (name
        ? { ...origin, owner, name, externalId: raw.repository?.id === undefined ? undefined : String(raw.repository.id) }
        : undefined)
      if (!repo || !hasEveryLabel(raw.labels, query.labels) || (query.repo && raw.repository && raw.repository.full_name !== `${query.repo.owner}/${query.repo.name}`)) {
        return undefined
      }
      return toThread({ ...origin, repo, kind: raw.pull_request ? 'pull_request' : 'issue', number: String(raw.number) }, raw)
    }, warnings)
  }

  async function searchReposPage(query: RepoSearchQuery): Promise<Page<Repo>> {
    const result = await fetcher.page<ForgejoRepositoryDetail>('/repos/search', {
      query: {
        q: query.text,
        owner: query.owner,
        sort: query.sort === 'stars' ? 'stars' : query.sort === 'created' ? 'created' : query.sort === 'updated' ? 'updated' : undefined,
        order: query.direction,
        limit: query.perPage,
      },
      cursor: query.cursor,
      signal: query.signal,
      select: (body, next) => ({ items: (body as { data: ForgejoRepositoryDetail[] }).data, next }),
    })
    return toPage(result, raw => toRepo(origin, raw))
  }

  return {
    traits: { poll: true, eventKinds: 'native', authKinds: ['token', 'anonymous'] },
    search: {
      threadsPage: verb(true, searchThreadsPage),
      reposPage: verb(true, searchReposPage),
    },
    probeVersion: async () => (await fetcher.json<{ version?: string }>('/version')).data.version,
    users: {
      get: verb(true, login => readUser(`/users/${encodeURIComponent(login)}`)),
      me: verb(true, () => readUser('/user')),
    },
    repos: {
      get: verb(true, async ref => toRepo(origin, (await fetcher.json<ForgejoRepositoryDetail>(repoPath(ref))).data)),
      listPage: verb(true, (listOptions = {}) => list('/user/repos', listOptions, (raw: ForgejoRepositoryDetail) => toRepo(origin, raw))),
      labelsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/labels`, listOptions, toLabel)),
      createLabel: verb('experimental', async (repo, label) => toLabel((await fetcher.json<ForgejoLabel>(`${repoPath(repo)}/labels`, {
        method: 'POST',
        json: { name: label.name, color: hexColour(label.colour, '#'), description: label.description },
      })).data)),
      milestonesPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/milestones`, listOptions, (raw: ForgejoMilestone) => toMilestone(raw)!, { query: { state: listOptions.state ?? 'open' } })),
      collaboratorsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/collaborators`, listOptions, (raw: ForgejoUser) => ({ actor: toActor(origin, raw)!, role: 'read' as const, raw }))),
      permissionFor: verb('experimental', async (repo, actor) => {
        const { data } = await fetcher.json<{ permission?: string, role_name?: string }>(`${repoPath(repo)}/collaborators/${encodeURIComponent(actorLogin(actor))}/permission`)
        return toRole(data.role_name ?? data.permission)
      }),
      addCollaborator: verb('experimental', async (repo, actor, role) => {
        await fetcher.raw(`${repoPath(repo)}/collaborators/${encodeURIComponent(actorLogin(actor))}`, {
          method: 'PUT',
          json: { permission: role === 'admin' ? 'admin' : role === 'read' || role === 'triage' ? 'read' : 'write' },
        })
      }),
      assignableUsersPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/assignees`, listOptions, (raw: ForgejoUser) => toActor(origin, raw)!)),
      reviewerCandidatesPage: verb('experimental', (thread, listOptions = {}) => list(`${repoPath(requireThread(thread, context).repo)}/reviewers`, listOptions, (raw: ForgejoUser) => toActor(origin, raw)!)),
    },
    notifications: {
      listPage: verb(true, notificationPage),
      markRead: verb(true, ref => setStatus(ref, 'read')),
      markDone: verb('emulated', async (ref, writeOptions) => {
        await setStatus(ref, 'read')
        await unsubscribe(ref, writeOptions)
      }),
      unsubscribe: verb(true, unsubscribe),
      markAllRead: verb(true, async (bulk: BulkNotificationOptions = {}) => {
        await fetcher.raw(bulk.repo ? `${repoPath(bulk.repo)}/notifications` : '/notifications', {
          method: 'PUT',
          query: { 'last_read_at': bulk.before?.toISOString(), 'to-status': 'read' },
        })
      }),
      unreadCount: verb(true, async () => (await fetcher.json<{ new: number }>('/notifications/new')).data.new),
    },
    checks: {
      list: verb(true, async (repo, sha) => ({ items: await statusChecks(repo, sha) })),
      report: verb('experimental', async (repo, sha, input) => toStatusCheck(repo, (await fetcher.json<ForgejoCommitStatus>(`${repoPath(repo)}/statuses/${sha}`, {
        method: 'POST',
        json: { state: STATUS_STATES[input.state], context: input.name, description: input.description, target_url: input.url },
      })).data)),
    },
    contents: {
      file: verb(true, async (repo, path, fileOptions = {}) => {
        const encoded = path.split('/').map(encodeURIComponent).join('/')
        const { data } = await fetcher.json<ForgejoContentFile>(`${repoPath(repo)}/contents/${encoded}`, {
          query: { ref: fileOptions.ref },
          signal: fileOptions.signal,
        })
        const file = { path: data.path, sha: data.sha, size: data.size, url: data.html_url ?? undefined }
        // Large files come back with a null `content`; the raw endpoint has no size limit.
        if (data.encoding === 'base64' && data.content) {
          return toFileContent(fromBase64(data.content), file, fileOptions, context)
        }
        const response = await fetcher.raw(`${repoPath(repo)}/raw/${encoded}`, { query: { ref: fileOptions.ref }, signal: fileOptions.signal })
        return toFileContent(new Uint8Array(await response.arrayBuffer()), file, fileOptions, context)
      }),
      treePage: verb(true, async (repo, treeOptions = {}) => {
        const ref = treeOptions.ref ?? 'HEAD'
        const { data, response } = await fetcher.json<ForgejoTree>(`${repoPath(repo)}/git/trees/${encodeURIComponent(ref)}`, {
          query: { recursive: treeOptions.recursive ? 'true' : undefined, per_page: treeOptions.perPage },
          signal: treeOptions.signal,
        })
        const prefix = treeOptions.path?.replace(/^\/|\/$/g, '')
        const entries = (data.tree ?? []).filter(entry => !prefix || entry.path.startsWith(`${prefix}/`))
        const warnings = data.truncated
          ? [{ code: 'tree_truncated' as const, message: `${profile.forge} truncated the tree; read it directory by directory instead`, subject: ref }]
          : []
        return toPage({ data: entries, response, notModified: false }, toTreeEntry, warnings)
      }),
      branchesPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/branches`, listOptions, toBranch)),
      tagsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/tags`, listOptions, toTag)),
      resolveRef: verb(true, async (repo, ref) => {
        const { data } = await fetcher.json<ForgejoCommit[]>(`${repoPath(repo)}/commits`, { query: { sha: ref, limit: 1, stat: 'false' } })
        const sha = data[0]?.sha
        if (!sha) {
          throw new NotFoundError(`${profile.forge} has no commit for ${ref}`, 404, '', context)
        }
        return sha
      }),
      commitsPage: verb(true, (repo, query = {}) => list(`${repoPath(repo)}/commits`, query, (raw: ForgejoCommit) => toCommit(repo, raw), { query: { sha: query.ref, path: query.path, since: query.since?.toISOString(), until: query.until?.toISOString() } })),
      commit: verb(true, async (repo, sha) => toCommit(repo, (await fetcher.json<ForgejoCommit>(`${repoPath(repo)}/git/commits/${sha}`, { query: { stat: 'true', files: 'true' } })).data)),
      compare: verb(true, async (repo, base, head) => {
        const { data } = await fetcher.json<ForgejoCompare>(`${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
        return {
          base,
          head,
          aheadBy: data.total_commits ?? data.commits?.length,
          commits: (data.commits ?? []).map(raw => toCommit(repo, raw)),
          files: (data.files ?? []).map(toChangedFile),
          raw: data,
        }
      }),
    },
    releases: {
      listPage: verb(true, releasesPage),
      get: verb(true, async ref => toRelease(ref.repo, (await fetcher.json<ForgejoRelease>(`${repoPath(ref.repo)}/releases/${encodeURIComponent(ref.id)}`)).data)),
      getByTag: verb(true, async (repo, tag) => toRelease(repo, (await fetcher.json<ForgejoRelease>(`${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`)).data)),
      downloadAsset: verb('experimental', async (ref, downloadOptions = {}) => (await fetcher.stream(`${repoPath(ref.repo)}/releases/${encodeURIComponent(ref.release.id)}/assets/${encodeURIComponent(ref.id)}`, { signal: downloadOptions.signal })).body),
      latest: verb(true, async (repo) => {
        try {
          return toRelease(repo, (await fetcher.json<ForgejoRelease>(`${repoPath(repo)}/releases/latest`)).data)
        }
        catch (error) {
          if (error instanceof NotFoundError) {
            return undefined
          }
          throw error
        }
      }),
    },
    threads: {
      checks: perKind({ pull_request: true }, async (thread) => {
        const ref = requireThread(thread, context)
        const { data } = await fetcher.json<ForgejoIssue>(threadPath(ref))
        return { items: data.head?.sha ? await statusChecks(ref.repo, data.head.sha) : [] }
      }),
      reviewsPage: verb(true, async (thread, listOptions: PageOptions = {}) => {
        const ref = requirePull(thread, 'reviewed')
        const result = await fetcher.page<ForgejoReview>(`${pullPath(ref)}/reviews`, {
          query: { limit: listOptions.perPage },
          cursor: listOptions.cursor,
          signal: listOptions.signal,
        })
        const reviews = await Promise.all((result.data ?? []).map(async (raw) => {
          const comments = raw.comments_count === 0
            ? []
            : (await fetcher.json<ForgejoReviewComment[]>(`${pullPath(ref)}/reviews/${encodeURIComponent(raw.id)}/comments`)).data ?? []
          return toReview(ref, raw, comments.map(comment => toReviewComment(ref, comment)))
        }))
        return { items: reviews, cursor: result.cursor }
      }),
      filesPage: verb(true, (ref, listOptions = {}) => list(`${pullPath(requirePull(ref, 'read for changed files'))}/files`, listOptions, toChangedFile)),
      commitsPage: verb(true, (ref, listOptions = {}) => list(`${pullPath(requirePull(ref, 'read for commits'))}/commits`, listOptions, (raw: ForgejoCommit) => toCommit(ref.repo, raw))),
      createReview: verb('experimental', createReview),
      submitReview: verb('experimental', async (ref, event, body) => {
        const pull = requirePull(ref.thread, 'reviewed')
        const { data } = await fetcher.json<ForgejoReview>(`${pullPath(pull)}/reviews/${encodeURIComponent(ref.id)}`, {
          method: 'POST',
          json: { event: REVIEW_EVENTS[event], body: body ?? '' },
        })
        return toReview(pull, data, [])
      }),
      get: perKind({ issue: true, pull_request: true, commit: 'experimental' }, get),
      getMany: verb(true, refs => getManyConcurrently(refs, get)),
      listPage: perKind(ISSUE_AND_PULL, listPage),
      eventsPage: verb(true, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> => {
        const ref = requireThread(thread, context)
        return list(`${issuePath(ref)}/timeline`, listOptions, (entry: ForgejoTimelineEntry) => toEvent(ref, entry))
      }),
      commentsPage: perKind(ISSUE_AND_PULL, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> => {
        const ref = requireIssueOrPull(thread, context, 'list comments on')
        return list(`${issuePath(ref)}/comments`, listOptions, (raw: ForgejoComment) => toComment(ref, raw))
      }),
      comment: perKind({ issue: 'experimental', pull_request: true }, async (thread, body) => {
        const ref = requireIssueOrPull(thread, context, 'comment on')
        const { data } = await fetcher.json<ForgejoComment>(`${issuePath(ref)}/comments`, { method: 'POST', json: { body } })
        return toComment(ref, data)
      }),
      editComment: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (ref, body) => {
        const { data } = await fetcher.json<ForgejoComment>(`${repoPath(ref.thread.repo)}/issues/comments/${encodeURIComponent(ref.id)}`, { method: 'PATCH', json: { body } })
        return toComment(ref.thread, data)
      }),
      deleteComment: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (ref) => {
        await fetcher.raw(`${repoPath(ref.thread.repo)}/issues/comments/${encodeURIComponent(ref.id)}`, { method: 'DELETE' })
      }),
      create: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (repo, input) => {
        const labels = input.labels?.length ? await resolveLabels(repo, input.labels) : undefined
        const assignees = input.assignees?.map(actorLogin)
        if (input.kind === 'issue') {
          const { data } = await fetcher.json<ForgejoIssue>(`${repoPath(repo)}/issues`, {
            method: 'POST',
            json: { title: input.title, body: input.body, labels, assignees },
          })
          return toThread({ ...origin, repo, kind: 'issue', number: String(data.number) }, data)
        }
        if (!input.head || !input.base) {
          throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
        }
        const { data } = await fetcher.json<ForgejoIssue>(`${repoPath(repo)}/pulls`, {
          method: 'POST',
          json: { title: input.draft ? `WIP: ${input.title}` : input.title, body: input.body, head: input.head, base: input.base, labels, assignees },
        })
        return toThread({ ...origin, repo, kind: 'pull_request', number: String(data.number) }, data)
      }),
      update: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, input) => {
        const ref = requireIssueOrPull(thread, context, 'update')
        const { data } = await fetcher.json<ForgejoIssue>(ref.kind === 'pull_request' ? threadPath(ref) : issuePath(ref), {
          method: 'PATCH',
          json: input,
        })
        return toThread(ref, data)
      }),
      addLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        await fetcher.raw(`${issuePath(ref)}/labels`, { method: 'POST', json: { labels: await resolveLabels(ref.repo, labels) } })
      }),
      removeLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        for (const id of await resolveLabels(ref.repo, labels)) {
          await fetcher.raw(`${issuePath(ref)}/labels/${id}`, { method: 'DELETE' })
        }
      }),
      setMilestone: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, milestone) => {
        const ref = requireIssueOrPull(thread, context, 'set the milestone of')
        await fetcher.raw(issuePath(ref), { method: 'PATCH', json: { milestone: milestone === undefined ? 0 : Number(typeof milestone === 'string' ? milestone : milestone.id) } })
      }),
      reactionsPage: perKind(ISSUE_AND_PULL, async (target, listOptions = {}) => {
        const result = await fetcher.page<ForgejoReaction>(reactionPath(target), {
          query: { limit: listOptions.perPage },
          cursor: listOptions.cursor,
          signal: listOptions.signal,
        })
        return toPage(result, (raw) => {
          const reactor = toActor(context, raw.user)
          return reactor && { content: reactionContent(raw.content), contentRaw: raw.content, actor: reactor, createdAt: toDate(raw.created_at), raw }
        })
      }),
      reactions: perKind({ issue: 'experimental', pull_request: 'experimental' }, {
        react: (target, reaction) => setReaction(target, reaction, 'POST'),
        unreact: (target, reaction) => setReaction(target, reaction, 'DELETE'),
      }),
      setLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        await fetcher.raw(`${issuePath(ref)}/labels`, { method: 'PUT', json: { labels: await resolveLabels(ref.repo, labels) } })
      }),
      setAssignees: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, assignees) => {
        const ref = requireIssueOrPull(thread, context, 'assign')
        await fetcher.raw(issuePath(ref), { method: 'PATCH', json: { assignees: assignees.map(actorLogin) } })
      }),
      requestReview: perKind({ pull_request: 'experimental' }, async (thread, reviewers) => {
        await fetcher.raw(`${threadPath(requireThread(thread, context))}/requested_reviewers`, { method: 'POST', json: { reviewers: reviewers.map(actorLogin) } })
      }),
      close: perKind({ issue: 'experimental', pull_request: true }, ref => setState(ref, 'closed')),
      reopen: perKind({ issue: 'experimental', pull_request: true }, ref => setState(ref, 'open')),
      merge: verb(true, merge),
      subscriptions: perKind(ISSUE_AND_PULL, {
        async subscription(thread): Promise<SubscriptionState> {
          const ref = requireIssueOrPull(thread, context, 'read the subscription of')
          const { data } = await fetcher.json<{ subscribed: boolean, ignored: boolean }>(`${issuePath(ref)}/subscriptions/check`)
          return data.ignored ? 'ignored' : data.subscribed ? 'subscribed' : 'none'
        },
        async subscribe(thread) {
          const ref = requireIssueOrPull(thread, context, 'subscribe to')
          await fetcher.raw(await subscriptionPath({ owner: ref.repo.owner, name: ref.repo.name, number: ref.number }), { method: 'PUT' })
        },
        async unsubscribe(thread) {
          const ref = requireIssueOrPull(thread, context, 'unsubscribe from')
          await fetcher.raw(await subscriptionPath({ owner: ref.repo.owner, name: ref.repo.name, number: ref.number }), { method: 'DELETE' })
        },
      }),
    },
    web: githubShapedWeb(baseUrl.replace(/\/api\/v1$/, ''), { pull: 'pulls', commentFragment: 'issuecomment-', file: at => /^[0-9a-f]{40}$/.test(at) ? `/src/commit/${at}` : `/src/branch/${encodeURIComponent(at)}`, lineFragment: line => `L${line}`, reserved: FORGEJO_RESERVED_PATHS }),
    webhooks: {
      listPage: verb('experimental', (target, listOptions = {}) => list(hooksPath(target), listOptions, (raw: ForgejoHook) => toWebhook(target, raw))),
      create: verb('experimental', async (target, input) => toWebhook(target, (await fetcher.json<ForgejoHook>(hooksPath(target), {
        method: 'POST',
        json: {
          type: 'gitea',
          active: input.active ?? true,
          events: nativeEventsFor(FORGEJO_NATIVE_EVENTS, input.events, input.nativeEvents),
          config: { url: input.url, content_type: input.contentType ?? 'json', ...input.secret ? { secret: input.secret } : {} },
        },
      })).data)),
      update: verb('experimental', async (ref, update) => toWebhook(ref.target, (await fetcher.json<ForgejoHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, {
        method: 'PATCH',
        json: {
          ...update.active === undefined ? {} : { active: update.active },
          ...update.events || update.nativeEvents ? { events: nativeEventsFor(FORGEJO_NATIVE_EVENTS, update.events, update.nativeEvents) } : {},
          ...update.url || update.secret || update.contentType
            ? { config: { ...update.url ? { url: update.url } : {}, content_type: update.contentType ?? 'json', ...update.secret ? { secret: update.secret } : {} } }
            : {},
        },
      })).data)),
      delete: verb('experimental', async (ref) => {
        await fetcher.raw(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, { method: 'DELETE' })
      }),
      rotateSecret: verb('experimental', async (ref, secret) => {
        const current = toWebhook(ref.target, (await fetcher.json<ForgejoHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`)).data)
        const { data } = await fetcher.json<ForgejoHook>(`${hooksPath(ref.target)}/${encodeURIComponent(ref.id)}`, {
          method: 'PATCH',
          json: { config: { url: current.url, content_type: current.contentType ?? 'json', secret } },
        })
        return toWebhook(ref.target, data)
      }),
    },
    scopes: forgejoScopesFor,
  }
}

const FORGEJO = /* @__PURE__ */ forgejoDefinition(FORGEJO_PROFILE)

/** Creates a Forgejo provider for Codeberg or any self-hosted Forgejo instance. */
export const forgejo: ProviderFactoryFunction<ForgejoOptions> = /* @__PURE__ */ defineForgeProvider({ ...FORGEJO, webhooks: forgejoWebhooks(FORGEJO_PROFILE) })

/** `forgejo()` without webhook ingestion, for bundles that never receive a delivery. */
export const forgejoLite: ProviderFactoryFunction<ForgejoOptions> = /* @__PURE__ */ defineForgeProvider(FORGEJO)

/**
 * Forgejo and Gitea token scopes, which are per resource group with a
 * `read:` or `write:` prefix.
 */
export function forgejoScopesFor(verb: ForgeVerb): VerbScopes {
  const [group = '', name = ''] = verb.split('.')
  const writes = new Set(['comment', 'upsertComment', 'editComment', 'deleteComment', 'create', 'update', 'close', 'reopen', 'setLabels', 'addLabels', 'removeLabels', 'setMilestone', 'react', 'unreact', 'setAssignees', 'requestReview', 'merge', 'approveAndMerge', 'createReview', 'submitReview', 'approve', 'createLabel', 'addCollaborator', 'subscribe', 'unsubscribe', 'report'])
  const write = writes.has(name)
  if (group === 'webhooks') {
    return name === 'verify' || name === 'ingest' ? {} : { token: ['write:repository', 'write:organization'] }
  }
  if (group === 'notifications') {
    return { token: [name === 'list' || name === 'page' || name === 'unreadCount' ? 'read:notification' : 'write:notification'] }
  }
  if (group === 'users' || group === 'search') {
    return { token: ['read:user'] }
  }
  if (group === 'threads' || group === 'repos' || group === 'contents' || group === 'releases' || group === 'checks' || group === 'ci') {
    return { token: [write ? 'write:issue' : 'read:issue', write ? 'write:repository' : 'read:repository'] }
  }
  return {}
}
