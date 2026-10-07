import type { MergeHooks, ProviderDefinition, ProviderFactoryFunction } from '../define.ts'
import type {
  Actor,
  CheckState,
  Comment,
  CommentRef,
  Commit,
  CommitSearchQuery,
  Cursor,
  EventKind,
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
  RepoRole,
  RepoSearchQuery,
  ResolvedThreadRef,
  Review,
  SearchQuery,
  SecurityAlert,
  SecurityAlertListOptions,
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
  GitLabApprovals,
  GitLabAwardEmoji,
  GitLabCommit,
  GitLabCommitComment,
  GitLabCommitDetail,
  GitLabCommitStatus,
  GitLabCompare,
  GitLabDiff,
  GitLabFile,
  GitLabHook,
  GitLabHookEvent,
  GitLabIssue,
  GitLabJob,
  GitLabLabel,
  GitLabMember,
  GitLabMilestone,
  GitLabNote,
  GitLabNoteDetail,
  GitLabPipeline,
  GitLabProjectDetail,
  GitLabProjectSettings,
  GitLabRelease,
  GitLabTodo,
  GitLabUser,
  GitLabVulnerability,
} from './types.ts'
import { fromBase64, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { InsufficientScopeError, NotFoundError, soleMergeMethod, TokenRevokedError, toMergeError, UnresolvedThreadError, UnsupportedOperationError } from '../errors.ts'
import { isNamespaceRef, reactionContent } from '../model.ts'
import { createListing, getManyConcurrently, hexColour, memo, memoBy, phased, requireIssueOrPull, requireThread, resolveToken, syntheticReview, toDate, toPage, toWarning, versionAtLeast } from '../utils.ts'
import { nativeEventsFor } from '../webhooks.ts'
import {
  FORGE,
  projectId,
  repoRefFromWebUrl,
  REPORT_TYPES,
  toActor,
  toBranch,
  toChangedFile,
  toCiJob,
  toCommit,
  toCommitComment,
  toCommitCommentEvent,
  toCommitThread,
  toJobCheck,
  toLabel,
  toMilestone,
  toNoteComment,
  toNoteEvent,
  toNotification,
  toPipeline,
  toPipelineSummary,
  toRelease,
  toRepo,
  toRole,
  toStatusCheck,
  toTag,
  toThread,
  toTreeEntry,
  toVulnerability,
  toWebhook,
  toWebhookDelivery,
} from './normalise.ts'
import { gitlabWeb } from './web.ts'
import { GITLAB_NATIVE_EVENTS } from './webhook-events.ts'
import { gitlabWebhooks } from './webhooks.ts'

/** Personal, project, group or OAuth access token. */
export type GitLabAuth = TokenAuth | AnonymousAuth

export interface GitLabOptions extends ForgeOptionsBase {
  /** Defaults to `{ type: 'anonymous' }`: public reads only. */
  auth?: GitLabAuth
  /** Instance root, for example `https://gitlab.com`. */
  baseUrl?: string
}

/** GitLab versions with the webhook event log and resend endpoints. */
const GITLAB_HOOK_EVENTS = '17.0'

const ISSUE_LIKE = { issue: true, pull_request: true } as const

/** Access level per normalised role, as `POST /projects/:id/members` takes it. */
const ACCESS_LEVELS: Record<RepoRole, number> = { admin: 50, maintain: 40, write: 30, triage: 20, read: 10, none: 0 }

/** GitLab awards emoji by name; these are the names behind the normalised reactions. */
const AWARD_EMOJI: Record<ReactionContent, string> = {
  '+1': 'thumbsup',
  '-1': 'thumbsdown',
  'laugh': 'laughing',
  'confused': 'confused',
  'heart': 'heart',
  'hooray': 'tada',
  'rocket': 'rocket',
  'eyes': 'eyes',
}

/** The model's name for each award emoji `forges` writes. */
const REACTION_NAMES: Record<string, string> = Object.fromEntries(Object.entries(AWARD_EMOJI).map(([content, name]) => [name, content]))

const VULNERABILITIES_QUERY = `query ProjectVulnerabilities($fullPath: ID!, $first: Int, $after: String, $state: [VulnerabilityState!], $reportType: [VulnerabilityReportType!]) {
  project(fullPath: $fullPath) {
    vulnerabilities(first: $first, after: $after, state: $state, reportType: $reportType) {
      pageInfo { hasNextPage endCursor }
      nodes { id title severity state reportType detectedAt updatedAt dismissedAt resolvedAt webUrl }
    }
  }
}`

const BASE_METHODS: Record<NonNullable<GitLabProjectSettings['merge_method']>, MergeMethod> = {
  merge: 'merge',
  rebase_merge: 'rebase_merge',
  ff: 'fast_forward_only',
}

function threadPath(ref: ResolvedThreadRef): string {
  const project = `/projects/${projectId(ref.repo)}`
  switch (ref.kind) {
    case 'pull_request':
      return `${project}/merge_requests/${encodeURIComponent(ref.number)}`
    case 'commit':
      return `${project}/repository/commits/${encodeURIComponent(ref.number)}`
    default:
      return `${project}/issues/${encodeURIComponent(ref.number)}`
  }
}

const GITLAB: ProviderDefinition<GitLabOptions> = {
  forge: FORGE,
  baseUrl: 'https://gitlab.com',
  anonymous: true,
  apiPath: '/api/v4',
  headers: { accept: 'application/json' },
  authHeaders: ({ options: { auth } }) => auth?.type === 'token' ? async () => ({ authorization: `Bearer ${await resolveToken(auth)}` }) : undefined,
  setup({ instance, baseUrl, origin: context, fetcher }) {
    /**
     * GitLab lists pending and done to-dos separately. With `all`, pending
     * pages are followed by done pages; `cursor.token` marks the switch.
     */
    async function notificationPage(listOptions: NotificationListOptions = {}): Promise<Page<Notification>> {
      const cursor = listOptions.cursor
      const state = cursor?.token === 'done' ? 'done' : 'pending'
      const result = await fetcher.json<GitLabTodo[]>(cursor?.nextUrl ?? '/todos', {
        query: cursor?.nextUrl ? undefined : { state, per_page: listOptions.perPage },
        signal: listOptions.signal,
      })
      const since = listOptions.since?.getTime()
      const items = (result.data ?? [])
        .map(raw => toNotification(instance, raw))
        .filter(item => since === undefined || item.updatedAt.getTime() >= since)
      const phase = cursor?.token ?? 'pending'
      const next = result.cursor?.nextUrl
        ? { ...result.cursor, token: phase === 'done' ? 'done' : undefined }
        : listOptions.all && phase !== 'done' ? { token: 'done' } : undefined
      return { items, cursor: next, notModified: result.notModified }
    }

    /** GitLab assigns by user id, so logins are resolved once each. */
    /** Award emoji hang off the issue, the merge request or a note, all under the same path. */
    function awardPath(target: ThreadRef | CommentRef): string {
      return 'thread' in target
        ? `${threadPath(requireIssueOrPull(target.thread, context, 'react to'))}/notes/${target.id}`
        : threadPath(requireIssueOrPull(target, context, 'react to'))
    }

    /** The authenticated username, read once; removing an award needs its id, which is found by owner. */
    const viewerLogin = memo(() => fetcher.json<GitLabUser>('/user').then(result => result.data.username, () => undefined))

    const userIdByName = memoBy((username: string) => fetcher.json<GitLabUser[]>('/users', { query: { username } }).then(({ data }) => {
      if (!data[0]) {
        throw new UnsupportedOperationError(`No GitLab user named ${username}`, context)
      }
      return data[0].id
    }))

    function userId(actor: string | Actor): Promise<number> {
      if (typeof actor !== 'string' && /^\d+$/.test(actor.id)) {
        return Promise.resolve(Number(actor.id))
      }
      return userIdByName(typeof actor === 'string' ? actor : actor.login)
    }

    const STATUS_STATES: Record<CheckState, string> = { pending: 'pending', success: 'success', failure: 'failed', neutral: 'success', unknown: 'pending' }
    const PIPELINE_STATES: Record<CheckState, string | undefined> = { pending: 'running', success: 'success', failure: 'failed', neutral: 'manual', unknown: undefined }

    async function setDiscussionResolved(thread: ThreadRef, id: string, resolved: boolean): Promise<void> {
      const ref = requireThread(thread, context)
      await fetcher.raw(`${threadPath(ref)}/discussions/${encodeURIComponent(id)}`, { method: 'PUT', query: { resolved } })
    }

    const list = createListing(fetcher, 'per_page')

    async function readUser(path: string): Promise<User> {
      const { data } = await fetcher.json<GitLabUser & { bio?: string, organization?: string, location?: string, website_url?: string, created_at?: string, followers?: number, following?: number }>(path)
      return { ...toActor(instance, data)!, bio: data.bio || undefined, company: data.organization || undefined, location: data.location || undefined, websiteUrl: data.website_url || undefined, createdAt: toDate(data.created_at), followers: data.followers, following: data.following, raw: data }
    }

    function projectPath(repo: RepoRef): string {
      return `/projects/${projectId(repo)}`
    }

    /** Project hooks, or group hooks for a namespace ref. */
    function hooksPath(target: RepoRef): string {
      return isNamespaceRef(target)
        ? `/groups/${encodeURIComponent(target.externalId ?? target.owner)}/hooks`
        : `${projectPath(target)}/hooks`
    }

    /** GitLab subscribes with one boolean per event group rather than a list of names. */
    function hookFlags(input: { events?: EventKind[], nativeEvents?: string[] }): Record<string, boolean> {
      return Object.fromEntries(nativeEventsFor(GITLAB_NATIVE_EVENTS, input.events, input.nativeEvents).map((flag: string) => [flag, true]))
    }

    function requireMerge(thread: ThreadRef, action: string): ResolvedThreadRef {
      const ref = requireThread(thread, context)
      if (ref.kind !== 'pull_request') {
        throw new UnsupportedOperationError(`Only merge requests can be ${action}`, context)
      }
      return ref
    }

    /** GitLab's file endpoint needs an explicit ref, so the project's default branch stands in. */
    async function defaultBranch(repo: RepoRef): Promise<string> {
      const { data } = await fetcher.json<GitLabProjectDetail>(projectPath(repo))
      return data.default_branch ?? 'HEAD'
    }

    async function get(thread: ThreadRef): Promise<Thread> {
      const ref = requireThread(thread, context)
      if (ref.kind === 'discussion') {
        throw new UnsupportedOperationError('GitLab has no discussion threads', context)
      }
      if (ref.kind === 'commit') {
        return toCommitThread(ref, (await fetcher.json<GitLabCommit>(threadPath(ref))).data)
      }
      const { data } = await fetcher.json<GitLabIssue>(threadPath(ref))
      const result = toThread(ref, data)
      if (data.head_pipeline) {
        result.checks = toPipelineSummary(data.head_pipeline)
      }
      return result
    }

    const graphqlUrl = `${baseUrl.replace(/\/api\/v4$/, '')}/api/graphql`

    async function vulnerabilitiesPage(repo: RepoRef, listOptions: SecurityAlertListOptions = {}): Promise<Page<SecurityAlert>> {
      const state = listOptions.state ?? 'open'
      const { data } = await fetcher.json<{
        data?: { project?: { vulnerabilities?: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: GitLabVulnerability[] } | null } | null }
        errors?: Array<{ message: string }>
      }>(graphqlUrl, {
        method: 'POST',
        json: {
          operationName: 'ProjectVulnerabilities',
          query: VULNERABILITIES_QUERY,
          variables: {
            fullPath: `${repo.owner}/${repo.name}`,
            first: Math.min(listOptions.perPage ?? 50, 100),
            after: listOptions.cursor?.token ?? null,
            state: state === 'open' ? ['DETECTED', 'CONFIRMED'] : state === 'closed' ? ['RESOLVED', 'DISMISSED'] : null,
            reportType: listOptions.kind ? REPORT_TYPES[listOptions.kind] : null,
          },
        },
        signal: listOptions.signal,
      })
      const vulnerabilities = data.data?.project?.vulnerabilities
      if (!vulnerabilities) {
        const error = new InsufficientScopeError(
          data.errors?.[0]?.message ?? 'The token cannot read vulnerabilities for this project, or its licence has no vulnerability report',
          403,
          '',
          context,
        )
        if (listOptions.kind) {
          throw error
        }
        return { items: [], warnings: [toWarning('insufficient_scope', error, `${repo.owner}/${repo.name}`)] }
      }
      return {
        items: vulnerabilities.nodes.map(node => toVulnerability(repo, node)),
        cursor: vulnerabilities.pageInfo.hasNextPage && vulnerabilities.pageInfo.endCursor ? { token: vulnerabilities.pageInfo.endCursor } : undefined,
      }
    }

    async function releasesPage(repo: RepoRef, listOptions: PageOptions = {}): Promise<Page<Release>> {
      return list(`${projectPath(repo)}/releases`, listOptions, (raw: GitLabRelease) => toRelease(repo, raw))
    }

    async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
      if (query.kind === 'discussion') {
        return { items: [], warnings: [{ code: 'kind_unsupported', message: 'GitLab has no discussion threads' }] }
      }
      const warnings: ForgeWarning[] = !query.cursor && query.sort === 'comments'
        ? [{ code: 'sort_unsupported', message: 'GitLab cannot sort by comment count; sorted by creation time' }]
        : []
      const state = query.state ?? 'open'
      const kinds = query.kind ? [query.kind] : ['issue', 'pull_request'] as const
      const page = await phased(kinds.map(kind => async (cursor?: Cursor): Promise<Page<Thread>> => {
        const merges = kind === 'pull_request'
        const result = await fetcher.page<GitLabIssue>(`${projectPath(repo)}/${merges ? 'merge_requests' : 'issues'}`, {
          query: {
            state: state === 'open' ? 'opened' : state === 'merged' ? 'merged' : state === 'closed' && !merges ? 'closed' : undefined,
            labels: query.labels?.join(','),
            author_username: query.author,
            assignee_username: query.assignee,
            updated_after: query.since?.toISOString(),
            created_after: query.createdAfter?.toISOString(),
            order_by: query.sort === 'updated' ? 'updated_at' : 'created_at',
            sort: query.direction ?? 'desc',
            per_page: query.perPage,
          },
          cursor,
          signal: query.signal,
        })
        return toPage(result, raw => merges && state === 'closed' && raw.state === 'opened'
          ? undefined
          : toThread({ forge: FORGE, instance, repo, kind, number: String(raw.iid) }, raw))
      }), query.cursor)
      return warnings.length ? { ...page, warnings } : page
    }

    /** Cross-project search runs on the global issue and merge request listings, which take `search` and `in`. */
    async function searchThreadsPage(query: SearchQuery): Promise<Page<Thread>> {
      const warnings: ForgeWarning[] = []
      if (!query.cursor && query.involves) {
        warnings.push({ code: 'filter_unsupported', message: 'GitLab has no involves filter; it was ignored' })
      }
      if (!query.cursor && query.sort === 'comments') {
        warnings.push({ code: 'sort_unsupported', message: 'GitLab cannot sort by comment count; sorted by update time' })
      }
      const state = query.state ?? 'all'
      const kinds = query.kind ? [query.kind] : ['issue', 'pull_request'] as const
      const page = await phased(kinds.map(kind => async (cursor?: Cursor): Promise<Page<Thread>> => {
        const merges = kind === 'pull_request'
        const base = query.repo ? `${projectPath(query.repo)}/` : '/'
        const result = await fetcher.page<GitLabIssue>(`${base}${merges ? 'merge_requests' : 'issues'}`, {
          query: {
            scope: query.repo ? undefined : 'all',
            search: query.text,
            in: query.text ? 'title,description' : undefined,
            state: state === 'open' ? 'opened' : state === 'closed' ? 'closed' : undefined,
            labels: query.labels?.join(','),
            author_username: query.author,
            assignee_username: query.assignee,
            updated_after: query.since?.toISOString(),
            order_by: query.sort === 'created' ? 'created_at' : 'updated_at',
            sort: query.direction ?? 'desc',
            per_page: query.perPage,
          },
          cursor,
          signal: query.signal,
        })
        return toPage(result, (raw) => {
          const repo = query.repo ?? repoRefFromWebUrl(instance, raw.web_url, merges ? raw.target_project_id : undefined)
          return repo ? toThread({ forge: FORGE, instance, repo, kind, number: String(raw.iid) }, raw) : undefined
        })
      }), query.cursor)
      return warnings.length ? { ...page, warnings: [...warnings, ...page.warnings ?? []] } : page
    }

    async function searchReposPage(query: RepoSearchQuery): Promise<Page<Repo>> {
      const path = query.owner ? `/groups/${encodeURIComponent(query.owner)}/projects` : '/projects'
      const result = await fetcher.page<GitLabProjectDetail>(path, {
        query: {
          search: query.text,
          order_by: query.sort === 'created' ? 'created_at' : query.sort === 'stars' ? 'star_count' : query.sort === 'updated' ? 'updated_at' : undefined,
          sort: query.direction,
          per_page: query.perPage,
        },
        cursor: query.cursor,
        signal: query.signal,
      })
      return toPage(result, raw => toRepo(instance, raw))
    }

    /** Needs Advanced Search, which no endpoint reports; an instance without it returns an empty page. */
    async function searchCommitsPage(query: CommitSearchQuery): Promise<Page<Commit>> {
      const unsupported = (['author', 'committer', 'since', 'until', 'sort'] as const).filter(field => query[field] !== undefined)
      const warnings: ForgeWarning[] = unsupported.length
        ? [{ code: 'filter_unsupported', message: `GitLab commit search cannot filter or sort by ${unsupported.join(', ')}` }]
        : []
      const result = await fetcher.page<GitLabCommitDetail & { project_id?: number }>(
        query.repo ? `${projectPath(query.repo)}/search` : '/search',
        {
          query: { scope: 'commits', search: query.text ?? '', per_page: query.perPage },
          cursor: query.cursor,
          signal: query.signal,
        },
      )
      const repo = query.repo
      return toPage(result, raw => repo && toCommit(repo, raw), warnings)
    }

    async function setSubscribed(thread: ThreadRef, subscribed: boolean): Promise<void> {
      const ref = requireIssueOrPull(thread, context, subscribed ? 'subscribe to' : 'unsubscribe from')
      await fetcher.raw(`${threadPath(ref)}/${subscribed ? 'subscribe' : 'unsubscribe'}`, { method: 'POST' })
    }

    async function unsubscribe(_ref: NotificationRef, writeOptions: NotificationWriteOptions = {}): Promise<void> {
      if (!writeOptions.thread) {
        throw new UnresolvedThreadError(
          'GitLab cannot look up a to-do by id; pass { thread } to unsubscribe',
          context,
        )
      }
      const thread = requireThread(writeOptions.thread, context)
      if (thread.kind !== 'issue' && thread.kind !== 'pull_request') {
        throw new UnsupportedOperationError(`GitLab cannot unsubscribe from a ${thread.kind}`, context)
      }
      await fetcher.raw(`${threadPath(thread)}/unsubscribe`, { method: 'POST' })
    }

    async function setState(thread: ThreadRef, stateEvent: 'close' | 'reopen'): Promise<void> {
      await fetcher.raw(threadPath(requireIssueOrPull(thread, context, stateEvent)), {
        method: 'PUT',
        json: { state_event: stateEvent },
      })
    }

    async function resolveMergeMethod(ref: ResolvedThreadRef, requested?: MergeMethod): Promise<MergeMethod> {
      if (requested === 'squash') {
        return requested
      }
      const { data: project } = await fetcher.json<GitLabProjectSettings>(`/projects/${projectId(ref.repo)}`)
      const base = BASE_METHODS[project.merge_method ?? 'merge']
      const squash = project.squash_option ?? 'default_off'
      if (requested) {
        if (requested !== base || squash === 'always') {
          throw new UnsupportedOperationError(
            `This project merges with ${squash === 'always' ? 'squash' : base}; GitLab cannot override it per merge request`,
            context,
          )
        }
        return requested
      }
      return soleMergeMethod({ [base]: squash !== 'always', squash: squash !== 'never' }, context)
    }

    /** GitLab has approvals, not reviews: one synthesised review per approver, with no comments to hang on it. */
    function toApprovalReviews(ref: ResolvedThreadRef, approvals: GitLabApprovals): Review[] {
      return (approvals.approved_by ?? []).map(({ user }) => syntheticReview(ref, `approval:${user?.username ?? user?.id ?? ''}`, 'approved', { author: toActor(instance, user), stateRaw: 'approved', raw: user }))
    }

    async function approve(thread: ThreadRef, body?: string): Promise<GitLabApprovals> {
      const ref = requireThread(thread, context)
      if (ref.kind !== 'pull_request') {
        throw new UnsupportedOperationError('Only merge requests can be approved', context)
      }
      if (body) {
        throw new UnsupportedOperationError('GitLab approvals carry no body; leave a comment instead', context)
      }
      const { data } = await fetcher.json<GitLabApprovals>(`${threadPath(ref)}/approve`, {
        method: 'POST',
        mapError: error => error instanceof TokenRevokedError
          ? new InsufficientScopeError('Not allowed to approve this merge request', 401, error.body, { ...context, url: error.url, method: error.method }, { cause: error })
          : error,
      })
      return data
    }

    async function merge(thread: ThreadRef, mergeOptions: MergeOptions = {}, hooks: MergeHooks = {}): Promise<void> {
      const ref = requireThread(thread, context)
      if (ref.kind !== 'pull_request') {
        throw new UnsupportedOperationError('Only merge requests can be merged', context)
      }
      const method = await resolveMergeMethod(ref, mergeOptions.method)
      await hooks.beforeMerge?.()
      await fetcher.raw(`${threadPath(ref)}/merge`, {
        method: 'PUT',
        json: {
          sha: mergeOptions.sha,
          ...mergeOptions.message ? { [method === 'squash' ? 'squash_commit_message' : 'merge_commit_message']: mergeOptions.message } : {},
          squash: method === 'squash',
          merge_when_pipeline_succeeds: mergeOptions.whenChecksPass ?? false,
        },
        mapError: toMergeError,
      })
    }

    return {
      traits: { poll: true, eventKinds: 'heuristic', authKinds: ['token', 'anonymous'], limits: { bodyLength: 1_048_576, commentLength: 1_000_000, labelLength: 255 } },
      probeVersion: async () => (await fetcher.json<{ version?: string }>('/version')).data.version,
      web: gitlabWeb(baseUrl.replace(/\/api\/v4$/, '')),
      webhooks: {
        listPage: verb('experimental', (target, listOptions = {}) => list(hooksPath(target), listOptions, (raw: GitLabHook) => toWebhook(target, raw))),
        create: verb('experimental', async (target, input) => toWebhook(target, (await fetcher.json<GitLabHook>(hooksPath(target), {
          method: 'POST',
          json: { url: input.url, token: input.secret, ...hookFlags(input) },
        })).data)),
        update: verb('experimental', async (ref, update) => toWebhook(ref.target, (await fetcher.json<GitLabHook>(`${hooksPath(ref.target)}/${ref.id}`, {
          method: 'PUT',
          json: { ...update.url ? { url: update.url } : {}, ...update.secret ? { token: update.secret } : {}, ...hookFlags(update) },
        })).data)),
        delete: verb('experimental', async (ref) => {
          await fetcher.raw(`${hooksPath(ref.target)}/${ref.id}`, { method: 'DELETE' })
        }),
        rotateSecret: verb('experimental', async (ref, secret) => toWebhook(ref.target, (await fetcher.json<GitLabHook>(`${hooksPath(ref.target)}/${ref.id}`, {
          method: 'PUT',
          json: { token: secret },
        })).data)),
        deliveriesPage: verb(({ version }) => versionAtLeast(version, GITLAB_HOOK_EVENTS), (ref, listOptions = {}) => list(`${hooksPath(ref.target)}/${ref.id}/events`, listOptions, (raw: GitLabHookEvent) => toWebhookDelivery(ref, raw))),
        redeliver: verb(({ version }) => versionAtLeast(version, GITLAB_HOOK_EVENTS), async (ref) => {
          await fetcher.raw(`${hooksPath(ref.hook.target)}/${ref.hook.id}/events/${ref.id}/resend`, { method: 'POST' })
        }),
      },
      scopes: gitlabScopesFor,
      users: {
        get: verb(true, async (login) => {
          const { data: matches } = await fetcher.json<GitLabUser[]>('/users', { query: { username: login } })
          if (!matches?.[0]) {
            throw new NotFoundError(`No GitLab user named ${login}`, 404, '', context)
          }
          return readUser(`/users/${matches[0].id}`)
        }),
        me: verb(true, () => readUser('/user')),
      },
      repos: {
        get: verb(true, async (ref) => {
          return toRepo(instance, (await fetcher.json<GitLabProjectDetail>(projectPath(ref))).data)
        }),
        listPage: verb(true, (listOptions = {}) => list('/projects', listOptions, (raw: GitLabProjectDetail) => toRepo(instance, raw), { query: { membership: true } })),
        labelsPage: verb(true, (repo, listOptions = {}) => list(`${projectPath(repo)}/labels`, listOptions, toLabel)),
        createLabel: verb('experimental', async (repo, label) => toLabel((await fetcher.json<GitLabLabel>(`${projectPath(repo)}/labels`, {
          method: 'POST',
          json: { name: label.name, color: hexColour(label.colour, '#'), description: label.description },
        })).data)),
        milestonesPage: verb(true, (repo, listOptions = {}) => list(`${projectPath(repo)}/milestones`, listOptions, (raw: GitLabMilestone) => toMilestone(raw)!, { query: { state: (listOptions.state ?? 'open') === 'all' ? undefined : listOptions.state === 'closed' ? 'closed' : 'active' } })),
        collaboratorsPage: verb(true, (repo, listOptions = {}) => list(`${projectPath(repo)}/members/all`, listOptions, (raw: GitLabMember) => ({ actor: toActor(instance, raw)!, role: toRole(raw.access_level), roleRaw: String(raw.access_level), raw }))),
        permissionFor: verb(true, async (repo, actor) => {
          try {
            const { data } = await fetcher.json<GitLabMember>(`${projectPath(repo)}/members/all/${await userId(actor)}`)
            return toRole(data.access_level)
          }
          catch (error) {
            if (error instanceof NotFoundError) {
              return 'none'
            }
            throw error
          }
        }),
        addCollaborator: verb('experimental', async (repo, actor, role) => {
          await fetcher.raw(`${projectPath(repo)}/members`, { method: 'POST', json: { user_id: await userId(actor), access_level: ACCESS_LEVELS[role] } })
        }),
        assignableUsersPage: verb(true, (repo, listOptions = {}) => list(`${projectPath(repo)}/users`, listOptions, (raw: GitLabUser) => toActor(instance, raw)!)),
        reviewerCandidatesPage: verb('emulated', (thread, listOptions = {}) => list(`${projectPath(requireThread(thread, context).repo)}/users`, listOptions, (raw: GitLabUser) => toActor(instance, raw)!)),
      },
      notifications: {
        listPage: verb(true, notificationPage),
        markDone: verb(true, async (ref) => {
          await fetcher.raw(`/todos/${ref.id}/mark_as_done`, { method: 'POST' })
        }),
        unsubscribe: verb(true, unsubscribe),
        markAllDone: verb('experimental', async (bulk: BulkNotificationOptions = {}) => {
          if (bulk.repo || bulk.before) {
            throw new UnsupportedOperationError('GitLab marks every to-do done at once; repo and before filters are not supported', context)
          }
          await fetcher.raw('/todos/mark_as_done', { method: 'POST' })
        }),
        unreadCount: verb(true, async () => {
          const response = await fetcher.raw('/todos', { query: { state: 'pending', per_page: 1 } })
          const total = response.headers.get('x-total')
          if (total === null) {
            throw new UnsupportedOperationError('GitLab omitted X-Total; the to-do count is too large to report', context)
          }
          return Number(total)
        }),
      },
      contents: {
        file: verb(true, async (repo, path, fileOptions = {}) => {
          const ref = fileOptions.ref ?? await defaultBranch(repo)
          const { data } = await fetcher.json<GitLabFile>(`${projectPath(repo)}/repository/files/${encodeURIComponent(path.replace(/^\//, ''))}`, {
            query: { ref },
            signal: fileOptions.signal,
          })
          const file = { path: data.file_path, sha: data.blob_id, size: data.size }
          return toFileContent(fromBase64(data.content ?? ''), file, fileOptions, context)
        }),
        treePage: verb(true, (repo, treeOptions = {}) => list(`${projectPath(repo)}/repository/tree`, treeOptions, toTreeEntry, { query: { ref: treeOptions.ref, path: treeOptions.path, recursive: treeOptions.recursive ? 'true' : undefined } })),
        branchesPage: verb(true, (repo, listOptions = {}) => list(`${projectPath(repo)}/repository/branches`, listOptions, toBranch)),
        tagsPage: verb(true, (repo, listOptions = {}) => list(`${projectPath(repo)}/repository/tags`, listOptions, toTag)),
        resolveRef: verb(true, async (repo, ref) => (await fetcher.json<GitLabCommitDetail>(`${projectPath(repo)}/repository/commits/${encodeURIComponent(ref)}`)).data.id),
        commitsPage: verb(true, (repo, query = {}) => list(`${projectPath(repo)}/repository/commits`, query, (raw: GitLabCommitDetail) => toCommit(repo, raw), { query: { ref_name: query.ref, path: query.path, author: query.author, since: query.since?.toISOString(), until: query.until?.toISOString() } })),
        commit: verb(true, async (repo, sha) => {
          const [commit, diffs] = await Promise.all([
            fetcher.json<GitLabCommitDetail>(`${projectPath(repo)}/repository/commits/${sha}`, { query: { stats: 'true' } }),
            fetcher.json<GitLabDiff[]>(`${projectPath(repo)}/repository/commits/${sha}/diff`),
          ])
          return toCommit(repo, commit.data, (diffs.data ?? []).map(toChangedFile))
        }),
        compare: verb(true, async (repo, base, head) => {
          const { data } = await fetcher.json<GitLabCompare>(`${projectPath(repo)}/repository/compare`, { query: { from: base, to: head } })
          return {
            base,
            head,
            aheadBy: data.commits?.length,
            commits: (data.commits ?? []).map(raw => toCommit(repo, raw)),
            files: (data.diffs ?? []).map(toChangedFile),
            raw: data,
          }
        }),
      },
      releases: {
        listPage: verb(true, releasesPage),
        get: verb(true, async ref => toRelease(ref.repo, (await fetcher.json<GitLabRelease>(`${projectPath(ref.repo)}/releases/${encodeURIComponent(ref.tag ?? ref.id)}`)).data)),
        getByTag: verb(true, async (repo, tag) => toRelease(repo, (await fetcher.json<GitLabRelease>(`${projectPath(repo)}/releases/${encodeURIComponent(tag)}`)).data)),
        latest: verb(true, async (repo) => {
          const { items } = await releasesPage(repo, { perPage: 20 })
          return items.find(release => release.publishedAt)
        }),
      },
      search: {
        threadsPage: verb(true, searchThreadsPage),
        reposPage: verb(true, searchReposPage),
        commitsPage: verb('experimental', searchCommitsPage),
      },
      checks: {
        list: verb(true, async (repo, sha) => ({
          items: await Array.fromAsync(
            fetcher.items<GitLabCommitStatus>(`${projectPath(repo)}/repository/commits/${sha}/statuses`, { query: { per_page: 100 } }),
            raw => toStatusCheck(repo, raw),
          ),
        })),
        report: verb('experimental', async (repo, sha, input) => toStatusCheck(repo, (await fetcher.json<GitLabCommitStatus>(`${projectPath(repo)}/statuses/${sha}`, {
          method: 'POST',
          json: {
            state: STATUS_STATES[input.state],
            name: input.name,
            description: input.description,
            target_url: input.url,
          },
        })).data)),
        rerun: verb('experimental', async (ref) => {
          if (ref.type !== 'job' && ref.type !== 'status') {
            throw new UnsupportedOperationError(`GitLab cannot re-run a ${ref.type}`, context)
          }
          await fetcher.raw(`${projectPath(ref.repo)}/jobs/${ref.id}/retry`, { method: 'POST' })
        }),
      },
      ci: {
        runsPage: verb(true, (repo, query = {}) => list(`${projectPath(repo)}/pipelines`, query, (raw: GitLabPipeline) => toPipeline(repo, raw), { query: { ref: query.branch, status: PIPELINE_STATES[query.state ?? 'unknown'] } })),
        run: verb(true, async ref => toPipeline(ref.repo, (await fetcher.json<GitLabPipeline>(`${projectPath(ref.repo)}/pipelines/${ref.id}`)).data)),
        jobsPage: verb(true, (ref, listOptions = {}) => list(`${projectPath(ref.repo)}/pipelines/${ref.id}/jobs`, listOptions, (raw: GitLabJob) => toCiJob(ref, raw))),
        log: verb('experimental', async ref => (await fetcher.stream(`${projectPath(ref.repo)}/jobs/${encodeURIComponent(ref.id)}/trace`)).body),
      },
      securityAlerts: {
        kinds: { dependency: 'experimental', code_scanning: 'experimental', secret: 'experimental' },
        listPage: vulnerabilitiesPage,
      },
      threads: {
        filesPage: verb(true, (thread, listOptions = {}) => list(`${threadPath(requireMerge(thread, 'read for changed files'))}/diffs`, listOptions, toChangedFile)),
        commitsPage: verb(true, (thread, listOptions = {}) => list(`${threadPath(requireMerge(thread, 'read for commits'))}/commits`, listOptions, (raw: GitLabCommitDetail) => toCommit(thread.repo, raw))),
        reviewsPage: verb('emulated', async (thread) => {
          const ref = requireThread(thread, context)
          if (ref.kind !== 'pull_request') {
            throw new UnsupportedOperationError('Only merge requests have approvals', context)
          }
          const { data } = await fetcher.json<GitLabApprovals>(`${threadPath(ref)}/approvals`)
          return { items: toApprovalReviews(ref, data) }
        }),
        approve: verb(true, async (thread, body) => {
          await approve(thread, body)
        }),
        createReview: verb('emulated', async (thread, input) => {
          if (input.event !== 'approve') {
            throw new UnsupportedOperationError('GitLab has approvals, not reviews; only `approve` can be created', context)
          }
          if (input.comments?.length) {
            throw new UnsupportedOperationError('GitLab approvals carry no inline comments; post them as discussions', context)
          }
          const ref = requireThread(thread, context)
          const approvals = await approve(ref, input.body)
          const viewer = await viewerLogin()
          const reviews = toApprovalReviews(ref, approvals)
          return reviews.find(review => review.author?.login === viewer) ?? reviews.at(-1) ?? {
            ref: { forge: FORGE, instance, thread: ref, id: 'approval:' },
            state: 'approved' as const,
            stateRaw: 'approved',
            comments: false as const,
            raw: approvals,
          }
        }),
        reviewThreads: verb('experimental', {
          resolveReviewThread: (thread, id) => setDiscussionResolved(thread, id, true),
          unresolveReviewThread: (thread, id) => setDiscussionResolved(thread, id, false),
        }),
        checks: perKind({ pull_request: true }, async (thread) => {
          const ref = requireThread(thread, context)
          const { data } = await fetcher.json<GitLabIssue>(threadPath(ref))
          if (!data.head_pipeline) {
            return { items: [] }
          }
          return { items: await Array.fromAsync(fetcher.items<GitLabJob>(`${projectPath(ref.repo)}/pipelines/${data.head_pipeline.id}/jobs`, { query: { per_page: 100 } }), job => toJobCheck(ref.repo, job)) }
        }),
        get: perKind({ issue: true, pull_request: true, commit: 'experimental' }, get),
        getMany: verb(true, refs => getManyConcurrently(refs, get)),
        listPage: perKind(ISSUE_LIKE, listPage),
        eventsPage: verb(true, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> => {
          const ref = requireThread(thread, context)
          if (ref.kind === 'commit') {
            const offset = Number(listOptions.cursor?.token ?? 0)
            const result = await fetcher.page<GitLabCommitComment>(`${threadPath(ref)}/comments`, { query: { per_page: listOptions.perPage }, cursor: listOptions.cursor, signal: listOptions.signal })
            let index = offset
            const page = toPage(result, comment => toCommitCommentEvent(ref, comment, index++))
            return page.cursor ? { ...page, cursor: { ...page.cursor, token: String(index) } } : page
          }
          return list(`${threadPath(ref)}/notes`, listOptions, (note: GitLabNote) => toNoteEvent(ref, note), { query: { sort: 'asc', order_by: 'created_at' } })
        }),
        commentsPage: perKind({ issue: true, pull_request: true, commit: 'experimental' }, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> => {
          const ref = requireThread(thread, context)
          if (ref.kind === 'commit') {
            return list(`${threadPath(ref)}/comments`, listOptions, (comment: GitLabCommitComment) => toCommitComment(ref, comment))
          }
          return list(`${threadPath(requireIssueOrPull(ref, context, 'list comments on'))}/notes`, listOptions, (note: GitLabNoteDetail) => note.system ? undefined : toNoteComment(ref, note), { query: { sort: 'asc', order_by: 'created_at' } })
        }),
        comment: perKind({ issue: 'experimental', pull_request: true, commit: 'experimental' }, async (thread, body) => {
          const ref = requireThread(thread, context)
          if (ref.kind === 'commit') {
            const { data } = await fetcher.json<GitLabCommitComment>(`${threadPath(ref)}/comments`, { method: 'POST', json: { note: body } })
            return toCommitComment(ref, data)
          }
          const { data } = await fetcher.json<GitLabNoteDetail>(`${threadPath(requireIssueOrPull(ref, context, 'comment on'))}/notes`, {
            method: 'POST',
            json: { body },
          })
          return toNoteComment(ref, data)
        }),
        editComment: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (ref, body) => {
          const thread = requireIssueOrPull(ref.thread, context, 'edit comments on')
          const { data } = await fetcher.json<GitLabNoteDetail>(`${threadPath(thread)}/notes/${ref.id}`, { method: 'PUT', json: { body } })
          return toNoteComment(thread, data)
        }),
        deleteComment: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (ref) => {
          const thread = requireIssueOrPull(ref.thread, context, 'delete comments on')
          await fetcher.raw(`${threadPath(thread)}/notes/${ref.id}`, { method: 'DELETE' })
        }),
        create: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (repo, input) => {
          if (input.kind === 'discussion') {
            throw new UnsupportedOperationError('GitLab has no discussion threads', context)
          }
          const assignee_ids = input.assignees?.length ? await Promise.all(input.assignees.map(userId)) : undefined
          const labels = input.labels?.join(',')
          if (input.kind === 'issue') {
            const { data } = await fetcher.json<GitLabIssue>(`${projectPath(repo)}/issues`, {
              method: 'POST',
              json: { title: input.title, description: input.body, labels, assignee_ids },
            })
            return toThread({ forge: FORGE, instance, repo, kind: 'issue', number: String(data.iid) }, data)
          }
          if (!input.head || !input.base) {
            throw new UnsupportedOperationError('Creating a merge request needs head and base branches', context)
          }
          const { data } = await fetcher.json<GitLabIssue>(`${projectPath(repo)}/merge_requests`, {
            method: 'POST',
            json: {
              title: input.draft ? `Draft: ${input.title}` : input.title,
              description: input.body,
              source_branch: input.head,
              target_branch: input.base,
              labels,
              assignee_ids,
            },
          })
          return toThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: String(data.iid) }, data)
        }),
        update: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, input) => {
          const ref = requireIssueOrPull(thread, context, 'update')
          const { data } = await fetcher.json<GitLabIssue>(threadPath(ref), {
            method: 'PUT',
            json: { title: input.title, description: input.body },
          })
          return toThread(ref, data)
        }),
        addLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
          const ref = requireIssueOrPull(thread, context, 'label')
          await fetcher.raw(threadPath(ref), { method: 'PUT', json: { add_labels: labels.join(',') } })
        }),
        removeLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
          const ref = requireIssueOrPull(thread, context, 'label')
          await fetcher.raw(threadPath(ref), { method: 'PUT', json: { remove_labels: labels.join(',') } })
        }),
        setMilestone: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, milestone) => {
          const ref = requireIssueOrPull(thread, context, 'set the milestone of')
          await fetcher.raw(threadPath(ref), { method: 'PUT', json: { milestone_id: milestone === undefined ? 0 : Number(typeof milestone === 'string' ? milestone : milestone.id) } })
        }),
        reactionsPage: perKind(ISSUE_LIKE, async (target, listOptions = {}) => {
          const result = await fetcher.page<GitLabAwardEmoji & { created_at?: string }>(`${awardPath(target)}/award_emoji`, {
            query: { per_page: listOptions.perPage },
            cursor: listOptions.cursor,
            signal: listOptions.signal,
          })
          return toPage(result, (raw) => {
            const reactor = toActor(instance, raw.user)
            return reactor && { content: reactionContent(REACTION_NAMES[raw.name] ?? raw.name), contentRaw: raw.name, actor: reactor, createdAt: toDate(raw.created_at), raw }
          })
        }),
        reactions: perKind({ issue: 'experimental', pull_request: 'experimental' }, {
          async react(target, reaction) {
            await fetcher.raw(`${awardPath(target)}/award_emoji`, { method: 'POST', json: { name: AWARD_EMOJI[reaction] } })
          },
          async unreact(target, reaction) {
            const path = `${awardPath(target)}/award_emoji`
            const { data } = await fetcher.json<GitLabAwardEmoji[]>(path, { query: { per_page: 100 } })
            const login = await viewerLogin()
            const mine = data.find(award => award.name === AWARD_EMOJI[reaction] && award.user?.username === login)
            if (mine) {
              await fetcher.raw(`${path}/${mine.id}`, { method: 'DELETE' })
            }
          },
        }),
        transfer: verb('experimental', async (thread, repo) => {
          const ref = requireIssueOrPull(thread, context, 'transfer')
          if (ref.kind !== 'issue') {
            throw new UnsupportedOperationError('GitLab moves issues only', context)
          }
          const { data: target } = await fetcher.json<{ id: number }>(`/projects/${projectId(repo)}`)
          const { data } = await fetcher.json<GitLabIssue>(`${threadPath(ref)}/move`, { method: 'POST', json: { to_project_id: target.id } })
          return { forge: FORGE, instance, repo, kind: 'issue', number: String(data.iid), externalId: data.id === undefined ? undefined : String(data.id) }
        }),
        markDuplicate: verb('emulated', async (thread, canonical) => {
          const ref = requireIssueOrPull(thread, context, 'mark duplicate')
          const reference = canonical.repo.owner === ref.repo.owner && canonical.repo.name === ref.repo.name
            ? `#${canonical.number}`
            : `${canonical.repo.owner}/${canonical.repo.name}#${canonical.number}`
          await fetcher.raw(`${threadPath(ref)}/notes`, { method: 'POST', json: { body: `/duplicate ${reference}` } })
        }),
        setLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
          const ref = requireIssueOrPull(thread, context, 'label')
          await fetcher.raw(threadPath(ref), { method: 'PUT', json: { labels: labels.join(',') } })
        }),
        setAssignees: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, assignees) => {
          const ref = requireIssueOrPull(thread, context, 'assign')
          await fetcher.raw(threadPath(ref), { method: 'PUT', json: { assignee_ids: await Promise.all(assignees.map(userId)) } })
        }),
        requestReview: perKind({ pull_request: 'experimental' }, async (thread, reviewers) => {
          const ref = requireThread(thread, context)
          if (ref.kind !== 'pull_request') {
            throw new UnsupportedOperationError('Only merge requests have reviewers', context)
          }
          const { data } = await fetcher.json<GitLabIssue>(threadPath(ref))
          const ids = new Set([...(data.reviewers ?? []).map(user => user.id), ...await Promise.all(reviewers.map(userId))])
          await fetcher.raw(threadPath(ref), { method: 'PUT', json: { reviewer_ids: [...ids] } })
        }),
        close: perKind({ issue: 'experimental', pull_request: true }, ref => setState(ref, 'close')),
        reopen: perKind({ issue: 'experimental', pull_request: true }, ref => setState(ref, 'reopen')),
        merge: verb(true, merge),
        subscriptions: perKind(ISSUE_LIKE, {
          subscription: async (thread): Promise<SubscriptionState> => {
            const ref = requireIssueOrPull(thread, context, 'read the subscription of')
            return (await fetcher.json<GitLabIssue>(threadPath(ref))).data.subscribed ? 'subscribed' : 'none'
          },
          subscribe: thread => setSubscribed(thread, true),
          unsubscribe: thread => setSubscribed(thread, false),
        }),
      },
    }
  },
}

/** Creates a GitLab provider for gitlab.com or a self-managed instance. */
export const gitlab: ProviderFactoryFunction<GitLabOptions> = /* @__PURE__ */ defineForgeProvider({ ...GITLAB, webhooks: gitlabWebhooks })

/** `gitlab()` without webhook ingestion, for bundles that never receive a delivery. */
export const gitlabLite: ProviderFactoryFunction<GitLabOptions> = /* @__PURE__ */ defineForgeProvider(GITLAB)

/** GitLab tokens carry coarse scopes; `api` covers writes and `read_api` reads. */
export function gitlabScopesFor(verb: ForgeVerb): VerbScopes {
  const [group = '', name = ''] = verb.split('.')
  if (group === 'webhooks') {
    return name === 'verify' || name === 'ingest' ? {} : { token: ['api'], note: 'Maintainer on the project, or Owner on the group' }
  }
  const reads = new Set(['get', 'list', 'listPage', 'page', 'events', 'eventsPage', 'comments', 'commentsPage', 'getMany', 'reviews', 'reviewsPage', 'checks', 'files', 'filesPage', 'commits', 'commitsPage', 'subscription', 'unreadCount', 'threads', 'threadsPage', 'repos', 'reposPage', 'tree', 'treePage', 'branches', 'branchesPage', 'tags', 'tagsPage', 'file', 'compare', 'resolveRef', 'commit', 'latest', 'getByTag', 'downloadAsset', 'runs', 'runsPage', 'run', 'jobs', 'jobsPage', 'log', 'permissionFor', 'labels', 'labelsPage', 'milestones', 'milestonesPage', 'collaborators', 'collaboratorsPage', 'assignableUsers', 'assignableUsersPage', 'reviewerCandidates', 'reviewerCandidatesPage'])
  return { token: [reads.has(name) ? 'read_api' : 'api'] }
}
