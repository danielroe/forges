import type { RepoRef, ThreadKind, ThreadRef } from '../model.ts'
import type { ReferenceSyntax, RepoSection, WebLinks } from '../web.ts'
import { lineOf, rangeOf } from '../web.ts'

const SECTIONS: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: 'merge_requests' }
const KINDS = new Map(Object.entries(SECTIONS).map(([kind, section]) => [section, kind as ThreadKind]))
const PREFIXES: Partial<Record<ThreadKind, string>> = { issue: '#', pull_request: '!' }
const PAGES: Partial<Record<RepoSection, string>> = { issues: 'issues', pullRequests: 'merge_requests', compare: 'compare', releases: 'releases', stargazers: 'starrers', forks: 'forks' }
const GROUP_PAGES: Partial<Record<RepoSection, string>> = { issues: 'issues', pullRequests: 'merge_requests' }
const REFERENCES: ReferenceSyntax = {
  threads: [{ prefix: '#', kind: 'issue' }, { prefix: '!', kind: 'pull_request' }],
  repo: String.raw`(?:[\w.-]+\/)+[\w.-]+`,
  suffix: String.raw`\+s?`,
  commits: true,
}

const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const projectPath = (repo: RepoRef) => `/${encode(repo.owner)}/${encodeURIComponent(repo.name)}`

export function gitlabWeb(baseUrl: string): WebLinks {
  return {
    baseUrl,
    repo: repo => repo.kind === 'namespace' ? `/${encode(repo.owner)}` : projectPath(repo),
    section: (repo, section) => repo.kind === 'namespace'
      ? GROUP_PAGES[section] && `/groups/${encode(repo.owner)}/-/${GROUP_PAGES[section]}`
      : PAGES[section] && `${projectPath(repo)}/-/${PAGES[section]}`,
    thread: ref => ref.repo.kind === 'namespace' || !SECTIONS[ref.kind] ? undefined : `${projectPath(ref.repo)}/-/${SECTIONS[ref.kind]}/${encodeURIComponent(ref.number)}`,
    comment: ref => ref.thread.repo.kind === 'namespace' || !SECTIONS[ref.thread.kind] ? undefined : `${projectPath(ref.thread.repo)}/-/${SECTIONS[ref.thread.kind]}/${encodeURIComponent(ref.thread.number)}#note_${ref.id}`,
    commit: (repo, sha) => repo.kind === 'namespace' ? undefined : `${projectPath(repo)}/-/commit/${encodeURIComponent(sha)}`,
    release: ref => ref.tag ? `${projectPath(ref.repo)}/-/releases/${encodeURIComponent(ref.tag)}` : undefined,
    file: (repo, path, at, line) => `${projectPath(repo)}/-/blob/${encodeURIComponent(at)}/${encode(path)}${line ? `#L${line}` : ''}`,
    raw: (repo, path, at) => `${projectPath(repo)}/-/raw/${encodeURIComponent(at)}/${encode(path)}`,
    compare: (repo, base, head) => `${projectPath(repo)}/-/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    parse: (segments, url, from) => {
      const separator = segments.indexOf('-')
      const path = separator < 0 ? segments : segments.slice(0, separator)
      if (path.length < 2) {
        return undefined
      }
      const repo: RepoRef = { ...from, owner: path.slice(0, -1).join('/'), name: path.at(-1)!.replace(/\.git$/, '') }
      const [section, id] = separator < 0 ? [] : segments.slice(separator + 1)
      if (section === 'blob' && id && segments.length > separator + 3) {
        return { repo, file: { at: id, path: segments.slice(separator + 3).join('/'), ...lineOf(url.hash.replace(/^#L/, '')) } }
      }
      if (section === 'releases' && id) {
        return { repo, release: { ...from, repo, id, tag: id } }
      }
      if (section === 'commit' && id) {
        return { repo, commit: { ...from, repo, sha: id } }
      }
      if (section === 'tags' && id) {
        return { repo, tag: segments.slice(separator + 2).join('/') }
      }
      if (section === 'compare' && id) {
        return { repo, ...rangeOf(segments.slice(separator + 2).join('/')) }
      }
      const kind = section ? KINDS.get(section) : undefined
      if (!kind || !id) {
        return { repo }
      }
      const thread: ThreadRef = { ...from, repo, kind, number: id }
      const sha = kind === 'pull_request' ? url.searchParams.get('commit_id') : undefined
      if (sha) {
        return { repo, thread, commit: { ...from, repo, sha } }
      }
      const note = url.hash.startsWith('#note_') ? url.hash.slice('#note_'.length) : undefined
      return { repo, thread, ...note ? { comment: { ...from, thread, id: note } } : {} }
    },
    reference: (ref, same, expand) => {
      if ('sha' in ref) {
        return `${same ? '' : `${ref.repo.owner}/${ref.repo.name}@`}${ref.sha.slice(0, 8)}`
      }
      const prefix = PREFIXES[ref.kind]
      if (!prefix || ref.repo.kind === 'namespace') {
        return undefined
      }
      return `${same ? '' : `${ref.repo.owner}/${ref.repo.name}`}${prefix}${ref.number}${expand ? '+' : ''}`
    },
    references: REFERENCES,
  }
}
