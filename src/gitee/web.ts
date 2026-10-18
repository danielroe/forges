import type { ReferenceSyntax, WebDefinition } from '../web.ts'
import { githubShapedWeb, OWNER_NAME } from '../web.ts'

/** Gitee numbers issues with an `I` and five letters or digits, such as `I6XZ2N`, and pull requests with digits. */
const REFERENCES: ReferenceSyntax = { threads: [{ prefix: '#', kind: 'issue', number: 'I[A-Z0-9]{5}' }, { prefix: '!', kind: 'pull_request' }], repo: OWNER_NAME, commits: true }

export const GITEE_WEB: WebDefinition<'gitee'> = {
  forge: 'gitee',
  baseUrl: 'https://gitee.com',
  apiPath: '/api/v5',
  links: ({ baseUrl }) => githubShapedWeb(baseUrl.replace(/\/api\/v5$/, ''), {
    pull: 'pulls',
    sections: { forks: 'members' },
    commentFragment: 'note_',
    file: at => `/blob/${encodeURIComponent(at)}`,
    lineFragment: line => `L${line}`,
    pullPrefix: '!',
    references: REFERENCES,
  }),
}
