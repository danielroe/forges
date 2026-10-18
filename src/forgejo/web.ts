import type { WebDefinition } from '../web.ts'
import { githubShapedWeb } from '../web.ts'

const RESERVED_PATHS = ['-', '.well-known', 'admin', 'api', 'assets', 'attachments', 'avatars', 'captcha', 'explore', 'issues', 'login', 'milestones', 'notifications', 'org', 'pulls', 'repo', 'repo-avatars', 'search', 'user']

function forgejoWeb<Forge extends 'forgejo' | 'gitea'>(forge: Forge, baseUrl: string): WebDefinition<Forge> {
  return {
    forge,
    baseUrl,
    apiPath: '/api/v1',
    links: ({ baseUrl }) => githubShapedWeb(baseUrl.replace(/\/api\/v1$/, ''), {
      pull: 'pulls',
      // Forgejo and Gitea list stargazers at `/stars`, not `/stargazers`.
      sections: { stargazers: 'stars' },
      commentFragment: 'issuecomment-',
      file: at => /^[0-9a-f]{40}$/.test(at) ? `/src/commit/${at}` : `/src/${encodeURIComponent(at)}`,
      parseFile: ([route, qualifier, ref, ...rest]) => {
        if (route !== 'src' || !qualifier || !ref) {
          return undefined
        }
        // Gitea and Forgejo write `/src/branch/{ref}`, `/src/tag/{ref}` or
        // `/src/commit/{sha}`, and accept the shorter `/src/{ref}` too.
        if (qualifier === 'branch' || qualifier === 'tag' || qualifier === 'commit') {
          return rest.length ? { at: ref, path: rest.join('/') } : undefined
        }
        return { at: qualifier, path: [ref, ...rest].join('/') }
      },
      lineFragment: line => `L${line}`,
      reserved: RESERVED_PATHS,
    }),
  }
}

export const FORGEJO_WEB = /* @__PURE__ */ forgejoWeb('forgejo', 'https://codeberg.org')
export const GITEA_WEB = /* @__PURE__ */ forgejoWeb('gitea', 'https://gitea.com')
