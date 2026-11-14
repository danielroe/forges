import type { WebDefinition } from '../web.ts'
import { githubShapedWeb } from '../web.ts'

/** Top-level paths of upstream.codes that are not accounts. */
const RESERVED_PATHS = [
  'about',
  'api',
  'apps',
  'attachments',
  'auth',
  'blog',
  'brand',
  'change-requests',
  'changelog',
  'claim',
  'cli',
  'compare',
  'dashboard',
  'docs',
  'downloads',
  'enterprise',
  'explore',
  'feed',
  'integrations',
  'invites',
  'issues',
  'legal',
  'login',
  'migrate',
  'notifications',
  'onset',
  'open-source',
  'organizations',
  'plugins',
  'pricing',
  'product',
  'profile',
  'rapid',
  'redeem',
  'repositories',
  'roadmap',
  'search',
  'security',
  'settings',
  'share',
  'stars',
  'support',
  'topics',
  'trending',
]

export const UPSTREAM_WEB: WebDefinition<'upstream'> = {
  forge: 'upstream',
  baseUrl: 'https://upstream.codes',
  apiPath: '/api/v3',
  instance: host => host === 'api.upstream.codes'
    ? 'upstream.codes'
    : host,
  links: ({ baseUrl }) => {
    const root = baseUrl.replace(/\/api\/v3$/, '').replace('://api.upstream.codes', '://upstream.codes')
    const links = githubShapedWeb(root, {
      // Upstream calls pull requests change requests.
      pull: 'changes',
      commentFragment: 'comment-',
      file: at => `/blob/${encodeURIComponent(at)}`,
      lineFragment: line => `L${line}`,
      sections: { pullRequests: 'changes', watchers: null },
      reserved: RESERVED_PATHS,
    })
    return {
      ...links,
      // A release page is addressed by an internal id that the API doesn't return, so no link names one release.
      release: () => undefined,
    }
  },
}
