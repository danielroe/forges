import type { RepoRef } from '../model.ts'
import type { WebDefinition, WebLinks } from '../web.ts'

/** Entire's prefix for repositories it hosts, beside `gh` for GitHub mirrors. */
export const HOST = 'et'

const projectPath = (project: string) => `/${HOST}/${encodeURIComponent(project)}`
const repoPath = (repo: RepoRef) => repo.kind === 'namespace' ? projectPath(repo.owner) : `${projectPath(repo.owner)}/${encodeURIComponent(repo.name)}`

export const ENTIRE_WEB: WebDefinition<'entire'> = {
  forge: 'entire',
  baseUrl: 'https://us.console.entire.io',
  apiPath: '/api/v1',
  instance: host => host.endsWith('.console.entire.io') ? 'entire.com' : host,
  links: ({ instance }) => entireWeb(instance === 'entire.com' ? 'https://entire.com' : `https://${instance}`),
}

/**
 * A project trail is at `/et/{project}/-/trails/{number}`, and a change, the
 * branch of one repository on a trail, at `/et/{project}/{repo}/trails/{number}`.
 */
function entireWeb(baseUrl: string): WebLinks {
  return {
    baseUrl,
    repo: repo => repoPath(repo),
    section: (repo, section) => {
      if (section === 'issues') {
        return `${projectPath(repo.owner)}/-/trails`
      }
      return section === 'pullRequests' && repo.kind !== 'namespace' ? `${repoPath(repo)}/trails` : undefined
    },
    thread: (ref) => {
      if (!ref.number) {
        return undefined
      }
      if (ref.kind === 'issue') {
        return `${projectPath(ref.repo.owner)}/-/trails/${encodeURIComponent(ref.number)}`
      }
      return ref.kind === 'pull_request' && ref.repo.kind !== 'namespace' ? `${repoPath(ref.repo)}/trails/${encodeURIComponent(ref.number)}` : undefined
    },
    parse: (segments, _url, from) => {
      const [host, project, name, section, number] = segments
      if (host !== HOST || !project) {
        return undefined
      }
      const namespace: RepoRef = { ...from, owner: project, name: '', kind: 'namespace' }
      if (!name) {
        return { repo: namespace }
      }
      if (name === '-') {
        return section === 'trails' && number && /^\d+$/.test(number)
          ? { repo: namespace, thread: { ...from, repo: namespace, kind: 'issue', number } }
          : { repo: namespace }
      }
      const repo: RepoRef = { ...from, owner: project, name }
      return section === 'trails' && number && /^\d+$/.test(number)
        ? { repo, thread: { ...from, repo, kind: 'pull_request', number } }
        : { repo }
    },
  }
}
