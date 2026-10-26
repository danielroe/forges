import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { Fetcher } from '../fetch.ts'
import type { BaseOptions, Branch, ChangedFile, Comment, Commit, CommitQuery, CommitRef, CompareOptions, Comparison, Cursor, FileOptions, ForgeEventInput, ForgeWarning, ListOptions, Page, PageOptions, RepoQuery, RepoRef, ResolvedThreadRef, Review, ReviewThread, Tag, Thread, ThreadQuery, ThreadRef, TreeEntry, TreeOptions, User } from '../model.ts'
import type { ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { WebLinks } from '../web.ts'
import type { EntireApproval, EntireBranch, EntireChange, EntireCollaborator, EntireCommit, EntireCommitDetail, EntireCompareFile, EntireCompareStatus, EntireCoreRepo, EntireDiscussion, EntireMe, EntireProjectTrail, EntireRef, EntireRepo, EntireResolvedProject, EntireReviewComment, EntireTimelineItem, EntireTreeEntry } from './types.ts'
import { isSha, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { eventTime } from '../events.ts'
import { isNamespaceRef } from '../model.ts'
import { getManyConcurrently, memoBy, phased, requireIssueOrPull, resolveToken, toDate, toFileStatus } from '../utils.ts'
import { webUrlFor } from '../web.ts'
import { approvalState, flattenMessages, FORGE, identityActor, projectRef, toApproval, toBranch, toChangedFile, toCodeReview, toCollaborator, toComment, toCommit, toCoreRepo, toIssue, toPull, toRepo, toReviewThread, toTreeEntry } from './normalise.ts'
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

  const project = memoBy(async (name: string): Promise<Project> => {
    const { data } = await fetcher.json<EntireResolvedProject>(`/projects/resolve/${HOST}/${encodeURIComponent(name)}`)
    if (!data.project.apiUrl) {
      throw new NotFoundError(`Project ${name} has no processing cell`, 404, '', origin)
    }
    return { id: data.project.id, cell: await cellFetcher(data.project.apiUrl) }
  })

  const repoIdOf = memoBy(async (path: string) => {
    const [name] = path.split('/')
    const { cell } = await project(name!)
    const { data } = await cell.json<{ repoId: string }>('/git/repos/resolve', { query: { repoPath: `${HOST}/${path}` } })
    return data.repoId
  })

  async function located(repo: RepoRef): Promise<{ cell: Fetcher, id: string, path: string }> {
    const { cell } = await project(repo.owner)
    const id = repo.externalId ?? await repoIdOf(`${repo.owner}/${repo.name}`)
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
    const { cell } = await project(ref.repo.owner)
    return (await cell.json<EntireChange>(`${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}`, { signal })).data
  }

  async function get(thread: ThreadRef, opts?: BaseOptions): Promise<Thread> {
    const ref = requireIssueOrPull(thread, origin, 'read')
    if (ref.kind === 'pull_request') {
      return toPull(requirePull(ref, 'read').repo, await change(ref, opts?.signal))
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
    const { cell } = await project(repo.owner)
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

  async function discussions(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<EntireDiscussion[]> {
    const { cell } = await project(ref.repo.owner)
    if (ref.kind === 'pull_request') {
      return everything<EntireDiscussion>(cell, `${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}/discussions`, snakePage('items'), { include_messages: true }, signal)
    }
    const path = `${projectTrailPath(ref.repo.owner)}/${encodeURIComponent(ref.number)}/discussions`
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

  async function findings(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<EntireReviewComment[]> {
    const { cell } = await project(ref.repo.owner)
    return everything<EntireReviewComment>(cell, `${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}/reviews/comments`, snakePage('comments'), {}, signal)
  }

  async function reviews(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<Review[]> {
    const { cell } = await project(ref.repo.owner)
    const [{ data }, all] = await Promise.all([
      cell.json<{ approvals: EntireApproval[] }>(`${trailPath(ref.repo)}/${encodeURIComponent(ref.number)}/approvals`, { signal }),
      findings(ref, signal),
    ])
    const byReview = Map.groupBy(all.sort((a, b) => a.created_at.localeCompare(b.created_at)), finding => finding.review_id)
    return [
      ...data.approvals.map(approval => toApproval(ref, approval)),
      ...[...byReview].map(([id, items]) => toCodeReview(ref, id, items)),
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
          login: data.global.username,
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
    },
    threads: {
      get: perKind({ issue: true, pull_request: true }, get),
      listPage: perKind({ issue: true, pull_request: true }, listPage),
      getMany: verb(true, (refs: ThreadRef[], opts) => getManyConcurrently(refs, get, opts)),
      eventsPage: verb(true, eventsPage),
      commentsPage: perKind({ issue: true, pull_request: true }, async (thread: ThreadRef, list: ListOptions = {}) => slice(await comments(requireIssueOrPull(thread, origin, 'read comments on'), list.signal), list)),
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
