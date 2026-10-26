import type { RepoRef } from '../model.ts'
import type { WebDefinition, WebLinks } from '../web.ts'
import { bareSha, lineOf } from '../web.ts'
import { serviceHost, serviceUrl } from './services.ts'

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const repoPath = (repo: RepoRef) => `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

export const SOURCEHUT_WEB: WebDefinition<'sourcehut'> = {
  forge: 'sourcehut',
  baseUrl: 'https://sr.ht',
  links: ({ instance }) => sourcehutWeb(instance),
}

/**
 * Sourcehut puts each service on its own subdomain. `baseUrl` is the git host;
 * `parseUrl` also reads the issue and mailing-list hosts, whose threads get
 * absolute URLs rather than being relative to the git host.
 */
function sourcehutWeb(instance: string): WebLinks {
  const git = serviceUrl(instance, 'git')
  const todo = serviceUrl(instance, 'todo')
  const lists = serviceUrl(instance, 'lists')
  const todoHost = serviceHost(instance, 'todo')
  const listsHost = serviceHost(instance, 'lists')
  return {
    baseUrl: git,
    hosts: [todoHost, listsHost],
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
      const number = ref.displayNumber ?? ref.number
      if (!number) {
        return undefined
      }
      if (ref.kind === 'issue') {
        return `${todo}${repoPath(ref.repo)}/${encodeURIComponent(number)}`
      }
      if (ref.kind === 'pull_request') {
        return `${lists}${repoPath(ref.repo)}/patches/${encodeURIComponent(number)}`
      }
      return undefined
    },
    commit: (repo, sha) => `${repoPath(repo)}/commit/${encodeURIComponent(sha)}`,
    // A file page carries the `item` segment; a directory page does not.
    file: (repo, path, at, line) => `${repoPath(repo)}/tree/${encodeURIComponent(at)}/item/${encodePath(path)}${line ? `#L${line}` : ''}`,
    // The raw bytes are on `blob` and the rendered page on `tree/<at>/item`, the reverse of GitHub.
    raw: (repo, path, at) => `${repoPath(repo)}/blob/${encodeURIComponent(at)}/${encodePath(path)}`,
    release: ref => ref.tag ? `${repoPath(ref.repo)}/tree/${encodeURIComponent(ref.tag)}` : undefined,
    parse: (segments, url, from) => {
      // Tickets and patchsets are identified by an integer id, which is both the
      // API number and the display number, so a parsed ref is already resolved.
      if (url.host === todoHost) {
        const [owner, name, id] = segments
        if (!owner?.startsWith('~') || !name) {
          return undefined
        }
        const repo: RepoRef = { ...from, owner, name }
        // Other trailing segments, such as `settings`, are tracker pages, not tickets.
        return id && /^\d+$/.test(id) ? { repo, thread: { ...from, repo, kind: 'issue', number: id, displayNumber: id } } : { repo }
      }
      if (url.host === listsHost) {
        const [owner, name, marker, id] = segments
        if (!owner?.startsWith('~') || !name) {
          return undefined
        }
        const repo: RepoRef = { ...from, owner, name }
        return marker === 'patches' && id && /^\d+$/.test(id) ? { repo, thread: { ...from, repo, kind: 'pull_request', number: id, displayNumber: id } } : { repo }
      }
      const [owner, name, section, at, marker] = segments
      if (!owner?.startsWith('~') || !name) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner, name: name.replace(/\.git$/, '') }
      if (section === 'tree' && at && marker === 'item' && segments[5]) {
        return { repo, file: { at, path: segments.slice(5).join('/'), ...lineOf(url.hash.replace(/^#L/, '')) } }
      }
      if (section === 'commit' && at) {
        return { repo, commit: { ...from, repo, sha: at } }
      }
      return { repo }
    },
    reference: (ref, same) => {
      if ('sha' in ref) {
        return (same ? bareSha(ref.sha, 7) : undefined) ?? `${ref.repo.owner}/${ref.repo.name}@${ref.sha.slice(0, 7)}`
      }
      // Only issues have a text syntax; a patchset falls back to its lists.sr.ht URL.
      if (ref.kind !== 'issue') {
        return undefined
      }
      const number = ref.displayNumber ?? ref.number
      return number ? `${same ? '' : `${ref.repo.owner}/${ref.repo.name}`}#${number}` : undefined
    },
    references: { threads: [{ prefix: '#', kind: 'issue' }], repo: String.raw`~[\w.-]+\/[\w.-]+`, commits: true },
  }
}
