import type { RepoRef, ResolvedCommentRef, ResolvedThreadRef, ThreadKind, ThreadRef } from '../model.ts'
import type { RepoSection, WebDefinition, WebLinks } from '../web.ts'
import { bareSha, lineOf, rangeOf } from '../web.ts'

const SECTIONS: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: 'pulls' }
const PAGES: Partial<Record<RepoSection, string>> = { issues: 'issues', pullRequests: 'pulls', compare: 'compare', stargazers: 'stars', forks: 'forks' }

const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')
/** A Tangled owner is a handle or a DID, so a cross-repo reference can carry `:`. */
const REFERENCE_REPO = String.raw`[\w:.-]+\/[\w.-]+`

/** `owner/name`, by the owner's handle where it is known, as Tangled names a repository. */
const repoSlug = (repo: RepoRef) => `${repo.ownerHandle ?? repo.owner}/${repo.name}`

/**
 * The path of a repository's page. Tangled addresses a repository by its
 * owner's handle, and redirects a path that names the owner's DID.
 */
export const repoPath = (repo: RepoRef) => `/${encodeURIComponent(repo.ownerHandle ?? repo.owner).replaceAll('%3A', ':')}/${encodeURIComponent(repo.name)}`

/** The path of a thread's page, which Tangled addresses by the number it shows the thread as. */
export const threadPath = (ref: ThreadRef) => SECTIONS[ref.kind] && ref.displayNumber ? `${repoPath(ref.repo)}/${SECTIONS[ref.kind]}/${encodeURIComponent(ref.displayNumber)}` : undefined

/** The path of a comment's page, anchored on its thread. */
export function commentPath(ref: ResolvedCommentRef) {
  const path = threadPath(ref.thread)
  return path && ref.id ? `${path}#comment-${encodeURIComponent(ref.id.split('/').pop()!)}` : undefined
}

/** The page of a thread, where the appview numbers it. */
export function threadUrl(baseUrl: string, ref: ResolvedThreadRef) {
  const path = threadPath(ref)
  return path === undefined ? undefined : `${baseUrl}${path}`
}

/** The page of a comment, anchored on its thread. */
export function commentUrl(baseUrl: string, ref: ResolvedCommentRef) {
  const path = commentPath(ref)
  return path === undefined ? undefined : `${baseUrl}${path}`
}

export const TANGLED_WEB: WebDefinition<'tangled'> = {
  forge: 'tangled',
  baseUrl: 'https://tangled.org',
  links: ({ baseUrl }) => tangledWeb(baseUrl),
}

/** Tangled pages address threads by their display number, so parsed refs carry `displayNumber` and need resolving. */
function tangledWeb(baseUrl: string): WebLinks {
  return {
    baseUrl,
    // Older links point at tangled.sh, which redirects to tangled.org.
    ...baseUrl === 'https://tangled.org' ? { hosts: ['tangled.sh'] } : {},
    repo: repoPath,
    section: (repo, section) => repo.kind === 'namespace' || !PAGES[section] ? undefined : `${repoPath(repo)}/${PAGES[section]}`,
    thread: threadPath,
    comment: commentPath,
    commit: (repo, sha) => `${repoPath(repo)}/commit/${encodeURIComponent(sha)}`,
    compare: (repo, base, head) => `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    file: (repo, path, at, line) => `${repoPath(repo)}/blob/${encodeURIComponent(at)}/${encode(path)}${line ? `#L${line}` : ''}`,
    raw: (repo, path, at) => `${repoPath(repo)}/raw/${encodeURIComponent(at)}/${encode(path)}`,
    parse: (segments, url, from) => {
      const [owner, name, section, id] = segments
      if (!owner || !name) {
        return undefined
      }
      const handle = owner.replace(/^@/, '')
      const repo: RepoRef = { ...from, owner: handle, name, ...(handle.startsWith('did:') ? {} : { ownerHandle: handle }) }
      if (section === 'blob' && id && segments[4]) {
        return { repo, file: { at: id, path: segments.slice(4).join('/'), ...lineOf(url.hash.replace(/^#L/, '')) } }
      }
      if (section === 'commit' && id) {
        return { repo, commit: { ...from, repo, sha: id } }
      }
      if (section === 'compare' && id) {
        return { repo, ...rangeOf(segments.slice(3).join('/')) }
      }
      const kind = section === 'issues' ? 'issue' : section === 'pulls' ? 'pull_request' : undefined
      return kind && id ? { repo, thread: { ...from, repo, kind, displayNumber: id } } : { repo }
    },
    reference: (ref, same) => {
      if ('sha' in ref) {
        return (same ? bareSha(ref.sha, 7) : undefined) ?? `${repoSlug(ref.repo)}@${ref.sha.slice(0, 7)}`
      }
      // Only the display number gives a short form; `number` is the record's AT-URI.
      return ref.displayNumber ? `${same ? '' : repoSlug(ref.repo)}#${ref.displayNumber}` : undefined
    },
    // A `#<n>` written in text is the display number: the record's AT-URI is not known from text alone.
    references: { threads: [{ prefix: '#', kind: 'issue', displayNumber: true }], repo: REFERENCE_REPO, commits: true },
  }
}
