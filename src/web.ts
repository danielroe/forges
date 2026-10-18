import type { CommentRef, CommitRef, ForgeOrigin, ReleaseRef, RepoRef, ResolvedCommentRef, ResolvedThreadRef, ThreadKind, ThreadRef } from './model.ts'
import { isResolvedThread, normaliseRepoName } from './model.ts'

/** A repository's section, for linking to the section itself rather than one entry in it. */
export type RepoSection = 'issues' | 'pullRequests' | 'compare' | 'releases' | 'stargazers' | 'forks' | 'watchers'

/**
 * Something with a web page. A revision (`at`, `base` or `head`) is a branch,
 * tag or commit sha; Azure DevOps reads anything but a full commit sha as a branch.
 */
export type UrlTarget
  = | { repo: RepoRef }
    | { repo: RepoRef, section: RepoSection }
    | { thread: ThreadRef }
    | { comment: CommentRef }
    | { release: ReleaseRef }
    | { file: { repo: RepoRef, path: string, at: string, line?: number } }
    | { raw: { repo: RepoRef, path: string, at: string } }
    | { commit: { repo: RepoRef, sha: string } }
    | { compare: { repo: RepoRef, base: string, head: string } }

/** What a forge web URL points at. `repo` is always set; the rest when the URL is that specific. */
export interface ParsedForgeUrl {
  repo: RepoRef
  thread?: ThreadRef
  comment?: CommentRef
  commit?: CommitRef
  release?: ReleaseRef
  /** The tag of a tag page that is not a release page, such as GitLab's `-/tags/{tag}`. */
  tag?: string
  /** The revisions of a page that compares two, such as `compare/{base}...{head}` or `compare/{base}..{head}`. */
  compare?: { base: string, head: string }
  /**
   * A file page: the repository-relative `path`, the revision `at` and the first selected `line`.
   * `at` is unset when the URL leaves the revision to the default branch. An unencoded `/` in
   * a branch name reads as the start of `path`. Forges that address files and folders
   * alike, such as Forgejo, Bitbucket and Azure DevOps, also set this for a folder.
   */
  file?: { path: string, at?: string, line?: number }
}

/** Options for `provider.referenceFor()`. */
export interface ReferenceOptions {
  /** Repository the reference is written in; a reference within it is the short form. */
  from?: RepoRef
  /** Request the reference expanded to its title, where the forge supports it (GitLab's `+` suffix). */
  expand?: boolean
}

/**
 * How a provider builds and reads its web URLs. Builders return a path relative
 * to `baseUrl` or an absolute URL, and may return `undefined` when the forge has no such page.
 */
export interface WebLinks {
  /** The base URL of the forge website, such as `https://github.com` or `https://example.com/gitlab`. */
  baseUrl: string
  /** Other hosts that serve the same pages, such as a domain the forge has moved from. `parse` reads their URLs too. */
  hosts?: readonly string[]
  /** The page of a repository. */
  repo: (repo: RepoRef) => string
  /** The page of one of a repository's sections, such as its issues, pull requests, stargazers or forks. */
  section?: (repo: RepoRef, section: RepoSection) => string | undefined
  /** The page of an issue or pull request. */
  thread: (ref: ResolvedThreadRef) => string | undefined
  /** The page of a comment, anchored on its thread. */
  comment?: (ref: ResolvedCommentRef) => string | undefined
  /** The page of a commit. */
  commit?: (repo: RepoRef, sha: string) => string | undefined
  /** The page of a release. */
  release?: (ref: ReleaseRef) => string | undefined
  /** The page of a file at a revision, optionally at a line. */
  file?: (repo: RepoRef, path: string, at: string, line?: number) => string | undefined
  /** The raw bytes of a file at a revision. */
  raw?: (repo: RepoRef, path: string, at: string) => string | undefined
  /** The page that compares two revisions. */
  compare?: (repo: RepoRef, base: string, head: string) => string | undefined
  /** Reads a URL already known to be under `baseUrl`, split into the path segments after it. */
  parse: (segments: string[], url: URL, origin: ForgeOrigin) => ParsedForgeUrl | undefined
  /** The forge's cross-reference syntax; `undefined` falls back to the page URL. */
  reference?: (ref: ResolvedThreadRef | CommitRef, sameRepo: boolean, expand: boolean) => string | undefined
}

export function sameRepo(a: RepoRef, b: RepoRef | undefined): boolean {
  if (!b || a.forge !== b.forge || a.instance !== b.instance) {
    return false
  }
  const [left, right] = [normaliseRepoName(a), normaliseRepoName(b)]
  return left.owner === right.owner && left.name === right.name
}

export function lineOf(value: string | null | undefined): { line?: number } {
  const line = Number.parseInt(value ?? '', 10)
  return line > 0 ? { line } : {}
}

/** Reads `base...head` or `base..head`. Git forbids `..` in a ref name, so the first `..` separates the two. */
export function rangeOf(value: string): { compare?: { base: string, head: string } } {
  const at = value.indexOf('..')
  const base = value.slice(0, at)
  const head = value.slice(value[at + 2] === '.' ? at + 3 : at + 2)
  return at > 0 && head ? { compare: { base, head } } : {}
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function webUrlFor(web: WebLinks, target: UrlTarget): string | undefined {
  const revision = 'file' in target ? target.file : 'raw' in target ? target.raw : 'commit' in target ? target.commit : 'compare' in target ? target.compare : undefined
  if (revision?.repo.kind === 'namespace') {
    return undefined
  }
  let path: string | undefined
  if ('repo' in target) {
    path = 'section' in target && target.section ? web.section?.(target.repo, target.section) : web.repo(target.repo)
  }
  else if ('thread' in target) {
    path = isResolvedThread(target.thread) ? web.thread(target.thread) : undefined
  }
  else if ('comment' in target) {
    const { comment } = target
    path = isResolvedThread(comment.thread) ? web.comment?.(comment as ResolvedCommentRef) : undefined
  }
  else if ('release' in target) {
    path = web.release?.(target.release)
  }
  else if ('file' in target) {
    path = web.file?.(target.file.repo, target.file.path, target.file.at, target.file.line)
  }
  else if ('raw' in target) {
    path = web.raw?.(target.raw.repo, target.raw.path, target.raw.at)
  }
  else if ('commit' in target) {
    path = target.commit.sha ? web.commit?.(target.commit.repo, target.commit.sha) : undefined
  }
  else {
    path = web.compare?.(target.compare.repo, target.compare.base, target.compare.head)
  }
  return path === undefined ? undefined : path.startsWith('/') ? `${web.baseUrl}${path}` : path
}

/** `ssh://user@host:port/path` or `git://host:port/path` with the host in group 1, or `user@host:path` with it in group 2; the path is group 3. */
const CLONE_URL_RE = /^(?:(?:ssh|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/|(?:[^@/\s]+@)?([^:/\s]+):(?!\/))(.+)$/i

/** The `git+` that npm's `repository` field writes before a transport scheme. */
const GIT_PLUS_RE = /^git\+(?=[a-z]+:\/\/)/i

/** The npm `repository` shorthand, https://docs.npmjs.com/cli/configuring-npm/package-json#repository */
const SHORTHAND_RE = /^(github|gitlab|bitbucket):(?!\/)/i
const SHORTHAND_HOSTS: Record<string, string> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }

export function parseWebUrl(web: WebLinks, input: string | URL, origin: ForgeOrigin): ParsedForgeUrl | undefined {
  const base = new URL(web.baseUrl)
  const prefix = base.pathname.replace(/\/$/, '')
  const source = String(input).replace(GIT_PLUS_RE, '').replace(SHORTHAND_RE, (_, forge: string) => `https://${SHORTHAND_HOSTS[forge.toLowerCase()]}/`)
  const clone = CLONE_URL_RE.exec(source)
  let url: URL
  try {
    url = new URL(clone && (clone[1] ?? clone[2])!.toLowerCase() === base.hostname ? `${base.origin}${prefix}/${clone[3]}` : source)
  }
  catch {
    return undefined
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || (url.host !== base.host && !web.hosts?.includes(url.host)) || url.username || url.password) {
    return undefined
  }
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

export function referenceFor(web: WebLinks | undefined, ref: ThreadRef | CommitRef, options: ReferenceOptions = {}): string | undefined {
  if (!web || !('sha' in ref || isResolvedThread(ref))) {
    return undefined
  }
  return web.reference?.(ref, sameRepo(ref.repo, options.from), options.expand ?? false) ?? webUrlFor(web, 'sha' in ref ? { commit: ref } : { thread: ref })
}

/** How a forge that lays out its website like GitHub differs from GitHub. */
export interface GitHubShape {
  /** The path segment of pull requests, such as `pull` or `pulls`. */
  pull: string
  /** The forge has discussions, which are addressed like issues. */
  discussions?: boolean
  /** Fragment for a comment id, for example `issuecomment-` or `note_`. */
  commentFragment: string
  /** The path segment that leads to a file at a revision. */
  file: (at: string) => string
  /** Reads a file page back from the segments after the repository name; defaults to `blob/{at}/{path}`. */
  parseFile?: (segments: string[]) => { at: string, path: string } | undefined
  /** The path segment of commits; defaults to `commit`. */
  commit?: string
  /** Whether the forge serves raw files at `/raw/{at}/{path}`; defaults to `true`. */
  raw?: boolean
  /** The origin that serves raw files at `/{owner}/{name}/{at}/{path}`; when unset, raw files are linked at `/raw/{at}/{path}` on the forge. */
  rawOrigin?: string
  /** The URL fragment that selects a line of a file. */
  lineFragment: (line: number) => string
  /** Reference prefix for pulls when it differs from issues. */
  pullPrefix?: string
  /**
   * Path segments for sections whose path is not the section's own name, such as a
   * forge that lists stargazers at `stars`; `null` marks a section the forge has no
   * page for, so `section()` returns `undefined` for it.
   */
  sections?: Partial<Record<RepoSection, string | null>>
  /** Reserved owner segments. */
  reserved?: readonly string[]
}

/** Reads GitHub's file route, `blob/{at}/{path}`. */
function parseGitHubFile([route, at, ...path]: string[]): { at: string, path: string } | undefined {
  return route === 'blob' && at && path.length ? { at, path: path.join('/') } : undefined
}

/** Web links for forges laid out like GitHub: `/{owner}/{name}/issues/{n}` and friends. */
export function githubShapedWeb(baseUrl: string, shape: GitHubShape): WebLinks {
  const repoPath = (repo: RepoRef) => `/${encodePath(repo.owner)}/${encodeURIComponent(repo.name)}`
  const kindPath: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: shape.pull, ...shape.discussions ? { discussion: 'discussions' } : {} }
  const commitPath = shape.commit ?? 'commit'
  const kindOf = new Map<string, ThreadKind>(Object.entries(kindPath).map(([kind, path]) => [path, kind as ThreadKind]))
  const reserved = new Set(shape.reserved?.map(segment => segment.toLowerCase()))
  const parseFile = shape.parseFile ?? parseGitHubFile
  return {
    baseUrl,
    repo: repoPath,
    section: (repo, section) => {
      if (repo.kind === 'namespace') {
        return undefined
      }
      const path = shape.sections?.[section]
      if (path === null) {
        return undefined
      }
      return `${repoPath(repo)}/${path ?? (section === 'pullRequests' ? 'pulls' : section)}`
    },
    thread: ref => kindPath[ref.kind] && `${repoPath(ref.repo)}/${kindPath[ref.kind]}/${encodeURIComponent(ref.number)}`,
    comment: ref => kindPath[ref.thread.kind] && `${repoPath(ref.thread.repo)}/${kindPath[ref.thread.kind]}/${encodeURIComponent(ref.thread.number)}#${shape.commentFragment}${ref.id}`,
    commit: (repo, sha) => `${repoPath(repo)}/${commitPath}/${encodeURIComponent(sha)}`,
    release: ref => ref.tag ? `${repoPath(ref.repo)}/releases/tag/${encodeURIComponent(ref.tag)}` : undefined,
    file: (repo, path, at, line) => `${repoPath(repo)}${shape.file(at)}/${encodePath(path)}${line ? `#${shape.lineFragment(line)}` : ''}`,
    raw: (repo, path, at) => shape.raw === false
      ? undefined
      : shape.rawOrigin
        ? `${shape.rawOrigin}${repoPath(repo)}/${encodeURIComponent(at)}/${encodePath(path)}`
        : `${repoPath(repo)}/raw/${encodeURIComponent(at)}/${encodePath(path)}`,
    compare: (repo, base, head) => `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    parse: (segments, url, from) => {
      const [owner, name, section, id] = segments
      if (!owner || !name || reserved.has(owner.toLowerCase())) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner, name: name.replace(/\.git$/, '') }
      const file = parseFile(segments.slice(2))
      if (file) {
        return { repo, file: { ...file, ...lineOf(url.hash.replace(/^#L/, '')) } }
      }
      const kind = section ? kindOf.get(section) : undefined
      if (section === 'releases' && id === 'tag' && segments[4]) {
        return { repo, release: { ...from, repo, id: segments[4], tag: segments[4] } }
      }
      if (section === commitPath && id) {
        return { repo, commit: { ...from, repo, sha: id } }
      }
      if (section === 'compare' && id) {
        return { repo, ...rangeOf(segments.slice(3).join('/')) }
      }
      if (!kind || !id) {
        return { repo }
      }
      const thread: ThreadRef = { ...from, repo, kind, number: id }
      if (kind === 'pull_request' && segments[4] === 'commits' && segments[5]) {
        return { repo, thread, commit: { ...from, repo, sha: segments[5] } }
      }
      const comment = url.hash.startsWith(`#${shape.commentFragment}`) ? url.hash.slice(shape.commentFragment.length + 1) : undefined
      return { repo, thread, ...comment ? { comment: { ...from, thread, id: comment } } : {} }
    },
    reference: (ref, same) => {
      if ('sha' in ref) {
        return same ? ref.sha.slice(0, 7) : `${ref.repo.owner}/${ref.repo.name}@${ref.sha.slice(0, 7)}`
      }
      const prefix = ref.kind === 'pull_request' && shape.pullPrefix ? shape.pullPrefix : '#'
      return `${same ? '' : `${ref.repo.owner}/${ref.repo.name}`}${prefix}${ref.number}`
    },
  }
}
