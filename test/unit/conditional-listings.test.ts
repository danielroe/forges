import type { Fixture } from '../../src/testing/index.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { createFetcher } from '../../src/fetch.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { fixtureFetch } from '../../src/testing/index.ts'
import { fixtureDirectory } from '../utils/fixtures.ts'

const token = { type: 'token', token: 't' } as const
const notModified = (etag: string): Fixture['response'] => ({ status: 304, headers: { etag } })
const listed = (body: unknown, headers: Record<string, string> = {}): Fixture['response'] => ({ status: 200, headers, body })
const sentEtags = (calls: Array<{ headers: Headers }>) => calls.map(call => call.headers.get('if-none-match'))

describe('fetcher.page', () => {
  const first = 'https://api.example/items?per_page=2'
  const second = 'https://api.example/items?per_page=2&page=2'

  function fetcherFor(response: Fixture['response']) {
    const served = fixtureFetch([], { [`GET ${first}`]: response, [`GET ${second}`]: listed([], { etag: 'W/"two"' }) })
    return { fetcher: createFetcher({ baseUrl: 'https://api.example', fetch: served.fetch }), calls: served.calls }
  }

  it('sends the etag of a first-page cursor and reports the validator of a `304`', async () => {
    const { fetcher, calls } = fetcherFor(notModified('W/"one"'))

    const result = await fetcher.page('/items', { query: { per_page: 2 }, cursor: { etag: 'W/"one"' } })

    expect(sentEtags(calls)).toEqual(['W/"one"'])
    expect(result).toMatchObject({ notModified: true, data: [], cursor: undefined, etag: 'W/"one"' })
  })

  it('reports the validator of a first page that changed', async () => {
    const { fetcher } = fetcherFor(listed([1], { etag: 'W/"new"', link: `<${second}>; rel="next"` }))

    const result = await fetcher.page('/items', { query: { per_page: 2 }, cursor: { etag: 'W/"one"' } })

    expect(result).toMatchObject({ notModified: false, data: [1], etag: 'W/"new"', cursor: { nextUrl: second } })
  })

  it('reports no etag for a changed first page that has none', async () => {
    const { fetcher } = fetcherFor(listed([1]))

    const result = await fetcher.page('/items', { query: { per_page: 2 }, cursor: { etag: 'W/"one"' } })

    expect(result.etag).toBeUndefined()
  })

  it('never sends the etag for a later page', async () => {
    const { fetcher, calls } = fetcherFor(listed([1]))

    const next = await fetcher.page('/items', { query: { per_page: 2 }, cursor: { nextUrl: second, etag: 'W/"one"' } })
    await fetcher.page('/items', { query: { per_page: 2 }, cursor: { token: '2', etag: 'W/"one"' } })

    expect(sentEtags(calls)).toEqual([null, null])
    expect(next.etag).toBeUndefined()
  })

  it('sends no etag and reports none when the page is not conditional', async () => {
    const { fetcher, calls } = fetcherFor(listed([1], { etag: 'W/"new"' }))

    const result = await fetcher.page('/items', { query: { per_page: 2 }, cursor: { etag: 'W/"one"' }, conditional: false })

    expect(sentEtags(calls)).toEqual([null])
    expect(result.etag).toBeUndefined()
  })

  it('sends no `If-None-Match` without an etag', async () => {
    const { fetcher, calls } = fetcherFor(listed([1], { etag: 'W/"new"' }))

    const result = await fetcher.page('/items', { query: { per_page: 2 } })

    expect(sentEtags(calls)).toEqual([null])
    expect(result.etag).toBe('W/"new"')
  })
})

describe('github', () => {
  const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' } as const
  const issues = 'https://api.github.com/repos/acme/widgets/issues'
  const pull = { number: 7, title: 'Fix', state: 'open', pull_request: {}, user: { login: 'ada', id: 1 }, labels: [], created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }
  const issue = { ...pull, number: 6, pull_request: undefined }

  it('reads an unchanged first page of threads without reading its checks', async () => {
    const { fetch, calls } = fixtureFetch([], { [`GET ${issues}?state=all&sort=updated&direction=desc`]: notModified('W/"one"') })
    const provider = github({ auth: token, fetch }).create()

    const page = await provider.threads.listPage(repo, { state: 'all', sort: 'updated', cursor: { etag: 'W/"one"' } })

    expect(page).toMatchObject({ items: [], notModified: true, etag: 'W/"one"' })
    expect(calls.map(call => call.url)).toEqual([`${issues}?state=all&sort=updated&direction=desc`])
    expect(sentEtags(calls)).toEqual(['W/"one"'])
  })

  it('reports no etag when it reads past the first page to find an item', async () => {
    const next = `${issues}?state=open&sort=created&direction=desc&page=2`
    const { fetch, calls } = fixtureFetch([], {
      [`GET ${issues}?state=open&sort=created&direction=desc`]: listed([pull], { etag: 'W/"one"', link: `<${next}>; rel="next"` }),
      [`GET ${next}`]: listed([issue], { etag: 'W/"two"' }),
    })
    const provider = github({ fetch }).create()

    const page = await provider.threads.listPage(repo, { kind: 'issue', cursor: { etag: 'W/"stale"' } })

    expect(page.items.map(thread => thread.ref.number)).toEqual(['6'])
    expect(page.etag).toBeUndefined()
    expect(sentEtags(calls)).toEqual(['W/"stale"', null])
  })

  it('falls back from an organisation to a user for a conditional first page', async () => {
    const { fetch, calls } = fixtureFetch([], {
      'GET https://api.github.com/orgs/ada/repos': { status: 404, body: { message: 'Not Found' } },
      'GET https://api.github.com/users/ada/repos?type=owner': notModified('W/"one"'),
    })
    const provider = github({ fetch }).create()

    const page = await provider.repos.byOwnerPage({ forge: 'github', instance: 'github.com', owner: 'ada', name: '', kind: 'namespace' }, { cursor: { etag: 'W/"one"' } })

    expect(page).toMatchObject({ items: [], notModified: true, etag: 'W/"one"' })
    expect(sentEtags(calls)).toEqual(['W/"one"', 'W/"one"'])
  })
})

describe('gitlab', () => {
  const repo = { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: 'widgets' } as const
  const project = 'https://gitlab.com/api/v4/projects/acme%2Fwidgets'

  it('reads issues alone conditionally', async () => {
    const { fetch, calls } = fixtureFetch([], { [`GET ${project}/issues?state=opened&order_by=created_at&sort=desc`]: notModified('W/"one"') })
    const provider = gitlab({ auth: token, fetch }).create()

    const page = await provider.threads.listPage(repo, { kind: 'issue', cursor: { etag: 'W/"one"' } })

    expect(page).toMatchObject({ items: [], notModified: true, etag: 'W/"one"' })
    expect(sentEtags(calls)).toEqual(['W/"one"'])
  })

  it('reads issues and merge requests together unconditionally', async () => {
    const { fetch, calls } = fixtureFetch([], {
      [`GET ${project}/issues?state=opened&order_by=created_at&sort=desc`]: listed([], { etag: 'W/"issues"' }),
      [`GET ${project}/merge_requests?state=opened&order_by=created_at&sort=desc`]: listed([], { etag: 'W/"merges"' }),
    })
    const provider = gitlab({ auth: token, fetch }).create()

    const page = await provider.threads.listPage(repo, { cursor: { etag: 'W/"one"' } })

    expect(page.etag).toBeUndefined()
    expect(sentEtags(calls)).toEqual([null, null])
  })

  it('reads pending to-dos conditionally, and every to-do unconditionally', async () => {
    const conditional = fixtureFetch([], { 'GET https://gitlab.com/api/v4/todos?state=pending': notModified('W/"one"') })
    const unconditional = fixtureFetch([], { 'GET https://gitlab.com/api/v4/todos?state=pending': listed([], { etag: 'W/"two"' }) })

    const pending = await gitlab({ auth: token, fetch: conditional.fetch }).create().notifications.listPage({ cursor: { etag: 'W/"one"' } })
    const all = await gitlab({ auth: token, fetch: unconditional.fetch }).create().notifications.listPage({ all: true, cursor: { etag: 'W/"one"' } })

    expect(pending).toMatchObject({ items: [], notModified: true, etag: 'W/"one"' })
    expect(all).toMatchObject({ items: [], cursor: { token: 'done' } })
    expect(all.etag).toBeUndefined()
    expect(sentEtags([...conditional.calls, ...unconditional.calls])).toEqual(['W/"one"', null])
  })
})

describe('bitbucket', () => {
  const repo = { forge: 'bitbucket', instance: 'bitbucket.org', owner: 'acme', name: 'widgets' } as const
  const pulls = 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests?sort=-created_on&pagelen=50&state=OPEN'

  it('reads the first page conditionally and the page its body names without the etag', async () => {
    const next = `${pulls}&page=2`
    const [pull] = ((JSON.parse(readFileSync(`${fixtureDirectory('bitbucket')}list-pulls.json`, 'utf8')) as Fixture).response.body as { values: unknown[] }).values
    const { fetch, calls } = fixtureFetch([], {
      [`GET ${pulls}`]: listed({ values: [pull], next }, { etag: '"one"' }),
      [`GET ${next}`]: listed({ values: [] }, { etag: '"two"' }),
    })
    const provider = bitbucket({ auth: token, fetch }).create()

    const page = await provider.threads.listPage(repo, { cursor: { etag: '"stale"' } })
    const later = await provider.threads.listPage(repo, { cursor: page.cursor })

    expect(page).toMatchObject({ etag: '"one"', cursor: { nextUrl: next } })
    expect(later.etag).toBeUndefined()
    expect(sentEtags(calls)).toEqual(['"stale"', null])
  })
})

describe('gitee', () => {
  const repo = { forge: 'gitee', instance: 'gitee.com', owner: 'acme', name: 'widgets' } as const
  const pulls = 'https://gitee.com/api/v5/repos/acme/widgets/pulls?state=open&sort=created&direction=desc&page=1&per_page=50'

  it('reads open pull requests conditionally', async () => {
    const { fetch, calls } = fixtureFetch([], { [`GET ${pulls}`]: notModified('W/"one"') })
    const provider = gitee({ auth: token, fetch }).create()

    const page = await provider.threads.listPage(repo, { kind: 'pull_request', cursor: { etag: 'W/"one"' } })

    expect(page).toMatchObject({ items: [], notModified: true, etag: 'W/"one"' })
    expect(sentEtags(calls)).toEqual(['W/"one"'])
  })

  it('reads open issues, which span two states, unconditionally', async () => {
    const issues = 'https://gitee.com/api/v5/repos/acme/widgets/issues?sort=created&direction=desc&page=1&per_page=50'
    const { fetch, calls } = fixtureFetch([], {
      [`GET ${issues}&state=open`]: listed([], { etag: 'W/"open"' }),
      [`GET ${issues}&state=progressing`]: listed([], { etag: 'W/"progressing"' }),
    })
    const provider = gitee({ auth: token, fetch }).create()

    const page = await provider.threads.listPage(repo, { kind: 'issue', cursor: { etag: 'W/"one"' } })

    expect(page.etag).toBeUndefined()
    expect(sentEtags(calls)).toEqual([null, null])
  })
})
