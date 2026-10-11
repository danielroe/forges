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
import type {
  KnotBlob,
  KnotBranch,
  KnotCommit,
  KnotDiffFile,
  KnotHash,
  KnotPatchFile,
  KnotPatchHeader,
  KnotTag,
  KnotTextFragment,
  KnotTreeEntry,
  RecordResponse,
  RepoRecord,
} from './types.ts'
import { fromBase64, toFileContent } from '../contents.ts'
import { NotFoundError, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { toDate } from '../utils.ts'
import { FORGE } from './normalise.ts'

interface KnotDeps {
  fetcher: Fetcher
  instance: string
  webUrl: string
  context: ForgeErrorContext
  canonicalRepo: (repo: RepoRef, signal?: AbortSignal) => Promise<{ ref: RepoRef, record: RecordResponse<RepoRecord> }>
  /** Mints a token that lets the signed-in account call `lxm` on the knot `aud`. */
  serviceAuth?: (aud: string, lxm: string, signal?: AbortSignal) => Promise<string>
}

const DEFAULT_PAGE = 30

const TREE_TYPES: Record<string, TreeEntryType> = {
  '0040000': 'directory',
  '0120000': 'symlink',
  '0160000': 'submodule',
}

function hex(hash: KnotHash | undefined): string {
  if (typeof hash === 'string' || hash === undefined) {
    return hash ?? ''
  }
  return hash.map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function signature({ Name, Email, When }: { Name: string, Email: string, When?: string }) {
  return { name: Name, email: Email, date: toDate(When) }
}

function fragmentPatch(fragments: KnotTextFragment[]): string {
  return fragments.map((fragment) => {
    const header = `@@ -${fragment.OldPosition},${fragment.OldLines} +${fragment.NewPosition},${fragment.NewLines} @@${fragment.Comment ? ` ${fragment.Comment}` : ''}\n`
    return header + (fragment.Lines ?? []).map(line => `${line.Op === 1 ? '-' : line.Op === 2 ? '+' : ' '}${line.Line}`).join('')
  }).join('')
}

function changedFile(file: { oldName: string, newName: string, isNew: boolean, isDelete: boolean, isCopy: boolean, isRename: boolean, isBinary: boolean, sha?: string, fragments?: KnotTextFragment[] | null }): ChangedFile {
  const fragments = file.fragments ?? []
  const status = file.isNew ? 'added' : file.isDelete ? 'removed' : file.isRename ? 'renamed' : file.isCopy ? 'copied' : 'modified'
  return {
    path: file.isDelete ? file.oldName : file.newName,
    previousPath: file.isRename || file.isCopy ? file.oldName : undefined,
    status,
    additions: fragments.reduce((sum, fragment) => sum + fragment.LinesAdded, 0),
    deletions: fragments.reduce((sum, fragment) => sum + fragment.LinesDeleted, 0),
    patch: file.isBinary || !fragments.length ? undefined : fragmentPatch(fragments),
    sha: file.sha || undefined,
    isBinary: file.isBinary || undefined,
  }
}

const fromDiff = (file: KnotDiffFile) => changedFile({ oldName: file.name.old, newName: file.name.new, isNew: file.is_new, isDelete: file.is_delete, isCopy: file.is_copy, isRename: file.is_rename, isBinary: file.is_binary, fragments: file.text_fragments })

const fromPatch = (file: KnotPatchFile) => changedFile({ oldName: file.OldName, newName: file.NewName, isNew: file.IsNew, isDelete: file.IsDelete, isCopy: file.IsCopy, isRename: file.IsRename, isBinary: file.IsBinary, sha: file.NewOIDPrefix, fragments: file.TextFragments })

function stats(files: ChangedFile[]) {
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  return { additions, deletions, total: additions + deletions }
}

/** Offset pagination, as knots page branches, tags and commits. */
function offsetPage<T>(items: T[], offset: number, limit: number): Pick<Page<T>, 'items' | 'cursor'> {
  return { items, cursor: items.length >= limit ? { token: String(offset + items.length) } : undefined }
}

function offsetOf(options: PageOptions): number {
  const offset = Number(options.cursor?.token ?? 0)
  return Number.isInteger(offset) && offset > 0 ? offset : 0
}

export type TangledContents = ReturnType<typeof createTangledContents>

/** Reads git contents from the knot named in each repo record. */
export function createTangledContents({ fetcher, instance, webUrl, context, canonicalRepo, serviceAuth }: KnotDeps) {
  async function knotFor(repo: RepoRef, signal?: AbortSignal) {
    const { ref, record } = await canonicalRepo(repo, signal)
    const { knot, repoDid, name } = record.value
    const origin = /^https?:\/\//.test(knot) ? knot.replace(/\/$/, '') : `https://${knot}`
    return {
      ref: repoDid ? { ...ref, externalId: repoDid } : ref,
      record,
      // Repos without a repo DID are addressed by owner DID and name.
      repo: repoDid ?? `${ref.owner}/${name ?? ref.name}`,
      call: async <T>(nsid: string, query: Record<string, string | number | undefined>) =>
        (await fetcher.json<T>(`${origin}/xrpc/${nsid}`, { query, signal })).data,
      /** Calls a knot procedure as the signed-in account. */
      post: async (nsid: string, json: Record<string, unknown>, mapError?: (error: unknown) => unknown) => {
        const token = await serviceAuth!(`did:web:${encodeURIComponent(new URL(origin).host)}`, nsid, signal)
        await fetcher.raw(`${origin}/xrpc/${nsid}`, { method: 'POST', json, headers: { authorization: `Bearer ${token}` }, mapError, signal })
      },
    }
  }

  const pageUrl = (repo: RepoRef, section: string, ref: string | undefined, path: string) =>
    `${webUrl}/${repo.owner}/${repo.name}/${section}/${encodeURIComponent(ref ?? 'HEAD')}/${path.split('/').map(encodeURIComponent).join('/')}`

  function toCommit(repo: RepoRef, raw: KnotCommit, files?: ChangedFile[]): Commit {
    const sha = raw.this ?? hex(raw.hash)
    return {
      ref: { forge: FORGE, instance, repo, sha },
      sha,
      message: raw.message,
      author: raw.author && signature(raw.author),
      committer: raw.committer && signature(raw.committer),
      parents: (raw.parent_hashes ?? []).map(hex),
      url: `${webUrl}/${repo.owner}/${repo.name}/commit/${sha}`,
      ...files ? { files, stats: stats(files) } : {},
      raw,
    }
  }

  function fromHeader(repo: RepoRef, header: KnotPatchHeader): Commit {
    const files = (header.Files ?? []).map(fromPatch)
    const author = header.Author && { ...signature(header.Author), date: toDate(header.AuthorDate) }
    const committer = header.Committer && { ...signature(header.Committer), date: toDate(header.CommitterDate) }
    return {
      ref: { forge: FORGE, instance, repo, sha: header.SHA },
      sha: header.SHA,
      message: header.Body ? `${header.Title}\n\n${header.Body}` : header.Title,
      author: author || undefined,
      committer: committer || undefined,
      parents: [],
      url: `${webUrl}/${repo.owner}/${repo.name}/commit/${header.SHA}`,
      files,
      stats: stats(files),
      raw: { ...header, Files: undefined },
    }
  }

  return {
    async defaultBranch(repo: RepoRef, signal?: AbortSignal): Promise<string | undefined> {
      const knot = await knotFor(repo, signal)
      return (await knot.call<{ name?: string }>('sh.tangled.repo.getDefaultBranch', { repo: knot.repo })).name || undefined
    },
    async file(repo: RepoRef, path: string, options: FileOptions = {}) {
      const knot = await knotFor(repo, options.signal)
      const blob = await knot.call<KnotBlob>('sh.tangled.repo.blob', { repo: knot.repo, ref: options.ref, path })
      if (blob.submodule || blob.content === undefined) {
        throw new NotFoundError(`${path} is a submodule, not a file`, 404, '', context)
      }
      const bytes = blob.encoding === 'base64' ? fromBase64(blob.content) : new TextEncoder().encode(blob.content)
      return toFileContent(bytes, { path, size: blob.size, url: pageUrl(knot.ref, 'blob', options.ref, path) }, options, context)
    },
    async treePage(repo: RepoRef, options: TreeOptions = {}): Promise<Page<TreeEntry>> {
      const knot = await knotFor(repo, options.signal)
      const parent = options.path?.replace(/^\/|\/$/g, '') ?? ''
      const data = await knot.call<{ files?: KnotTreeEntry[] | null }>('sh.tangled.repo.tree', { repo: knot.repo, ref: options.ref, path: parent || undefined })
      const items = (data.files ?? []).map((entry): TreeEntry => {
        const path = parent ? `${parent}/${entry.name}` : entry.name
        const type = TREE_TYPES[entry.mode] ?? 'file'
        return {
          path,
          type,
          size: type === 'file' ? entry.size : undefined,
          mode: entry.mode.replace(/^0+(?=\d{6}$)/, ''),
          url: pageUrl(knot.ref, type === 'directory' ? 'tree' : 'blob', options.ref, path),
        }
      })
      const warnings: ForgeWarning[] = options.recursive ? [{ code: 'recursive_unsupported', message: 'Knots list one level of a tree; read subdirectories separately' }] : []
      return warnings.length ? { items, warnings } : { items }
    },
    async branchesPage(repo: RepoRef, options: PageOptions = {}): Promise<Page<Branch>> {
      const knot = await knotFor(repo, options.signal)
      const offset = offsetOf(options)
      const limit = Math.min(options.perPage ?? DEFAULT_PAGE, 100)
      const data = await knot.call<{ branches?: KnotBranch[] | null }>('sh.tangled.repo.branches', { repo: knot.repo, limit, cursor: offset || undefined })
      return offsetPage((data.branches ?? []).map(branch => ({
        name: branch.reference.name,
        sha: branch.reference.hash,
        isDefault: branch.is_default ?? false,
        url: `${webUrl}/${knot.ref.owner}/${knot.ref.name}/tree/${encodeURIComponent(branch.reference.name)}`,
        raw: { ...branch, commit: undefined },
      })), offset, limit)
    },
    async tagsPage(repo: RepoRef, options: PageOptions = {}): Promise<Page<Tag>> {
      const knot = await knotFor(repo, options.signal)
      const offset = offsetOf(options)
      const limit = Math.min(options.perPage ?? DEFAULT_PAGE, 100)
      const data = await knot.call<{ tags?: KnotTag[] | null }>('sh.tangled.repo.tags', { repo: knot.repo, limit, cursor: offset || undefined })
      return offsetPage((data.tags ?? []).map(tag => ({
        name: tag.name,
        sha: tag.tag ? hex(tag.tag.Target) : tag.hash,
        url: `${webUrl}/${knot.ref.owner}/${knot.ref.name}/tree/${encodeURIComponent(tag.name)}`,
        raw: tag,
      })), offset, limit)
    },
    async resolveRef(repo: RepoRef, ref: string, options: { signal?: AbortSignal } = {}): Promise<string> {
      const knot = await knotFor(repo, options.signal)
      const data = await knot.call<{ commits?: KnotCommit[] | null }>('sh.tangled.repo.log', { repo: knot.repo, ref, limit: 1 })
      const commit = data.commits?.[0]
      if (!commit) {
        throw new NotFoundError(`No commit at ${ref}`, 404, '', context)
      }
      return commit.this ?? hex(commit.hash)
    },
    async commitsPage(repo: RepoRef, query: CommitQuery = {}): Promise<Page<Commit>> {
      const knot = await knotFor(repo, query.signal)
      const offset = offsetOf(query)
      const limit = query.perPage ?? DEFAULT_PAGE
      const data = await knot.call<{ commits?: KnotCommit[] | null }>('sh.tangled.repo.log', { repo: knot.repo, ref: query.ref, limit, cursor: offset || undefined })
      const page = offsetPage((data.commits ?? []).map(commit => toCommit(knot.ref, commit)), offset, limit)
      const ignored = (['path', 'author', 'since', 'until'] as const).filter(key => query[key] !== undefined)
      return ignored.length && !offset
        ? { ...page, warnings: [{ code: 'filter_unsupported', message: `Knots do not filter commits by ${ignored.join(', ')}; those filters were ignored` }] }
        : page
    },
    async commit(repo: RepoRef, sha: string, options: { signal?: AbortSignal } = {}): Promise<Commit> {
      const knot = await knotFor(repo, options.signal)
      const { diff } = await knot.call<{ diff: { commit: KnotCommit, diff?: KnotDiffFile[] | null } }>('sh.tangled.repo.diff', { repo: knot.repo, ref: sha })
      return toCommit(knot.ref, diff.commit, (diff.diff ?? []).map(fromDiff))
    },
    async compare(repo: RepoRef, base: string, head: string, options: { signal?: AbortSignal } = {}): Promise<Comparison> {
      const knot = await knotFor(repo, options.signal)
      const data = await knot.call<{ rev1: string, rev2: string, merge_base?: string, format_patch?: KnotPatchHeader[] | null, combined_patch?: KnotPatchFile[] | null }>(
        'sh.tangled.repo.compare',
        { repo: knot.repo, rev1: base, rev2: head },
      )
      const commits = (data.format_patch ?? []).map(header => fromHeader(knot.ref, header))
      return {
        base,
        head,
        aheadBy: commits.length,
        commits,
        files: (data.combined_patch ?? []).map(fromPatch),
        mergeBaseSha: data.merge_base || undefined,
        raw: { rev1: data.rev1, rev2: data.rev2, merge_base: data.merge_base },
      }
    },
    /** The `git format-patch` of the commits `head` has and `base` lacks, empty when there are none. */
    async formatPatch(repo: RepoRef, base: string, head: string, signal?: AbortSignal): Promise<string> {
      const knot = await knotFor(repo, signal)
      return (await knot.call<{ patch?: string }>('sh.tangled.repo.compare', { repo: knot.repo, rev1: base, rev2: head })).patch ?? ''
    },
    /** Applies `patch` to `branch` on the knot, as `git am` does for a format-patch. */
    async merge(repo: RepoRef, branch: string, patch: string, signal?: AbortSignal): Promise<void> {
      const knot = await knotFor(repo, signal)
      if (!knot.ref.externalId) {
        throw new UnsupportedOperationError(`${repo.owner}/${repo.name} has no repo DID, which merging needs`, context)
      }
      await knot.post('sh.tangled.repo.merge', { did: knot.ref.owner, name: knot.record.value.name ?? knot.ref.name, repo: knot.ref.externalId, branch, patch }, toMergeError)
    },
    async addCollaborator(repo: RepoRef, subject: string, signal?: AbortSignal): Promise<void> {
      const knot = await knotFor(repo, signal)
      if (!knot.ref.externalId) {
        throw new UnsupportedOperationError(`${repo.owner}/${repo.name} has no repo DID, which managing collaborators needs`, context)
      }
      await knot.post('sh.tangled.repo.addCollaborator', { repo: knot.ref.externalId, subject })
    },
  }
}
