import type { WebDefinition } from '../web.ts'
import { githubShapedWeb } from '../web.ts'

const RESERVED_PATHS = ['admin', 'api', 'assets', 'dashboard', 'groups', 'new', 'plugin-assets', 'register', 'search', 'signin', 'signout', 'user']

export const GITBUCKET_WEB: WebDefinition<'gitbucket'> = {
  forge: 'gitbucket',
  // GitBucket has no public instance, so every provider names its own server.
  baseUrl: '',
  apiPath: '/api/v3',
  links: ({ baseUrl }) => {
    const links = githubShapedWeb(baseUrl.replace(/\/api\/v3$/, ''), {
      pull: 'pull',
      // GitBucket has no stargazer or watcher pages, and lists forks under the network.
      sections: { stargazers: null, watchers: null, forks: 'network/members' },
      commentFragment: 'comment-',
      file: at => `/blob/${encodeURIComponent(at)}`,
      lineFragment: line => `L${line}`,
      reserved: RESERVED_PATHS,
    })
    return {
      ...links,
      // A release page is `/releases/{tag}`, without GitHub's `tag` segment.
      release: ref => ref.tag ? `${links.repo(ref.repo)}/releases/${encodeURIComponent(ref.tag)}` : undefined,
      parse: (segments, url, from) => {
        // Clone URLs live under `/git/{owner}/{name}.git`.
        const [first, ...rest] = segments
        const path = first === 'git' ? rest : segments
        const [owner, name, section, tag] = path
        if (owner && name && section === 'releases' && tag && !RESERVED_PATHS.includes(owner.toLowerCase())) {
          const repo = { ...from, owner, name }
          return { repo, release: { ...from, repo, id: tag, tag } }
        }
        return links.parse(path, url, from)
      },
    }
  },
}
