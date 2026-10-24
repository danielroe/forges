import type { WebDefinition } from '../web.ts'
import { githubShapedWeb } from '../web.ts'

export const PUSHIN_WEB: WebDefinition<'pushin'> = {
  forge: 'pushin',
  baseUrl: 'https://pushin.eu',
  apiPath: '/api/v1',
  links: ({ baseUrl }) => githubShapedWeb(baseUrl.replace(/\/api\/v1$/, ''), {
    pull: 'pulls',
    commit: 'commits',
    ...new URL(baseUrl).host === 'pushin.eu' ? { rawOrigin: 'https://raw.pushin.eu' } : { raw: false },
    sections: { forks: null, watchers: null },
    commentFragment: 'comment-',
    file: at => `/blob/${encodeURIComponent(at)}`,
    lineFragment: line => `L${line}`,
  }),
}
