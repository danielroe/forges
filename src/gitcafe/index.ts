import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { Actor, BaseOptions, Check, Comment, CommentRef, Cursor, ForgeEventInput, Label, ListOptions, Milestone, Page, PageOptions, ReactionContent, RepoRef, ResolvedThreadRef, ReviewComment, Thread, ThreadQuery, ThreadRef, WebhookRef } from '../model.ts'
import type { AnonymousAuth, ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { WebLinks } from '../web.ts'
import type { Site } from './normalise.ts'
import type { GitCafeBlob, GitCafeChangedFile, GitCafeCheck, GitCafeCollaborator, GitCafeCommit, GitCafeDelivery, GitCafeIssue, GitCafeIssueComment, GitCafeLabel, GitCafeMember, GitCafeMergeOperation, GitCafeMilestone, GitCafeProfile, GitCafePull, GitCafePullComment, GitCafePullStatus, GitCafeReactionGroup, GitCafeRef, GitCafeRepository, GitCafeReview, GitCafeRun, GitCafeStatus, GitCafeTreeEntry, GitCafeWebhook } from './types.ts'
import { isSha, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { MergeBlockedError, MergeConflictError, NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { eventTime } from '../events.ts'
import { getManyConcurrently, hasEveryLabel, phased, rateLimitPart, requireIssueOrPull, resolveToken } from '../utils.ts'
import { nativeEventsFor } from '../webhooks.ts'
import { FORGE, REACTION_EMOJI, toBranch, toChangedFile, toCheck, toCollaborator, toCommit, toDelivery, toIssueComment, toIssueThread, toLabel, toMembers, toMilestone, toPullComment, toPullThread, toReactions, toRepo, toReview, toReviewComment, toReviewThreads, toRun, toStatusCheck, toTag, toTreeEntry, toUser, toWebhook } from './normalise.ts'
import { GITCAFE_WEB } from './web.ts'
import { GITCAFE_NATIVE_EVENTS } from './webhook-events.ts'
import { gitcafeWebhooks } from './webhooks.ts'

/** A personal access token created under Settings → Tokens (`gct_…`), sent as `Authorization: Bearer`. */
export type GitCafeAuth = TokenAuth | AnonymousAuth

/** Options for `gitcafe()`. */
export interface GitCafeOptions extends ForgeOptionsBase {
  /**
   * How to authenticate. Without credentials, only public reads work.
   * @default { type: 'anonymous' }
   */
  auth?: GitCafeAuth
  /**
   * Instance root. `/api` is appended.
   * @default https://git.cafe
   */
  baseUrl?: string
}

type Query = Record<string, string | number | boolean | undefined>

/** What GitCafe wraps every listing in: the items, and the token of the page after them. */
interface Listed<R> {
  items: R[]
  next: string | null
  total?: number
}

type Issueish = ResolvedThreadRef & { kind: 'issue' | 'pull_request' }

const MERGE_STRATEGIES: Record<string, string> = {
  merge: 'merge',
  squash: 'squash',
  rebase: 'rebase',
  fast_forward_only: 'fast-forward',
}

function setupGitCafe({ options, instance, origin: context, fetcher, baseUrl }: ProviderContext<GitCafeOptions, undefined>): ProviderSpec & { web: WebLinks } {
  const anonymous = options.auth?.type === 'anonymous'
  const web = GITCAFE_WEB.links({ baseUrl, instance })
  const site: Site = { forge: FORGE, instance, url: web.baseUrl }
  const repoPath = (repo: RepoRef) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  const threadPath = (ref: Issueish) => `${repoPath(ref.repo)}/${ref.kind === 'pull_request'
    ? 'pulls'
    : 'issues'}/${encodeURIComponent(ref.number)}`
  const threadRef = (repo: RepoRef, kind: 'issue' | 'pull_request', number: number): Issueish => ({
    forge: FORGE,
    instance,
    repo,
    kind,
    number: String(number),
  })

  /** One page of a listing. GitCafe pages with the `next` token of the body, which browsers can read where they can't read `Link`. */
  async function listed<R, T>(path: string, page: PageOptions, map: (raw: R) => T | undefined, query: Query = {}): Promise<Page<T>> {
    const { data, response } = await fetcher.json<Listed<R>>(path, {
      query: { ...query, limit: page.perPage, after: page.cursor?.token },
      signal: page.signal,
    })
    return {
      items: data.items.flatMap(raw => map(raw) ?? []),
      ...typeof data.total === 'number'
        ? { total: data.total }
        : {},
      ...data.next
        ? {
            cursor: { token: data.next },
          }
        : {},
      ...rateLimitPart(response),
    }
  }

  /** Every item of a listing that is short by nature, such as the labels of a repository. */
  async function everything<R>(path: string, signal?: AbortSignal, query: Query = {}): Promise<R[]> {
    const items: R[] = []
    let cursor: Cursor | undefined
    do {
      const page: Page<R> = await listed(path, { perPage: 50, cursor, signal }, (raw: R) => raw, query)
      items.push(...page.items)
      cursor = page.cursor
    } while (cursor)
    return items
  }

  function requirePull(thread: ThreadRef, action: string): Issueish {
    const ref = requireIssueOrPull(thread, context, action)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError(`Only pull requests can be ${action}`, context)
    }
    return ref
  }

  /**
   * How GitCafe wants a revision: `oid` for a full sha, `ref` for a full ref
   * name. A bare name is tried as a branch first and as a tag second.
   */
  async function atRevision<T>(revision: string | undefined, run: (query: Query) => Promise<T>): Promise<T> {
    if (!revision) {
      return run({})
    }
    if (isSha(revision)) {
      return run({ oid: revision })
    }
    if (revision === 'HEAD' || revision.startsWith('refs/')) {
      return run({ ref: revision })
    }
    try {
      return await run({ ref: `refs/heads/${revision}` })
    }
    catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error
      }
      return run({ ref: `refs/tags/${revision}` })
    }
  }

  async function issue(ref: Issueish, signal?: AbortSignal): Promise<GitCafeIssue> {
    return (await fetcher.json<GitCafeIssue>(threadPath(ref), { signal })).data
  }

  async function pull(ref: Issueish, signal?: AbortSignal): Promise<GitCafePull> {
    return (await fetcher.json<GitCafePull>(threadPath(ref), { signal })).data
  }

  /** A single pull request comes without its labels, assignees, reviewers and milestone, so they are read beside it. */
  async function get(thread: ThreadRef, getOptions?: BaseOptions): Promise<Thread> {
    const ref = requireIssueOrPull(thread, context, 'read')
    const signal = getOptions?.signal
    if (ref.kind === 'issue') {
      return toIssueThread(site, ref, await issue(ref, signal))
    }
    const [raw, labels, assignees, reviewers] = await Promise.all([
      pull(ref, signal),
      everything<GitCafeLabel>(`${threadPath(ref)}/labels`, signal),
      everything<GitCafeMember>(`${threadPath(ref)}/assignees`, signal),
      everything<GitCafeMember>(`${threadPath(ref)}/reviewers`, signal),
    ])
    const [milestone] = raw.milestoneId
      ? await everything<GitCafeMilestone>(`${threadPath(ref)}/milestone`, signal)
      : []
    return toPullThread(site, ref, {
      ...raw,
      labels,
      assignees,
      reviewers,
      milestone,
    })
  }

  /** GitCafe filters by id, and pull requests not at all, so labels and people are matched on the page instead. */
  function wanted(query: ThreadQuery): (thread: Thread) => Thread | undefined {
    return thread => hasEveryLabel(thread.labels, query.labels)
      && (!query.author || thread.author?.login === query.author)
      && (!query.assignee || thread.assignees.some(assignee => assignee.login === query.assignee))
      ? thread
      : undefined
  }

  /** The forge counts every thread of the state, which stops being the total once the page is filtered. */
  function withoutTotal<T>(query: ThreadQuery, { total, ...page }: Page<T>): Page<T> {
    return query.labels?.length || query.author || query.assignee || total === undefined
      ? page
      : { ...page, total }
  }

  async function issuesPage(repo: RepoRef, query: ThreadQuery, cursor?: Cursor): Promise<Page<Thread>> {
    const state = query.state ?? 'open'
    return withoutTotal(query, await listed(`${repoPath(repo)}/issues/`, { ...query, cursor }, (raw: GitCafeIssue) => wanted(query)(toIssueThread(site, threadRef(repo, 'issue', raw.number), raw)), {
      statuses: state === 'all'
        ? undefined
        : state,
      sort: query.sort === 'updated'
        ? 'updated'
        : 'created',
      direction: query.direction ?? 'desc',
    }))
  }

  function pullsPage(repo: RepoRef, query: ThreadQuery, state: string | undefined, cursor?: Cursor): Promise<Page<Thread>> {
    return listed(`${repoPath(repo)}/pulls/`, { ...query, cursor }, (raw: GitCafePull) => wanted(query)(toPullThread(site, threadRef(repo, 'pull_request', raw.number), raw)), {
      state,
      sort: query.direction === 'asc'
        ? 'oldest'
        : 'newest',
    })
  }

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    if (query.kind === 'discussion') {
      return {
        items: [],
        warnings: [
          { code: 'kind_unsupported', message: 'GitCafe has no discussions' },
        ],
      }
    }
    const state = query.state ?? 'open'
    const phases: Array<(cursor?: Cursor) => Promise<Page<Thread>>> = []
    if (query.kind !== 'pull_request' && state !== 'merged') {
      phases.push(cursor => issuesPage(repo, query, cursor))
    }
    if (query.kind !== 'issue') {
      // `closed` leaves merged pull requests out on GitCafe, so they are listed after the closed ones.
      const states = state === 'closed'
        ? ['closed', 'merged']
        : [
            state === 'all'
              ? undefined
              : state,
          ]
      phases.push(...states.map(value => (cursor?: Cursor) => pullsPage(repo, query, value, cursor)))
    }
    return phases.length
      ? phased(phases, query.cursor)
      : { items: [] }
  }

  function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireIssueOrPull(thread, context, 'read comments on')
    return ref.kind === 'issue'
      ? listed(`${threadPath(ref)}/comments/`, listOptions, (raw: GitCafeIssueComment) => toIssueComment(site, ref, raw))
      : listed(`${threadPath(ref)}/comments/`, listOptions, (raw: GitCafePullComment) => raw.deletedAt
          ? undefined
          : toPullComment(site, ref, raw), { filter: 'general' })
  }

  async function eventsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> {
    const ref = requireIssueOrPull(thread, context, 'read events for')
    const page = await commentsPage(ref, listOptions)
    return {
      ...page,
      items: page.items.map(comment => ({
        forge: FORGE,
        instance,
        id: comment.ref.id,
        kind: 'comment' as const,
        kindRaw: 'comment',
        summary: `${comment.author?.login ?? 'someone'} commented`,
        ...eventTime(comment.createdAt, new Date(0)),
        actor: comment.author,
        repo: ref.repo,
        thread: ref,
        source: 'poll' as const,
        detail: { type: 'comment' as const, comment: comment.ref, body: comment.body },
        payload: comment.raw,
      })),
    }
  }

  async function inlineComments(ref: Issueish, signal?: AbortSignal, review?: string): Promise<GitCafePullComment[]> {
    const comments = await everything<GitCafePullComment>(`${threadPath(ref)}/comments/`, signal, { filter: 'inline', review })
    return comments.filter(comment => !comment.deletedAt)
  }

  async function reviewComments(ref: Issueish, review: string, signal?: AbortSignal): Promise<ReviewComment[]> {
    return (await inlineComments(ref, signal, review)).map(raw => toReviewComment(site, ref, raw))
  }

  /** The checks of a commit, which on GitCafe include the commit statuses reported for it. */
  async function checksOf(repo: RepoRef, sha: string, signal?: AbortSignal): Promise<Page<Check>> {
    const checks = await everything<GitCafeCheck>(`${repoPath(repo)}/commits/${encodeURIComponent(sha)}/checks`, signal)
    return {
      items: checks.map(raw => toCheck(site, repo, raw)),
    }
  }

  /** Writes carry the version they expect, so that an edit made in between is refused instead of overwritten. */
  async function versionOf(ref: Issueish, signal?: AbortSignal): Promise<number> {
    return (ref.kind === 'issue'
      ? await issue(ref, signal)
      : await pull(ref, signal)).version
  }

  async function write<T>(ref: Issueish, path: string, method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const { data } = await fetcher.json<T>(`${threadPath(ref)}${path}`, {
      method,
      json: { expectedVersion: await versionOf(ref, signal), ...body },
      signal,
    })
    return data
  }

  async function labelIds(repo: RepoRef, names: string[], signal?: AbortSignal): Promise<string[]> {
    if (!names.length) {
      return []
    }
    const known = new Map((await everything<GitCafeLabel>(`${repoPath(repo)}/labels`, signal)).map(label => [label.name, label.id]))
    return names.map((name) => {
      const id = known.get(name)
      if (!id) {
        throw new UnsupportedOperationError(`No label named ${name} in ${repo.owner}/${repo.name}`, context)
      }
      return id
    })
  }

  function actorIds(actors: Array<string | Actor>, signal?: AbortSignal): Promise<string[]> {
    return Promise.all(actors.map(async actor => typeof actor === 'string'
      ? (await fetcher.json<GitCafeProfile>(`/users/${encodeURIComponent(actor)}`, { signal })).data.actorId
      : actor.id))
  }

  async function milestoneId(repo: RepoRef, milestone: Milestone | string, signal?: AbortSignal): Promise<string> {
    if (typeof milestone !== 'string') {
      return milestone.id
    }
    const found = (await everything<GitCafeMilestone>(`${repoPath(repo)}/milestones`, signal, { state: 'all' })).find(candidate => candidate.id === milestone || candidate.title === milestone)
    if (!found) {
      throw new UnsupportedOperationError(`No milestone titled ${milestone}`, context)
    }
    return found.id
  }

  async function setLabels(thread: ThreadRef, names: string[], writeOptions?: BaseOptions): Promise<Label[]> {
    const ref = requireIssueOrPull(thread, context, 'label')
    const { items } = await write<{ items: GitCafeLabel[] }>(ref, '/labels', 'PUT', { labelIds: await labelIds(ref.repo, names, writeOptions?.signal) }, writeOptions?.signal)
    return items.map(toLabel)
  }

  async function setAssignees(thread: ThreadRef, assignees: Array<string | Actor>, writeOptions?: BaseOptions): Promise<Actor[]> {
    const ref = requireIssueOrPull(thread, context, 'assign')
    const { items } = await write<{ items: GitCafeMember[] }>(ref, '/assignees', 'PUT', { actorIds: await actorIds(assignees, writeOptions?.signal) }, writeOptions?.signal)
    return toMembers(site, items)
  }

  async function setState(thread: ThreadRef, action: 'close' | 'reopen', body: Record<string, unknown>, writeOptions?: BaseOptions): Promise<Thread> {
    const ref = requireIssueOrPull(thread, context, action)
    await write(ref, `/${action}`, 'POST', body, writeOptions?.signal)
    return get(ref, writeOptions)
  }

  function commentPath(comment: CommentRef, action: string): { ref: Issueish, path: string } {
    const ref = requireIssueOrPull(comment.thread, context, action)
    return { ref, path: `${threadPath(ref)}/comments/${encodeURIComponent(comment.id)}` }
  }

  /** A comment has no read of its own, so its version comes from the listing it is in. */
  async function commentVersion(comment: CommentRef, action: string, signal?: AbortSignal): Promise<number> {
    const { ref } = commentPath(comment, action)
    const found = (await everything<{ id: string, version: number }>(`${threadPath(ref)}/comments/`, signal)).find(candidate => candidate.id === comment.id)
    if (!found) {
      throw new NotFoundError(`No comment ${comment.id} on #${ref.number}`, 404, '', context)
    }
    return found.version
  }

  async function writeComment<T>(comment: CommentRef, action: string, request: { suffix?: string, method: string, body?: Record<string, unknown> }, signal?: AbortSignal): Promise<T> {
    const { path } = commentPath(comment, action)
    const { data } = await fetcher.json<T>(`${path}${request.suffix ?? ''}`, {
      method: request.method,
      json: { expectedVersion: await commentVersion(comment, action, signal), ...request.body },
      signal,
    })
    return data
  }

  function reactionSubject(target: ThreadRef | CommentRef): { ref: Issueish, comment?: string } {
    return 'thread' in target
      ? {
          ref: requireIssueOrPull(target.thread, context, 'react to'),
          comment: target.id,
        }
      : {
          ref: requireIssueOrPull(target, context, 'react to'),
        }
  }

  async function reactionGroups(target: ThreadRef | CommentRef, signal?: AbortSignal): Promise<{ ref: Issueish, id: string, kind: string, groups: GitCafeReactionGroup[] }> {
    const { ref, comment } = reactionSubject(target)
    const prefix = ref.kind === 'issue'
      ? 'issue'
      : 'pull_request'
    const id = comment ?? (ref.kind === 'issue'
      ? (await issue(ref, signal)).id
      : (await pull(ref, signal)).id)
    const kind = comment
      ? `${prefix}_comment`
      : prefix
    const groups = await everything<GitCafeReactionGroup & { subject: { kind: string, id: string } }>(`${threadPath(ref)}/reactions/`, signal)
    return {
      ref,
      id,
      kind,
      groups: groups.filter(group => group.subject.kind === kind && group.subject.id === id),
    }
  }

  async function setResolved(thread: ThreadRef, id: string, action: 'resolve' | 'unresolve', writeOptions?: BaseOptions): Promise<void> {
    const ref = requirePull(thread, 'reviewed')
    await writeComment({
      forge: FORGE,
      instance,
      thread: ref,
      id,
    }, 'review', { suffix: `/${action}`, method: 'POST' }, writeOptions?.signal)
  }

  function hookPath(target: RepoRef): string {
    return target.kind === 'namespace'
      ? `/orgs/${encodeURIComponent(target.owner)}/webhooks`
      : `${repoPath(target)}/webhooks`
  }

  async function hookVersion(ref: WebhookRef, signal?: AbortSignal): Promise<number> {
    return (await fetcher.json<GitCafeWebhook>(`${hookPath(ref.target)}/${encodeURIComponent(ref.id)}`, { signal })).data.version
  }

  return {
    traits: {
      eventKinds: 'native',
      authKinds: ['token', 'anonymous'],
    },
    notApplicable: [
      'users.sponsorable',
      'users.sponsorableMany',
      'threads.transfer',
      'threads.markDuplicate',
      'threads.setIssueType',
      'repos.issueTypes',
      'releases.list',
      'releases.get',
      'releases.latest',
      'releases.getByTag',
      'releases.downloadAsset',
      'releases.create',
      'releases.update',
      'notifications.list',
      'notifications.markRead',
      'notifications.markDone',
      'notifications.unsubscribe',
      'notifications.markAllRead',
      'notifications.markAllDone',
    ],
    users: {
      get: verb(true, async (login, getOptions) => toUser(site, (await fetcher.json<GitCafeProfile>(`/users/${encodeURIComponent(login)}`, { signal: getOptions?.signal })).data)),
      me: verb(true, async meOptions => toUser(site, (await fetcher.json<GitCafeProfile>('/user/profile', { signal: meOptions?.signal })).data)),
    },
    repos: {
      get: verb(true, async (repo, getOptions) => toRepo(site, (await fetcher.json<GitCafeRepository>(`${repoPath(repo)}/`, { signal: getOptions?.signal })).data)),
      listPage: verb(true, (listOptions = {}) => listed('/repos', listOptions, (raw: GitCafeRepository) => toRepo(site, raw), {
        affiliation: 'member',
        visibility: listOptions.visibility === 'public' || listOptions.visibility === 'private'
          ? listOptions.visibility
          : undefined,
        sort: listOptions.sort === 'updated'
          ? 'updated'
          : undefined,
      })),
      byOwnerPage: verb(true, (owner, query = {}) => listed('/explore/repos', query, (raw: GitCafeRepository) => toRepo(site, raw), { owner: owner.owner })),
      labelsPage: verb(true, (repo, listOptions = {}) => listed(`${repoPath(repo)}/labels`, listOptions, (raw: GitCafeLabel) => toLabel(raw))),
      createLabel: verb('unverified', async (repo, label, writeOptions) => toLabel((await fetcher.json<GitCafeLabel>(`${repoPath(repo)}/labels`, {
        method: 'POST',
        json: { name: label.name, color: `#${label.colour ?? '888888'}`, description: label.description },
        signal: writeOptions?.signal,
      })).data)),
      milestonesPage: verb(true, (repo, listOptions = {}) => listed(`${repoPath(repo)}/milestones`, listOptions, (raw: GitCafeMilestone) => toMilestone(raw), { state: listOptions.state ?? 'open' })),
      collaboratorsPage: verb(!anonymous, (repo, listOptions = {}) => listed(`${repoPath(repo)}/collaborators/`, listOptions, (raw: GitCafeCollaborator) => toCollaborator(site, raw))),
      assignableUsersPage: verb(!anonymous, (repo, listOptions = {}) => listed(`${repoPath(repo)}/issues/assignee-candidates`, listOptions, (raw: GitCafeMember) => toMembers(site, [raw])[0])),
    },
    threads: {
      get: perKind({ issue: true, pull_request: true }, get),
      listPage: perKind({ issue: true, pull_request: true }, listPage),
      getMany: verb(true, (refs, manyOptions) => getManyConcurrently(refs, get, manyOptions)),
      eventsPage: verb('emulated', eventsPage),
      commentsPage: perKind({ issue: true, pull_request: true }, commentsPage),
      reactionsPage: perKind({ issue: true, pull_request: true }, async (target, listOptions = {}) => {
        const { groups } = await reactionGroups(target, listOptions.signal)
        return {
          items: groups.flatMap(group => toReactions(site, group)),
        }
      }),
      reviewsPage: verb(true, async (thread, listOptions: PageOptions = {}) => {
        const ref = requirePull(thread, 'reviewed')
        const page = await listed(`${threadPath(ref)}/reviews`, listOptions, (raw: GitCafeReview) => raw)
        return {
          ...page,
          items: await Promise.all(page.items.map(async raw => toReview(site, ref, raw, await reviewComments(ref, raw.id, listOptions.signal)))),
        }
      }),
      getReview: verb(true, async (review, getOptions) => {
        const ref = requirePull(review.thread, 'reviewed')
        const { data } = await fetcher.json<GitCafeReview>(`${threadPath(ref)}/reviews/${encodeURIComponent(review.id)}`, { signal: getOptions?.signal })
        return toReview(site, ref, data, await reviewComments(ref, review.id, getOptions?.signal))
      }),
      reviewThreadsPage: verb(true, async (thread, listOptions = {}) => {
        const ref = requirePull(thread, 'reviewed')
        return {
          items: toReviewThreads(site, ref, await inlineComments(ref, listOptions.signal)),
        }
      }),
      filesPage: verb(true, (thread, listOptions = {}) => {
        const ref = requirePull(thread, 'read the files of')
        return listed(`${threadPath(ref)}/changes`, listOptions, (raw: GitCafeChangedFile) => toChangedFile(raw))
      }),
      commitsPage: verb(true, (thread, listOptions = {}) => {
        const ref = requirePull(thread, 'read the commits of')
        return listed(`${threadPath(ref)}/commits`, listOptions, (raw: GitCafeCommit) => toCommit(site, ref.repo, raw))
      }),
      checks: perKind({ pull_request: true }, async (thread, checkOptions) => {
        const ref = requirePull(thread, 'checked')
        const { headOid } = await pull(ref, checkOptions?.signal)
        return headOid
          ? checksOf(ref.repo, headOid, checkOptions?.signal)
          : { items: [] }
      }),
      createComment: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (thread, body, writeOptions) => {
        const ref = requireIssueOrPull(thread, context, 'comment on')
        const { data } = await fetcher.json<GitCafeIssueComment & GitCafePullComment>(`${threadPath(ref)}/comments/`, {
          method: 'POST',
          json: { body },
          signal: writeOptions?.signal,
        })
        return ref.kind === 'issue'
          ? toIssueComment(site, ref, data)
          : toPullComment(site, ref, data)
      }),
      updateComment: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (comment, body, writeOptions) => {
        const { ref } = commentPath(comment, 'edit a comment on')
        const data = await writeComment<GitCafeIssueComment & GitCafePullComment>(comment, 'edit a comment on', {
          method: 'PATCH',
          body: { body },
        }, writeOptions?.signal)
        return ref.kind === 'issue'
          ? toIssueComment(site, ref, data)
          : toPullComment(site, ref, data)
      }),
      deleteComment: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (comment, writeOptions) => {
        await writeComment(comment, 'delete a comment on', { method: 'DELETE' }, writeOptions?.signal)
      }),
      close: perKind({ issue: 'unverified', pull_request: 'unverified' }, (thread, closeOptions) => setState(thread, 'close', thread.kind === 'issue'
        ? {
            state: closeOptions?.reason === 'not_planned' || closeOptions?.reason === 'duplicate'
              ? 'canceled'
              : 'completed',
            reason: closeOptions?.reasonRaw,
          }
        : {}, closeOptions)),
      reopen: perKind({ issue: 'unverified', pull_request: 'unverified' }, (thread, writeOptions) => setState(thread, 'reopen', {}, writeOptions)),
      locking: perKind({ issue: 'unverified', pull_request: 'unverified' }, {
        lock: async (thread, lockOptions) => {
          const ref = requireIssueOrPull(thread, context, 'lock')
          // Pull requests need a reason to lock, and issues take one or none.
          const reason = lockOptions?.reason ?? (ref.kind === 'pull_request'
            ? 'resolved'
            : undefined)
          await write(ref, '/lock', ref.kind === 'issue'
            ? 'PUT'
            : 'POST', { reason }, lockOptions?.signal)
        },
        unlock: async (thread, writeOptions) => {
          const ref = requireIssueOrPull(thread, context, 'unlock')
          await write(ref, ref.kind === 'issue'
            ? '/lock'
            : '/unlock', ref.kind === 'issue'
            ? 'DELETE'
            : 'POST', {}, writeOptions?.signal)
        },
      }),
      create: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (repo, input, writeOptions) => {
        const signal = writeOptions?.signal
        if (input.kind === 'issue') {
          const { data } = await fetcher.json<GitCafeIssue>(`${repoPath(repo)}/issues/`, {
            method: 'POST',
            json: {
              title: input.title,
              description: input.body,
              labelIds: input.labels && await labelIds(repo, input.labels, signal),
              assigneeIds: input.assignees && await actorIds(input.assignees, signal),
            },
            signal,
          })
          return get(threadRef(repo, 'issue', data.number), writeOptions)
        }
        if (input.kind !== 'pull_request' || !input.head || !input.base) {
          throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
        }
        if (input.draft) {
          throw new UnsupportedOperationError('GitCafe opens a pull request ready for review; convert it to a draft afterwards', context)
        }
        // `owner:branch` names a branch of a fork, and GitCafe wants the id of the repository that holds the branch.
        const [forkOwner, branch] = input.head.includes(':')
          ? input.head.split(':', 2) as [string, string]
          : [repo.owner, input.head]
        const { data: source } = await fetcher.json<GitCafeRepository>(`${repoPath({ ...repo, owner: forkOwner })}/`, { signal })
        const { data } = await fetcher.json<GitCafePull>(`${repoPath(repo)}/pulls/`, {
          method: 'POST',
          json: {
            repo: source.id,
            source: branch,
            target: input.base,
            title: input.title,
            description: input.body,
          },
          signal,
        })
        const ref = threadRef(repo, 'pull_request', data.number)
        if (input.labels?.length) {
          await setLabels(ref, input.labels, writeOptions)
        }
        if (input.assignees?.length) {
          await setAssignees(ref, input.assignees, writeOptions)
        }
        return get(ref, writeOptions)
      }),
      update: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (thread, input, writeOptions) => {
        const ref = requireIssueOrPull(thread, context, 'update')
        if (input.title !== undefined || input.body !== undefined) {
          await write(ref, '', 'PATCH', { title: input.title, description: input.body }, writeOptions?.signal)
        }
        if (input.labels) {
          await setLabels(ref, input.labels, writeOptions)
        }
        if (input.assignees) {
          await setAssignees(ref, input.assignees, writeOptions)
        }
        if (input.state) {
          const current = await get(ref, writeOptions)
          if ((current.state === 'open') !== (input.state === 'open')) {
            return setState(ref, input.state === 'open'
              ? 'reopen'
              : 'close', {}, writeOptions)
          }
          return current
        }
        return get(ref, writeOptions)
      }),
      setLabels: perKind({ issue: 'unverified', pull_request: 'unverified' }, setLabels),
      setAssignees: perKind({ issue: 'unverified', pull_request: 'unverified' }, setAssignees),
      setMilestone: perKind({ issue: 'unverified', pull_request: 'unverified' }, async (thread, milestone, writeOptions) => {
        const ref = requireIssueOrPull(thread, context, 'set the milestone of')
        const id = milestone === undefined
          ? null
          : await milestoneId(ref.repo, milestone, writeOptions?.signal)
        await write(ref, '/milestone', 'PUT', { milestoneId: id }, writeOptions?.signal)
        const current = (await get(ref, writeOptions)).milestone
        return id === null
          ? undefined
          : current ?? (typeof milestone === 'string'
            ? undefined
            : milestone)
      }),
      reactions: perKind({ issue: 'unverified', pull_request: 'unverified' }, {
        react: async (target, reaction: ReactionContent, writeOptions) => {
          const { ref, comment } = reactionSubject(target)
          const prefix = ref.kind === 'issue'
            ? 'issue'
            : 'pull_request'
          const id = comment ?? (ref.kind === 'issue'
            ? (await issue(ref, writeOptions?.signal)).id
            : (await pull(ref, writeOptions?.signal)).id)
          await fetcher.raw(`${threadPath(ref)}/reactions/`, {
            method: 'POST',
            json: {
              subject: {
                kind: comment
                  ? `${prefix}_comment`
                  : prefix,
                id,
              },
              emoji: { kind: 'unicode', value: REACTION_EMOJI[reaction] },
            },
            signal: writeOptions?.signal,
          })
        },
        unreact: async (target, reaction: ReactionContent, writeOptions) => {
          const { ref, groups } = await reactionGroups(target, writeOptions?.signal)
          const emoji = REACTION_EMOJI[reaction].replaceAll('️', '')
          const mine = groups.find(group => group.emoji.kind === 'unicode' && group.emoji.value.replaceAll('️', '') === emoji)?.viewerReactionId
          if (mine) {
            await fetcher.raw(`${threadPath(ref)}/reactions/${encodeURIComponent(mine)}`, { method: 'DELETE', signal: writeOptions?.signal })
          }
        },
      }),
      requestReview: perKind({ pull_request: 'unverified' }, async (thread, reviewers, writeOptions) => {
        const ref = requirePull(thread, 'reviewed')
        // The endpoint replaces the reviewers, so the ones already asked are sent along with the new ones.
        const current = await everything<GitCafeMember>(`${threadPath(ref)}/reviewers`, writeOptions?.signal)
        const ids = new Set([
          ...current.map(member => member.actor.actorId),
          ...await actorIds(reviewers, writeOptions?.signal),
        ])
        await write(ref, '/reviewers', 'PUT', {
          actorIds: [...ids],
        }, writeOptions?.signal)
      }),
      createReview: verb('unverified', async (thread, input, writeOptions) => {
        const ref = requirePull(thread, 'reviewed')
        if (!input.event) {
          throw new UnsupportedOperationError('GitCafe keeps a pending review as a draft of its own; pass `event` to submit the review', context)
        }
        if (input.comments?.length) {
          throw new UnsupportedOperationError('GitCafe attaches inline comments through a review draft, which `forges` does not write yet', context)
        }
        const raw = await pull(ref, writeOptions?.signal)
        const { data } = await fetcher.json<GitCafeReview>(`${threadPath(ref)}/reviews`, {
          method: 'POST',
          json: {
            verdict: input.event,
            body: input.body,
            commitOid: raw.headOid,
            expectedVersion: raw.version,
            requestId: crypto.randomUUID(),
          },
          signal: writeOptions?.signal,
        })
        return toReview(site, ref, data, [])
      }),
      replyToReviewComment: verb('unverified', async (thread, comment, body, writeOptions) => {
        const ref = requirePull(thread, 'reviewed')
        const id = comment.inReplyTo ?? comment.thread?.id ?? comment.ref?.id
        if (id === undefined) {
          throw new UnsupportedOperationError('GitCafe replies to a review comment by its id; pass the comment with its `ref`', context)
        }
        const { data } = await fetcher.json<GitCafePullComment>(`${threadPath(ref)}/comments/${encodeURIComponent(id)}/replies`, {
          method: 'POST',
          json: { body },
          signal: writeOptions?.signal,
        })
        return toReviewComment(site, ref, data)
      }),
      reviewThreads: verb('unverified', {
        resolveReviewThread: (thread, id, writeOptions) => setResolved(thread, id, 'resolve', writeOptions),
        unresolveReviewThread: (thread, id, writeOptions) => setResolved(thread, id, 'unresolve', writeOptions),
      }),
      merge: verb('unverified', async (thread, mergeOptions = {}) => {
        const ref = requirePull(thread, 'merged')
        const signal = mergeOptions.signal
        const { data: status } = await fetcher.json<GitCafePullStatus>(`${threadPath(ref)}/status`, { signal })
        if (!status.headOid || !status.baseOid) {
          throw new MergeBlockedError(`GitCafe has not observed the branches of #${ref.number} yet`, 409, '', context)
        }
        if (mergeOptions.sha && mergeOptions.sha !== status.headOid) {
          throw new MergeBlockedError(`Head of #${ref.number} is ${status.headOid}, not ${mergeOptions.sha}`, 409, '', context)
        }
        const strategy = mergeOptions.method
          ? MERGE_STRATEGIES[mergeOptions.method]
          : status.merge.strategies.length === 1
            ? status.merge.strategies[0]
            : undefined
        if (!strategy) {
          throw new UnsupportedOperationError(mergeOptions.method
            ? `GitCafe has no ${mergeOptions.method} merge`
            : `Pass a merge method: this pull request allows ${status.merge.strategies.join(', ')}`, context)
        }
        const { data } = await fetcher.json<GitCafeMergeOperation & { failure?: string, reason?: string }>(`${threadPath(ref)}/merge`, {
          method: 'POST',
          json: {
            requestId: crypto.randomUUID(),
            expectedVersion: status.version,
            headOid: status.headOid,
            baseOid: status.baseOid,
            strategy,
          },
          signal,
        })
        if (data.state === 'failed') {
          const why = data.failure ?? data.reason ?? 'failed'
          throw why.includes('conflict')
            ? new MergeConflictError(`GitCafe could not merge #${ref.number}: ${why}`, 409, '', context)
            : new MergeBlockedError(`GitCafe could not merge #${ref.number}: ${why}`, 409, '', context)
        }
        return {
          status: data.state === 'completed'
            ? 'merged'
            : 'queued',
          sha: data.resultOid ?? undefined,
          raw: data,
        }
      }),
    },
    checks: {
      list: verb(true, (repo, sha, checkOptions) => checksOf(repo, sha, checkOptions?.signal)),
      report: verb('unverified', async (repo, sha, input, writeOptions) => {
        if (input.state === 'neutral') {
          throw new UnsupportedOperationError('GitCafe commit statuses are pending, success or failure', context)
        }
        const { data } = await fetcher.json<GitCafeStatus>(`${repoPath(repo)}/statuses/${encodeURIComponent(sha)}`, {
          method: 'POST',
          json: {
            context: input.name,
            state: input.state,
            description: input.description,
            target_url: input.url,
          },
          signal: writeOptions?.signal,
        })
        return toStatusCheck(site, repo, data)
      }),
    },
    ci: {
      runsPage: verb(true, (repo, query = {}) => listed(`${repoPath(repo)}/actions/runs`, query, (raw: GitCafeRun) => toRun(site, repo, raw), {
        branch: query.branch,
        status: query.state === 'pending'
          ? undefined
          : query.state && 'completed',
      })),
    },
    contents: {
      getFile: verb(true, (repo, path, fileOptions) => atRevision(fileOptions?.ref, async (query) => {
        const signal = fileOptions?.signal
        if (fileOptions?.metadata === false) {
          const response = await fetcher.raw(`${repoPath(repo)}/raw`, {
            query: { ...query, path },
            signal,
          })
          return toFileContent(new Uint8Array(await response.arrayBuffer()), { path }, fileOptions, context)
        }
        const { data } = await fetcher.json<GitCafeBlob>(`${repoPath(repo)}/blob`, {
          query: { ...query, path },
          signal,
        })
        const file = {
          path: data.path,
          sha: data.oid,
          size: data.size,
          url: `${site.url}${web.file?.(repo, data.path, fileOptions?.ref ?? data.commit)}`,
        }
        // The JSON read carries text only; the bytes of a binary file come from the raw read, pinned to the same commit.
        const bytes = data.content === null
          ? new Uint8Array(await (await fetcher.raw(`${repoPath(repo)}/raw`, {
              query: { oid: data.commit, path },
              signal,
            })).arrayBuffer())
          : new TextEncoder().encode(data.content)
        return toFileContent(bytes, file, fileOptions, context)
      })),
      treePage: verb(true, (repo, treeOptions = {}) => atRevision(treeOptions.ref, async (query) => {
        const page = await listed(`${repoPath(repo)}/tree`, treeOptions, (raw: GitCafeTreeEntry) => toTreeEntry(raw), { ...query, path: treeOptions.path || undefined })
        return treeOptions.recursive
          ? {
              ...page,
              warnings: [
                { code: 'recursive_unsupported' as const, message: 'GitCafe lists one directory at a time' },
              ],
            }
          : page
      })),
      branchesPage: verb(true, (repo, listOptions = {}) => listed(`${repoPath(repo)}/refs`, listOptions, (raw: GitCafeRef) => toBranch(raw), { kind: 'branches' })),
      tagsPage: verb(true, (repo, listOptions = {}) => listed(`${repoPath(repo)}/refs`, listOptions, (raw: GitCafeRef) => toTag(raw), { kind: 'tags' })),
      resolveRef: verb(true, (repo, ref, resolveOptions) => atRevision(ref, async query => (await fetcher.json<GitCafeCommit>(`${repoPath(repo)}/commit`, { query, signal: resolveOptions?.signal })).data.oid)),
    },
    commits: {
      listPage: verb(true, (repo, query = {}) => atRevision(query.ref, revision => listed(`${repoPath(repo)}/commits`, query, (raw: GitCafeCommit) => toCommit(site, repo, raw), revision))),
      get: verb(true, async (commit, getOptions) => toCommit(site, commit.repo, (await fetcher.json<GitCafeCommit>(`${repoPath(commit.repo)}/commit`, {
        query: { oid: commit.sha },
        signal: getOptions?.signal,
      })).data)),
    },
    web,
    webhooks: {
      listPage: verb(!anonymous, (target, listOptions = {}) => listed(`${hookPath(target)}/`, listOptions, (raw: GitCafeWebhook) => toWebhook(target, raw))),
      create: verb('unverified', async (target, input, writeOptions) => toWebhook(target, (await fetcher.json<{ endpoint: GitCafeWebhook }>(`${hookPath(target)}/`, {
        method: 'POST',
        json: {
          url: input.url,
          events: nativeEventsFor(GITCAFE_NATIVE_EVENTS, input.events, input.nativeEvents),
          active: input.active,
          secret: input.secret,
        },
        signal: writeOptions?.signal,
      })).data.endpoint)),
      update: verb('unverified', async (ref, update, writeOptions) => toWebhook(ref.target, (await fetcher.json<GitCafeWebhook>(`${hookPath(ref.target)}/${encodeURIComponent(ref.id)}`, {
        method: 'PATCH',
        json: {
          expectedVersion: await hookVersion(ref, writeOptions?.signal),
          url: update.url,
          events: update.events || update.nativeEvents
            ? nativeEventsFor(GITCAFE_NATIVE_EVENTS, update.events, update.nativeEvents)
            : undefined,
          active: update.active,
        },
        signal: writeOptions?.signal,
      })).data)),
      delete: verb('unverified', async (ref, writeOptions) => {
        await fetcher.raw(`${hookPath(ref.target)}/${encodeURIComponent(ref.id)}`, {
          method: 'DELETE',
          json: { expectedVersion: await hookVersion(ref, writeOptions?.signal) },
          signal: writeOptions?.signal,
        })
      }),
      deliveriesPage: verb(!anonymous, (ref, listOptions = {}) => listed(`${hookPath(ref.target)}/${encodeURIComponent(ref.id)}/deliveries`, listOptions, (raw: GitCafeDelivery) => toDelivery(ref, raw))),
    },
    scopes: gitcafeScopesFor,
  }
}

const GITCAFE: ProviderDefinition<GitCafeOptions, undefined, true> = {
  forge: FORGE,
  hasWeb: true,
  experimental: true,
  anonymous: true,
  baseUrl: 'https://git.cafe',
  apiPath: '/api',
  headers: { accept: 'application/json' },
  authHeaders: ({ options: { auth } }) => auth?.type === 'token'
    ? async () => ({ authorization: `Bearer ${await resolveToken(auth)}` })
    : undefined,
  webhooks: gitcafeWebhooks,
  setup: setupGitCafe,
}

/** Creates a GitCafe provider. */
export const gitcafe: ProviderFactoryFunction<GitCafeOptions, true, 'gitcafe'> = /* @__PURE__ */ defineForgeProvider(GITCAFE)

/** Scope requirements for a GitCafe operation. */
function gitcafeScopesFor(_verb: ForgeVerb): VerbScopes {
  return { note: 'A personal access token from Settings → Tokens, with read or write permission on each resource the operation touches: repositories, issues, pull requests, checks or webhooks' }
}
