import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { Check, CheckState, Comment, CommentRef, Cursor, ForgeEventInput, ForgeWarning, ListOptions, MergeMethod, Page, RepoRef, ResolvedThreadRef, Review, ReviewInput, SearchQuery, Thread, ThreadQuery, ThreadRef } from '../model.ts'
import type { AnonymousAuth, BasicAuth, ForgeOptionsBase, TokenAuth } from '../provider.ts'
import type { AzureCommit, AzureCommitDiffs, AzureIdentity, AzureItem, AzurePolicyEvaluation, AzurePullRequest, AzureRef, AzureRepository, AzureReviewer, AzureStatus, AzureThread, AzureWorkItem, AzureWorkItemComment, AzureWorkItemUpdate } from './types.ts'
import { toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { ForgeError, MergeMethodRequiredError, NotFoundError, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { getManyConcurrently, memo, phased, requireIssueOrPull, requireThread, resolveToken, summariseChecks, syntheticReview, toWarning } from '../utils.ts'
import { FORGE, isConversationThread, projectRef, toActor, toBranch, toChangedFile, toCommit, toPolicyCheck, toPullComment, toPullThread, toRepo, toRepoRef, toStatusCheck, toTag, toThreadEvents, toTreeEntry, toWorkItemComment, toWorkItemEvents, toWorkItemThread } from './normalise.ts'
import { azureWeb } from './web.ts'
import { azureDevOpsWebhooks } from './webhooks.ts'

/** The REST API version sent with every request; preview endpoints set their own. */
export const AZURE_DEVOPS_API_VERSION = '7.1'
const POLICY_API_VERSION = '7.1-preview.1'
const COMMENTS_API_VERSION = '7.1-preview.4'

/** A personal access token (sent as basic auth with an empty user name), or explicit basic credentials. */
export type AzureDevOpsAuth = TokenAuth | BasicAuth | AnonymousAuth

/** Options for `azureDevOps()`. */
export interface AzureDevOpsOptions extends ForgeOptionsBase {
  /**
   * How to authenticate. Without credentials, only public reads work.
   * @default { type: 'anonymous' }
   */
  auth?: AzureDevOpsAuth
  /** The organization (or Azure DevOps Server collection) that `repos.list()` lists. */
  organization: string
  /**
   * For Azure DevOps Server, the server root, for example `https://tfs.example.com/tfs`.
   * @default https://dev.azure.com
   */
  baseUrl?: string
  /**
   * Work item type `threads.create({ kind: 'issue' })` creates. Scrum projects use `Impediment` or `Product Backlog Item`.
   * @default Issue
   */
  issueType?: string
  /** `username:password` the service hook subscription sends as basic auth. */
  webhookSecret?: string
}

const ISSUE_AND_PULL = { issue: true, pull_request: true } as const
const PER_PAGE = 50
/** System work item types that are not issues: test management and code review records. */
const NOT_ISSUES = ['Test Case', 'Test Plan', 'Test Suite', 'Shared Steps', 'Shared Parameter', 'Code Review Request', 'Code Review Response', 'Feedback Request', 'Feedback Response']
const MERGE_STRATEGIES = { merge: 'noFastForward', squash: 'squash', rebase: 'rebase', rebase_merge: 'rebaseMerge' } as const

function setupAzure({ options, instance, origin: context, fetcher, baseUrl }: ProviderContext<AzureDevOpsOptions, undefined>): ProviderSpec {
  const enc = encodeURIComponent
  /** Pull request statuses, policy evaluations and WIQL queries redirect a request without credentials to sign in. */
  const anonymous = options.auth?.type === 'anonymous'

  const STATUS_STATES: Record<CheckState, AzureStatus['state']> = { pending: 'pending', success: 'succeeded', failure: 'failed', neutral: 'notApplicable', unknown: 'notSet' }

  function scope(repo: RepoRef): { org: string, project: string } {
    const slash = repo.owner.indexOf('/')
    if (slash < 0) {
      return { org: options.organization, project: repo.owner }
    }
    return { org: repo.owner.slice(0, slash), project: repo.owner.slice(slash + 1) }
  }
  const projectPath = (repo: RepoRef) => {
    const { org, project } = scope(repo)
    return `/${enc(org)}/${enc(project)}/_apis`
  }
  const repoPath = (repo: RepoRef) => `${projectPath(repo)}/git/repositories/${enc(repo.externalId ?? repo.name)}`
  const pullPath = (ref: ResolvedThreadRef) => `${repoPath(ref.repo)}/pullRequests/${ref.number}`
  const workItemPath = (ref: ResolvedThreadRef) => `${projectPath(ref.repo)}/wit/workitems/${ref.number}`
  const issueRef = (repo: RepoRef, id: string): ResolvedThreadRef => {
    const { org, project } = scope(repo)
    return { forge: FORGE, instance, repo: projectRef(instance, org, project), kind: 'issue', number: id }
  }

  const categories = new Map<string, Promise<Map<string, string>>>()
  function stateCategories(repo: RepoRef, type: string): Promise<Map<string, string>> {
    const key = `${repo.owner}:${type}`
    let found = categories.get(key)
    if (!found) {
      found = fetcher.json<{ value: Array<{ name: string, category: string }> }>(`${projectPath(repo)}/wit/workitemtypes/${enc(type)}/states`)
        .then(({ data }) => new Map(data.value.map(state => [state.name, state.category])))
      found.catch(() => categories.delete(key))
      categories.set(key, found)
    }
    return found
  }

  async function workItemThread(ref: ResolvedThreadRef, raw: AzureWorkItem): Promise<Thread> {
    const type = raw.fields['System.WorkItemType'] as string | undefined
    const category = type ? (await stateCategories(ref.repo, type)).get(raw.fields['System.State'] as string) : undefined
    return toWorkItemThread(ref, raw, category)
  }

  const myId = memo(() => fetcher.json<{ authenticatedUser: AzureIdentity }>(`/${enc(options.organization)}/_apis/connectionData`, { query: { 'api-version': '7.1-preview.1' } })
    .then(({ data }) => data.authenticatedUser.id))

  async function pullChecks(ref: ResolvedThreadRef, pull: AzurePullRequest): Promise<Check[]> {
    const [statuses, evaluations] = await Promise.all([
      fetcher.json<{ value: AzureStatus[] }>(`${pullPath(ref)}/statuses`),
      pull.artifactId
        ? fetcher.json<{ value: AzurePolicyEvaluation[] }>(`${projectPath(ref.repo)}/policy/evaluations`, { query: { 'artifactId': pull.artifactId, 'api-version': POLICY_API_VERSION } })
        : Promise.resolve({ data: { value: [] as AzurePolicyEvaluation[] } }),
    ])
    return [...statuses.data.value.map(raw => toStatusCheck(ref.repo, raw)), ...evaluations.data.value.map(raw => toPolicyCheck(ref.repo, raw))]
  }

  /** Azure DevOps has reviewer votes, not reviews: one synthesised review per voter. */
  function toVoteReview(ref: ResolvedThreadRef, reviewer: AzureReviewer): Review {
    const state = reviewer.vote >= 5 ? 'approved' : reviewer.vote <= -5 ? 'changes_requested' : 'pending'
    return syntheticReview(ref, `vote:${reviewer.id}`, state, { author: toActor(instance, reviewer), stateRaw: `vote:${reviewer.vote}`, raw: reviewer })
  }

  async function createReview(thread: ThreadRef, input: ReviewInput): Promise<Review> {
    const ref = requireThread(thread, context)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError('Only pull requests can be reviewed', context)
    }
    if (input.event !== 'approve' && input.event !== 'request_changes') {
      throw new UnsupportedOperationError('Azure DevOps records votes, not review bodies', context)
    }
    if (input.body || input.comments?.length) {
      throw new UnsupportedOperationError('Azure DevOps votes carry no body or inline comments; post them as comment threads', context)
    }
    const id = await myId()
    const vote = input.event === 'approve' ? 10 : -10
    const { data } = await fetcher.json<AzureReviewer>(`${pullPath(ref)}/reviewers/${enc(id)}`, { method: 'PUT', json: { vote } })
    return toVoteReview(ref, { ...data, id: data.id ?? id, vote: data.vote ?? vote })
  }

  async function setThreadStatus(thread: ThreadRef, id: string, status: 'closed' | 'active'): Promise<void> {
    const ref = requireThread(thread, context)
    await fetcher.raw(`${pullPath(ref)}/threads/${enc(id)}`, {
      method: 'PATCH',
      json: { status },
      query: { 'api-version': COMMENTS_API_VERSION },
    })
  }

  async function get(thread: ThreadRef): Promise<Thread> {
    const ref = requireIssueOrPull(thread, context, 'read')
    if (ref.kind === 'issue') {
      return workItemThread(issueRef(ref.repo, ref.number), (await fetcher.json<AzureWorkItem>(workItemPath(ref), { query: { $expand: 'links' } })).data)
    }
    const { data } = await fetcher.json<AzurePullRequest>(pullPath(ref))
    const result = toPullThread({ ...ref, repo: toRepoRef(instance, scope(ref.repo).org, data.repository) }, data)
    if (anonymous) {
      return result
    }
    try {
      result.checks = summariseChecks((await pullChecks(ref, data)).map(check => check.state))
    }
    catch (error) {
      if (!(error instanceof ForgeError)) {
        throw error
      }
      result.warnings = [...result.warnings ?? [], toWarning('checks_unreadable', error, ref.number)]
    }
    return result
  }

  async function pullPage(repo: RepoRef, status: string, query: ThreadQuery, cursor?: Cursor): Promise<Page<Thread>> {
    const skip = Number(cursor?.token ?? 0)
    const top = Math.min(query.perPage ?? PER_PAGE, 1000)
    const { data } = await fetcher.json<{ value: AzurePullRequest[] }>(`${repoPath(repo)}/pullrequests`, {
      query: {
        'searchCriteria.status': status,
        'searchCriteria.minTime': query.createdAfter?.toISOString(),
        'searchCriteria.queryTimeRangeType': query.createdAfter ? 'created' : undefined,
        '$top': top,
        '$skip': skip,
      },
      signal: query.signal,
    })
    const { org } = scope(repo)
    return {
      items: data.value
        .filter(raw => !query.author || raw.createdBy?.uniqueName === query.author || raw.createdBy?.id === query.author)
        .filter(raw => !query.labels?.length || query.labels.every(label => raw.labels?.some(item => item.name === label)))
        .map(raw => toPullThread({ forge: FORGE, instance, repo: toRepoRef(instance, org, raw.repository), kind: 'pull_request', number: String(raw.pullRequestId) }, raw)),
      cursor: data.value.length === top ? { token: String(skip + top) } : undefined,
    }
  }

  function wiql(query: ThreadQuery & { text?: string }): string {
    const literal = (value: string) => `'${value.replaceAll('\'', '\'\'')}'`
    const clauses = [
      '[System.TeamProject] = @project',
      `[System.WorkItemType] NOT IN (${NOT_ISSUES.map(literal).join(', ')})`,
      ...(query.labels ?? []).map(label => `[System.Tags] CONTAINS ${literal(label)}`),
      ...query.author ? [`[System.CreatedBy] = ${literal(query.author)}`] : [],
      ...query.assignee ? [`[System.AssignedTo] = ${literal(query.assignee)}`] : [],
      ...query.since ? [`[System.ChangedDate] >= ${literal(query.since.toISOString())}`] : [],
      ...query.createdAfter ? [`[System.CreatedDate] >= ${literal(query.createdAfter.toISOString())}`] : [],
      ...query.text ? [`[System.Title] CONTAINS ${literal(query.text)}`] : [],
    ]
    const order = query.sort === 'updated' ? '[System.ChangedDate]' : '[System.CreatedDate]'
    return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY ${order} ${(query.direction ?? 'desc').toUpperCase()}`
  }

  /** WIQL returns every matching id; each page reads its slice of them. */
  async function workItemPage(repo: RepoRef, query: ThreadQuery & { text?: string }, cursor?: Cursor): Promise<Page<Thread>> {
    const offset = Number(cursor?.token ?? 0)
    const size = Math.min(query.perPage ?? PER_PAGE, 200)
    const { data } = await fetcher.json<{ workItems: Array<{ id: number }> }>(`${projectPath(repo)}/wit/wiql`, { method: 'POST', json: { query: wiql(query) }, signal: query.signal })
    const ids = data.workItems.slice(offset, offset + size).map(item => item.id)
    if (!ids.length) {
      return { items: [] }
    }
    const { data: batch } = await fetcher.json<{ value: AzureWorkItem[] }>(`${projectPath(repo)}/wit/workitemsbatch`, { method: 'POST', json: { ids, $expand: 'Links' }, signal: query.signal })
    const state = query.state ?? 'open'
    const items = (await Promise.all(batch.value.map(raw => workItemThread(issueRef(repo, String(raw.id)), raw))))
      .filter(thread => state === 'all' || thread.state === state)
    return { items, cursor: offset + size < data.workItems.length ? { token: String(offset + size) } : undefined }
  }

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    if (query.kind === 'discussion') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: 'Azure DevOps has no discussions' }] }
    }
    const warnings: ForgeWarning[] = []
    if (!query.cursor && query.kind !== 'issue') {
      if (query.sort && query.sort !== 'created') {
        warnings.push({ code: 'sort_unsupported', message: 'Azure DevOps lists pull requests newest first only' })
      }
      if (query.assignee || query.since) {
        warnings.push({ code: 'filter_unsupported', message: 'Azure DevOps pull requests have no assignees or update-time filter; those filters were ignored' })
      }
    }
    const state = query.state ?? 'open'
    const pullStates = state === 'open' ? ['active'] : state === 'merged' ? ['completed'] : state === 'closed' ? ['completed', 'abandoned'] : ['all']
    const phases: Array<(cursor?: Cursor) => Promise<Page<Thread>>> = []
    if (query.kind !== 'pull_request') {
      if (!anonymous) {
        phases.push(cursor => workItemPage(repo, query, cursor))
      }
      else if (!query.cursor) {
        warnings.push({ code: 'kind_unsupported', message: 'Azure DevOps lists work items only to signed-in users; this listing has pull requests only' })
      }
    }
    if (query.kind !== 'issue') {
      phases.push(...pullStates.map(status => (cursor?: Cursor) => pullPage(repo, status, query, cursor)))
    }
    const page = await phased(phases, query.cursor)
    return warnings.length ? { ...page, warnings: [...warnings, ...page.warnings ?? []] } : page
  }

  async function threads(ref: ResolvedThreadRef): Promise<AzureThread[]> {
    return (await fetcher.json<{ value: AzureThread[] }>(`${pullPath(ref)}/threads`)).data.value.filter(thread => !thread.isDeleted)
  }

  /** Pull request threads come unpaged, so comments are one complete page; work item comments page by continuation token. */
  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireIssueOrPull(thread, context, 'list comments on')
    if (ref.kind === 'pull_request') {
      return {
        items: (await threads(ref)).filter(isConversationThread).flatMap(item => item.comments.filter(comment => !comment.isDeleted && comment.commentType !== 'system').map(comment => toPullComment(ref, item, comment))),
      }
    }
    const issue = issueRef(ref.repo, ref.number)
    const { data } = await fetcher.json<{ comments: AzureWorkItemComment[], continuationToken?: string }>(`${workItemPath(ref)}/comments`, {
      query: { 'api-version': COMMENTS_API_VERSION, '$top': listOptions.perPage ?? PER_PAGE, 'continuationToken': listOptions.cursor?.token },
    })
    return { items: data.comments.filter(comment => !comment.isDeleted).map(raw => toWorkItemComment(issue, raw)), cursor: data.continuationToken ? { token: data.continuationToken } : undefined }
  }

  async function eventsPage(thread: ThreadRef): Promise<Page<ForgeEventInput>> {
    const ref = requireIssueOrPull(thread, context, 'list events on')
    if (ref.kind === 'pull_request') {
      const events = (await threads(ref)).flatMap(item => toThreadEvents(ref, item))
      return { items: events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()) }
    }
    const issue = issueRef(ref.repo, ref.number)
    const [{ data: updates }, { data: comments }] = await Promise.all([
      fetcher.json<{ value: AzureWorkItemUpdate[] }>(`${workItemPath(ref)}/updates`),
      fetcher.json<{ comments: AzureWorkItemComment[] }>(`${workItemPath(ref)}/comments`, { query: { 'api-version': COMMENTS_API_VERSION } }),
    ])
    return { items: toWorkItemEvents(issue, updates.value, comments.comments.filter(comment => !comment.isDeleted)) }
  }

  async function patchWorkItem(ref: ResolvedThreadRef, fields: Record<string, unknown>): Promise<AzureWorkItem> {
    const { data } = await fetcher.json<AzureWorkItem>(workItemPath(ref), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json-patch+json' },
      body: JSON.stringify(Object.entries(fields).map(([name, value]) => ({ op: 'add', path: `/fields/${name}`, value }))),
    })
    return data
  }

  async function stateIn(ref: ResolvedThreadRef, wanted: string[]): Promise<string> {
    const { data } = await fetcher.json<AzureWorkItem>(workItemPath(ref))
    const type = data.fields['System.WorkItemType'] as string
    for (const [name, category] of await stateCategories(ref.repo, type)) {
      if (wanted.includes(category)) {
        return name
      }
    }
    throw new UnsupportedOperationError(`The ${type} work item type has no ${wanted.join(' or ')} state`, context)
  }

  async function setState(thread: ThreadRef, state: 'open' | 'closed'): Promise<void> {
    const ref = requireIssueOrPull(thread, context, state === 'open' ? 'reopen' : 'close')
    if (ref.kind === 'pull_request') {
      await fetcher.raw(pullPath(ref), { method: 'PATCH', json: { status: state === 'open' ? 'active' : 'abandoned' } })
      return
    }
    await patchWorkItem(ref, { 'System.State': await stateIn(ref, state === 'open' ? ['Proposed', 'InProgress'] : ['Completed']) })
  }

  function splitCommentId(ref: CommentRef): { thread: string, comment: string } {
    const [thread = '', comment = ''] = ref.id.split('/')
    return { thread, comment }
  }

  /** WIQL runs against one project, and reaches work items only: Azure DevOps has no pull request search. */
  async function searchThreadsPage(query: SearchQuery): Promise<Page<Thread>> {
    if (!query.repo) {
      throw new UnsupportedOperationError('Azure DevOps work item search is scoped to a project; pass `repo`', context)
    }
    if (query.kind === 'pull_request') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: 'Azure DevOps has no pull request search' }] }
    }
    const warnings: ForgeWarning[] = query.involves && !query.cursor
      ? [{ code: 'filter_unsupported', message: 'Azure DevOps WIQL has no involves filter; it was ignored' }]
      : []
    const page = await workItemPage(query.repo, {
      text: query.text,
      state: query.state ?? 'all',
      labels: query.labels,
      author: query.author,
      assignee: query.assignee,
      since: query.since,
      sort: query.sort === 'created' ? 'created' : 'updated',
      direction: query.direction,
      perPage: query.perPage,
      signal: query.signal,
    }, query.cursor)
    return warnings.length ? { ...page, warnings: [...warnings, ...page.warnings ?? []] } : page
  }

  return {
    traits: { eventKinds: 'native', authKinds: ['token', 'basic', 'anonymous'] },
    search: { threadsPage: verb(!anonymous && 'experimental', searchThreadsPage) },
    repos: {
      get: verb(true, async (ref) => {
        const { data } = await fetcher.json<AzureRepository>(repoPath(ref))
        return toRepo(instance, scope(ref).org, data)
      }),
      listPage: verb('experimental', async () => {
        const { data } = await fetcher.json<{ value: AzureRepository[] }>(`/${enc(options.organization)}/_apis/git/repositories`)
        return { items: data.value.map(raw => toRepo(instance, options.organization, raw)) }
      }),
    },
    contents: {
      file: verb('experimental', async (repo, path, fileOptions = {}) => {
        const query = {
          path,
          download: 'true',
          $format: 'octetStream',
          ...fileOptions.ref ? { 'versionDescriptor.version': fileOptions.ref, 'versionDescriptor.versionType': /^[0-9a-f]{40}$/i.test(fileOptions.ref) ? 'commit' : 'branch' } : {},
        }
        const response = await fetcher.raw(`${repoPath(repo)}/items`, { query, signal: fileOptions.signal })
        return toFileContent(new Uint8Array(await response.arrayBuffer()), { path: path.replace(/^\//, '') }, fileOptions, context)
      }),
      treePage: verb('experimental', async (repo, treeOptions = {}) => {
        const { data } = await fetcher.json<{ value: AzureItem[] }>(`${repoPath(repo)}/items`, {
          query: {
            scopePath: treeOptions.path ? `/${treeOptions.path.replace(/^\//, '')}` : '/',
            recursionLevel: treeOptions.recursive ? 'full' : 'oneLevel',
            ...treeOptions.ref ? { 'versionDescriptor.version': treeOptions.ref } : {},
          },
          signal: treeOptions.signal,
        })
        return { items: data.value.filter(item => item.path !== '/').map(toTreeEntry) }
      }),
      branchesPage: verb('experimental', async (repo, listOptions = {}) => {
        const { data } = await fetcher.json<{ value: AzureRef[] }>(`${repoPath(repo)}/refs`, { query: { filter: 'heads/' }, signal: listOptions.signal })
        return { items: data.value.map(toBranch) }
      }),
      tagsPage: verb('experimental', async (repo, listOptions = {}) => {
        const { data } = await fetcher.json<{ value: AzureRef[] }>(`${repoPath(repo)}/refs`, { query: { filter: 'tags/', peelTags: 'true' }, signal: listOptions.signal })
        return { items: data.value.map(toTag) }
      }),
      resolveRef: verb('experimental', async (repo, ref) => {
        const { data } = await fetcher.json<{ value: AzureCommit[] }>(`${repoPath(repo)}/commits`, {
          query: { 'searchCriteria.itemVersion.version': ref, '$top': 1 },
        })
        const sha = data.value[0]?.commitId
        if (!sha) {
          throw new NotFoundError(`Azure DevOps has no commit for ${ref}`, 404, '', context)
        }
        return sha
      }),
      commitsPage: verb('experimental', async (repo, query = {}) => {
        const { data } = await fetcher.json<{ value: AzureCommit[] }>(`${repoPath(repo)}/commits`, {
          query: {
            'searchCriteria.itemVersion.version': query.ref,
            'searchCriteria.itemPath': query.path,
            'searchCriteria.author': query.author,
            'searchCriteria.fromDate': query.since?.toISOString(),
            'searchCriteria.toDate': query.until?.toISOString(),
            '$top': query.perPage,
          },
          signal: query.signal,
        })
        return { items: data.value.map(raw => toCommit(repo, raw)) }
      }),
      commit: verb('experimental', async (repo, sha) => {
        const { data } = await fetcher.json<AzureCommit>(`${repoPath(repo)}/commits/${sha}`, { query: { changeCount: 100 } })
        return toCommit(repo, data, (data.changes ?? []).filter(change => !change.item?.isFolder).map(toChangedFile))
      }),
      compare: verb('experimental', async (repo, base, head) => {
        const { data } = await fetcher.json<AzureCommitDiffs>(`${repoPath(repo)}/diffs/commits`, {
          query: { baseVersion: base, targetVersion: head, $top: 1000 },
        })
        return {
          base,
          head,
          aheadBy: data.aheadCount,
          behindBy: data.behindCount,
          mergeBaseSha: data.commonCommit,
          commits: [],
          files: (data.changes ?? []).filter(change => !change.item?.isFolder).map(toChangedFile),
          raw: data,
        }
      }),
    },
    checks: {
      list: verb('experimental', async (repo, sha) => ({ items: (await fetcher.json<{ value: AzureStatus[] }>(`${repoPath(repo)}/commits/${sha}/statuses`)).data.value.map(raw => toStatusCheck(repo, raw)) })),
      report: verb('experimental', async (repo, sha, input) => toStatusCheck(repo, (await fetcher.json<AzureStatus>(`${repoPath(repo)}/commits/${sha}/statuses`, {
        method: 'POST',
        json: {
          state: STATUS_STATES[input.state],
          description: input.description,
          targetUrl: input.url,
          context: { name: input.name, genre: input.externalId ?? 'forges' },
        },
      })).data)),
    },
    threads: {
      get: perKind({ issue: 'experimental', pull_request: true }, get),
      getMany: verb(true, refs => getManyConcurrently(refs, get)),
      listPage: perKind({ issue: !anonymous, pull_request: true }, listPage),
      eventsPage: verb(true, eventsPage),
      commitsPage: verb('experimental', async (thread, listOptions = {}) => {
        const ref = requireThread(thread, context)
        if (ref.kind !== 'pull_request') {
          throw new UnsupportedOperationError('Only pull requests can be read for commits', context)
        }
        const { data } = await fetcher.json<{ value: AzureCommit[] }>(`${pullPath(ref)}/commits`, { query: { $top: listOptions.perPage }, signal: listOptions.signal })
        return { items: data.value.map(raw => toCommit(ref.repo, raw)) }
      }),
      commentsPage: perKind({ issue: 'experimental', pull_request: true }, commentsPage),
      comment: perKind({ issue: 'experimental', pull_request: true }, async (thread, body) => {
        const ref = requireIssueOrPull(thread, context, 'comment on')
        if (ref.kind === 'issue') {
          const { data } = await fetcher.json<AzureWorkItemComment>(`${workItemPath(ref)}/comments`, { method: 'POST', json: { text: body }, query: { 'api-version': COMMENTS_API_VERSION } })
          return toWorkItemComment(issueRef(ref.repo, ref.number), data)
        }
        const { data } = await fetcher.json<AzureThread>(`${pullPath(ref)}/threads`, { method: 'POST', json: { comments: [{ parentCommentId: 0, content: body, commentType: 'text' }], status: 'active' } })
        return toPullComment(ref, data, data.comments[0]!)
      }),
      editComment: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (ref, body) => {
        const thread = requireIssueOrPull(ref.thread, context, 'edit comments on')
        if (thread.kind === 'issue') {
          const { data } = await fetcher.json<AzureWorkItemComment>(`${workItemPath(thread)}/comments/${ref.id}`, { method: 'PATCH', json: { text: body }, query: { 'api-version': COMMENTS_API_VERSION } })
          return toWorkItemComment(issueRef(thread.repo, thread.number), data)
        }
        const ids = splitCommentId(ref)
        const { data } = await fetcher.json<AzureThread['comments'][number]>(`${pullPath(thread)}/threads/${ids.thread}/comments/${ids.comment}`, { method: 'PATCH', json: { content: body } })
        return toPullComment(thread, { id: Number(ids.thread), comments: [] }, data)
      }),
      deleteComment: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (ref) => {
        const thread = requireIssueOrPull(ref.thread, context, 'delete comments on')
        if (thread.kind === 'issue') {
          await fetcher.raw(`${workItemPath(thread)}/comments/${ref.id}`, { method: 'DELETE', query: { 'api-version': COMMENTS_API_VERSION } })
          return
        }
        const ids = splitCommentId(ref)
        await fetcher.raw(`${pullPath(thread)}/threads/${ids.thread}/comments/${ids.comment}`, { method: 'DELETE' })
      }),
      create: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (repo, input) => {
        if (input.kind === 'issue') {
          if ((input.assignees?.length ?? 0) > 1) {
            throw new UnsupportedOperationError('Azure DevOps work items take a single assignee', context)
          }
          const fields: Record<string, unknown> = { 'System.Title': input.title }
          if (input.body) {
            fields['System.Description'] = input.body
          }
          if (input.labels?.length) {
            fields['System.Tags'] = input.labels.join('; ')
          }
          if (input.assignees?.[0]) {
            fields['System.AssignedTo'] = typeof input.assignees[0] === 'string' ? input.assignees[0] : input.assignees[0].login
          }
          const { data } = await fetcher.json<AzureWorkItem>(`${projectPath(repo)}/wit/workitems/$${enc(options.issueType ?? 'Issue')}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json-patch+json' },
            body: JSON.stringify(Object.entries(fields).map(([name, value]) => ({ op: 'add', path: `/fields/${name}`, value }))),
          })
          return workItemThread(issueRef(repo, String(data.id)), data)
        }
        if (!input.head || !input.base) {
          throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
        }
        const { data } = await fetcher.json<AzurePullRequest>(`${repoPath(repo)}/pullrequests`, {
          method: 'POST',
          json: {
            sourceRefName: `refs/heads/${input.head}`,
            targetRefName: `refs/heads/${input.base}`,
            title: input.title,
            description: input.body,
            isDraft: input.draft ?? false,
            labels: input.labels?.map(name => ({ name })),
            reviewers: input.assignees?.map(reviewer => ({ id: typeof reviewer === 'string' ? reviewer : reviewer.id })),
          },
        })
        return toPullThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: String(data.pullRequestId) }, data)
      }),
      update: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, input) => {
        const ref = requireIssueOrPull(thread, context, 'update')
        if (ref.kind === 'issue') {
          const fields: Record<string, unknown> = {}
          if (input.title !== undefined) {
            fields['System.Title'] = input.title
          }
          if (input.body !== undefined) {
            fields['System.Description'] = input.body
          }
          return workItemThread(issueRef(ref.repo, ref.number), await patchWorkItem(ref, fields))
        }
        const { data } = await fetcher.json<AzurePullRequest>(pullPath(ref), { method: 'PATCH', json: { title: input.title, description: input.body } })
        return toPullThread(ref, data)
      }),
      close: perKind(ISSUE_AND_PULL, ref => setState(ref, 'closed')),
      reopen: perKind({ issue: 'experimental', pull_request: true }, ref => setState(ref, 'open')),
      setLabels: perKind({ issue: 'experimental', pull_request: 'experimental' }, async (thread, labels) => {
        const ref = requireIssueOrPull(thread, context, 'label')
        if (ref.kind === 'issue') {
          await patchWorkItem(ref, { 'System.Tags': labels.join('; ') })
          return
        }
        const { data } = await fetcher.json<{ value: Array<{ id: string, name: string }> }>(`${pullPath(ref)}/labels`)
        const current = data.value.map(label => label.name)
        for (const label of data.value.filter(item => !labels.includes(item.name))) {
          await fetcher.raw(`${pullPath(ref)}/labels/${enc(label.id)}`, { method: 'DELETE' })
        }
        for (const name of labels.filter(item => !current.includes(item))) {
          await fetcher.raw(`${pullPath(ref)}/labels`, { method: 'POST', json: { name } })
        }
      }),
      setAssignees: perKind({ issue: 'experimental' }, async (thread, assignees) => {
        if (assignees.length > 1) {
          throw new UnsupportedOperationError('Azure DevOps work items take a single assignee', context)
        }
        const assignee = assignees[0]
        await patchWorkItem(requireIssueOrPull(thread, context, 'assign'), { 'System.AssignedTo': assignee === undefined ? '' : typeof assignee === 'string' ? assignee : assignee.login })
      }),
      requestReview: perKind({ pull_request: 'experimental' }, async (thread, reviewers) => {
        const ref = requireThread(thread, context)
        for (const reviewer of reviewers) {
          const id = typeof reviewer === 'string' ? reviewer : reviewer.id
          await fetcher.raw(`${pullPath(ref)}/reviewers/${enc(id)}`, { method: 'PUT', json: { vote: 0 } })
        }
      }),
      merge: verb(true, async (thread, mergeOptions = {}, hooks = {}) => {
        const ref = requireThread(thread, context)
        if (ref.kind !== 'pull_request') {
          throw new UnsupportedOperationError('Only pull requests can be completed', context)
        }
        if (!mergeOptions.method) {
          throw new MergeMethodRequiredError(Object.keys(MERGE_STRATEGIES) as MergeMethod[], context)
        }
        if (mergeOptions.method === 'fast_forward_only') {
          throw new UnsupportedOperationError('Azure DevOps does not support fast-forward-only completion', context)
        }
        const completionOptions = {
          mergeStrategy: MERGE_STRATEGIES[mergeOptions.method],
          ...mergeOptions.message ? { mergeCommitMessage: mergeOptions.message } : {},
        }
        const id = await myId()
        await hooks.beforeMerge?.()
        if (mergeOptions.whenChecksPass) {
          await fetcher.raw(pullPath(ref), { method: 'PATCH', json: { autoCompleteSetBy: { id }, completionOptions }, mapError: toMergeError })
          return
        }
        const sha = mergeOptions.sha ?? (await fetcher.json<AzurePullRequest>(pullPath(ref))).data.lastMergeSourceCommit?.commitId
        await fetcher.raw(pullPath(ref), { method: 'PATCH', json: { status: 'completed', lastMergeSourceCommit: { commitId: sha }, completionOptions }, mapError: toMergeError })
      }),
      checks: perKind({ pull_request: !anonymous }, async (thread) => {
        const ref = requireThread(thread, context)
        return { items: await pullChecks(ref, (await fetcher.json<AzurePullRequest>(pullPath(ref))).data) }
      }),
      reviewsPage: verb('emulated', async (thread) => {
        const ref = requireThread(thread, context)
        const { data } = await fetcher.json<AzurePullRequest>(pullPath(ref))
        return { items: (data.reviewers ?? []).filter(reviewer => reviewer.vote !== 0).map(reviewer => toVoteReview(ref, reviewer)) }
      }),
      createReview: verb('emulated', createReview),
      reviewThreads: verb('experimental', {
        resolveReviewThread: (thread, id) => setThreadStatus(thread, id, 'closed'),
        unresolveReviewThread: (thread, id) => setThreadStatus(thread, id, 'active'),
      }),
    },
    web: azureWeb(baseUrl),
    webhooks: {
    },
    scopes: verb => verb.startsWith('webhooks.')
      ? { token: ['vso.work_full'], note: 'Service hook subscriptions need project administrator rights' }
      : { token: ['vso.code', 'vso.work'] },
  }
}

const AZURE_DEVOPS: ProviderDefinition<AzureDevOpsOptions> = {
  forge: FORGE,
  experimental: true,
  baseUrl: 'https://dev.azure.com',
  anonymous: true,
  headers: { accept: 'application/json' },
  query: { 'api-version': AZURE_DEVOPS_API_VERSION },
  authHeaders: ({ options: { auth } }) => {
    if (!auth || auth.type === 'anonymous') {
      return undefined
    }
    return async () => ({ authorization: `Basic ${btoa(auth.type === 'token' ? `:${await resolveToken(auth)}` : `${auth.username}:${auth.password}`)}` })
  },
  setup: setupAzure,
}

/** Creates an Azure DevOps provider for one organization on dev.azure.com, or a collection on Azure DevOps Server. */
export const azureDevOps: ProviderFactoryFunction<AzureDevOpsOptions> = /* @__PURE__ */ defineForgeProvider({ ...AZURE_DEVOPS, webhooks: azureDevOpsWebhooks })

/** `azureDevOps()` without webhook ingestion, for bundles that never receive a delivery. */
export const azureDevOpsLite: ProviderFactoryFunction<AzureDevOpsOptions> = /* @__PURE__ */ defineForgeProvider(AZURE_DEVOPS)
