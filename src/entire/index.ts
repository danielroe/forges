import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { Fetcher } from '../fetch.ts'
import type { Actor, BaseOptions, Branch, ChangedFile, Comment, CommentRef, Commit, CommitQuery, CommitRef, CompareOptions, Comparison, Cursor, FileOptions, ForgeEventInput, ForgeWarning, ListOptions, MergeOptions, MergeResult, Page, PageOptions, RepoQuery, RepoRef, RepoRole, ResolvedThreadRef, Review, ReviewComment, ReviewInput, ReviewRef, ReviewThread, Tag, Thread, ThreadInput, ThreadQuery, ThreadRef, ThreadUpdate, TreeEntry, TreeOptions, UpdateBranchOptions, UpdateBranchResult, User } from '../model.ts'
import type { ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { WebLinks } from '../web.ts'
import type { EntireApproval, EntireBranch, EntireChange, EntireCollaborator, EntireCommit, EntireCommitDetail, EntireCompareFile, EntireCompareStatus, EntireCoreRepo, EntireDiscussion, EntireDiscussionCreated, EntireMe, EntireMerged, EntireMessage, EntireProjectTrail, EntireRef, EntireRepo, EntireRepoResolution, EntireResolvedProject, EntireReviewComment, EntireReviewPublished, EntireReviewSnapshot, EntireTimelineItem, EntireTreeEntry } from './types.ts'
import { isSha, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { BranchMovedError, ForgeApiError, ForgeError, NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { eventTime } from '../events.ts'
import { isNamespaceRef } from '../model.ts'
import { getManyConcurrently, memoBy, phased, requireIssueOrPull, resolveToken, toDate, toFileStatus } from '../utils.ts'
import { webUrlFor } from '../web.ts'
import { approvalState, findingComment, flattenMessages, FORGE, identityActor, projectRef, pullRef, toApproval, toBranch, toChangedFile, toCodeReview, toCollaborator, toComment, toCommit, toCoreRepo, toIssue, toPull, toRepo, toReviewThread, toTreeEntry } from './normalise.ts'
import { ENTIRE_WEB, HOST } from './web.ts'

/**
 * A bearer token for an Entire account, such as the one `entire auth token` prints. Login tokens
 * expire, so pass `token` as a function to read a fresh one for every request.
 */
export type EntireAuth = TokenAuth

/** Options for `entire()`. */
export interface EntireOptions extends ForgeOptionsBase {
  auth: EntireAuth
  /**
   * Control plane root. `/api/v1` is appended. Requests about a project go to the processing cell that the
   * control plane names for it.
   * @default https://us.console.entire.io
   */
  baseUrl?: string
}

interface Project {
  id: string
  cell: Fetcher
}

interface TokenPageShape {
  items: string
  next: string
  size: string
  token: string
}

const camelPage = (items: string): TokenPageShape => ({ items, next: 'nextPageToken', size: 'pageSize', token: 'pageToken' })
const snakePage = (items: string): TokenPageShape => ({ items, next: 'next_cursor', size: 'per_page', token: 'cursor' })

const bearer = (auth: EntireAuth) => async () => ({ authorization: `Bearer ${await resolveToken(auth)}` })

function setupEntire({ options, instance, origin, fetcher, createFetcher, baseUrl }: ProviderContext<EntireOptions, undefined>): ProviderSpec & { web: WebLinks } {
  const web = ENTIRE_WEB.links({ baseUrl, instance })
  const authHeaders = bearer(options.auth)
  const cellFetcher = memoBy(async (apiUrl: string) => createFetcher({ baseUrl: `${apiUrl.replace(/\/$/, '')}/api/v1`, authHeaders }))

  const placed = (raw: Pick<EntireCoreRepo, 'placements'> | undefined) => raw?.placements?.find(placement => placement.apiBaseUrl && !placement.mirror)

  /** A project the account reads through one of its repositories, when it has no grant on the project itself. */
  async function projectThroughRepo(name: string): Promise<Project | undefined> {
    const { data } = await fetcher.json<{ repos: EntireCoreRepo[] }>('/repos', { query: { org: name, pageSize: 1 } })
    const raw = data.repos[0]
    const placement = placed(raw)
    if (!raw || !placement?.apiBaseUrl) {
      return undefined
    }
    const cell = await cellFetcher(placement.apiBaseUrl)
    const { data: repo } = await cell.json<EntireRepo>(`/repos/${encodeURIComponent(placement.id)}`)
    return repo.owning_project_id ? { id: repo.owning_project_id, cell } : undefined
  }

  const project = memoBy(async (name: string): Promise<Project> => {
    try {
      const { data } = await fetcher.json<EntireResolvedProject>(`/projects/resolve/${HOST}/${encodeURIComponent(name)}`)
      if (!data.project.apiUrl) {
        throw new NotFoundError(`Project ${name} has no processing cell`, 404, '', origin)
      }
      return { id: data.project.id, cell: await cellFetcher(data.project.apiUrl) }
    }
    catch (error) {
      const fallback = error instanceof ForgeApiError && error.status === 403 ? await projectThroughRepo(name) : undefined
      if (!fallback) {
        throw error
      }
      return fallback
    }
  })

  const placement = memoBy(async (path: string): Promise<{ cell: Fetcher, id: string }> => {
    const { data } = await fetcher.json<{ resolutions: EntireRepoResolution[] }>('/repos/resolve', { method: 'POST', json: { repositories: [{ fullName: path, provider: 'entire' }] } })
    const found = placed(data.resolutions[0])
    if (!found?.apiBaseUrl) {
      throw new NotFoundError(`No repository ${path} on Entire`, 404, '', origin)
    }
    return { cell: await cellFetcher(found.apiBaseUrl), id: found.id }
  })

  async function located(repo: RepoRef): Promise<{ cell: Fetcher, id: string, path: string }> {
    const { cell, id } = await placement(`${repo.owner}/${repo.name}`)
    return { cell, id: encodeURIComponent(id), path: `/git/repos/${encodeURIComponent(id)}` }
  }

  const trailPath = (repo: RepoRef) => `/trails/${HOST}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  const projectTrailPath = (project: string) => `/${HOST}/${encodeURIComponent(project)}/trails`

  async function tokenPage<R, T>(f: Fetcher, path: string, shape: TokenPageShape, page: PageOptions & { query?: Record<string, string | number | boolean | undefined> }, map: (raw: R) => T | undefined): Promise<Page<T>> {
    const { data } = await f.json<Record<string, unknown>>(path, {
      query: { ...page.query, [shape.size]: page.perPage, [shape.token]: page.cursor?.token },
      signal: page.signal,
    })
    const raw = data[shape.items] as R[] | undefined
    const next = data[shape.next]
    const total = data.total_count
    return {
      items: (raw ?? []).flatMap(item => map(item) ?? []),
      ...typeof total === 'number' ? { total } : {},
      ...typeof next === 'string' && next ? { cursor: { token: next } } : {},
    }
  }

  async function everything<R>(f: Fetcher, path: string, shape: TokenPageShape, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal): Promise<R[]> {
    const items: R[] = []
    let cursor: Cursor | undefined
    do {
      const page: Page<R> = await tokenPage(f, path, shape, { query, perPage: 100, cursor, signal }, (raw: R) => raw)
      items.push(...page.items)
      cursor = page.cursor
    } while (cursor)
    return items
  }

  function slice<T>(items: T[], page: PageOptions): Page<T> {
    const offset = Number(page.cursor?.token ?? 0)
    const size = page.perPage ?? 100
    const next = offset + size
    return { items: items.slice(offset, next), ...next < items.length ? { cursor: { token: String(next) } } : {} }
  }

  function requirePull(thread: ThreadRef, action: string): ResolvedThreadRef {
    const ref = requireIssueOrPull(thread, origin, action)
    if (ref.kind !== 'pull_request' || isNamespaceRef(ref.repo)) {
      throw new UnsupportedOperationError(`Only changes can be ${action}`, origin)
    }
    return ref
  }

  async function change(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<EntireChange> {
    const { cell } = await located(ref.repo)
    return (await cell.json<EntireChange>(`${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}`, { signal })).data
  }

  async function parentTrail(repo: RepoRef, raw: EntireChange, signal?: AbortSignal): Promise<EntireProjectTrail | undefined> {
    if (!raw.parent) {
      return undefined
    }
    const { cell } = await located(repo)
    return (await cell.json<EntireProjectTrail>(`${projectTrailPath(raw.parent.project)}/${encodeURIComponent(raw.parent.id)}`, { signal })).data
  }

  async function get(thread: ThreadRef, opts?: BaseOptions): Promise<Thread> {
    const ref = requireIssueOrPull(thread, origin, 'read')
    if (ref.kind === 'pull_request') {
      const { repo } = requirePull(ref, 'read')
      const raw = await change(ref, opts?.signal)
      const parent = raw.body_document?.text_snapshot ? undefined : await parentTrail(repo, raw, opts?.signal)
      return toPull(repo, raw, parent?.body)
    }
    const { cell } = await project(ref.repo.owner)
    const { data } = await cell.json<EntireProjectTrail>(`${projectTrailPath(ref.repo.owner)}/${encodeURIComponent(ref.number)}`, { signal: opts?.signal })
    return toIssue(origin, ref.repo.owner, data)
  }

  async function issuesPage(repo: RepoRef, query: ThreadQuery, cursor?: Cursor): Promise<Page<Thread>> {
    const { id, cell } = await project(repo.owner)
    const status = query.state === 'all' ? undefined : query.state === 'closed' ? 'closed' : 'open'
    return tokenPage(cell, '/trails', camelPage('items'), {
      ...query,
      cursor,
      query: { projectId: id, status, author: query.author, assignee: query.assignee },
    }, (raw: EntireProjectTrail) => toIssue(origin, repo.owner, raw))
  }

  async function pullsPage(repo: RepoRef, query: ThreadQuery, cursor?: Cursor): Promise<Page<Thread>> {
    const { cell } = await located(repo)
    const status = query.state === 'all' ? undefined : query.state === 'merged' ? 'merged' : query.state === 'closed' ? 'closed,merged' : 'open'
    return tokenPage(cell, trailPath(repo), snakePage('items'), {
      ...query,
      cursor,
      query: { status, author: query.author, assignee: query.assignee },
    }, (raw: EntireChange) => toPull(repo, raw))
  }

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    const warnings: ForgeWarning[] = query.labels?.length ? [{ code: 'filter_unsupported', message: 'Entire trails have no labels' }] : []
    const namespace = isNamespaceRef(repo)
    const withWarnings = (page: Page<Thread>) => warnings.length ? { ...page, warnings: [...page.warnings ?? [], ...warnings] } : page
    if (query.kind === 'discussion') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: 'Entire has no discussions' }] }
    }
    if (query.kind === 'issue' || namespace) {
      return query.state === 'merged' ? { items: [] } : withWarnings(await issuesPage(projectRef(origin, repo.owner), query, query.cursor))
    }
    if (query.kind === 'pull_request' || query.state === 'merged') {
      return withWarnings(await pullsPage(repo, query, query.cursor))
    }
    return withWarnings(await phased([
      cursor => issuesPage(projectRef(origin, repo.owner), query, cursor),
      cursor => pullsPage(repo, query, cursor),
    ], query.cursor))
  }

  async function discussionsAt(ref: ResolvedThreadRef): Promise<{ cell: Fetcher, path: string }> {
    if (ref.kind === 'pull_request') {
      return { cell: (await located(ref.repo)).cell, path: `${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}/discussions` }
    }
    return { cell: (await project(ref.repo.owner)).cell, path: `${projectTrailPath(ref.repo.owner)}/${encodeURIComponent(ref.number)}/discussions` }
  }

  async function discussions(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<EntireDiscussion[]> {
    const { cell, path } = await discussionsAt(ref)
    if (ref.kind === 'pull_request') {
      return everything<EntireDiscussion>(cell, path, snakePage('items'), { include_messages: true }, signal)
    }
    const list = await everything<EntireDiscussion>(cell, path, camelPage('items'), {}, signal)
    return Promise.all(list.map(async (discussion) => {
      const { data } = await cell.json<{ discussion: EntireDiscussion, messages: EntireDiscussion['messages'] }>(`${path}/${encodeURIComponent(discussion.id)}`, { signal })
      return { ...data.discussion, messages: data.messages }
    }))
  }

  async function comments(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<Comment[]> {
    return (await discussions(ref, signal))
      .filter(discussion => !discussion.review_comment_id)
      .flatMap(discussion => flattenMessages(discussion.messages).map(message => toComment(ref, discussion, message)))
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
  }

  /** The message `ref` names, with its discussion, or the finding it names. */
  async function findComment(ref: CommentRef, signal?: AbortSignal): Promise<{ thread: ResolvedThreadRef, discussion: EntireDiscussion, message?: EntireMessage }> {
    const thread = requireIssueOrPull(ref.thread, origin, 'read comments on')
    for (const discussion of await discussions(thread, signal)) {
      const message = flattenMessages(discussion.messages).find(item => item.id === ref.id)
      if (message || discussion.review_comment?.id === ref.id) {
        return { thread, discussion, message }
      }
    }
    throw new NotFoundError(`No comment ${ref.id} on ${thread.kind === 'issue' ? 'trail' : 'change'} ${thread.number}`, 404, '', origin)
  }

  async function findings(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<EntireReviewComment[]> {
    const { cell } = await located(ref.repo)
    return everything<EntireReviewComment>(cell, `${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}/reviews/comments`, snakePage('comments'), {}, signal)
  }

  async function approvals(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<EntireApproval[]> {
    const { cell } = await located(ref.repo)
    return (await cell.json<{ approvals: EntireApproval[] }>(`${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}/approvals`, { signal })).data.approvals
  }

  async function codeReview(ref: ResolvedThreadRef, id: string, signal?: AbortSignal): Promise<EntireReviewSnapshot> {
    const { cell } = await located(ref.repo)
    return (await cell.json<EntireReviewSnapshot>(`${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}/reviews/${encodeURIComponent(id)}`, { signal })).data
  }

  async function reviews(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<Review[]> {
    const [approved, all] = await Promise.all([approvals(ref, signal), findings(ref, signal)])
    const byReview = Map.groupBy(all.sort((a, b) => a.created_at.localeCompare(b.created_at)), finding => finding.review_id)
    const summaries = await Promise.all([...byReview.keys()].map(async id => (await codeReview(ref, id, signal)).review.summary))
    return [
      ...approved.map(approval => toApproval(ref, approval)),
      ...[...byReview].map(([id, items], index) => toCodeReview(ref, id, items, summaries[index])),
    ].sort((a, b) => (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0))
  }

  function toEvent(ref: ResolvedThreadRef, item: EntireTimelineItem, threads = new Map<string, EntireDiscussion>()): ForgeEventInput {
    const actor = item.actor ? identityActor(origin, item.actor.identity, item.actor.login) : undefined
    const who = actor?.login ?? 'someone'
    const base = {
      ...origin,
      id: item.id,
      kindRaw: item.kind,
      ...eventTime(toDate(item.occurredAt ?? item.occurred_at), new Date(0)),
      actor,
      repo: ref.repo,
      thread: ref,
      source: 'poll' as const,
      payload: item,
    }
    const commentId = item.commentId ?? item.comment_id
    const discussion = threads.get(item.discussionId ?? item.discussion_id ?? '')
    switch (item.kind) {
      case 'comment': {
        const body = item.body ?? flattenMessages(discussion?.messages).find(message => message.id === commentId)?.body
        const finding = discussion?.review_comment
        if (finding) {
          const line = finding.location.end_line ?? finding.location.start_line
          return { ...base, kind: 'review_comment', summary: `${who} commented on a review`, detail: { type: 'review_comment', ...commentId ? { comment: { ...origin, thread: ref, id: commentId } } : {}, ...body ? { body } : {}, ...finding.location.file_path ? { path: finding.location.file_path } : {}, ...line ? { line } : {} } }
        }
        return { ...base, kind: 'comment', summary: `${who} commented`, detail: { type: 'comment', ...commentId ? { comment: { ...origin, thread: ref, id: commentId } } : {}, ...body ? { body } : {} } }
      }
      case 'approval': {
        const state = approvalState(item.approvalStatus ?? '')
        return { ...base, kind: 'review', summary: `${who} ${state === 'approved' ? 'approved' : state === 'changes_requested' ? 'requested changes' : 'reviewed'}`, detail: { type: 'review', state, ...item.approvalStatus ? { stateRaw: item.approvalStatus } : {}, ...item.body ? { body: item.body } : {}, review: { ...origin, thread: ref, id: item.id.replace(/^trail-approval-/, '') } } }
      }
      case 'review_posted':
        return { ...base, kind: 'review', summary: `${who} reviewed`, detail: { type: 'review', state: 'commented', stateRaw: item.kind, review: { ...origin, thread: ref, id: item.id.replace(/^trail-review-/, '') } } }
      case 'commit':
        return { ...base, kind: 'commit', summary: item.title ?? 'commit', ...item.commitSha ? { commit: { ...origin, repo: ref.repo, sha: item.commitSha } } : {} }
      case 'trail_created':
        return { ...base, kind: 'state_change', action: 'opened', summary: `${who} opened the trail`, detail: { type: 'state_change', state: 'open' } }
      case 'trail_branch_merged':
        return { ...base, kind: 'state_change', action: 'merged', summary: `${who} merged the change`, detail: { type: 'state_change', state: 'merged' } }
      default:
        return { ...base, kind: 'other', summary: item.title ?? item.kind }
    }
  }

  async function eventsPage(thread: ThreadRef, list: ListOptions = {}): Promise<Page<ForgeEventInput>> {
    const ref = requireIssueOrPull(thread, origin, 'read events for')
    if (ref.kind === 'pull_request') {
      const { cell, id } = await located(requirePull(ref, 'read').repo)
      const [page, all] = await Promise.all([
        tokenPage(cell, `/repos/${id}/trails/${encodeURIComponent(ref.number)}/timeline`, camelPage('items'), list, (item: EntireTimelineItem) => item),
        discussions(ref, list.signal),
      ])
      const threads = new Map(all.map(discussion => [discussion.id, discussion]))
      return { ...page, items: page.items.map(item => toEvent(ref, item, threads)) }
    }
    const { cell } = await project(ref.repo.owner)
    return tokenPage(cell, `${projectTrailPath(ref.repo.owner)}/${encodeURIComponent(ref.number)}/timeline`, snakePage('items'), list, (item: EntireTimelineItem) => toEvent(ref, item))
  }

  async function compare(repo: RepoRef, base: string, head: string, compareOptions: CompareOptions = {}): Promise<Comparison> {
    const { cell, path } = await located(repo)
    const signal = compareOptions.signal
    const { data: status } = await cell.json<EntireCompareStatus>(`${path}/compare/status`, { query: { base, head }, signal })
    const from = status.mergeBaseSHA ?? base
    const [files, commits] = await Promise.all([
      compareOptions.files === false ? undefined : cell.json<{ files?: EntireCompareFile[] }>(`${path}/compare`, { query: { base: from, head }, signal }),
      cell.json<{ commits: EntireCommit[] }>(`${path}/commits`, { query: { ref: head, notRef: from, pageSize: Math.min(compareOptions.commitLimit ?? 200, 200) }, signal }),
    ])
    return {
      base,
      head,
      aheadBy: status.commitsAhead,
      behindBy: status.commitsBehind,
      commits: commits.data.commits.map(commit => toCommit(origin, repo, commit)),
      files: (files?.data.files ?? []).map(toChangedFile),
      ...status.mergeBaseSHA ? { mergeBaseSha: status.mergeBaseSHA } : {},
      raw: { status, files: files?.data, commits: commits.data },
    }
  }

  async function changeRange(thread: ThreadRef, signal?: AbortSignal): Promise<{ repo: RepoRef, base: string, head: string }> {
    const ref = requirePull(thread, 'compared')
    const raw = await change(ref, signal)
    const head = raw.head_sha ?? raw.branch
    if (raw.merge_base_sha) {
      return { repo: ref.repo, base: raw.merge_base_sha, head }
    }
    const { cell, path } = await located(ref.repo)
    const { data } = await cell.json<EntireCompareStatus>(`${path}/compare/status`, { query: { base: raw.base, head }, signal })
    return { repo: ref.repo, base: data.mergeBaseSHA ?? raw.base, head }
  }

  async function refsPage(repo: RepoRef, prefix: string, page: PageOptions): Promise<Page<EntireRef>> {
    const { cell, path } = await located(repo)
    return tokenPage(cell, `${path}/refs`, camelPage('refs'), { ...page, query: { prefix, peel: true, symrefs: true } }, (raw: EntireRef) => raw)
  }

  async function resolveRef(repo: RepoRef, ref: string, opts?: BaseOptions): Promise<string> {
    if (isSha(ref)) {
      return ref
    }
    const { cell, path } = await located(repo)
    const { data } = await cell.json<{ commits: EntireCommit[] }>(`${path}/commits`, { query: { ref, pageSize: 1 }, signal: opts?.signal })
    const sha = data.commits[0]?.sha
    if (!sha) {
      throw new NotFoundError(`No revision ${ref} in ${repo.owner}/${repo.name}`, 404, '', origin)
    }
    return sha
  }

  function actorReference(actor: string | Actor): string {
    if (typeof actor !== 'string') {
      return `ulid:${actor.id}`
    }
    return actor.startsWith('ulid:') || actor.startsWith('@') ? actor : `@${actor}`
  }

  function refuseLabels(labels: string[] | undefined): void {
    if (labels?.length) {
      throw new UnsupportedOperationError('Entire trails have no labels', origin)
    }
  }

  async function create(repo: RepoRef, input: ThreadInput, opts?: BaseOptions): Promise<Thread> {
    refuseLabels(input.labels)
    const assignees = input.assignees?.map(actorReference)
    if (input.kind === 'issue') {
      const scoped = isNamespaceRef(repo) ? undefined : await located(repo)
      const cell = scoped?.cell ?? (await project(repo.owner)).cell
      const { data } = await cell.json<EntireProjectTrail>(projectTrailPath(repo.owner), {
        method: 'POST',
        json: { title: input.title, body: input.body, assignees, repoIds: scoped && [decodeURIComponent(scoped.id)] },
        signal: opts?.signal,
      })
      return toIssue(origin, repo.owner, data)
    }
    if (input.kind !== 'pull_request' || isNamespaceRef(repo)) {
      throw new UnsupportedOperationError(`Entire cannot open a ${input.kind.replace('_', ' ')} here`, origin)
    }
    if (!input.head || !input.base) {
      throw new TypeError('A change needs `head` and `base`')
    }
    if (input.head.includes(':')) {
      throw new UnsupportedOperationError('Entire opens changes from branches of the same repository', origin)
    }
    const { cell, id } = await located(repo)
    const repositoryId = decodeURIComponent(id)
    const { data } = await cell.json<EntireProjectTrail>(projectTrailPath(repo.owner), {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      json: {
        title: input.title,
        body: input.body,
        repoIds: [repositoryId],
        changes: [{ repositoryId, branchName: input.head, base: input.base, branchAction: 'link', title: input.title, assignees, readyForReview: !input.draft }],
      },
      signal: opts?.signal,
    })
    const number = data.changes?.find(item => item.repositoryId === repositoryId)?.number
    if (number === undefined) {
      throw new ForgeError(`Entire opened trail ${data.number} without a change in ${repo.owner}/${repo.name}`, origin)
    }
    return get(pullRef(repo, number), opts)
  }

  async function update(thread: ThreadRef, input: ThreadUpdate, opts?: BaseOptions): Promise<Thread> {
    const ref = requireIssueOrPull(thread, origin, 'update')
    refuseLabels(input.labels)
    const assignees = input.assignees?.map(actorReference)
    const signal = opts?.signal
    if (ref.kind === 'issue') {
      const { cell } = await project(ref.repo.owner)
      const { data } = await cell.json<EntireProjectTrail>(`${projectTrailPath(ref.repo.owner)}/${encodeURIComponent(ref.number)}`, {
        method: 'PATCH',
        json: { title: input.title, body: input.body, status: input.state, assignees },
        signal,
      })
      return toIssue(origin, ref.repo.owner, data)
    }
    const pull = requirePull(ref, 'updated')
    const { cell } = await located(pull.repo)
    if (input.title !== undefined || input.state !== undefined || assignees) {
      await cell.json(`${trailPath(pull.repo)}/${encodeURIComponent(pull.number)}`, { method: 'PATCH', json: { title: input.title, status: input.state, assignees }, signal })
    }
    if (input.body !== undefined) {
      const raw = await change(pull, signal)
      if (!raw.parent) {
        throw new UnsupportedOperationError(`Change ${pull.number} has no trail to hold its description`, origin)
      }
      await cell.json(`${projectTrailPath(raw.parent.project)}/${encodeURIComponent(raw.parent.id)}`, { method: 'PATCH', json: { body: input.body }, signal })
    }
    return get(pull, opts)
  }

  async function createComment(thread: ThreadRef, body: string, opts?: BaseOptions): Promise<Comment> {
    const ref = requireIssueOrPull(thread, origin, 'comment on')
    const { cell, path } = await discussionsAt(ref)
    const { data } = await cell.json<EntireDiscussionCreated>(path, { method: 'POST', json: { body }, signal: opts?.signal })
    return toComment(ref, data.discussion, data.message)
  }

  async function messagePath(ref: CommentRef, signal?: AbortSignal) {
    const found = await findComment(ref, signal)
    if (!found.message) {
      throw new UnsupportedOperationError('Entire edits a finding through the code review that left it', origin)
    }
    const { cell, path } = await discussionsAt(found.thread)
    return { ...found, message: found.message, cell, path: `${path}/${encodeURIComponent(found.discussion.id)}/messages/${encodeURIComponent(found.message.id)}` }
  }

  async function setResolved(thread: ThreadRef, id: string, resolved: boolean, opts?: BaseOptions): Promise<void> {
    const ref = requirePull(thread, 'reviewed')
    const { cell, path } = await discussionsAt(ref)
    await cell.json(`${path}/${encodeURIComponent(id)}`, { method: 'PATCH', json: { resolved }, signal: opts?.signal })
  }

  /** The text of lines `start` to `end` of `file` at the head of `ref`, which a line finding quotes. */
  async function selectedText(ref: ResolvedThreadRef, file: string, start: number, end: number, signal?: AbortSignal): Promise<string> {
    const raw = await change(ref, signal)
    const { cell, path } = await located(ref.repo)
    const response = await cell.raw(`${path}/raw`, { query: { ref: raw.head_sha ?? raw.branch, path: file }, signal })
    return (await response.text()).split('\n').slice(start - 1, end).join('\n')
  }

  async function createReview(thread: ThreadRef, input: ReviewInput, opts?: BaseOptions): Promise<Review> {
    const ref = requirePull(thread, 'reviewed')
    const signal = opts?.signal
    const { cell } = await located(ref.repo)
    const path = `${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}`
    if (input.event === 'approve' || input.event === 'request_changes') {
      if (input.comments?.length) {
        throw new UnsupportedOperationError('Entire approvals carry no inline comments', origin)
      }
      const { data } = await cell.json<{ approval: EntireApproval }>(`${path}/approvals`, { method: 'POST', json: { event: input.event, body: input.body }, signal })
      return toApproval(ref, data.approval)
    }
    if (input.event !== 'comment') {
      throw new UnsupportedOperationError('Entire has no pending reviews', origin)
    }
    const inline = input.comments ?? []
    if (!inline.length && !input.body) {
      throw new TypeError('A review needs a body or comments')
    }
    if (inline.some(comment => comment.side === 'left')) {
      throw new UnsupportedOperationError('Entire anchors findings to the head of a change', origin)
    }
    const comments = inline.length
      ? await Promise.all(inline.map(async (comment, index) => {
          const end = comment.line
          const start = comment.startLine ?? end
          return {
            client_id: String(index + 1),
            body: comment.body,
            location: start === undefined || end === undefined
              ? { granularity: 'file', file_path: comment.path }
              : { granularity: start === end ? 'line' : 'range', file_path: comment.path, start_line: start, end_line: end, selected_text: await selectedText(ref, comment.path, start, end, signal) },
          }
        }))
      : [{ client_id: '1', body: input.body, location: { granularity: 'whole_change' } }]
    const { data: started } = await cell.json<{ review_id: string }>(`${path}/reviews`, { method: 'POST', json: {}, signal })
    const { data } = await cell.json<EntireReviewPublished>(`${path}/reviews/${encodeURIComponent(started.review_id)}/comments`, {
      method: 'POST',
      json: { summary: input.body, comments },
      signal,
    })
    const failed = data.results.find(result => result.error)
    if (failed) {
      throw new ForgeError(`Entire refused a review comment: ${failed.error!.message}`, origin)
    }
    return toCodeReview(ref, started.review_id, data.results.flatMap(result => result.comment ?? []), input.body)
  }

  async function getReview(reviewRef: ReviewRef, opts?: BaseOptions): Promise<Review> {
    const ref = requirePull(reviewRef.thread, 'reviewed')
    const approval = (await approvals(ref, opts?.signal)).find(item => item.id === reviewRef.id)
    if (approval) {
      return toApproval(ref, approval)
    }
    const { review, comments = [] } = await codeReview(ref, reviewRef.id, opts?.signal)
    return toCodeReview(ref, review.id, comments, review.summary)
  }

  async function replyToReviewComment(thread: ThreadRef, comment: Pick<ReviewComment, 'ref' | 'thread' | 'inReplyTo'>, body: string, opts?: BaseOptions): Promise<ReviewComment> {
    const ref = requirePull(thread, 'reviewed')
    const discussion = comment.thread?.id ?? (comment.ref && (await findComment(comment.ref, opts?.signal)).discussion.id)
    if (!discussion) {
      throw new UnsupportedOperationError('Entire replies to a review comment in its discussion; pass the comment with its `thread` or `ref`', origin)
    }
    const { cell, path } = await discussionsAt(ref)
    const { data } = await cell.json<{ message: EntireMessage }>(`${path}/${encodeURIComponent(discussion)}/messages`, { method: 'POST', json: { body }, signal: opts?.signal })
    const reply = toComment(ref, { id: discussion, resolved: comment.thread?.resolved ?? false }, data.message)
    return { ...reply, ...comment.inReplyTo ?? comment.ref?.id ? { inReplyTo: comment.inReplyTo ?? comment.ref?.id } : {} }
  }

  const moved = (error: unknown) => error instanceof ForgeApiError && (error.status === 412 || (error.status === 409 && /head_mismatch/.test(error.body)))
    ? new BranchMovedError('The head branch no longer points at the expected sha', error.status, error.body, origin, { cause: error })
    : error

  async function merge(thread: ThreadRef, options: MergeOptions = {}): Promise<MergeResult> {
    const ref = requirePull(thread, 'merged')
    if (options.method && options.method !== 'merge') {
      throw new UnsupportedOperationError(`Entire has no ${options.method} merge`, origin)
    }
    if (options.whenChecksPass) {
      throw new UnsupportedOperationError('Entire merges a change once its gates pass, with no queue', origin)
    }
    const { cell, id } = await located(ref.repo)
    const path = `/repos/${id}/trails/${encodeURIComponent(ref.number)}`
    const submit = () => cell.json<EntireMerged>(`${path}/merge`, { method: 'POST', json: { deleteBranch: false, expectedHeadSha: options.sha }, mapError: moved, signal: options.signal })
    const { data } = await submit().catch(async (error: unknown) => {
      if (!(error instanceof ForgeApiError) || error.status !== 422 || !/merge_gates_pending/.test(error.body)) {
        throw error
      }
      await cell.json(`${path}/gates/recompute`, { method: 'POST', signal: options.signal })
      return submit()
    })
    return { status: 'merged', ...data.mergeCommitSha ? { sha: data.mergeCommitSha } : {}, raw: data }
  }

  async function updateBranch(thread: ThreadRef, options: UpdateBranchOptions = {}): Promise<UpdateBranchResult> {
    const ref = requirePull(thread, 'updated')
    const { cell, id, path } = await located(ref.repo)
    const signal = options.signal
    const raw = await change(ref, signal)
    if (options.method === 'rebase') {
      const response = await cell.raw(`${path}/rebases`, { method: 'POST', json: { branch: raw.branch, onto: raw.base, expectedBranchSHA: options.sha }, mapError: moved, signal })
      const events = (await response.text()).split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string })
      if (events.at(-1)?.type !== 'completed') {
        throw new ForgeError(`Entire did not finish rebasing ${raw.branch}: ${JSON.stringify(events.at(-1))}`, origin)
      }
      return { status: 'updated', raw: events }
    }
    if (options.sha && raw.head_sha && raw.head_sha !== options.sha) {
      throw new BranchMovedError(`${raw.branch} is at ${raw.head_sha}, not ${options.sha}`, 409, '', origin)
    }
    const { data } = await cell.json(`/repos/${id}/trails/${encodeURIComponent(ref.number)}/update-branch`, { method: 'POST', signal })
    return { status: 'updated', raw: data }
  }

  const GRANT_ROLES: Partial<Record<RepoRole, string>> = { read: 'reader', write: 'writer', admin: 'admin' }

  return {
    traits: {
      eventKinds: 'native',
      authKinds: ['token'],
    },
    notApplicable: [
      'repos.labels',
      'repos.createLabel',
      'repos.milestones',
      'repos.issueTypes',
      'threads.setLabels',
      'threads.addLabels',
      'threads.removeLabels',
      'threads.setMilestone',
      'threads.setIssueType',
      'threads.reactions',
      'threads.react',
      'threads.transfer',
      'threads.markDuplicate',
      'threads.lock',
      'threads.hideComment',
      'releases.list',
      'releases.get',
      'releases.getByTag',
      'releases.latest',
      'releases.create',
      'releases.update',
      'releases.downloadAsset',
    ],
    users: {
      me: verb(true, async (opts): Promise<User> => {
        const { data } = await fetcher.json<EntireMe>('/me', { signal: opts?.signal })
        return {
          ...origin,
          login: data.global.username ?? data.global.handle ?? data.global.accountId,
          id: data.global.accountId,
          ...data.global.displayName ? { name: data.global.displayName } : {},
          ...data.global.avatarUrl ? { avatarUrl: data.global.avatarUrl } : {},
          isBotHint: false,
          ...data.regional?.bio ? { bio: data.regional.bio } : {},
          ...data.regional?.location ? { location: data.regional.location } : {},
          ...data.global.createdAt ? { createdAt: toDate(data.global.createdAt) } : {},
          raw: data,
        }
      }),
    },
    repos: {
      get: verb(true, async (repo, opts) => {
        const { cell, id } = await located(repo)
        return toRepo(origin, (await cell.json<EntireRepo>(`/repos/${id}`, { signal: opts?.signal })).data)
      }),
      listPage: verb(true, async (query: RepoQuery = {}) => tokenPage(fetcher, '/repos', camelPage('repos'), query, (raw: EntireCoreRepo) => toCoreRepo(origin, raw))),
      byOwnerPage: verb(true, async (owner: RepoRef, query: RepoQuery = {}) => {
        const { id } = await project(owner.owner)
        const page = await tokenPage(fetcher, `/projects/${encodeURIComponent(id)}/repos`, camelPage('repos'), query, (raw: EntireCoreRepo) => toCoreRepo(origin, raw, owner.owner))
        return query.visibility && query.visibility !== 'all' ? { ...page, items: page.items.filter(repo => repo.visibility === query.visibility) } : page
      }),
      collaboratorsPage: verb(true, async (repo, page: PageOptions = {}) => {
        const { id } = await located(repo)
        return tokenPage(fetcher, `/repos/${id}/collaborators`, camelPage('collaborators'), page, (raw: EntireCollaborator) => toCollaborator(origin, raw))
      }),
      addCollaborator: verb(true, async (repo, actor, role, opts) => {
        const grant = GRANT_ROLES[role]
        if (!grant) {
          throw new UnsupportedOperationError(`Entire has no ${role} repository role`, origin)
        }
        if (typeof actor === 'string') {
          throw new UnsupportedOperationError('Entire grants access to an account by its id; pass an actor', origin)
        }
        const { id } = await located(repo)
        await fetcher.json(`/repos/${id}/grants`, { method: 'POST', json: { accountId: actor.id, role: grant }, signal: opts?.signal })
        return { status: 'added' }
      }),
    },
    threads: {
      get: perKind({ issue: true, pull_request: true }, get),
      listPage: perKind({ issue: true, pull_request: true }, listPage),
      getMany: verb(true, (refs: ThreadRef[], opts) => getManyConcurrently(refs, get, opts)),
      eventsPage: verb(true, eventsPage),
      commentsPage: perKind({ issue: true, pull_request: true }, async (thread: ThreadRef, list: ListOptions = {}) => slice(await comments(requireIssueOrPull(thread, origin, 'read comments on'), list.signal), list)),
      getComment: perKind({ issue: true, pull_request: true }, async (ref, opts) => {
        const { thread, discussion, message } = await findComment(ref, opts?.signal)
        return message ? toComment(thread, discussion, message) : findingComment(thread, discussion.review_comment!, discussion.resolved || discussion.review_comment!.status !== 'open')
      }),
      createComment: perKind({ issue: true, pull_request: true }, createComment),
      updateComment: perKind({ issue: true, pull_request: true }, async (ref, body, opts) => {
        const { thread, discussion, cell, path } = await messagePath(ref, opts?.signal)
        const { data } = await cell.json<{ message: EntireMessage }>(path, { method: 'PATCH', json: { body }, signal: opts?.signal })
        return toComment(thread, discussion, data.message)
      }),
      deleteComment: perKind({ issue: true, pull_request: true }, async (ref, opts) => {
        const { cell, path } = await messagePath(ref, opts?.signal)
        await cell.raw(path, { method: 'DELETE', signal: opts?.signal })
      }),
      create: perKind({ issue: true, pull_request: true }, create),
      update: perKind({ issue: true, pull_request: true }, update),
      close: perKind({ issue: true, pull_request: true }, (ref, opts) => update(ref, { state: 'closed' }, opts)),
      reopen: perKind({ issue: true, pull_request: true }, (ref, opts) => update(ref, { state: 'open' }, opts)),
      setAssignees: perKind({ issue: true, pull_request: true }, async (ref, assignees, opts) => (await update(ref, { assignees }, opts)).assignees),
      merge: verb(true, merge),
      updateBranch: verb(true, updateBranch),
      getReview: verb(true, getReview),
      createReview: verb(true, createReview),
      replyToReviewComment: verb(true, replyToReviewComment),
      reviewThreads: verb(true, {
        resolveReviewThread: (ref, id, opts) => setResolved(ref, id, true, opts),
        unresolveReviewThread: (ref, id, opts) => setResolved(ref, id, false, opts),
      }),
      reviewsPage: verb(true, async (thread: ThreadRef, page: PageOptions = {}) => slice(await reviews(requirePull(thread, 'reviewed'), page.signal), page)),
      reviewThreadsPage: verb(true, async (thread: ThreadRef, page: PageOptions = {}): Promise<Page<ReviewThread>> => {
        const ref = requirePull(thread, 'reviewed')
        const threads = (await discussions(ref, page.signal))
          .filter((discussion): discussion is EntireDiscussion & { review_comment: EntireReviewComment } => Boolean(discussion.review_comment))
          .map(discussion => toReviewThread(ref, discussion))
        return slice(threads, page)
      }),
      filesPage: verb(true, async (thread: ThreadRef, page: PageOptions = {}): Promise<Page<ChangedFile>> => {
        const { repo, base, head } = await changeRange(thread, page.signal)
        const { cell, path } = await located(repo)
        const { data } = await cell.json<{ files?: EntireCompareFile[] }>(`${path}/compare`, { query: { base, head }, signal: page.signal })
        return slice((data.files ?? []).map(toChangedFile), page)
      }),
      commitsPage: verb(true, async (thread: ThreadRef, page: PageOptions = {}): Promise<Page<Commit>> => {
        const { repo, base, head } = await changeRange(thread, page.signal)
        const { cell, path } = await located(repo)
        return tokenPage(cell, `${path}/commits`, camelPage('commits'), { ...page, query: { ref: head, notRef: base } }, (raw: EntireCommit) => toCommit(origin, repo, raw))
      }),
    },
    contents: {
      getFile: verb(true, async (repo: RepoRef, filePath: string, fileOptions: FileOptions = {}) => {
        const { cell, path } = await located(repo)
        const at = fileOptions.ref ?? 'HEAD'
        const response = await cell.raw(`${path}/raw`, { query: { ref: at, path: filePath }, signal: fileOptions.signal })
        const bytes = new Uint8Array(await response.arrayBuffer())
        const sha = response.headers.get('entire-sha') ?? undefined
        const metadata = { path: filePath, ...sha ? { sha } : {}, size: bytes.byteLength, url: webUrlFor(web, { file: { repo, path: filePath, at } }) }
        return toFileContent(bytes, metadata, fileOptions, origin)
      }),
      treePage: verb(true, async (repo: RepoRef, tree: TreeOptions = {}): Promise<Page<TreeEntry>> => {
        const { cell, path } = await located(repo)
        const { data } = await cell.json<{ entries: EntireTreeEntry[], truncated?: boolean }>(`${path}/tree`, {
          query: { ref: tree.ref ?? 'HEAD', path: tree.path || undefined, recursive: tree.recursive || undefined },
          signal: tree.signal,
        })
        const page = slice(data.entries.map(entry => toTreeEntry(entry, tree.recursive ? '' : tree.path?.replace(/\/$/, '') ?? '')), tree)
        return data.truncated ? { ...page, warnings: [{ code: 'tree_truncated', message: 'Entire truncated the tree' }] } : page
      }),
      branchesPage: verb(true, async (repo: RepoRef, page: PageOptions = {}): Promise<Page<Branch>> => {
        const { cell, path } = await located(repo)
        const [head, branches] = await Promise.all([
          cell.json<{ refs: EntireRef[] }>(`${path}/refs`, { query: { prefix: 'HEAD', symrefs: true }, signal: page.signal }),
          tokenPage(cell, `${path}/branches`, camelPage('branches'), page, (raw: EntireBranch) => raw),
        ])
        const defaultBranch = head.data.refs.find(ref => ref.name === 'HEAD')?.symrefTarget?.replace(/^refs\/heads\//, '')
        return { ...branches, items: branches.items.map(raw => toBranch(raw, defaultBranch)) }
      }),
      tagsPage: verb(true, async (repo: RepoRef, page: PageOptions = {}): Promise<Page<Tag>> => {
        const refs = await refsPage(repo, 'refs/tags/', page)
        return { ...refs, items: refs.items.map(raw => ({ name: raw.name.replace(/^refs\/tags\//, ''), sha: raw.peeled ?? raw.oid, raw })) }
      }),
      resolveRef: verb(true, resolveRef),
      compare: verb(true, compare),
    },
    commits: {
      listPage: verb(true, async (repo: RepoRef, query: CommitQuery = {}): Promise<Page<Commit>> => {
        const { cell, path } = await located(repo)
        return tokenPage(cell, `${path}/commits`, camelPage('commits'), {
          ...query,
          query: { ref: query.ref ?? 'HEAD', path: query.path, author: query.author, since: query.since?.toISOString(), until: query.until?.toISOString(), includeStats: true },
        }, (raw: EntireCommit) => toCommit(origin, repo, raw))
      }),
      get: verb(true, async ({ repo, sha }: CommitRef, opts?: BaseOptions) => {
        const { cell, path, id } = await located(repo)
        const [{ data: list }, { data: detail }] = await Promise.all([
          cell.json<{ commits: EntireCommit[] }>(`${path}/commits`, { query: { ref: sha, pageSize: 1, includeStats: true }, signal: opts?.signal }),
          cell.json<EntireCommitDetail>(`/repos/${id}/commits/${encodeURIComponent(sha)}`, { signal: opts?.signal }),
        ])
        const commit = list.commits[0]
        if (!commit) {
          throw new NotFoundError(`No commit ${sha} in ${repo.owner}/${repo.name}`, 404, '', origin)
        }
        const files = (detail.commit.fileStats ?? []).map((file): ChangedFile => ({
          path: file.filename,
          ...file.previousFilename && file.previousFilename !== file.filename ? { previousPath: file.previousFilename } : {},
          status: toFileStatus(file.status),
          statusRaw: file.status,
          ...file.additions !== undefined ? { additions: file.additions } : {},
          ...file.deletions !== undefined ? { deletions: file.deletions } : {},
          ...file.patch ? { patch: file.patch } : {},
        }))
        return toCommit(origin, repo, commit, files, detail)
      }),
    },
    web,
    webhooks: {},
    scopes: entireScopesFor,
  }
}

const ENTIRE: ProviderDefinition<EntireOptions, undefined, true> = {
  forge: FORGE,
  hasWeb: true,
  experimental: true,
  baseUrl: ENTIRE_WEB.baseUrl,
  apiPath: ENTIRE_WEB.apiPath,
  instance: ENTIRE_WEB.instance,
  authHeaders: ({ options: { auth } }) => bearer(auth),
  setup: setupEntire,
}

/** Creates an Entire provider for the repositories Entire hosts, which live under `et/`. */
export const entire: ProviderFactoryFunction<EntireOptions, true, 'entire'> = /* @__PURE__ */ defineForgeProvider(ENTIRE)

/** Scope requirements for an Entire operation. */
function entireScopesFor(_verb: ForgeVerb): VerbScopes {
  return { note: 'An Entire login token, which carries the scopes of the account that signed in' }
}
