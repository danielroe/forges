import type { RepoRef, ThreadKind, ThreadRef } from '../model.ts'
import type { WebDefinition, WebLinks } from '../web.ts'

/** The explorer that browses any public node by its host. */
export const RADICLE_EXPLORER = 'https://radicle.network'

const SECTIONS: Partial<Record<ThreadKind, string>> = { issue: 'issues', pull_request: 'patches' }
const KINDS: Record<string, ThreadKind> = { issues: 'issue', patches: 'pull_request' }

/** A repository id, `z` and then base58, with or without `rad:`. */
const RID = /^(?:rad:)?z[1-9A-HJ-NP-Za-km-z]+$/

/** The repository id with its `rad:` prefix. */
export function ridOf(repo: RepoRef): string {
  if (!RID.test(repo.name)) {
    throw new TypeError(`${JSON.stringify(repo.name)} is not a Radicle repository id, such as rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5`)
  }
  return repo.name.startsWith('rad:')
    ? repo.name
    : `rad:${repo.name}`
}

/** The ref of a repository, which has no owner, so `owner` is `rad`. */
export function radicleRepoRef(origin: { forge: string, instance: string }, rid: string): RepoRef {
  const id = rid.replace(/^rad:/, '')
  return {
    ...origin,
    owner: 'rad',
    name: id,
    externalId: `rad:${id}`,
  }
}

export const RADICLE_WEB: WebDefinition<'radicle'> = {
  forge: 'radicle',
  baseUrl: 'https://seed.radicle.dev',
  apiPath: '/api/v1',
  links: ({ baseUrl }) => radicleWeb(`${RADICLE_EXPLORER}/nodes/${new URL(baseUrl).host}`),
}

function radicleWeb(baseUrl: string): WebLinks {
  const repoPath = (repo: RepoRef) => `/${ridOf(repo)}`
  const threadPath = (ref: ThreadRef) => SECTIONS[ref.kind] && ref.number
    ? `${repoPath(ref.repo)}/${SECTIONS[ref.kind]}/${encodeURIComponent(ref.number)}`
    : undefined
  return {
    baseUrl,
    repo: repoPath,
    section: (repo, section) => repo.kind === 'namespace'
      ? undefined
      : section === 'issues'
        ? `${repoPath(repo)}/issues`
        : section === 'pullRequests'
          ? `${repoPath(repo)}/patches`
          : undefined,
    thread: threadPath,
    commit: (repo, sha) => `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
    file: (repo, path, at) => `${repoPath(repo)}/tree/${encodeURIComponent(at)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    parse: (segments, _url, origin) => {
      const [rid, section, id] = segments
      if (!rid?.startsWith('rad:')) {
        return undefined
      }
      const repo = radicleRepoRef(origin, rid)
      if (section === 'tree' && id && segments[3]) {
        return {
          repo,
          file: {
            at: id,
            path: segments.slice(3).join('/'),
          },
        }
      }
      if (section === 'commits' && id) {
        return {
          repo,
          commit: { ...origin, repo, sha: id },
        }
      }
      const kind = section && KINDS[section]
      return kind && id
        ? {
            repo,
            thread: { ...origin, repo, kind, number: id },
          }
        : { repo }
    },
  }
}
