import { github } from 'forges/github'
import { getContributors } from './contributors.ts'

export function createDocsGitHub(token: string) {
  return github({
    auth: token ? { type: 'token', token } : { type: 'anonymous' },
    timeout: 5000,
    readOnly: true,
  }).create()
}

export const getGitHubContributors = defineCachedFunction((token: string) => getContributors(createDocsGitHub(token)), {
  name: 'github-contributors',
  maxAge: 60 * 60,
  getKey: () => 'danielroe-forges',
})
