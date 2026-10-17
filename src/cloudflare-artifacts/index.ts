import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { BaseOptions, ChangedFile, Commit, CommitQuery, FileContent, FileOptions, OwnerRepoQuery, Page, Repo, RepoQuery, RepoRef, TreeEntry, TreeOptions } from '../model.ts'
import type { ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { ArtifactsCommit, ArtifactsEnvelope, ArtifactsNamespace, ArtifactsRepository, ArtifactsTreeEntry } from './types.ts'
import { isSha, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { ForgeError, NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { mapConcurrent, rateLimitPart, resolveToken } from '../utils.ts'
import { FORGE, toCommit, toRepo, toTreeType } from './normalise.ts'

/** A Cloudflare API token with **Artifacts** > **Read**, sent as `Authorization: Bearer`. */
export type CloudflareArtifactsAuth = TokenAuth

/** Options for `cloudflareArtifacts()`. */
export interface CloudflareArtifactsOptions extends ForgeOptionsBase {
  /** How to authenticate. Artifacts has no anonymous reads. */
  auth: CloudflareArtifactsAuth
  /** The account that holds the namespaces. Its Git host is the instance of every ref. */
  accountId: string
  /**
   * The Cloudflare API root. `/client/v4` is appended.
   * @default https://api.cloudflare.com
   */
  baseUrl?: string
}

const DEFAULT_PAGE = 30
/** The repository listing takes at most 200 a page. */
const MAX_REPOS = 200
/** Tree reads in flight while comparing the trees of a commit. */
const TREE_READS = 8
const SORTS = { created: 'created_at', updated: 'updated_at', pushed: 'last_push_at', name: 'name' } as const

/** Where the listing resumes: inside a namespace, or at the cursor of the next one. */
type ListState = { namespace: string, next?: string, repos?: string } | { after: string }

/** A whole page size above zero, or the default, so `0` or `NaN` can't stall the listing. */
function pageSize(perPage: number | undefined, max = Number.POSITIVE_INFINITY): number {
  return perPage !== undefined && Number.isInteger(perPage) && perPage > 0 ? Math.min(perPage, max) : DEFAULT_PAGE
}

function offsetOf(cursor: { token?: string } | undefined): number {
  const offset = Number(cursor?.token ?? 0)
  return Number.isInteger(offset) && offset > 0 ? offset : 0
}

/** Artifacts finds a branch or tag by its short name, and nothing for `HEAD` or `refs/heads/x`. */
function logRef(ref: string | undefined): string | undefined {
  return ref === 'HEAD' ? undefined : ref?.replace(/^refs\/(?:heads|tags)\//, '')
}

function setupArtifacts({ options, origin, fetcher }: ProviderContext<CloudflareArtifactsOptions, undefined>): ProviderSpec {
  const root = `/accounts/${encodeURIComponent(options.accountId)}/artifacts/namespaces`
  const namespacePath = (namespace: string) => `${root}/${encodeURIComponent(namespace)}`
  const repoPath = (repo: RepoRef) => `${namespacePath(repo.owner)}/repos/${encodeURIComponent(repo.name)}`

  async function result<T>(path: string, query?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<ArtifactsEnvelope<T>> {
    return (await fetcher.json<ArtifactsEnvelope<T>>(path, { query, signal })).data
  }

  const listsNothing = (query: RepoQuery) => query.visibility !== undefined && query.visibility !== 'all' && query.visibility !== 'private'

  async function reposIn(namespace: string, query: RepoQuery & OwnerRepoQuery, cursor?: string): Promise<Page<Repo>> {
    if (listsNothing(query)) {
      return { items: [] }
    }
    const { data: { result: items, result_info }, response } = await fetcher.json<ArtifactsEnvelope<ArtifactsRepository[]>>(`${namespacePath(namespace)}/repos`, {
      query: {
        limit: pageSize(query.perPage, MAX_REPOS),
        cursor,
        sort: query.sort && SORTS[query.sort],
        direction: query.direction,
      },
      signal: query.signal,
    })
    return { items: items.map(raw => toRepo(origin, namespace, raw)), cursor: result_info?.cursor ? { token: result_info.cursor } : undefined, ...rateLimitPart(response) }
  }

  /** A cursor that `listRepos()` returned, or a `ForgeError` for one from anywhere else. */
  function listState(token: string): ListState {
    let state: unknown
    try {
      state = JSON.parse(token)
    }
    catch {}
    const fields = state as Partial<Record<'namespace' | 'after', unknown>> | null | undefined
    if (typeof fields?.namespace === 'string' || typeof fields?.after === 'string') {
      return state as ListState
    }
    throw new ForgeError('The cursor did not come from repos.list() on Cloudflare Artifacts', origin)
  }

  /** One namespace at a time, so a page holds the repositories of one namespace. */
  async function listRepos(query: RepoQuery = {}): Promise<Page<Repo>> {
    if (listsNothing(query) || (query.affiliation && !query.affiliation.includes('owner'))) {
      return { items: [] }
    }
    const state = query.cursor?.token ? listState(query.cursor.token) : undefined
    let current = state && 'namespace' in state ? state : undefined
    if (!current) {
      const { result: [first], result_info } = await result<ArtifactsNamespace[]>(root, { limit: 1, cursor: state && 'after' in state ? state.after : undefined }, query.signal)
      if (!first) {
        return { items: [] }
      }
      current = { namespace: first.namespace, next: result_info?.cursor }
    }
    const page = await reposIn(current.namespace, query, current.repos)
    const next: ListState | undefined = page.cursor?.token
      ? { namespace: current.namespace, next: current.next, repos: page.cursor.token }
      : current.next ? { after: current.next } : undefined
    return { items: page.items, cursor: next && { token: JSON.stringify(next) }, ...rateLimitPart(page) }
  }

  async function log(repo: RepoRef, ref: string | undefined, offset: number, limit: number, signal?: AbortSignal): Promise<ArtifactsCommit[]> {
    return (await result<ArtifactsCommit[]>(`${repoPath(repo)}/log`, { ref: logRef(ref), offset: offset || undefined, limit }, signal)).result
  }

  /** A full sha is read as it is. A branch, a tag or no ref at all goes through the log. */
  async function commitAt(repo: RepoRef, ref: string | undefined, signal?: AbortSignal): Promise<ArtifactsCommit> {
    if (ref && isSha(ref)) {
      return (await result<ArtifactsCommit>(`${repoPath(repo)}/commit/${ref}`, undefined, signal)).result
    }
    const [commit] = await log(repo, ref, 0, 1, signal)
    if (!commit) {
      throw new NotFoundError(`No commit at ${ref ?? 'the default branch'} in ${repo.owner}/${repo.name}`, 404, '', origin)
    }
    return commit
  }

  async function readTree(repo: RepoRef, hash: string, signal?: AbortSignal): Promise<ArtifactsTreeEntry[]> {
    return (await result<ArtifactsTreeEntry[]>(`${repoPath(repo)}/tree/${hash}`, undefined, signal)).result
  }

  /** Follows `path` down from the root tree, one request per directory. */
  async function treeAt(repo: RepoRef, rootHash: string, path: string, signal?: AbortSignal): Promise<ArtifactsTreeEntry[]> {
    let entries = await readTree(repo, rootHash, signal)
    for (const segment of path ? path.split('/') : []) {
      const entry = entries.find(candidate => candidate.name === segment)
      if (entry?.type !== 'tree') {
        throw new NotFoundError(`No directory ${path} in ${repo.owner}/${repo.name}`, 404, '', origin)
      }
      entries = await readTree(repo, entry.hash, signal)
    }
    return entries
  }

  /** What a commit changed against its first parent. Only changed directories are read. */
  async function changedFiles(repo: RepoRef, beforeRoot: string | undefined, afterRoot: string, signal?: AbortSignal): Promise<Array<ChangedFile & { before?: string }>> {
    const files: Array<ChangedFile & { before?: string }> = []
    let level = [{ before: beforeRoot, after: afterRoot as string | undefined, prefix: '' }]
    while (level.length) {
      const read = await mapConcurrent(level, TREE_READS, async ({ before, after, prefix }) => {
        const [old, current] = await Promise.all([before ? readTree(repo, before, signal) : [], after ? readTree(repo, after, signal) : []])
        return { old, current, prefix }
      })
      level = []
      for (const { old, current, prefix } of read) {
        for (const name of new Set([...old, ...current].map(entry => entry.name))) {
          const was = old.find(entry => entry.name === name)
          const is = current.find(entry => entry.name === name)
          if (was?.hash === is?.hash && was?.mode === is?.mode) {
            continue
          }
          const path = `${prefix}${name}`
          if (was?.type === 'tree' || is?.type === 'tree') {
            level.push({ before: was?.type === 'tree' ? was.hash : undefined, after: is?.type === 'tree' ? is.hash : undefined, prefix: `${path}/` })
          }
          const blobBefore = was && was.type !== 'tree' ? was.hash : undefined
          const blobAfter = is && is.type !== 'tree' ? is.hash : undefined
          if (blobBefore || blobAfter) {
            const status = !blobBefore ? 'added' : !blobAfter ? 'removed' : blobBefore === blobAfter ? 'changed' : 'modified'
            files.push({ path, status, ...blobAfter ? { sha: blobAfter } : {}, before: blobBefore })
          }
        }
      }
    }
    return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  }

  /** Pairs a removed and an added file with the same blob, as Git does for an unedited rename. */
  function withRenames(files: Array<ChangedFile & { before?: string }>): ChangedFile[] {
    const removedByBlob = new Map<string, string[]>()
    for (const file of files) {
      if (file.status === 'removed' && file.before) {
        removedByBlob.set(file.before, [...removedByBlob.get(file.before) ?? [], file.path])
      }
    }
    const renamedFrom = new Set<string>()
    const result = files.map(({ before: _before, ...file }): ChangedFile => {
      const previousPath = file.status === 'added' && file.sha ? removedByBlob.get(file.sha)?.shift() : undefined
      if (!previousPath) {
        return file
      }
      renamedFrom.add(previousPath)
      return { ...file, status: 'renamed', previousPath }
    })
    return result.filter(file => file.status !== 'removed' || !renamedFrom.has(file.path))
  }

  async function file(repo: RepoRef, path: string, fileOptions: FileOptions = {}): Promise<FileContent> {
    const ref = logRef(fileOptions.ref) ?? (await commitAt(repo, undefined, fileOptions.signal)).hash
    const response = await fetcher.raw(`${repoPath(repo)}/file`, { query: { ref, path }, signal: fileOptions.signal })
    const bytes = new Uint8Array(await response.arrayBuffer())
    return toFileContent(bytes, { path, size: bytes.length }, fileOptions, origin)
  }

  async function treePage(repo: RepoRef, treeOptions: TreeOptions = {}): Promise<Page<TreeEntry>> {
    const parent = treeOptions.path?.replace(/^\/|\/$/g, '') ?? ''
    const commit = await commitAt(repo, treeOptions.ref, treeOptions.signal)
    const items = (await treeAt(repo, commit.treeHash, parent, treeOptions.signal)).map((entry): TreeEntry => ({
      path: parent ? `${parent}/${entry.name}` : entry.name,
      type: toTreeType(entry),
      sha: entry.hash,
      mode: entry.mode.padStart(6, '0'),
    }))
    return treeOptions.recursive ? { items, warnings: [{ code: 'recursive_unsupported', message: 'Artifacts lists one level of a tree; read subdirectories separately' }] } : { items }
  }

  async function commitsPage(repo: RepoRef, query: CommitQuery = {}): Promise<Page<Commit>> {
    const offset = offsetOf(query.cursor)
    const limit = pageSize(query.perPage)
    const commits = await log(repo, query.ref, offset, limit + 1, query.signal)
    const page: Page<Commit> = {
      items: commits.slice(0, limit).map(raw => toCommit(origin, repo, raw)),
      cursor: commits.length > limit ? { token: String(offset + limit) } : undefined,
    }
    const ignored = (['path', 'author', 'since', 'until'] as const).filter(key => query[key] !== undefined)
    return ignored.length && !offset
      ? { ...page, warnings: [{ code: 'filter_unsupported', message: `Artifacts does not filter commits by ${ignored.join(', ')}; those filters were ignored` }] }
      : page
  }

  /** The tree of a parent, or `undefined` when a shallow import left the parent out. */
  async function parentTree(repo: RepoRef, sha: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return (await commitAt(repo, sha, signal)).treeHash
    }
    catch (error) {
      if (error instanceof NotFoundError) {
        return undefined
      }
      throw error
    }
  }

  async function commit(repo: RepoRef, sha: string, commitOptions: BaseOptions = {}): Promise<Commit> {
    const raw = await commitAt(repo, sha, commitOptions.signal)
    const [first] = raw.parents
    const before = first === undefined ? undefined : await parentTree(repo, first, commitOptions.signal)
    const files = first !== undefined && !before ? undefined : withRenames(await changedFiles(repo, before, raw.treeHash, commitOptions.signal))
    return toCommit(origin, repo, raw, files)
  }

  /** Core marks every thread verb unsupported, so this never runs. */
  async function noThreads(): Promise<never> {
    throw new UnsupportedOperationError('Cloudflare Artifacts has no issues or pull requests', origin)
  }

  return {
    traits: {
      eventKinds: 'native',
      authKinds: ['token'],
    },
    repos: {
      get: verb(true, async (repo, getOptions) => toRepo(origin, repo.owner, (await result<ArtifactsRepository>(repoPath(repo), undefined, getOptions?.signal)).result)),
      listPage: verb(true, listRepos),
      byOwnerPage: verb(true, (owner, query = {}) => reposIn(owner.owner, query, query.cursor?.token)),
    },
    threads: {
      get: perKind({}, noThreads),
      listPage: perKind({}, noThreads),
      getMany: verb(false, noThreads),
      eventsPage: verb(false, noThreads),
      commentsPage: perKind({}, noThreads),
    },
    contents: {
      getFile: verb(true, file),
      treePage: verb(true, treePage),
      resolveRef: verb(true, async (repo, ref, resolveOptions) => (await commitAt(repo, ref, resolveOptions?.signal)).hash),
    },
    commits: {
      listPage: verb(true, commitsPage),
      get: verb(true, ({ repo, sha }, options) => commit(repo, sha, options)),
    },
    webhooks: {},
    scopes: cloudflareArtifactsScopesFor,
  }
}

const CLOUDFLARE_ARTIFACTS: ProviderDefinition<CloudflareArtifactsOptions, undefined, false> = {
  forge: FORGE,
  hasWeb: false,
  experimental: true,
  baseUrl: 'https://api.cloudflare.com',
  apiPath: '/client/v4',
  authHeaders: ({ options: { auth } }) => async () => ({ authorization: `Bearer ${await resolveToken(auth)}` }),
  setup: setupArtifacts,
}

const define = /* @__PURE__ */ defineForgeProvider<CloudflareArtifactsOptions, undefined, false, 'cloudflare-artifacts'>(CLOUDFLARE_ARTIFACTS)

/**
 * Creates a Cloudflare Artifacts provider for one account. A ref's instance is the
 * account's Git host, `<accountId>.artifacts.cloudflare.net`, and its owner a namespace.
 */
export const cloudflareArtifacts: ProviderFactoryFunction<CloudflareArtifactsOptions, false, 'cloudflare-artifacts'> = options =>
  define({ ...options, instance: options.instance ?? `${options.accountId}.artifacts.cloudflare.net` })

/** Scope requirements for a Cloudflare Artifacts operation. */
export function cloudflareArtifactsScopesFor(_verb: ForgeVerb): VerbScopes {
  return { permissions: { Artifacts: 'read' }, note: 'A Cloudflare API token with Artifacts > Read, which covers every read' }
}
