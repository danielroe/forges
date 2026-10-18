import type { WebDefinition } from '../web.ts'
import { githubShapedWeb } from '../web.ts'

export const PUSHIN_WEB: WebDefinition<'pushin'> = {
  forge: 'pushin',
  baseUrl: 'https://pushin.eu',
  apiPath: '/api/v1',
  links: ({ baseUrl }) => githubShapedWeb(baseUrl.replace(/\/api\/v1$/, ''), {
    pull: 'pulls',
    commit: 'commits',
    raw: false,
    sections: { forks: null, watchers: null },
    commentFragment: 'comment-',
    file: at => `/blob/${encodeURIComponent(at)}`,
    lineFragment: line => `L${line}`,
  }),
}
