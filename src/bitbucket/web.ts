import type { RepoRef, ThreadKind, ThreadRef } from '../model.ts'
import type { WebLinks } from '../web.ts'

const SECTIONS: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: 'pull-requests', commit: 'commits' }
const KINDS = new Map(Object.entries(SECTIONS).map(([kind, section]) => [section, kind as ThreadKind]))

const repoPath = (repo: RepoRef) => `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

export function bitbucketWeb(origin: string): WebLinks {
  return {
    origin,
    repo: repoPath,
    thread: ref => SECTIONS[ref.kind] && `${repoPath(ref.repo)}/${SECTIONS[ref.kind]}/${encodeURIComponent(ref.number)}`,
    comment: ref => ref.thread.kind === 'commit' || !SECTIONS[ref.thread.kind] ? undefined : `${repoPath(ref.thread.repo)}/${SECTIONS[ref.thread.kind]}/${encodeURIComponent(ref.thread.number)}#comment-${ref.id}`,
    file: (repo, path, at, line) => `${repoPath(repo)}/src/${encodeURIComponent(at)}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#lines-${line}` : ''}`,
    raw: (repo, path, at) => `${repoPath(repo)}/raw/${encodeURIComponent(at)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    compare: (repo, base, head) => `${repoPath(repo)}/branches/compare/${encodeURIComponent(head)}%0D${encodeURIComponent(base)}`,
    parse: (segments, url, from) => {
      const [owner, name, section, id] = segments
      if (!owner || !name) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner, name: name.replace(/\.git$/, '') }
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
      return ref.kind === 'issue' ? `#${ref.number}` : ref.kind === 'pull_request' ? `pull request #${ref.number}` : ref.kind === 'commit' ? ref.number.slice(0, 12) : undefined
    },
  }
}
