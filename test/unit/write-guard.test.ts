import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardedFetch } from '../../scripts/write-guard.ts'
import { writeHarness } from '../../scripts/write-harness.ts'

const scratch = { forge: 'github', instance: 'github.com', owner: 'bot', name: 'forges-fixtures' }
const api = 'https://api.github.com'

function guarded() {
  const sent: string[] = []
  const fetch = guardedFetch(async (input, init) => {
    sent.push(`${init?.method ?? 'GET'} ${input}`)
    const body = new URL(input).pathname.endsWith('/graphql') ? { data: { repository: { issue: { id: 'I_kwDOscratch1' } } } } : { node_id: 'I_kwDOscratch2' }
    return new Response(JSON.stringify(body))
  }, { scope: [`${api}/repos/bot/forges-fixtures`], account: [`${api}/notifications`], repos: [scratch] })
  const graphql = (query: string, variables: Record<string, unknown>) => fetch(`${api}/graphql`, { method: 'POST', body: JSON.stringify({ query, variables }) })
  return { fetch, graphql, sent }
}

describe('write recording guard', () => {
  it('sends writes to the scratch repository and the account notifications', async () => {
    const { fetch, sent } = guarded()
    await fetch(`${api}/repos/bot/forges-fixtures/issues`, { method: 'POST', body: '{}' })
    await fetch(`${api}/notifications/threads/1`, { method: 'PATCH' })

    expect(sent).toHaveLength(2)
  })

  it('refuses a REST write anywhere else before sending it', async () => {
    const { fetch, sent } = guarded()

    await expect(fetch(`${api}/repos/bot/forges-fixtures-other/issues`, { method: 'POST' })).rejects.toThrow(/scratch repository/)
    await expect(fetch(`${api}/repos/nuxt/nuxt/issues/1`, { method: 'PATCH' })).rejects.toThrow(/scratch repository/)
    expect(sent).toEqual([])
  })

  it('allows a GraphQL mutation only on ids the scratch repository returned', async () => {
    const { fetch, graphql, sent } = guarded()
    await fetch(`${api}/repos/bot/forges-fixtures/issues/1`)
    await graphql('query Issue($owner: String!, $name: String!) { x }', { owner: 'bot', name: 'forges-fixtures' })
    await graphql('mutation Duplicate($canonical: ID!, $duplicate: ID!) { x }', { canonical: 'I_kwDOscratch1', duplicate: 'I_kwDOscratch2' })

    await expect(graphql('mutation React($id: ID!) { x }', { id: 'I_kwDOelsewhere' })).rejects.toThrow(/did not come from the scratch repository/)
    expect(sent).toHaveLength(3)
  })

  it('allows a Tangled record only when it names the scratch repository or the account itself', () => {
    const harness = writeHarness({ forge: 'tangled', baseUrl: 'https://tangled.org', authorization: '', scratch: { forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:bot', name: 'forges-fixtures' } })!
    const write = (method: string, body: unknown) => harness.allows!(`https://pds.example/xrpc/com.atproto.repo.${method}`, body)
    const create = (record: unknown) => write('createRecord', { repo: 'did:plc:bot', collection: 'sh.tangled.feed.comment', record })

    expect(create({ subject: { uri: 'at://did:plc:bot/sh.tangled.repo.issue/1' } })).toBe(true)
    expect(create({ subject: { uri: 'at://did:plc:someone/sh.tangled.repo.issue/1' } })).toBe(false)
    expect(write('deleteRecord', { repo: 'did:plc:bot', collection: 'sh.tangled.feed.comment', rkey: 'created' })).toBe(true)
    expect(write('deleteRecord', { repo: 'did:plc:bot', collection: 'app.bsky.feed.post', rkey: 'post' })).toBe(false)
    expect(write('uploadBlob', { repo: 'did:plc:bot' })).toBe(false)
  })

  it('never trusts ids from a GraphQL read of another repository', async () => {
    const { graphql } = guarded()
    await graphql('query Issue($owner: String!, $name: String!) { x }', { owner: 'nuxt', name: 'nuxt' })

    await expect(graphql('mutation React($id: ID!) { x }', { id: 'I_kwDOscratch1' })).rejects.toThrow(/did not come from the scratch repository/)
  })

  it('never trusts ids from a GraphQL read that names no repository or id', async () => {
    const { graphql } = guarded()
    await graphql('query Viewer { viewer { id } }', {})

    await expect(graphql('mutation React($id: ID!) { x }', { id: 'I_kwDOscratch1' })).rejects.toThrow(/did not come from the scratch repository/)
  })
})

describe('write recording cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const tag = 'forges-fixture-20261010120000'

  it.each([
    ['github', 'https://api.github.com', '/repos/bot/forges-fixtures', [`/releases/2`, `/git/refs/tags/${tag}`]],
    ['forgejo', 'https://codeberg.org/api/v1', '/repos/bot/forges-fixtures', [`/releases/2`, `/tags/${tag}`]],
    ['gitlab', 'https://gitlab.com/api/v4', '/projects/bot%2Fforges-fixtures', [`/releases/${tag}`, `/repository/tags/${tag}`]],
  ])('deletes only the fixture releases and tags on %s, releases first', async (forge, baseUrl, repo, deleted) => {
    const sent: string[] = []
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      sent.push(`${init?.method ?? 'GET'} ${input}`)
      const path = new URL(input).pathname
      const body = path.endsWith('/releases')
        ? [{ id: 1, tag_name: 'v0.0.1' }, { id: 2, tag_name: tag }]
        : path.endsWith('/tags')
          ? [{ name: 'v0.0.1' }, { name: tag }]
          : path.includes('/matching-refs/') ? [{ ref: `refs/tags/${tag}` }] : []
      return new Response(JSON.stringify(body))
    })
    const harness = writeHarness({ forge, baseUrl, authorization: '', scratch: { forge, instance: new URL(baseUrl).host, owner: 'bot', name: 'forges-fixtures' } })!

    await harness.cleanUp([], undefined, [])

    expect(sent.filter(line => line.startsWith('DELETE'))).toEqual(deleted.map(path => `DELETE ${baseUrl}${repo}${path}`))
  })
})
