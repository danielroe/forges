import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { BaseOptions, Branch, Comment, Commit, CommitQuery, CompareOptions, Comparison, FileContent, FileOptions, ListOptions, OwnerRepoQuery, Page, PageOptions, Repo, RepoRef, RepoSearchQuery, ResolvedThreadRef, Review, Tag, Thread, ThreadQuery, ThreadRef, TreeEntry, TreeOptions } from '../model.ts'
import type { AnonymousAuth, ForgeOptionsBase, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { WebLinks } from '../web.ts'
import type { RadicleBlob, RadicleCommit, RadicleCommitDetail, RadicleComparison, RadicleIssue, RadiclePatch, RadicleRepository, RadicleTree } from './types.ts'
import { decodeText, isSha } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { getManyConcurrently, phased, requireIssueOrPull } from '../utils.ts'
import { FORGE, toChangedFile, toComment, toCommit, toIssue, toPatch, toRepo, toReviews, toTreeEntry } from './normalise.ts'
import { RADICLE_EXPLORER, RADICLE_WEB, ridOf } from './web.ts'

/** A seed node serves its API to anyone, so there's nothing to sign in with. */
export type RadicleAuth = AnonymousAuth

/** Options for `radicle()`. */
export interface RadicleOptions extends ForgeOptionsBase {
  /**
   * Only public reads, as a node takes no credentials.
   * @default { type: 'anonymous' }
   */
  auth?: RadicleAuth
  /**
   * The root of a node that runs `radicle-httpd`. `/api/v1` is appended.
   * @default 'https://seed.radicle.dev'
   */
  baseUrl?: string
}

/** The most items httpd returns in a page. */
const MAX_PAGE = 100
const DEFAULT_PAGE = 30

/** The page size asked for, or the default, capped at what httpd returns. */
function pageSize(perPage: number | undefined): number {
  return perPage !== undefined && Number.isInteger(perPage) && perPage > 0
    ? Math.min(perPage, MAX_PAGE)
    : DEFAULT_PAGE
}

function pageIndex(cursor: { token?: string } | undefined): number {
  const index = Number(cursor?.token ?? 0)
  return Number.isInteger(index) && index > 0
    ? index
    : 0
}

/** A page that ends the listing when it comes back short, as httpd reports no total. */
function numbered<T>(items: T[], index: number, size: number): Page<T> {
  return items.length < size
    ? { items }
    : {
        items,
        cursor: {
          token: String(index + 1),
        },
      }
}

const ISSUE_STATUS = { open: 'open', closed: 'closed', all: 'all' } as const
const PATCH_STATUS = {
  open: 'open',
  closed: 'archived',
  merged: 'merged',
  all: 'all',
} as const

function setupRadicle({ origin, fetcher, baseUrl }: ProviderContext<RadicleOptions, undefined>): ProviderSpec & { web: WebLinks } {
  const webUrl = `${RADICLE_EXPLORER}/nodes/${new URL(baseUrl).host}`
  const web = RADICLE_WEB.links({ baseUrl, instance: origin.instance })
  const repoPath = (repo: RepoRef) => `/repos/${ridOf(repo)}`

  async function json<T>(path: string, query?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
    return (await fetcher.json<T>(path, { query, signal })).data
  }

  async function repo(ref: RepoRef, signal?: AbortSignal): Promise<RadicleRepository> {
    return json<RadicleRepository>(repoPath(ref), undefined, signal)
  }

  /** The sha of a branch, tag or `HEAD`, from the canonical refs, as httpd takes only shas. */
  async function shaOf(ref: RepoRef, name: string | undefined, signal?: AbortSignal): Promise<string> {
    if (name && isSha(name)) {
      return name
    }
    const raw = await repo(ref, signal)
    const refs = raw.refs?.refs ?? {}
    const tags = raw.refs?.tags ?? {}
    const target = !name || name === 'HEAD'
      ? raw.defaultBranch ?? `refs/heads/${raw.payloads['xyz.radicle.project']?.data.defaultBranch ?? 'main'}`
      : name
    const sha = refs[target] ?? refs[`refs/heads/${target}`] ?? tags[target]?.commit ?? tags[`refs/tags/${target}`]?.commit
      ?? (!name || name === 'HEAD'
        ? raw.payloads['xyz.radicle.project']?.meta?.head
        : undefined)
    if (!sha) {
      throw new NotFoundError(`No canonical ref ${name ?? 'for the default branch'} in ${ridOf(ref)}`, 404, '', origin)
    }
    return sha
  }

  /** The branches and tags the delegates agreed on. */
  async function canonical(ref: RepoRef, signal?: AbortSignal): Promise<{ branches: Branch[], tags: Tag[] }> {
    const raw = await repo(ref, signal)
    const head = raw.defaultBranch ?? `refs/heads/${raw.payloads['xyz.radicle.project']?.data.defaultBranch}`
    return {
      branches: Object.entries(raw.refs?.refs ?? {}).filter(([name]) => name.startsWith('refs/heads/')).map(([name, sha]) => ({
        name: name.slice('refs/heads/'.length),
        sha,
        isDefault: name === head,
        raw: { name, sha },
      })),
      tags: Object.entries(raw.refs?.tags ?? {}).map(([name, tag]) => ({
        name: name.replace(/^refs\/tags\//, ''),
        sha: tag.commit,
        raw: tag,
      })),
    }
  }

  async function listRepos(path: string, query: PageOptions, signal?: AbortSignal): Promise<Page<Repo>> {
    const index = pageIndex(query.cursor)
    const size = pageSize(query.perPage)
    const items = await json<RadicleRepository[]>(path, { show: 'all', page: index, perPage: size }, signal)
    return numbered(items.map(raw => toRepo(origin, raw, webUrl)), index, size)
  }

  function byOwnerPage(owner: RepoRef, query: OwnerRepoQuery = {}): Promise<Page<Repo>> {
    if (query.visibility === 'private' || query.visibility === 'internal') {
      return Promise.resolve({ items: [] })
    }
    if (!owner.owner.startsWith('did:')) {
      throw new UnsupportedOperationError('Radicle lists the repositories of a delegate by its DID, such as did:key:z6Mk…', origin)
    }
    return listRepos(`/delegates/${owner.owner}/repos`, query, query.signal)
  }

  async function searchReposPage(query: RepoSearchQuery = {}): Promise<Page<Repo>> {
    const index = pageIndex(query.cursor)
    const size = pageSize(query.perPage)
    const found = await json<Array<{ rid: string }>>('/repos/search', { q: query.queryRaw ?? query.text ?? '', page: index, perPage: size }, query.signal)
    const items = await Promise.all(found.map(async item => toRepo(origin, await json<RadicleRepository>(`/repos/${item.rid}`, undefined, query.signal), webUrl)))
    return numbered(items, index, size)
  }

  /** The id of an issue or patch, a full sha, checked before it goes in a path. */
  function objectId(ref: ResolvedThreadRef): string {
    if (!isSha(ref.number)) {
      throw new TypeError(`${JSON.stringify(ref.number)} is not a Radicle ${ref.kind === 'issue'
        ? 'issue'
        : 'patch'} id, which is 40 hex characters`)
    }
    return ref.number
  }

  async function issue(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<RadicleIssue> {
    return json<RadicleIssue>(`${repoPath(ref.repo)}/issues/${objectId(ref)}`, undefined, signal)
  }

  async function patch(ref: ResolvedThreadRef, signal?: AbortSignal): Promise<RadiclePatch> {
    return json<RadiclePatch>(`${repoPath(ref.repo)}/patches/${objectId(ref)}`, undefined, signal)
  }

  function requirePatch(thread: ThreadRef, action: string): ResolvedThreadRef {
    const ref = requireIssueOrPull(thread, origin, action)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError(`Only patches can be ${action}`, origin)
    }
    return ref
  }

  /** The branch a patch that targets the delegates merges into. */
  async function defaultBranch(ref: RepoRef, signal?: AbortSignal): Promise<string | undefined> {
    const raw = await repo(ref, signal)
    return raw.defaultBranch?.replace(/^refs\/heads\//, '') ?? raw.payloads['xyz.radicle.project']?.data.defaultBranch
  }

  async function get(thread: ThreadRef, options?: BaseOptions): Promise<Thread> {
    const ref = requireIssueOrPull(thread, origin, 'read')
    if (ref.kind === 'issue') {
      return toIssue(origin, ref.repo, await issue(ref, options?.signal), webUrl)
    }
    objectId(ref)
    const [raw, branch] = await Promise.all([
      patch(ref, options?.signal),
      defaultBranch(ref.repo, options?.signal),
    ])
    return toPatch(origin, ref.repo, raw, webUrl, branch)
  }

  async function issuesPage(repoRef: RepoRef, query: ThreadQuery, cursor?: { token?: string }): Promise<Page<Thread>> {
    const index = pageIndex(cursor)
    const size = pageSize(query.perPage)
    const status = ISSUE_STATUS[query.state === 'merged'
      ? 'closed'
      : query.state ?? 'open']
    const items = await json<RadicleIssue[]>(`${repoPath(repoRef)}/issues`, { status, page: index, perPage: size }, query.signal)
    return numbered(items.map(raw => toIssue(origin, repoRef, raw, webUrl)), index, size)
  }

  async function patchesPage(repoRef: RepoRef, query: ThreadQuery, status: string, cursor?: { token?: string }): Promise<Page<Thread>> {
    const index = pageIndex(cursor)
    const size = pageSize(query.perPage)
    const [items, branch] = await Promise.all([
      json<RadiclePatch[]>(`${repoPath(repoRef)}/patches`, { status, page: index, perPage: size }, query.signal),
      defaultBranch(repoRef, query.signal),
    ])
    return numbered(items.map(raw => toPatch(origin, repoRef, raw, webUrl, branch)), index, size)
  }

  /** Issues, then patches, with drafts after the open ones, as httpd lists them apart. */
  function listPage(repoRef: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    if (query.kind === 'discussion') {
      return Promise.resolve({
        items: [],
        warnings: [
          { code: 'kind_unsupported', message: 'Radicle has no discussions' },
        ],
      })
    }
    const state = query.state ?? 'open'
    const phases: Array<(cursor?: { token?: string }) => Promise<Page<Thread>>> = []
    if (query.kind !== 'pull_request' && state !== 'merged') {
      phases.push(cursor => issuesPage(repoRef, query, cursor))
    }
    if (query.kind !== 'issue') {
      const statuses = state === 'open'
        ? ['open', 'draft']
        : [PATCH_STATUS[state]]
      phases.push(...statuses.map(status => (cursor?: { token?: string }) => patchesPage(repoRef, query, status, cursor)))
    }
    return phased(phases, query.cursor)
  }

  /** The comments after the description, which is an issue's first comment. */
  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireIssueOrPull(thread, origin, 'read comments on')
    const comments = ref.kind === 'issue'
      ? (await issue(ref, listOptions.signal)).discussion.slice(1)
      : (await patch(ref, listOptions.signal)).revisions.flatMap(revision => revision.discussions)
    const since = listOptions.since && listOptions.since.getTime() / 1000
    const kept = since === undefined
      ? comments
      : comments.filter(comment => comment.timestamp >= since)
    const index = pageIndex(listOptions.cursor)
    const size = pageSize(listOptions.perPage)
    const slice = kept.slice(index * size, (index + 1) * size)
    return {
      ...numbered(slice.map(raw => toComment(origin, ref, raw, webUrl)), index, size),
      ...(index + 1) * size >= kept.length
        ? { cursor: undefined }
        : {},
      total: kept.length,
    }
  }

  async function reviewsPage(thread: ThreadRef, listOptions: PageOptions = {}): Promise<Page<Review>> {
    const ref = requirePatch(thread, 'reviewed')
    const reviews = toReviews(origin, ref, await patch(ref, listOptions.signal))
    const index = pageIndex(listOptions.cursor)
    const size = pageSize(listOptions.perPage)
    const items = reviews.slice(index * size, (index + 1) * size)
    return (index + 1) * size < reviews.length
      ? {
          items,
          cursor: {
            token: String(index + 1),
          },
          total: reviews.length,
        }
      : { items, total: reviews.length }
  }

  /** The latest revision of a patch, against the base it was written on. */
  async function revisionDiff(thread: ThreadRef, signal?: AbortSignal): Promise<{ ref: ResolvedThreadRef, comparison: RadicleComparison }> {
    const ref = requirePatch(thread, 'compared')
    const raw = await patch(ref, signal)
    const revision = raw.revisions.at(-1)
    if (!revision) {
      throw new NotFoundError(`Patch ${ref.number} has no revision`, 404, '', origin)
    }
    return { ref, comparison: await json<RadicleComparison>(`${repoPath(ref.repo)}/diff/${revision.base}/${revision.oid}`, undefined, signal) }
  }

  async function blob(repoRef: RepoRef, path: string, fileOptions: FileOptions = {}): Promise<FileContent> {
    const sha = await shaOf(repoRef, fileOptions.ref, fileOptions.signal)
    const encoded = path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/')
    const raw = await json<RadicleBlob>(`${repoPath(repoRef)}/blob/${sha}/${encoded}`, undefined, fileOptions.signal)
    const bytes = raw.binary
      ? Uint8Array.from(atob(raw.content), char => char.charCodeAt(0))
      : new TextEncoder().encode(raw.content)
    const file = { path: raw.path, size: bytes.length, url: `${webUrl}${web.file!(repoRef, raw.path, sha)}` }
    return fileOptions.as === 'text'
      ? {
          ...file,
          content: raw.binary
            ? decodeText(bytes, raw.path, origin)
            : raw.content,
          encoding: 'utf-8',
        }
      : { ...file, content: bytes, encoding: 'binary' }
  }

  async function treePage(repoRef: RepoRef, treeOptions: TreeOptions = {}): Promise<Page<TreeEntry>> {
    const sha = await shaOf(repoRef, treeOptions.ref, treeOptions.signal)
    const path = treeOptions.path?.replace(/^\/|\/$/g, '') ?? ''
    const raw = await json<RadicleTree>(`${repoPath(repoRef)}/tree/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`, undefined, treeOptions.signal)
    const items = raw.entries.map(toTreeEntry)
    return treeOptions.recursive
      ? {
          items,
          warnings: [
            { code: 'recursive_unsupported', message: 'Radicle lists one level of a tree; read subdirectories separately' },
          ],
        }
      : { items }
  }

  async function commitsPage(repoRef: RepoRef, query: CommitQuery = {}): Promise<Page<Commit>> {
    const parent = await shaOf(repoRef, query.ref, query.signal)
    const index = pageIndex(query.cursor)
    const size = pageSize(query.perPage)
    const items = await json<RadicleCommit[]>(`${repoPath(repoRef)}/commits`, {
      parent,
      since: query.since && Math.floor(query.since.getTime() / 1000),
      until: query.until && Math.ceil(query.until.getTime() / 1000),
      page: index,
      perPage: size,
    }, query.signal)
    const page = numbered(items.map(raw => toCommit(origin, repoRef, raw, webUrl)), index, size)
    const ignored = (['path', 'author'] as const).filter(key => query[key] !== undefined)
    return ignored.length && !index
      ? {
          ...page,
          warnings: [
            { code: 'filter_unsupported', message: `Radicle does not filter commits by ${ignored.join(', ')}; those filters were ignored` },
          ],
        }
      : page
  }

  async function compare(repoRef: RepoRef, base: string, head: string, options: CompareOptions = {}): Promise<Comparison> {
    const [baseSha, headSha] = await Promise.all([
      shaOf(repoRef, base, options.signal),
      shaOf(repoRef, head, options.signal),
    ])
    const raw = await json<RadicleComparison>(`${repoPath(repoRef)}/diff/${baseSha}/${headSha}`, undefined, options.signal)
    const commits = raw.commits.map(commit => toCommit(origin, repoRef, commit, webUrl))
    return {
      base: baseSha,
      head: headSha,
      aheadBy: commits.length,
      commits: options.commitLimit === undefined
        ? commits
        : commits.slice(0, options.commitLimit),
      files: options.files === false
        ? []
        : raw.diff.files.map(toChangedFile),
      raw,
    }
  }

  return {
    traits: {
      eventKinds: 'native',
      authKinds: ['anonymous'],
    },
    notApplicable: [
      'users.sponsorable',
      'users.sponsorableMany',
      'repos.milestones',
      'threads.setMilestone',
      'repos.issueTypes',
      'threads.setIssueType',
      'repos.templates',
      'webhooks.ingest',
    ],
    repos: {
      get: verb(true, async (ref, options) => toRepo(origin, await repo(ref, options?.signal), webUrl)),
      listPage: verb(false, async () => ({ items: [] })),
      byOwnerPage: verb(true, byOwnerPage),
    },
    threads: {
      get: perKind({ issue: true, pull_request: true }, get),
      listPage: perKind({ issue: true, pull_request: true }, listPage),
      getMany: verb(true, (refs, options) => getManyConcurrently(refs, get, options)),
      eventsPage: verb(false, async () => ({ items: [] })),
      commentsPage: perKind({ issue: true, pull_request: true }, commentsPage),
      reviewsPage: verb(true, reviewsPage),
      filesPage: verb(true, async (thread, listOptions: PageOptions = {}) => {
        const { comparison } = await revisionDiff(thread, listOptions.signal)
        return {
          items: comparison.diff.files.map(toChangedFile),
        }
      }),
      commitsPage: verb(true, async (thread, listOptions: PageOptions = {}) => {
        const { ref, comparison } = await revisionDiff(thread, listOptions.signal)
        return {
          items: comparison.commits.map(commit => toCommit(origin, ref.repo, commit, webUrl)),
        }
      }),
    },
    contents: {
      getFile: verb(true, blob),
      treePage: verb(true, treePage),
      resolveRef: verb(true, (repoRef, ref, options) => shaOf(repoRef, ref, options?.signal)),
      compare: verb(true, compare),
      branchesPage: verb(true, async (repoRef, options) => ({ items: (await canonical(repoRef, options?.signal)).branches })),
      tagsPage: verb(true, async (repoRef, options) => ({ items: (await canonical(repoRef, options?.signal)).tags })),
    },
    commits: {
      listPage: verb(true, commitsPage),
      get: verb(true, async ({ repo: repoRef, sha }, options) => {
        const raw = await json<RadicleCommitDetail>(`${repoPath(repoRef)}/commits/${await shaOf(repoRef, sha, options?.signal)}`, undefined, options?.signal)
        return toCommit(origin, repoRef, raw.commit, webUrl, raw.diff.files.map(toChangedFile))
      }),
    },
    search: {
      reposPage: verb(true, searchReposPage),
    },
    web,
    webhooks: {},
    scopes: radicleScopesFor,
  }
}

const RADICLE: ProviderDefinition<RadicleOptions, undefined, true> = {
  forge: FORGE,
  hasWeb: true,
  experimental: true,
  anonymous: true,
  baseUrl: 'https://seed.radicle.dev',
  apiPath: '/api/v1',
  setup: setupRadicle,
}

/**
 * Creates a Radicle provider that reads one seed node. A repository's id goes in `name`.
 * @example
 * ```ts
 * const forge = radicle()
 * const repo = await forge.repos.get({
 *   forge: 'radicle',
 *   instance: forge.instance,
 *   owner: 'rad',
 *   name: 'z3gqcJUoA1n9HaHKufZs5FCSGazv5',
 * })
 * ```
 */
export const radicle: ProviderFactoryFunction<RadicleOptions, true, 'radicle'> = /* @__PURE__ */ defineForgeProvider(RADICLE)

/** Scope requirements for a Radicle operation. */
function radicleScopesFor(_verb: ForgeVerb): VerbScopes {
  return { note: 'A seed node serves public repositories without credentials' }
}
