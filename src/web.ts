import type { CommentRef, CommitRef, ForgeInstance, ForgeKind, ForgeOrigin, ReleaseRef, RepoRef, ResolvedCommentRef, ResolvedThreadRef, ThreadKind, ThreadRef } from './model.ts'
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

/** Options for `provider.parseReferences()`. */
export interface ParseReferencesOptions {
  /** Repository the text is written in, which a short reference such as `#42` points into. */
  from: RepoRef
}

/** A reference that `parseReferences()` found in text. */
export interface ParsedReference {
  /** The offset of the reference's first character. */
  start: number
  /** The offset just past the reference. */
  end: number
  /** The thread or commit it refers to. A commit `sha` is as written, so it can be abbreviated. */
  ref: ThreadRef | CommitRef
}

/** How a forge writes references in Markdown, read back by `parseReferences()`. */
export interface ReferenceSyntax {
  /**
   * The prefixes before a thread number, such as `#` or `!`, and the kind of thread each refers to.
   * `number` is the source of a regular expression for the number, digits by default. `sameRepo`
   * marks a prefix that takes no repository, and `namespace` one that refers to the namespace of `from`.
   */
  threads: ReadonlyArray<{ prefix: string, kind: ThreadKind, number?: string, sameRepo?: boolean, namespace?: boolean }>
  /** The source of a regular expression for the `owner/name` before a reference to another repository; unset when the forge has none. */
  repo?: string
  /** The source of a regular expression for what may follow a thread number, such as GitLab's `+`. */
  suffix?: string
  /** Whether a bare sha, and `owner/name@sha` where the forge has `repo`, refer to commits. */
  commits?: boolean
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
  /** The references that `parseReferences()` reads; unset when the forge has none. */
  references?: ReferenceSyntax
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

/** `owner/name`, for forges that nest no deeper. */
export const OWNER_NAME: string = String.raw`[\w.-]+\/[\w.-]+`

/** What cannot come right before a reference, so that a path, an email address or a word does not read as one. */
const BEFORE = String.raw`(?<![\w/.@#~&!+-])`
/** What cannot come right after a reference: a word character, or a dot, slash or `@` that continues a word. */
const AFTER = String.raw`(?![\w-]|[./@]\w)`
const SHA = '[0-9a-f]{7,40}'
const SCHEME_CHAR = /[\w+.-]/
const LETTER = /[a-z]/i
const SPACE = /\s/

interface ReferenceRule {
  pattern: RegExp
  read: (groups: Record<string, string>, from: RepoRef, origin: ForgeOrigin) => ThreadRef | CommitRef | undefined
}

const rules = new WeakMap<ReferenceSyntax, ReferenceRule[]>()

function repoIn(slug: string, origin: ForgeOrigin): RepoRef {
  const at = slug.lastIndexOf('/')
  return { ...origin, owner: slug.slice(0, at), name: slug.slice(at + 1) }
}

/** The spans of URLs in `text`, each from its scheme to the next whitespace. */
function urlSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  for (let at = text.indexOf('://'); at !== -1; at = text.indexOf('://', at + 1)) {
    let start = at
    while (start > 0 && SCHEME_CHAR.test(text[start - 1]!)) {
      start--
    }
    while (start < at && !LETTER.test(text[start]!)) {
      start++
    }
    if (start === at || at + 3 >= text.length || SPACE.test(text[at + 3]!)) {
      continue
    }
    let end = at + 4
    while (end < text.length && !SPACE.test(text[end]!)) {
      end++
    }
    spans.push([start, end])
    at = end
  }
  return spans
}

/** A bare sha needs a letter and a digit, so that neither a number nor a word reads as one. */
function isBareSha(value: string): boolean {
  return /[a-f]/.test(value) && /\d/.test(value)
}

function rulesFor(syntax: ReferenceSyntax): ReferenceRule[] {
  const cached = rules.get(syntax)
  if (cached) {
    return cached
  }
  const compiled: ReferenceRule[] = []
  const rule = (source: string, read: ReferenceRule['read']) => compiled.push({ pattern: new RegExp(`${BEFORE}${source}${AFTER}`, 'g'), read })
  const suffix = syntax.suffix ? `(?:${syntax.suffix})?` : ''
  for (const { prefix, kind, number = String.raw`[1-9]\d*`, sameRepo: local, namespace } of syntax.threads) {
    const thread = `${prefix.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}(?<id>${number})${suffix}`
    rule(thread, ({ id }, from, origin) => ({ ...origin, repo: namespace ? { ...origin, owner: from.owner, name: '', kind: 'namespace' } : from, kind, number: id! }))
    if (syntax.repo && !local) {
      rule(`(?<slug>${syntax.repo})${thread}`, ({ slug, id }, _, origin) => ({ ...origin, repo: repoIn(slug!, origin), kind, number: id! }))
    }
  }
  if (syntax.commits) {
    rule(`(?<sha>${SHA})`, ({ sha }, from, origin) => isBareSha(sha!) ? { ...origin, repo: from, sha: sha! } : undefined)
    if (syntax.repo) {
      rule(`(?<slug>${syntax.repo})@(?<sha>${SHA})`, ({ slug, sha }, _, origin) => ({ ...origin, repo: repoIn(slug!, origin), sha: sha! }))
    }
  }
  rules.set(syntax, compiled)
  return compiled
}

export function parseReferences(web: WebLinks | undefined, text: string, from: RepoRef, origin: ForgeOrigin): ParsedReference[] {
  if (!web?.references || from.forge !== origin.forge || from.instance !== origin.instance) {
    return []
  }
  const urls = urlSpans(text)
  const found: ParsedReference[] = []
  for (const { pattern, read } of rulesFor(web.references)) {
    for (const match of text.matchAll(pattern)) {
      const ref = urls.some(([start, end]) => match.index >= start && match.index < end) ? undefined : read(match.groups!, from, origin)
      if (ref) {
        found.push({ start: match.index, end: match.index + match[0].length, ref })
      }
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  let end = 0
  return found.filter((match) => {
    if (match.start < end) {
      return false
    }
    end = match.end
    return true
  })
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
  /** The references that `parseReferences()` reads; defaults to `#{n}` and `pullPrefix`, with `owner/name` before them, and commit shas. */
  references?: ReferenceSyntax
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
    references: shape.references ?? {
      threads: [{ prefix: '#', kind: 'issue' }, ...shape.pullPrefix ? [{ prefix: shape.pullPrefix, kind: 'pull_request' as const }] : []],
      repo: OWNER_NAME,
      commits: true,
    },
  }
}

/** Where a forge's instance is, as a provider's options give it. */
export interface WebOptions {
  /** API base URL. Defaults to the forge's public instance. */
  baseUrl?: string
  /** Host used in refs and keys. Defaults to the host of `baseUrl`, with API subdomains mapped to the public host. */
  instance?: string
}

/** A forge's website without its API: its public instance, and its web links on an instance. */
export interface WebDefinition<Forge extends ForgeKind = ForgeKind> {
  forge: Forge
  /** The API base URL of the public instance. */
  baseUrl: string
  /** The path that a `baseUrl` given without it gets, such as `/api/v4`. */
  apiPath?: string
  /** The instance for the host of the API base URL; the host itself by default. */
  instance?: (host: string) => string
  /** The web links of the instance whose API base URL is `baseUrl`. */
  links: (base: { baseUrl: string, instance: ForgeInstance }) => WebLinks
}

/** The API base URL and the instance that `options` select. */
export function resolveInstance(definition: Omit<WebDefinition, 'links'>, options: WebOptions): { baseUrl: string, instance: ForgeInstance } {
  const root = (options.baseUrl ?? definition.baseUrl).replace(/\/$/, '')
  const baseUrl = definition.apiPath && !root.endsWith(definition.apiPath) ? `${root}${definition.apiPath}` : root
  let host: string
  try {
    host = new URL(baseUrl).host
  }
  catch (cause) {
    throw new TypeError(`Invalid baseUrl for ${definition.forge}: ${JSON.stringify(baseUrl)}`, { cause })
  }
  return { baseUrl, instance: options.instance ?? definition.instance?.(host) ?? host }
}

/** The web pages and references of one forge instance, without an API client. */
export interface ForgeWeb<Forge extends ForgeKind = ForgeKind> {
  readonly forge: Forge
  readonly instance: ForgeInstance
  /** The origin of the forge's website, such as `https://github.com`. */
  readonly webOrigin: string
  /** The web page for `target`; `undefined` when the forge has no such page. */
  urlFor: {
    (target: { repo: RepoRef, section?: undefined }): string
    (target: UrlTarget): string | undefined
  }
  /** Reads a web URL, clone URL or npm `repository` value on this instance into refs; `undefined` for anything else. */
  parseUrl: (url: string | URL) => ParsedForgeUrl | undefined
  /** How to mention `ref` in Markdown on this forge, short when written in `from`; the page URL where the forge has no reference syntax. */
  referenceFor: (ref: ThreadRef | CommitRef, options?: ReferenceOptions) => string | undefined
  /** The references to threads and commits in `text`, with their offsets, in order. */
  parseReferences: (text: string, options: ParseReferencesOptions) => ParsedReference[]
}

export function defineForgeWeb<Forge extends ForgeKind>(definition: WebDefinition<Forge>): (options?: WebOptions) => ForgeWeb<Forge> {
  return (options = {}) => {
    const { baseUrl, instance } = resolveInstance(definition, options)
    const origin = { forge: definition.forge, instance }
    const web = definition.links({ baseUrl, instance })
    return {
      ...origin,
      webOrigin: new URL(web.baseUrl).origin,
      urlFor: (target: UrlTarget) => webUrlFor(web, target),
      parseUrl: url => parseWebUrl(web, url, origin),
      referenceFor: (ref, referenceOptions) => referenceFor(web, ref, referenceOptions),
      parseReferences: (text, { from }) => parseReferences(web, text, from, origin),
    } as ForgeWeb<Forge>
  }
}

/** What `createForges()` routes between. */
export interface RoutedForge {
  readonly forge: ForgeKind
  readonly instance: ForgeInstance
  /** Reads a web URL, clone URL or npm `repository` value on this instance into refs; `undefined` for anything else. */
  parseUrl: (url: string | URL) => ParsedForgeUrl | undefined
  /** The references to threads and commits in `text`, with their offsets, in order. */
  parseReferences: (text: string, options: ParseReferencesOptions) => ParsedReference[]
}

/** A registry of forges that routes each ref, URL or text to the forge it belongs to. */
export interface WebForges<T extends RoutedForge = ForgeWeb> {
  readonly providers: T[]
  /** The first forge of kind `forge`, optionally on one instance. */
  get: (forge: ForgeKind, instance?: ForgeInstance) => T | undefined
  /** Every instance of a forge. */
  all: (forge: ForgeKind) => T[]
  /** The forge a ref belongs to, by `forge` and `instance`. */
  for: (ref: ForgeOrigin) => T | undefined
  /** The forge whose instance serves `url`. */
  forUrl: (url: string | URL) => T | undefined
  /** Reads a web URL, clone URL or npm `repository` value on any registered instance. */
  parseUrl: (url: string | URL) => (ParsedForgeUrl & { provider: T }) | undefined
  /** The references in `text`, read by the forge of `options.from`; empty when none is registered. */
  parseReferences: (text: string, options: ParseReferencesOptions) => ParsedReference[]
}

export function routeForges<T extends RoutedForge>(providers: readonly T[]): WebForges<T> {
  const seen = new Set<string>()
  for (const provider of providers) {
    const key = `${provider.forge}:${provider.instance}`
    if (seen.has(key)) {
      throw new TypeError(`Two providers are registered for ${provider.forge} on ${provider.instance}; pass \`instance\` to tell them apart`)
    }
    seen.add(key)
  }
  const find = (ref: ForgeOrigin) => providers.find(provider => provider.forge === ref.forge && provider.instance === ref.instance)
  const parseUrl = (url: string | URL) => {
    for (const provider of providers) {
      const parsed = provider.parseUrl(url)
      if (parsed) {
        return { ...parsed, provider }
      }
    }
    return undefined
  }
  return {
    providers: [...providers],
    get: (forge, instance) => providers.find(provider => provider.forge === forge && (!instance || provider.instance === instance)),
    all: forge => providers.filter(provider => provider.forge === forge),
    for: find,
    forUrl: url => parseUrl(url)?.provider,
    parseUrl,
    parseReferences: (text, options) => find(options.from)?.parseReferences(text, options) ?? [],
  }
}
