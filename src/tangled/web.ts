import type { RepoRef, ThreadKind } from '../model.ts'
import type { WebLinks } from '../web.ts'

const SECTIONS: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: 'pulls' }

const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const repoPath = (repo: RepoRef) => `/${encodeURIComponent(repo.owner).replaceAll('%3A', ':')}/${encodeURIComponent(repo.name)}`

/** Tangled pages address threads by their display number, so parsed refs carry `displayNumber` and need resolving. */
export function tangledWeb(origin: string): WebLinks {
  return {
    origin,
    repo: repoPath,
    thread: (ref) => {
      if (ref.kind === 'commit') {
        return `${repoPath(ref.repo)}/commit/${encodeURIComponent(ref.number)}`
      }
      return SECTIONS[ref.kind] && ref.displayNumber ? `${repoPath(ref.repo)}/${SECTIONS[ref.kind]}/${encodeURIComponent(ref.displayNumber)}` : undefined
    },
    file: (repo, path, at, line) => `${repoPath(repo)}/blob/${encodeURIComponent(at)}/${encode(path)}${line ? `#L${line}` : ''}`,
    raw: (repo, path, at) => `${repoPath(repo)}/raw/${encodeURIComponent(at)}/${encode(path)}`,
    parse: (segments, _url, from) => {
      const [owner, name, section, id] = segments
      if (!owner || !name) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner: owner.replace(/^@/, ''), name }
      if (section === 'commit' && id) {
        return { repo, thread: { ...from, repo, kind: 'commit', number: id } }
      }
      const kind = section === 'issues' ? 'issue' : section === 'pulls' ? 'pull_request' : undefined
      return kind && id ? { repo, thread: { ...from, repo, kind, displayNumber: id } } : { repo }
    },
  }
}
