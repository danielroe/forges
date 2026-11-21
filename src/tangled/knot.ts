import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher } from '../fetch.ts'
import type {
  Branch,
  ChangedFile,
  Commit,
  CommitQuery,
  Comparison,
  FileOptions,
  ForgeWarning,
  Page,
  PageOptions,
  RepoRef,
  Tag,
  TreeEntry,
  TreeEntryType,
  TreeOptions,
} from '../model.ts'
import type { PatchCommit } from './patch.ts'
import type { RepoHandle } from './records.ts'
import { toFileContent } from '../contents.ts'
import { NotFoundError } from '../errors.ts'
import { toDate } from '../utils.ts'
import { FORGE } from './normalise.ts'
import { parsePatch, patchCommits, patchFiles } from './patch.ts'
import { xrpcPath } from './records.ts'
import { repoPath } from './web.ts'

/** The DID of the service at `host`, as atproto service auth names it. */
export function serviceDidForHost(hostOrUrl: string): string {
  const host = new URL(/^https?:\/\//.test(hostOrUrl)
    ? hostOrUrl
    : `https://${hostOrUrl}`).host
  return `did:web:${host.replace(/:/g, '%3A')}`
}

/** The oid of git's empty tree, for the commit whose parent would be the empty one. */
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'

const TREE_TYPES: Record<string, TreeEntryType> = {
  '0040000': 'directory',
  '0120000': 'symlink',
  '0160000': 'submodule',
}

const DEFAULT_PAGE = 30

interface MirrorSignature {
  name: string
  email: string
  when: string
}

interface MirrorCommit {
  oid: string
  parents: string[]
  tree: string
  author: MirrorSignature
  committer: MirrorSignature
  message: string
  stat?: { insertions: number, deletions: number, filesChanged: number }
}

interface MirrorTreeEntry {
  name: string
  mode: string
  size: number
  lastCommit?: {
    hash: string
    message: string
    when: string
    author?: MirrorSignature
  }
}

interface MirrorList {
  cursor?: string
  total?: number
}

interface KnotDeps {
  instance: string
  webUrl: string
  context: ForgeErrorContext
  /** The origin of the index, whose mirror serves the git reads. */
  apiUrl: string
  fetcher: Fetcher
  repoFor: (repo: RepoRef, signal?: AbortSignal) => Promise<RepoHandle>
  /** Mints a token that lets the signed-in account call an XRPC method on an audience. */
  serviceAuth: (aud: string, lxm: string, signal?: AbortSignal) => Promise<string>
}

function signature(signature: MirrorSignature) {
  return {
    name: signature.name,
    email: signature.email,
    date: toDate(signature.when),
  }
}

function offsetOf(options: PageOptions): number {
  const offset = Number(options.cursor?.token ?? 0)
  return Number.isInteger(offset) && offset > 0
    ? offset
    : 0
}

/** Offset pagination, as the mirror pages commits. */
function offsetPage<T>(items: T[], offset: number, limit: number): Pick<Page<T>, 'items' | 'cursor'> {
  return {
    items,
    cursor: items.length >= limit
      ? {
          token: String(offset + items.length),
        }
      : undefined,
  }
}

function fileStats(files: ChangedFile[]) {
  return files.reduce((stats, file) => ({
    additions: stats.additions + (file.additions ?? 0),
    deletions: stats.deletions + (file.deletions ?? 0),
  }), { additions: 0, deletions: 0 })
}

export type TangledContents = ReturnType<typeof createTangledContents>

/** Reads git contents from the index's mirror of each repository's knot. */
export function createTangledContents({ instance, webUrl, context, apiUrl, fetcher, repoFor, serviceAuth }: KnotDeps) {
  async function query<T>(nsid: string, params: Record<string, string | number | boolean | readonly string[] | undefined>, signal?: AbortSignal): Promise<T> {
    return (await fetcher.json<T>(`${apiUrl}${xrpcPath(nsid, params)}`, { signal })).data
  }

  /** Calls a procedure of the index's mirror as the signed-in account, with a token the repository's knot accepts. */
  async function mirrorCall(repo: RepoHandle, nsid: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const token = await serviceAuth(serviceDidForHost(repo.knot), 'org.tangled.git.receivePack', signal)
    await fetcher.raw(`${apiUrl}/xrpc/${nsid}`, {
      method: 'POST',
      json: input,
      headers: { authorization: `Bearer ${token}` },
      signal,
    })
  }

  /** Calls a procedure of the repository's knot, with a token for the repository itself. */
  async function knotCall<T>(repo: RepoHandle, nsid: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = await serviceAuth(repo.did, nsid, signal)
    return (await fetcher.json<T>(`${repo.knot}/xrpc/${nsid}`, {
      method: 'POST',
      json: { repo: repo.did, ...input },
      headers: { authorization: `Bearer ${token}` },
      signal,
    })).data
  }

  function pageUrl(repo: RepoRef, section: string, ref: string | undefined, path: string): string {
    return `${webUrl}${repoPath(repo)}/${section}/${encodeURIComponent(ref ?? 'HEAD')}/${path.split('/').map(encodeURIComponent).join('/')}`
  }

  function toCommit(repo: RepoRef, commit: MirrorCommit, files?: ChangedFile[]): Commit {
    const stats = files
      ? fileStats(files)
      : commit.stat
        ? {
            additions: commit.stat.insertions,
            deletions: commit.stat.deletions,
            ...commit.stat.filesChanged !== undefined
              ? { total: commit.stat.filesChanged }
              : {},
          }
        : undefined
    return {
      ref: {
        forge: FORGE,
        instance,
        repo,
        sha: commit.oid,
      },
      sha: commit.oid,
      message: commit.message,
      author: commit.author && signature(commit.author),
      committer: commit.committer && signature(commit.committer),
      parents: commit.parents ?? [],
      url: `${webUrl}${repoPath(repo)}/commit/${commit.oid}`,
      ...files
        ? { files }
        : {},
      ...stats
        ? { stats }
        : {},
      raw: commit,
    }
  }

  /** The commits and files of a `format-patch` series; a bare diff has no commit headers. */
  function fromFormatPatch(repo: RepoRef, text: string): { commits: PatchCommit[], files: ChangedFile[] } {
    const commits = parsePatch(text)
    return {
      commits,
      files: patchFiles(commits).items,
    }
  }

  async function defaultBranch(repo: RepoRef, signal?: AbortSignal): Promise<string | undefined> {
    const { view } = await repoFor(repo, signal)
    return view.defaultBranch ?? view.git?.defaultBranch
  }

  async function file(repo: RepoRef, path: string, options: FileOptions = {}) {
    const handle = await repoFor(repo, options.signal)
    const entry = await query<{ name: string, mode: string, size: number }>('org.tangled.temp.git.getEntry', {
      repo: handle.did,
      ref: options.ref,
      path,
    }, options.signal)
    if (TREE_TYPES[entry.mode] === 'submodule') {
      throw new NotFoundError(`${path} is a submodule, not a file`, 404, '', context)
    }
    const response = await fetcher.raw(`${apiUrl}${xrpcPath('org.tangled.temp.git.getBlob', {
      repo: handle.did,
      ref: options.ref,
      path,
    })}`, { signal: options.signal })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (options.as !== 'binary' && bytes.subarray(0, 8000).includes(0)) {
      throw new NotFoundError(`${path} is a binary file`, 404, '', context)
    }
    return toFileContent(bytes, {
      path,
      size: entry.size,
      url: pageUrl(handle.ref, 'blob', options.ref, path),
    }, options, context)
  }

  async function treePage(repo: RepoRef, options: TreeOptions = {}): Promise<Page<TreeEntry>> {
    const handle = await repoFor(repo, options.signal)
    const parent = options.path?.replace(/^\/|\/$/g, '') ?? ''
    const data = await query<{ entries?: MirrorTreeEntry[] | null }>('org.tangled.temp.git.getTree', {
      repo: handle.did,
      ref: options.ref,
      path: parent || undefined,
    }, options.signal)
    const items = (data.entries ?? []).map((entry): TreeEntry => {
      const path = parent
        ? `${parent}/${entry.name}`
        : entry.name
      const type = TREE_TYPES[entry.mode] ?? 'file'
      return {
        path,
        type,
        size: type === 'file'
          ? entry.size
          : undefined,
        mode: entry.mode.replace(/^0+(?=\d{6}$)/, ''),
        url: pageUrl(handle.ref, type === 'directory'
          ? 'tree'
          : 'blob', options.ref, path),
      }
    })
    const warnings: ForgeWarning[] = options.recursive
      ? [
          { code: 'recursive_unsupported', message: 'The mirror lists one level of a tree; read subdirectories separately' },
        ]
      : []
    return warnings.length
      ? { items, warnings }
      : { items }
  }

  async function branchesPage(repo: RepoRef, options: PageOptions = {}): Promise<Page<Branch>> {
    const handle = await repoFor(repo, options.signal)
    const offset = offsetOf(options)
    const limit = Math.min(options.perPage ?? DEFAULT_PAGE, 100)
    const data = await query<MirrorList & { branches?: Array<{ name: string, oid: string }>, defaultBranch?: string }>('org.tangled.temp.git.listBranches', {
      repo: handle.did,
      limit,
      cursor: offset ? undefined : options.cursor?.token,
    }, options.signal)
    const items = (data.branches ?? []).map(branch => ({
      name: branch.name,
      sha: branch.oid,
      isDefault: branch.name === data.defaultBranch,
      url: `${webUrl}${repoPath(handle.ref)}/tree/${encodeURIComponent(branch.name)}`,
      raw: branch,
    }))
    return offset
      ? offsetPage(items, offset, limit)
      : {
          items,
          cursor: data.cursor && items.length >= limit
            ? { token: data.cursor }
            : undefined,
          ...data.total !== undefined
            ? { total: data.total }
            : {},
        }
  }

  async function tagsPage(repo: RepoRef, options: PageOptions = {}): Promise<Page<Tag>> {
    const handle = await repoFor(repo, options.signal)
    const offset = offsetOf(options)
    const limit = Math.min(options.perPage ?? DEFAULT_PAGE, 100)
    const data = await query<MirrorList & { tags?: Array<{ name: string, oid: string }> }>('org.tangled.temp.git.listTags', {
      repo: handle.did,
      limit,
      cursor: offset ? undefined : options.cursor?.token,
    }, options.signal)
    const items = (data.tags ?? []).map(tag => ({
      name: tag.name,
      sha: tag.oid,
      url: `${webUrl}${repoPath(handle.ref)}/tree/${encodeURIComponent(tag.name)}`,
      raw: tag,
    }))
    return offset
      ? offsetPage(items, offset, limit)
      : {
          items,
          cursor: data.cursor && items.length >= limit
            ? { token: data.cursor }
            : undefined,
          ...data.total !== undefined
            ? { total: data.total }
            : {},
        }
  }

  async function resolveRef(repo: RepoRef, ref: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const { did } = await repoFor(repo, options.signal)
    const data = await query<{ commits?: MirrorCommit[] }>('org.tangled.temp.git.listCommitsByRef', {
      repo: did,
      ranges: [ref],
      limit: 1,
    }, options.signal)
    const commit = data.commits?.[0]
    if (!commit) {
      throw new NotFoundError(`No commit at ${ref}`, 404, '', context)
    }
    return commit.oid
  }

  async function commitsPage(repo: RepoRef, commitQuery: CommitQuery = {}): Promise<Page<Commit>> {
    const { did, ref } = await repoFor(repo, commitQuery.signal)
    const offset = offsetOf(commitQuery)
    const limit = Math.min(commitQuery.perPage ?? DEFAULT_PAGE, 100)
    const data = await query<{ commits?: MirrorCommit[] }>('org.tangled.temp.git.listCommitsByRef', {
      repo: did,
      ranges: [commitQuery.ref ?? await defaultBranch(repo, commitQuery.signal) ?? 'HEAD'],
      skip: offset || undefined,
      limit,
      path: commitQuery.path,
      includeStats: true,
    }, commitQuery.signal)
    const page = offsetPage((data.commits ?? []).map(commit => toCommit(ref, commit)), offset, limit)
    const ignored = (['author', 'since', 'until'] as const).filter(key => commitQuery[key] !== undefined)
    return ignored.length && !offset
      ? {
          ...page,
          warnings: [
            { code: 'filter_unsupported', message: `The mirror does not filter commits by ${ignored.join(', ')}; those filters were ignored` },
          ],
        }
      : page
  }

  /** The `format-patch` of the range, which the mirror streams. */
  async function rangeText(repo: RepoRef, from: string, to: string, signal?: AbortSignal): Promise<string> {
    const { did } = await repoFor(repo, signal)
    const response = await fetcher.raw(`${apiUrl}${xrpcPath('org.tangled.temp.git.formatPatch', { repo: did, from, to })}`, { signal })
    return response.text()
  }

  async function commit(repo: RepoRef, sha: string, options: { signal?: AbortSignal } = {}): Promise<Commit> {
    const { did, ref } = await repoFor(repo, options.signal)
    const data = await query<{ commits?: MirrorCommit[] }>('org.tangled.temp.git.listCommitsByRef', {
      repo: did,
      ranges: [sha],
      limit: 1,
      includeStats: true,
    }, options.signal)
    const found = data.commits?.[0]
    if (!found) {
      throw new NotFoundError(`No commit ${sha}`, 404, '', context)
    }
    const base = found.parents[0] ?? (sha.length === 64
      ? EMPTY_TREE_SHA256
      : EMPTY_TREE_SHA1)
    const files = fromFormatPatch(ref, await rangeText(repo, base, sha, options.signal)).files
    return toCommit(ref, found, files)
  }

  async function compare(repo: RepoRef, base: string, head: string, options: { signal?: AbortSignal } = {}): Promise<Comparison> {
    const { did, ref } = await repoFor(repo, options.signal)
    const [baseOid, headOid] = await Promise.all([
      resolveRef(repo, base, options),
      resolveRef(repo, head, options),
    ])
    const [text, merge] = await Promise.all([
      rangeText(repo, baseOid, headOid, options.signal),
      query<{ commit?: string }>('org.tangled.temp.git.getMergeBase', {
        repos: [did],
        base: baseOid,
        head: headOid,
      }, options.signal),
    ])
    const { commits, files } = fromFormatPatch(ref, text)
    return {
      base,
      head,
      aheadBy: commits.filter(commit => commit.sha).length,
      commits: patchCommits(commits, { forge: FORGE, instance, repo: ref }),
      files,
      mergeBaseSha: merge.commit || undefined,
      raw: { base: baseOid, head: headOid },
    }
  }

  /** The commits and files of a pull's round, from the range its patch record names. */
  async function diffOf(repo: RepoRef, base: string, head: string, signal?: AbortSignal) {
    const { ref } = await repoFor(repo, signal)
    const { commits, files } = fromFormatPatch(ref, await rangeText(repo, base, head, signal))
    return {
      repo: ref,
      commits: patchCommits(commits, { forge: FORGE, instance, repo: ref }),
      files,
    }
  }

  /** The commit two revisions share, which a pull request ranges from. */
  async function mergeBaseOf(repo: RepoRef, base: string, head: string, signal?: AbortSignal): Promise<string | undefined> {
    const { did } = await repoFor(repo, signal)
    return (await query<{ commit?: string }>('org.tangled.temp.git.getMergeBase', {
      repos: [did],
      base,
      head,
    }, signal)).commit
  }

  /** Merges the pull's head commit onto its target branch through the mirror. */
  async function merge(repo: RepoRef, branch: string, headOid: string, { style, message, signal }: { style: 'merge' | 'rebase', message?: string, signal?: AbortSignal }): Promise<void> {
    const handle = await repoFor(repo, signal)
    const target = await query<{ oid: string }>('org.tangled.temp.git.getRef', {
      repo: handle.did,
      ref: `refs/heads/${branch}`,
    }, signal)
    await mirrorCall(handle, 'sh.tangled.git.mergeCommit', {
      target: { repo: handle.did, branch, commit: target.oid },
      source: { repo: handle.did, commit: headOid },
      style,
      ...style === 'merge' && message
        ? {
            mergeCommit: { message },
          }
        : {},
    }, signal)
  }

  /** Adds a collaborator, written as a record on the repository's knot. */
  async function addCollaborator(repo: RepoRef, subject: string, signal?: AbortSignal): Promise<void> {
    const handle = await repoFor(repo, signal)
    await knotCall(handle, 'com.atproto.repo.createRecord', {
      collection: 'org.tangled.graph.collaborator',
      rkey: subject,
      record: {
        $type: 'org.tangled.graph.collaborator',
        createdAt: new Date().toISOString(),
      },
    }, signal)
  }

  return {
    defaultBranch,
    file,
    treePage,
    branchesPage,
    tagsPage,
    resolveRef,
    commitsPage,
    commit,
    compare,
    mergeBaseOf,
    diffOf,
    merge,
    addCollaborator,
  }
}
