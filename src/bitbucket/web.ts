import type { RepoRef, ThreadKind, ThreadRef } from '../model.ts'
import type { RepoSection, WebLinks } from '../web.ts'
import { lineOf } from '../web.ts'

const SECTIONS: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: 'pull-requests' }
const KINDS = new Map(Object.entries(SECTIONS).map(([kind, section]) => [section, kind as ThreadKind]))
const PAGES: Partial<Record<RepoSection, string>> = { issues: 'issues', pullRequests: 'pull-requests', compare: 'branches/compare', forks: 'forks' }

const repoPath = (repo: RepoRef) => `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

export function bitbucketWeb(baseUrl: string): WebLinks {
  return {
    baseUrl,
    repo: repoPath,
    section: (repo, section) => repo.kind === 'namespace' || !PAGES[section] ? undefined : `${repoPath(repo)}/${PAGES[section]}`,
    thread: ref => SECTIONS[ref.kind] && `${repoPath(ref.repo)}/${SECTIONS[ref.kind]}/${encodeURIComponent(ref.number)}`,
    comment: ref => !SECTIONS[ref.thread.kind] ? undefined : `${repoPath(ref.thread.repo)}/${SECTIONS[ref.thread.kind]}/${encodeURIComponent(ref.thread.number)}#comment-${ref.id}`,
    commit: (repo, sha) => `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
    file: (repo, path, at, line) => `${repoPath(repo)}/src/${encodeURIComponent(at)}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#lines-${line}` : ''}`,
    raw: (repo, path, at) => `${repoPath(repo)}/raw/${encodeURIComponent(at)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    compare: (repo, base, head) => `${repoPath(repo)}/branches/compare/${encodeURIComponent(head)}%0D${encodeURIComponent(base)}`,
    parse: (segments, url, from) => {
      const [owner, name, section, id] = segments
      if (!owner || !name) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner, name: name.replace(/\.git$/, '') }
      if (section === 'src' && id && segments[4]) {
        return { repo, file: { at: id, path: segments.slice(4).join('/'), ...lineOf(url.hash.replace(/^#lines-/, '')) } }
      }
      if (section === 'commits' && id) {
        return { repo, commit: { ...from, repo, sha: id } }
      }
      const [head, base] = section === 'branches' && id === 'compare' ? segments.slice(4).join('/').split('\r') : []
      if (head && base) {
        return { repo, compare: { base, head } }
      }
      const kind = section ? KINDS.get(section) : undefined
      if (!kind || !id) {
        return { repo }
      }
      const thread: ThreadRef = { ...from, repo, kind, number: id }
      const comment = url.hash.startsWith('#comment-') ? url.hash.slice('#comment-'.length) : undefined
      return { repo, thread, ...comment ? { comment: { ...from, thread, id: comment } } : {} }
    },
    reference: (ref, same) => {
      if (!same) {
        return undefined
      }
      if ('sha' in ref) {
        return ref.sha.slice(0, 12)
      }
      return ref.kind === 'issue' ? `#${ref.number}` : ref.kind === 'pull_request' ? `pull request #${ref.number}` : undefined
    },
    references: { threads: [{ prefix: '#', kind: 'issue' }, { prefix: 'pull request #', kind: 'pull_request' }], commits: true },
  }
}
