import type { RepoRef } from '../model.ts'
import type { WebLinks } from '../web.ts'
import { lineOf } from '../web.ts'
import { serviceUrl } from './client.ts'

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const repoPath = (repo: RepoRef) => `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

/**
 * Sourcehut puts each service on its own subdomain. `baseUrl` is the git host,
 * the only host `parseUrl` reads back; issues and patches get absolute URLs.
 */
export function sourcehutWeb(instance: string): WebLinks {
  const git = serviceUrl(instance, 'git')
  const todo = serviceUrl(instance, 'todo')
  const lists = serviceUrl(instance, 'lists')
  return {
    baseUrl: git,
    repo: repo => repoPath(repo),
    section: (repo, section) => {
      if (repo.kind === 'namespace') {
        return undefined
      }
      if (section === 'issues') {
        return `${todo}${repoPath(repo)}`
      }
      if (section === 'pullRequests') {
        return `${lists}${repoPath(repo)}`
      }
      return undefined
    },
    thread: (ref) => {
      if (ref.kind === 'issue') {
        return `${todo}${repoPath(ref.repo)}/${encodeURIComponent(ref.number)}`
      }
      if (ref.kind === 'pull_request') {
        return `${lists}${repoPath(ref.repo)}/patches/${encodeURIComponent(ref.number)}`
      }
      if (ref.kind === 'commit') {
        return `${repoPath(ref.repo)}/commit/${encodeURIComponent(ref.number)}`
      }
      return undefined
    },
    // A file page carries the `item` segment; a directory page does not.
    file: (repo, path, at, line) => `${repoPath(repo)}/tree/${encodeURIComponent(at)}/item/${encodePath(path)}${line ? `#L${line}` : ''}`,
    // The raw bytes are on `blob` and the rendered page on `tree/<at>/item`, the reverse of GitHub.
    raw: (repo, path, at) => `${repoPath(repo)}/blob/${encodeURIComponent(at)}/${encodePath(path)}`,
    release: ref => ref.tag ? `${repoPath(ref.repo)}/tree/${encodeURIComponent(ref.tag)}` : undefined,
    parse: (segments, url, from) => {
      const [owner, name, section, at, marker] = segments
      if (!owner?.startsWith('~') || !name) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner, name: name.replace(/\.git$/, '') }
      if (section === 'tree' && at && marker === 'item' && segments[5]) {
        return { repo, file: { at, path: segments.slice(5).join('/'), ...lineOf(url.hash.replace(/^#L/, '')) } }
      }
      if (section === 'commit' && at) {
        return { repo, thread: { ...from, repo, kind: 'commit', number: at } }
      }
      return { repo }
    },
    reference: (ref, same) => {
      const number = ref.number
      if (ref.kind === 'commit') {
        return same ? number.slice(0, 7) : `${ref.repo.owner}/${ref.repo.name}@${number.slice(0, 7)}`
      }
      return `${same ? '' : `${ref.repo.owner}/${ref.repo.name}`}#${number}`
    },
  }
}
