import type { RepoRef, ThreadRef } from '../model.ts'
import type { WebLinks } from '../web.ts'

const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const gitPath = (repo: RepoRef) => `/${encode(repo.owner)}/_git/${encodeURIComponent(repo.name)}`
const isSha = (at: string) => /^[0-9a-f]{40}$/i.test(at)
const version = (at: string) => `${isSha(at) ? 'GC' : 'GB'}${encodeURIComponent(at)}`

export function azureWeb(origin: string): WebLinks {
  return {
    origin,
    repo: repo => repo.kind === 'namespace' ? `/${encode(repo.owner)}` : gitPath(repo),
    thread: (ref) => {
      if (ref.kind === 'issue') {
        return `/${encode(ref.repo.owner)}/_workitems/edit/${encodeURIComponent(ref.number)}`
      }
      if (ref.kind === 'pull_request') {
        return `${gitPath(ref.repo)}/pullrequest/${encodeURIComponent(ref.number)}`
      }
      return ref.kind === 'commit' ? `${gitPath(ref.repo)}/commit/${encodeURIComponent(ref.number)}` : undefined
    },
    file: (repo, path, at, line) => `${gitPath(repo)}?path=${encodeURIComponent(`/${path}`)}&version=${version(at)}${line ? `&line=${line}` : ''}`,
    raw: (repo, path, at) => `/${encode(repo.owner)}/_apis/git/repositories/${encodeURIComponent(repo.name)}/items?path=${encodeURIComponent(`/${path}`)}&versionDescriptor.version=${encodeURIComponent(at)}&versionDescriptor.versionType=${isSha(at) ? 'commit' : 'branch'}&$format=octetStream`,
    compare: (repo, base, head) => `${gitPath(repo)}/branchCompare?baseVersion=${version(base)}&targetVersion=${version(head)}`,
    parse: (segments, _url, from) => {
      const [org, project, section, ...rest] = segments
      if (!org || !project) {
        return undefined
      }
      const owner = `${org}/${project}`
      if (section === '_workitems' && rest[0] === 'edit' && rest[1]) {
        const repo: RepoRef = { ...from, owner, name: '', kind: 'namespace' }
        return { repo, thread: { ...from, repo, kind: 'issue', number: rest[1] } }
      }
      if (section !== '_git' || !rest[0]) {
        return { repo: { ...from, owner, name: '', kind: 'namespace' } }
      }
      const repo: RepoRef = { ...from, owner, name: rest[0] }
      const kind = rest[1] === 'pullrequest' ? 'pull_request' : rest[1] === 'commit' ? 'commit' : undefined
      if (!kind || !rest[2]) {
        return { repo }
      }
      const thread: ThreadRef = { ...from, repo, kind, number: rest[2] }
      return { repo, thread }
    },
    reference: ref => ref.kind === 'issue' ? `#${ref.number}` : ref.kind === 'pull_request' ? `!${ref.number}` : undefined,
  }
}
