import type { RepoRef, ThreadRef } from '../model.ts'
import type { RepoSection, WebLinks } from '../web.ts'
import { lineOf } from '../web.ts'

const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const gitPath = (repo: RepoRef) => `/${encode(repo.owner)}/_git/${encodeURIComponent(repo.name)}`
const REPO_PAGES: Partial<Record<RepoSection, string>> = { pullRequests: 'pullrequests', compare: 'branchCompare' }
const isSha = (at: string) => /^[0-9a-f]{40}$/i.test(at)
const version = (at: string) => `${isSha(at) ? 'GC' : 'GB'}${encodeURIComponent(at)}`
/** The `version` query of a file page: `GB` for a branch, `GC` for a commit or `GT` for a tag, then the revision. */
const FILE_VERSION_RE = /^G[BCT](.+)$/

export function azureWeb(baseUrl: string): WebLinks {
  return {
    baseUrl,
    repo: repo => repo.kind === 'namespace' ? `/${encode(repo.owner)}` : gitPath(repo),
    section: (repo, section) => {
      if (section === 'issues') {
        return `/${encode(repo.owner)}/_workitems`
      }
      return repo.kind === 'namespace' || !REPO_PAGES[section] ? undefined : `${gitPath(repo)}/${REPO_PAGES[section]}`
    },
    thread: (ref) => {
      if (ref.kind === 'issue') {
        return `/${encode(ref.repo.owner)}/_workitems/edit/${encodeURIComponent(ref.number)}`
      }
      if (ref.kind === 'pull_request') {
        return `${gitPath(ref.repo)}/pullrequest/${encodeURIComponent(ref.number)}`
      }
      return undefined
    },
    commit: (repo, sha) => repo.kind === 'namespace' ? undefined : `${gitPath(repo)}/commit/${encodeURIComponent(sha)}`,
    file: (repo, path, at, line) => `${gitPath(repo)}?path=${encodeURIComponent(`/${path}`)}&version=${version(at)}${line ? `&line=${line}` : ''}`,
    raw: (repo, path, at) => `/${encode(repo.owner)}/_apis/git/repositories/${encodeURIComponent(repo.name)}/items?path=${encodeURIComponent(`/${path}`)}&versionDescriptor.version=${encodeURIComponent(at)}&versionDescriptor.versionType=${isSha(at) ? 'commit' : 'branch'}&$format=octetStream`,
    compare: (repo, base, head) => `${gitPath(repo)}/branchCompare?baseVersion=${version(base)}&targetVersion=${version(head)}`,
    parse: (segments, url, from) => {
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
      const path = url.searchParams.get('path')?.replace(/^\//, '')
      if (!rest[1] && path) {
        const at = FILE_VERSION_RE.exec(url.searchParams.get('version') ?? '')?.[1]
        return { repo, file: { path, ...at ? { at } : {}, ...lineOf(url.searchParams.get('line')) } }
      }
      if (rest[1] === 'commit' && rest[2]) {
        return { repo, commit: { ...from, repo, sha: rest[2] } }
      }
      if (rest[1] !== 'pullrequest' || !rest[2]) {
        return { repo }
      }
      const thread: ThreadRef = { ...from, repo, kind: 'pull_request', number: rest[2] }
      return { repo, thread }
    },
    reference: ref => 'sha' in ref ? undefined : ref.kind === 'issue' ? `#${ref.number}` : `!${ref.number}`,
  }
}
