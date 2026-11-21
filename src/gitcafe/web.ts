import type { WebDefinition } from '../web.ts'
import { githubShapedWeb } from '../web.ts'

/** The first path segments that GitCafe keeps for itself, so they never name an account. */
const RESERVED_PATHS = [
  'api',
  'assets',
  'auth',
  'avatars',
  'device',
  'docs',
  'mcp',
  'new',
  'orgs',
  'pricing',
  'settings',
]

export const GITCAFE_WEB: WebDefinition<'gitcafe'> = {
  forge: 'gitcafe',
  baseUrl: 'https://git.cafe',
  apiPath: '/api',
  links: ({ baseUrl }) => githubShapedWeb(baseUrl.replace(/\/api$/, ''), {
    pull: 'pull',
    raw: false,
    // A comment's anchor is its id as it is, such as `#icomment_01m6…`.
    commentFragment: '',
    file: at => `/blob/${encodeURIComponent(at)}`,
    lineFragment: line => `L${line}`,
    sections: {
      compare: null,
      releases: null,
      forks: null,
      watchers: null,
    },
    reserved: RESERVED_PATHS,
  }),
}
