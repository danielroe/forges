import type { ReferenceSyntax, WebDefinition } from '../web.ts'
import { githubShapedWeb, OWNER_NAME } from '../web.ts'

const RESERVED_PATHS = ['about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise', 'enterprises', 'events', 'explore', 'features', 'gist', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'signup', 'site', 'sponsors', 'stars', 'topics', 'trending', 'users', 'watching']

const REFERENCES: ReferenceSyntax = { threads: [{ prefix: '#', kind: 'issue' }, { prefix: 'GH-', kind: 'issue', sameRepo: true }], repo: OWNER_NAME, commits: true }

export function isGheCom(host: string): boolean {
  return /^api\.[^.]+\.ghe\.com$/.test(host)
}

/** The web host for an API host: `api.github.com` and `api.<name>.ghe.com` drop the `api.` prefix. */
export function webHost(host: string): string {
  return host === 'api.github.com' || isGheCom(host) ? host.slice(4) : host
}

export const GITHUB_WEB: WebDefinition<'github'> = {
  forge: 'github',
  baseUrl: 'https://api.github.com',
  instance: webHost,
  links: ({ baseUrl }) => {
    const host = new URL(baseUrl).host
    const enterprise = host !== 'api.github.com' && !isGheCom(host)
    return githubShapedWeb(enterprise ? baseUrl.replace(/\/api\/v3$/, '') : `https://${webHost(host)}`, {
      pull: 'pull',
      discussions: true,
      ...host === 'api.github.com' ? { rawOrigin: 'https://raw.githubusercontent.com' } : {},
      commentFragment: 'issuecomment-',
      file: at => `/blob/${encodeURIComponent(at)}`,
      lineFragment: line => `L${line}`,
      reserved: RESERVED_PATHS,
      references: REFERENCES,
    })
  },
}
