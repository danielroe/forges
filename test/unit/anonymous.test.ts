import { describe, expect, it } from 'vitest'
import { forgejo } from '../../src/forgejo/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { ReadOnlyError, UnsupportedOperationError } from '../../src/index.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }
const issue = { forge: 'github', instance: 'github.com', repo, kind: 'issue' as const, number: '1' }

describe('anonymous providers', () => {
  it('reads without credentials and supports nothing that needs an account', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch }).create()
    await forge.repos.get(repo)

    expect(calls[0]!.authorization).toBeUndefined()
    expect(forge.capabilities.authKinds).toContain('anonymous')
    expect(forge.authKind).toBe('anonymous')
    expect(['threads.comment', 'threads.close', 'notifications.list', 'repos.list', 'installations.list', 'threads.subscribe', 'ci.log'].filter(verb => forge.can(verb as never))).toEqual([])
    expect(forge.can('threads.get', 'issue')).toBe(true)
    await expect(forge.threads.comment(issue, 'hi')).rejects.toThrow(UnsupportedOperationError)
  })

  it('rejects GitHub job logs without a request', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch }).create()

    expect(forge.can('ci.runs')).toBe(true)
    await expect(forge.ci.log({ forge: 'github', instance: 'github.com', repo, id: '4002' })).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it('rejects the account repository list without a request', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch }).create()

    await expect(forge.repos.listPage()).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it('reads GitHub threads over REST, since GraphQL needs a credential', async () => {
    const urls: string[] = []
    const forge = github({
      fetch: async (url) => {
        urls.push(url)
        return Response.json(url.includes('/issues/1') ? { number: 1, title: 'Crash', state: 'open', user: { login: 'a' } } : [{ number: 2, title: 'Fix', state: 'open', pull_request: {}, user: { login: 'a' } }])
      },
    }).create()

    const [result] = await forge.threads.getMany([issue])
    const page = await forge.threads.listPage(repo)

    expect(result!.ok).toBe(true)
    expect(page.warnings).toBeUndefined()
    expect(forge.can('threads.get', 'discussion')).toBe(false)
    expect(urls.some(url => url.endsWith('/graphql'))).toBe(false)
  })

  it('reads GitHub reviews without asking GraphQL for their conversations', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch }).create()

    const reviews = await Array.fromAsync(forge.threads.reviews({ ...issue, kind: 'pull_request', number: '42' }))

    expect(reviews.length).toBeGreaterThan(0)
    expect(calls.some(call => call.url.endsWith('/graphql'))).toBe(false)
  })

  it('accepts `{ type: \'anonymous\' }` explicitly on every forge that allows it', () => {
    for (const forge of [gitlab({ auth: { type: 'anonymous' } }).create(), forgejo({ auth: { type: 'anonymous' }, baseUrl: 'https://codeberg.org' }).create()]) {
      expect(forge.can('threads.get', 'issue')).toBe(true)
      expect(forge.can('notifications.list')).toBe(false)
    }
  })
})

describe('auth kind', () => {
  it('reports the auth type each provider was created with', () => {
    expect(github({ auth: { type: 'token', token: 't' } }).create().authKind).toBe('token')
    expect(gitlab({ auth: { type: 'anonymous' } }).create().authKind).toBe('anonymous')
    expect(forgejo({ baseUrl: 'https://codeberg.org' }).create().authKind).toBe('anonymous')
    expect(github({ auth: { type: 'token', token: 't' }, readOnly: true }).create().authKind).toBe('token')
  })
})

describe('read-only providers', () => {
  it('rejects every write with ReadOnlyError and keeps reads', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ auth: { type: 'token', token: 't' }, fetch, readOnly: true }).create()

    expect(forge.can('threads.close', 'issue')).toBe(false)
    expect(forge.can('notifications.markDone')).toBe(false)
    expect(forge.can('notifications.list')).toBe(true)
    expect(forge.can('threads.subscription', 'issue')).toBe(true)
    expect(forge.can('threads.subscribe', 'issue')).toBe(false)
    await expect(forge.threads.unsubscribe(issue)).rejects.toThrow(ReadOnlyError)
    await expect(forge.threads.close(issue)).rejects.toThrow(ReadOnlyError)
    await expect(forge.threads.approveAndMerge({ ...issue, kind: 'pull_request' })).rejects.toThrow(ReadOnlyError)
    await expect(forge.notifications.markRead({ forge: 'github', instance: 'github.com', id: '1' })).rejects.toBeInstanceOf(UnsupportedOperationError)
    await forge.repos.get(repo)
    expect(calls.map(call => call.method)).toEqual(['GET'])
  })
})
