import type { RepoRef, ThreadKind } from '../model.ts'
import type { RepoSection, WebDefinition, WebLinks } from '../web.ts'
import { lineOf } from '../web.ts'

const SECTIONS: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: 'pulls' }
const PAGES: Partial<Record<RepoSection, string>> = { issues: 'issues', pullRequests: 'pulls', compare: 'compare', stargazers: 'stars', forks: 'forks' }

const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const repoPath = (repo: RepoRef) => `/${encodeURIComponent(repo.owner).replaceAll('%3A', ':')}/${encodeURIComponent(repo.name)}`

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
    thread: ref => SECTIONS[ref.kind] && ref.displayNumber ? `${repoPath(ref.repo)}/${SECTIONS[ref.kind]}/${encodeURIComponent(ref.displayNumber)}` : undefined,
    commit: (repo, sha) => `${repoPath(repo)}/commit/${encodeURIComponent(sha)}`,
    file: (repo, path, at, line) => `${repoPath(repo)}/blob/${encodeURIComponent(at)}/${encode(path)}${line ? `#L${line}` : ''}`,
    raw: (repo, path, at) => `${repoPath(repo)}/raw/${encodeURIComponent(at)}/${encode(path)}`,
    parse: (segments, url, from) => {
      const [owner, name, section, id] = segments
      if (!owner || !name) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner: owner.replace(/^@/, ''), name }
      if (section === 'blob' && id && segments[4]) {
        return { repo, file: { at: id, path: segments.slice(4).join('/'), ...lineOf(url.hash.replace(/^#L/, '')) } }
      }
      if (section === 'commit' && id) {
        return { repo, commit: { ...from, repo, sha: id } }
      }
      const kind = section === 'issues' ? 'issue' : section === 'pulls' ? 'pull_request' : undefined
      return kind && id ? { repo, thread: { ...from, repo, kind, displayNumber: id } } : { repo }
    },
  }
}
