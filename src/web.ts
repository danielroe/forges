import type { CommentRef, ForgeOrigin, ReleaseRef, RepoRef, ResolvedThreadRef, ThreadKind, ThreadRef } from './model.ts'
import { isResolvedThread } from './model.ts'

/** Something with a web page. */
export type UrlTarget
  = | { repo: RepoRef }
    | { thread: ThreadRef }
    | { comment: CommentRef }
    | { release: ReleaseRef }
    | { file: { repo: RepoRef, path: string, at: string, line?: number } }
    | { compare: { repo: RepoRef, base: string, head: string } }

/** What a forge web URL points at. `repo` is always set; the rest when the URL is that specific. */
export interface ParsedForgeUrl {
  repo: RepoRef
  thread?: ThreadRef
  comment?: CommentRef
  release?: ReleaseRef
}

export interface ReferenceOptions {
  /** Repository the reference is written in; a reference within it is the short form. */
  from?: RepoRef
  /** Request the reference expanded to its title, where the forge supports it (GitLab's `+` suffix). */
  expand?: boolean
}

/**
 * How a provider builds and reads its web URLs. Paths are relative to
 * `origin`; any builder may return `undefined` when the forge has no such page.
 */
export interface WebLinks {
  origin: string
  repo: (repo: RepoRef) => string
  thread: (ref: ResolvedThreadRef) => string | undefined
  comment?: (ref: CommentRef & { thread: ResolvedThreadRef }) => string | undefined
  release?: (ref: ReleaseRef) => string | undefined
  file?: (repo: RepoRef, path: string, at: string, line?: number) => string | undefined
  compare?: (repo: RepoRef, base: string, head: string) => string | undefined
  /** Reads a URL already known to be on `origin`, split into path segments. */
  parse: (segments: string[], url: URL, origin: ForgeOrigin) => ParsedForgeUrl | undefined
  /** The forge's cross-reference syntax; `undefined` falls back to the thread URL. */
  reference?: (ref: ResolvedThreadRef, sameRepo: boolean, expand: boolean) => string | undefined
}

export function sameRepo(a: RepoRef, b: RepoRef | undefined): boolean {
  return Boolean(b) && a.forge === b!.forge && a.instance === b!.instance
    && a.owner.toLowerCase() === b!.owner.toLowerCase() && a.name.toLowerCase() === b!.name.toLowerCase()
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function webUrlFor(web: WebLinks, target: UrlTarget): string | undefined {
  let path: string | undefined
  if ('repo' in target) {
    path = web.repo(target.repo)
  }
  else if ('thread' in target) {
    path = isResolvedThread(target.thread) ? web.thread(target.thread) : undefined
  }
  else if ('comment' in target) {
    const { comment } = target
    path = isResolvedThread(comment.thread) ? web.comment?.(comment as CommentRef & { thread: ResolvedThreadRef }) : undefined
  }
  else if ('release' in target) {
    path = web.release?.(target.release)
  }
  else if ('file' in target) {
    path = web.file?.(target.file.repo, target.file.path, target.file.at, target.file.line)
  }
  else {
    path = web.compare?.(target.compare.repo, target.compare.base, target.compare.head)
  }
  return path === undefined ? undefined : `${web.origin}${path}`
}

export function parseWebUrl(web: WebLinks, input: string | URL, origin: ForgeOrigin): ParsedForgeUrl | undefined {
  let url: URL
  try {
    url = new URL(input)
  }
  catch {
    return undefined
  }
  const base = new URL(web.origin)
  if (url.origin !== base.origin || url.username || url.password) {
    return undefined
  }
  const prefix = base.pathname.replace(/\/$/, '')
  if (prefix && !url.pathname.startsWith(`${prefix}/`)) {
    return undefined
  }
  let segments: string[]
  try {
    segments = url.pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent)
  }
  catch {
    return undefined
  }
  return web.parse(segments, url, origin)
}

export function referenceFor(web: WebLinks | undefined, ref: ThreadRef, options: ReferenceOptions = {}): string | undefined {
  if (!web || !isResolvedThread(ref)) {
    return undefined
  }
  return web.reference?.(ref, sameRepo(ref.repo, options.from), options.expand ?? false) ?? webUrlFor(web, { thread: ref })
}

interface GitHubShape {
  pull: string
  discussions?: boolean
  /** Fragment for a comment id, for example `issuecomment-` or `note_`. */
  commentFragment: string
  file: (at: string) => string
  lineFragment: (line: number) => string
  /** Reference prefix for pulls when it differs from issues. */
  pullPrefix?: string
  /** Reserved owner segments. */
  reserved?: readonly string[]
}

/** Web links for forges laid out like GitHub: `/{owner}/{name}/issues/{n}` and friends. */
export function githubShapedWeb(origin: string, shape: GitHubShape): WebLinks {
  const repoPath = (repo: RepoRef) => `/${encodePath(repo.owner)}/${encodeURIComponent(repo.name)}`
  const kindPath: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: shape.pull, commit: 'commit', ...shape.discussions ? { discussion: 'discussions' } : {} }
  const kindOf = new Map<string, ThreadKind>(Object.entries(kindPath).map(([kind, path]) => [path, kind as ThreadKind]))
  const reserved = new Set(shape.reserved?.map(segment => segment.toLowerCase()))
  return {
    origin,
    repo: repoPath,
    thread: ref => kindPath[ref.kind] && `${repoPath(ref.repo)}/${kindPath[ref.kind]}/${encodeURIComponent(ref.number)}`,
    comment: ref => ref.thread.kind === 'commit' || !kindPath[ref.thread.kind]
      ? undefined
      : `${repoPath(ref.thread.repo)}/${kindPath[ref.thread.kind]}/${encodeURIComponent(ref.thread.number)}#${shape.commentFragment}${ref.id}`,
    release: ref => ref.tag ? `${repoPath(ref.repo)}/releases/tag/${encodeURIComponent(ref.tag)}` : undefined,
    file: (repo, path, at, line) => `${repoPath(repo)}${shape.file(at)}/${encodePath(path)}${line ? `#${shape.lineFragment(line)}` : ''}`,
    compare: (repo, base, head) => `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    parse: (segments, url, from) => {
      const [owner, name, section, id] = segments
      if (!owner || !name || reserved.has(owner.toLowerCase())) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner, name: name.replace(/\.git$/, '') }
      const kind = section ? kindOf.get(section) : undefined
      if (section === 'releases' && id === 'tag' && segments[4]) {
        return { repo, release: { ...from, repo, id: segments[4], tag: segments[4] } }
      }
      if (!kind || !id) {
        return { repo }
      }
      const thread: ThreadRef = { ...from, repo, kind, number: id }
      const comment = url.hash.startsWith(`#${shape.commentFragment}`) ? url.hash.slice(shape.commentFragment.length + 1) : undefined
      return { repo, thread, ...comment ? { comment: { ...from, thread, id: comment } } : {} }
    },
    reference: (ref, same) => {
      if (ref.kind === 'commit') {
        return same ? ref.number.slice(0, 7) : `${ref.repo.owner}/${ref.repo.name}@${ref.number.slice(0, 7)}`
      }
      const prefix = ref.kind === 'pull_request' && shape.pullPrefix ? shape.pullPrefix : '#'
      return `${same ? '' : `${ref.repo.owner}/${ref.repo.name}`}${prefix}${ref.number}`
    },
  }
}

/** Reads `url` with whichever of `providers` serves it. */
export function parseForgeUrl(url: string | URL, providers: ReadonlyArray<{ parseUrl: (url: string | URL) => ParsedForgeUrl | undefined }>): ParsedForgeUrl | undefined {
  for (const provider of providers) {
    const parsed = provider.parseUrl(url)
    if (parsed) {
      return parsed
    }
  }
  return undefined
}
