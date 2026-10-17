import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { fake } from '../../src/fake/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitea } from '../../src/gitea/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'

describe('queryRaw', () => {
  it('adds forge-native syntax to every GitHub search', async () => {
    const queries: string[] = []
    const provider = github({
      auth: { type: 'token', token: 't' },
      fetch: async (url) => {
        queries.push(new URL(url).searchParams.get('q') ?? '')
        return Response.json({ items: [] })
      },
    })

    await provider.search.threads({ text: 'crash', kind: 'issue', queryRaw: 'review-requested:octocat' }).page()
    await provider.search.repos({ owner: 'acme', queryRaw: 'stars:>100' }).page()
    await provider.search.commits({ text: 'fix', queryRaw: 'merge:false' }).page()
    await provider.search.code({ text: 'useFetch', owner: 'acme', queryRaw: 'language:typescript' }).page()

    expect(queries).toEqual(['crash is:issue review-requested:octocat', 'user:acme stars:>100', 'fix merge:false', 'useFetch user:acme language:typescript'])
  })

  it('searches issues and pull requests in one advanced search when no kind is given', async () => {
    const requests: URL[] = []
    const provider = github({
      fetch: async (url) => {
        requests.push(new URL(url))
        return Response.json({ items: [] })
      },
    })

    await provider.search.threads({ text: 'crash OR hang', repo: { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }, queryRaw: 'author:a OR author:b' }).page()

    expect(requests.map(url => url.searchParams.get('q'))).toEqual(['(crash OR hang) repo:acme/widgets (is:issue OR is:pr) (author:a OR author:b)'])
    expect(requests[0]!.searchParams.get('advanced_search')).toBe('true')
  })

  it('ignores parentheses and an unclosed quote in free text in an advanced search, as legacy search does', async () => {
    const queries: string[] = []
    const provider = github({
      fetch: async (url) => {
        queries.push(new URL(url).searchParams.get('q') ?? '')
        return Response.json({ items: [] })
      },
    })

    await provider.search.threads({ text: 'useFetch() OR "a (b" "dangling(' }).page()
    await provider.search.threads({ text: '()' }).page()
    await provider.search.threads({ text: 'useFetch()', kind: 'issue' }).page()

    expect(queries).toEqual(['(useFetch OR "a (b" dangling) (is:issue OR is:pr)', '(is:issue OR is:pr)', 'useFetch() is:issue'])
  })

  it.each([
    ['on GitHub Enterprise Server', { baseUrl: 'https://github.example.com/api/v3' }],
    ['with a GitHub App user access token', { auth: { type: 'token', token: async () => 'ghu_abc' } }],
  ] as const)('searches issues, then pull requests, %s when no kind is given', async (_, options) => {
    const requests: URL[] = []
    const provider = github({
      ...options,
      fetch: async (url) => {
        requests.push(new URL(url))
        return Response.json({ items: [] })
      },
    })
    const repo = { forge: 'github', instance: provider.instance, owner: 'acme', name: 'widgets' }

    const first = await provider.search.threads({ text: 'crash', repo }).page()
    await provider.search.threads({ text: 'crash', repo, cursor: first.cursor }).page()

    expect(requests.map(url => url.searchParams.get('q'))).toEqual(['crash repo:acme/widgets is:issue', 'crash repo:acme/widgets is:pr'])
    expect(requests.every(url => !url.searchParams.has('advanced_search'))).toBe(true)
  })

  it('drops it with a warning where the search has no query syntax', async () => {
    const searches: URL[] = []
    const provider = gitlab({
      fetch: async (url) => {
        searches.push(new URL(url))
        return Response.json([])
      },
    })

    const first = await provider.search.repos({ text: 'widgets', queryRaw: 'stars:>100' }).page()
    const next = await provider.search.repos({ text: 'widgets', queryRaw: 'stars:>100', cursor: { nextUrl: 'https://gitlab.com/api/v4/projects?page=2' } }).page()

    expect(first.warnings?.map(warning => warning.code)).toEqual(['filter_unsupported'])
    expect(next.warnings).toBeUndefined()
    expect(searches.every(url => !url.search.includes('stars'))).toBe(true)
  })
})

describe('owner', () => {
  function recording(body: unknown) {
    const requests: URL[] = []
    const fetch = async (url: string) => {
      requests.push(new URL(url))
      return Response.json(body)
    }
    return { requests, fetch }
  }

  it('narrows a GitHub thread search to the account, unless a repository is given', async () => {
    const { requests, fetch } = recording({ items: [] })
    const provider = github({ auth: { type: 'token', token: 't' }, fetch })

    await provider.search.threads({ text: 'crash', kind: 'issue', owner: 'nuxt' }).page()
    await provider.search.threads({ text: 'crash', kind: 'issue', owner: 'nuxt', repo: { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' } }).page()

    expect(requests.map(url => url.searchParams.get('q'))).toEqual(['crash user:nuxt is:issue', 'crash repo:acme/widgets is:issue'])
  })

  it('searches the issues and merge requests of a GitLab group', async () => {
    const { requests, fetch } = recording([])
    const provider = gitlab({ auth: { type: 'token', token: 't' }, fetch })

    const first = await provider.search.threads({ text: 'crash', owner: 'acme/platform' }).page()
    await provider.search.threads({ text: 'crash', owner: 'acme/platform', cursor: first.cursor }).page()

    expect(requests.map(url => url.pathname)).toEqual(['/api/v4/groups/acme%2Fplatform/issues', '/api/v4/groups/acme%2Fplatform/merge_requests'])
  })

  it.each([['Forgejo', forgejo], ['Gitea', gitea]] as const)('passes it to the %s issue search', async (_, create) => {
    const { requests, fetch } = recording([])
    await create({ auth: { type: 'token', token: 't' }, fetch }).search.threads({ text: 'crash', owner: 'acme' }).page()

    expect(requests[0]!.searchParams.get('owner')).toBe('acme')
  })

  it('searches the work items of the Azure DevOps project it names', async () => {
    const { requests, fetch } = recording({ workItems: [] })
    const provider = azureDevOps({ auth: { type: 'token', token: 'pat' }, organization: 'acme', fetch })

    await provider.search.threads({ text: 'crash', owner: 'acme/Widgets' }).page()

    expect(requests.map(url => url.pathname)).toEqual(['/acme/Widgets/_apis/wit/wiql'])
  })

  it('warns where the search cannot filter by owner', async () => {
    const { fetch } = recording([])
    const provider = gitee({ auth: { type: 'token', token: 't' }, fetch })

    const first = await provider.search.threads({ text: 'crash', owner: 'acme' }).page()
    const next = await provider.search.threads({ text: 'crash', owner: 'acme', cursor: { token: '2' } }).page()

    expect(first.warnings).toContainEqual(expect.objectContaining({ code: 'filter_unsupported' }))
    expect(next.warnings).toBeUndefined()
  })

  it('keeps the fake forge\'s threads of other owners out', async () => {
    const forge = fake({ seed: { threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Crash on start' }, { repo: 'other/gadgets', kind: 'issue', title: 'Crash on exit' }] } })

    const threads = await Array.fromAsync(forge.search.threads({ text: 'crash', owner: 'acme' }))

    expect(threads.map(thread => thread.title)).toEqual(['Crash on start'])
  })
})
