import type { RepoRef, ThreadRef } from '../model.ts'
import type { RepoSection, WebDefinition, WebLinks } from '../web.ts'
import { namespaceRef } from '../model.ts'
import { DEFAULT_REVISION, lineOf } from '../web.ts'

const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const gitPath = (repo: RepoRef) => `/${encode(repo.owner)}/_git/${encodeURIComponent(repo.name)}`
const REPO_PAGES: Partial<Record<RepoSection, string>> = { pullRequests: 'pullrequests', compare: 'branchCompare' }
const isSha = (at: string) => /^[0-9a-f]{40}$/i.test(at)
/** A bare revision could name a branch or a tag, so pinning a tag takes the full ref. */
const TAG_REF = 'refs/tags/'
const BRANCH_REF = 'refs/heads/'
const isTag = (at: string) => at.startsWith(TAG_REF)
const shortRef = (at: string) => at.startsWith(TAG_REF) ? at.slice(TAG_REF.length) : at.startsWith(BRANCH_REF) ? at.slice(BRANCH_REF.length) : at
const version = (at: string) => `${isSha(at) ? 'GC' : isTag(at) ? 'GT' : 'GB'}${encodeURIComponent(shortRef(at))}`
/** Azure DevOps resolves no `HEAD`; leaving the version off reads the default branch. */
const isDefaultRevision = (at: string) => at === DEFAULT_REVISION
/** A revision in a query, such as the `version` of a file page: `GB` for a branch, `GC` for a commit or `GT` for a tag, then the revision. */
const FILE_VERSION_RE = /^G([BCT])(.+)$/

/**
 * Reads a version query. A tag comes back as its full ref, and so does a branch named
 * like a sha or a ref, because either would otherwise rebuild as the other kind.
 */
function parseVersion(value: string | null): string | undefined {
  const [, type, ref] = FILE_VERSION_RE.exec(value ?? '') ?? []
  if (!ref) {
    return undefined
  }
  if (type === 'T') {
    return `${TAG_REF}${ref}`
  }
  return type === 'B' && (isSha(ref) || ref.startsWith('refs/')) ? `${BRANCH_REF}${ref}` : ref
}

export const AZURE_DEVOPS_WEB: WebDefinition<'azure-devops'> = {
  forge: 'azure-devops',
  baseUrl: 'https://dev.azure.com',
  links: ({ baseUrl }) => azureWeb(baseUrl),
}

function azureWeb(baseUrl: string): WebLinks {
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
      if (!ref.number) {
        return undefined
      }
      if (ref.kind === 'issue') {
        return `/${encode(ref.repo.owner)}/_workitems/edit/${encodeURIComponent(ref.number)}`
      }
      if (ref.kind === 'pull_request') {
        return `${gitPath(ref.repo)}/pullrequest/${encodeURIComponent(ref.number)}`
      }
      return undefined
    },
    commit: (repo, sha) => repo.kind === 'namespace' ? undefined : `${gitPath(repo)}/commit/${encodeURIComponent(sha)}`,
    file: (repo, path, at, line) => `${gitPath(repo)}?path=${encodeURIComponent(`/${path}`)}${isDefaultRevision(at) ? '' : `&version=${version(at)}`}${line ? `&line=${line}` : ''}`,
    raw: (repo, path, at) => `/${encode(repo.owner)}/_apis/git/repositories/${encodeURIComponent(repo.name)}/items?path=${encodeURIComponent(`/${path}`)}${isDefaultRevision(at) ? '' : `&versionDescriptor.version=${encodeURIComponent(shortRef(at))}&versionDescriptor.versionType=${isSha(at) ? 'commit' : isTag(at) ? 'tag' : 'branch'}`}&$format=octetStream`,
    compare: (repo, base, head) => `${gitPath(repo)}/branchCompare?baseVersion=${version(base)}&targetVersion=${version(head)}`,
    parse: (segments, url, from) => {
      const [org, project, section, ...rest] = segments
      if (!org || !project) {
        return undefined
      }
      const owner = `${org}/${project}`
      if (section === '_workitems' && rest[0] === 'edit' && rest[1]) {
        const repo = namespaceRef(from, owner)
        return { repo, thread: { ...from, repo, kind: 'issue', number: rest[1] } }
      }
      if (section !== '_git' || !rest[0]) {
        return { repo: namespaceRef(from, owner) }
      }
      const repo: RepoRef = { ...from, owner, name: rest[0] }
      const path = url.searchParams.get('path')?.replace(/^\//, '')
      if (!rest[1] && path) {
        const at = parseVersion(url.searchParams.get('version'))
        return { repo, file: { path, ...at ? { at } : {}, ...lineOf(url.searchParams.get('line')) } }
      }
      if (rest[1] === 'commit' && rest[2]) {
        return { repo, commit: { ...from, repo, sha: rest[2] } }
      }
      const base = parseVersion(url.searchParams.get('baseVersion'))
      const head = parseVersion(url.searchParams.get('targetVersion'))
      if (rest[1] === 'branchCompare' && base && head) {
        return { repo, compare: { base, head } }
      }
      if (rest[1] !== 'pullrequest' || !rest[2]) {
        return { repo }
      }
      const thread: ThreadRef = { ...from, repo, kind: 'pull_request', number: rest[2] }
      return { repo, thread }
    },
    reference: ref => 'sha' in ref || !ref.number ? undefined : ref.kind === 'issue' ? `#${ref.number}` : `!${ref.number}`,
    references: { threads: [{ prefix: '#', kind: 'issue', namespace: true }, { prefix: '!', kind: 'pull_request' }] },
  }
}
