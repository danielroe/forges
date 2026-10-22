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
    const forge = github({ fetch })
    await forge.repos.get(repo)

    expect(calls[0]!.authorization).toBeUndefined()
    expect(forge.capabilities.authKinds).toContain('anonymous')
    expect(forge.authKind).toBe('anonymous')
    expect(['threads.createComment', 'threads.close', 'notifications.list', 'repos.list', 'installations.list', 'threads.subscribe', 'ci.log'].filter(verb => forge.can(verb as never))).toEqual([])
    expect(forge.can('threads.get', 'issue')).toBe(true)
    await expect(forge.threads.createComment(issue, 'hi')).rejects.toThrow(UnsupportedOperationError)
  })

  it('rejects GitHub job logs without a request', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch })

    expect(forge.can('ci.runs')).toBe(true)
    await expect(forge.ci.log({ forge: 'github', instance: 'github.com', repo, id: '4002' })).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it('rejects GitLab issue and merge request comments without a request, since they need a token', async () => {
    const calls: string[] = []
    const forge = gitlab({
      fetch: async (url) => {
        calls.push(url)
        return Response.json([])
      },
    })
    const gitlabRepo = { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: 'widgets' }

    expect(forge.can('threads.comments', 'issue')).toBe(false)
    expect(forge.can('threads.comments', 'pull_request')).toBe(false)
    expect(forge.can('commits.comments')).toBe(true)
    expect(gitlab({ auth: { type: 'token', token: 't' } }).can('threads.comments', 'issue')).toBe(true)
    await expect(forge.threads.comments({ forge: 'gitlab', instance: 'gitlab.com', repo: gitlabRepo, kind: 'issue', number: '1' }).page()).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it('reads the rulesets of a branch without credentials', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const rules = await github({ fetch }).repos.branchRules(repo, 'next')

    expect(rules).toMatchObject({ branch: 'next', requiredChecks: [{ name: 'test' }], requiredApprovals: 1 })
    expect(rules.warnings).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it('reads the rules of a branch without credentials, and warns about the classic protection only an admin sees', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const rules = await github({ fetch }).repos.branchRules(repo, 'main')

    expect(rules.requiredChecks.map(check => check.name)).toEqual(['test', 'lint', 'CLA Signing'])
    expect(rules.requiredApprovals).toBe(1)
    expect(rules.warnings?.map(warning => warning.code)).toEqual(['insufficient_scope'])
    expect(calls.map(call => call.url)).not.toContain('https://api.github.com/repos/acme/widgets/branches/main/protection')
  })

  it('reads the rules of a Forgejo branch without credentials', async () => {
    const { fetch, calls } = fixtureFetch('forgejo')
    const rules = await forgejo({ fetch }).repos.branchRules({ forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, 'main')

    expect(calls[0]!.authorization).toBeUndefined()
    expect(rules.requiredApprovals).toBe(1)
  })

  it('rejects the account repository list without a request', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch })

    await expect(forge.repos.list().page()).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it('reads GitHub threads over REST, since GraphQL needs a credential', async () => {
    const urls: string[] = []
    const forge = github({
      fetch: async (url) => {
        urls.push(url)
        return Response.json(url.includes('/issues/1') ? { number: 1, title: 'Crash', state: 'open', user: { login: 'a' } } : [{ number: 2, title: 'Fix', state: 'open', pull_request: {}, user: { login: 'a' } }])
      },
    })

    const [result] = await forge.threads.getMany([issue])
    const page = await forge.threads.list(repo).page()

    expect(result!.ok).toBe(true)
    expect(page.warnings).toBeUndefined()
    expect(forge.can('threads.get', 'discussion')).toBe(false)
    expect(urls.some(url => url.endsWith('/graphql'))).toBe(false)
  })

  it('reports a GitHub discussion unreadable in getMany without a GraphQL request', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch })

    const [result] = await forge.threads.getMany([{ ...issue, kind: 'discussion', number: '7' }])

    expect(result).toMatchObject({ ok: false, warning: { code: 'thread_unreadable' } })
    expect(calls).toEqual([])
  })

  it('rejects thread events for a kind an anonymous provider cannot read, without a request', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch })
    const discussion = { ...issue, kind: 'discussion' as const, number: '7' }

    expect(forge.can('threads.events', 'issue')).toBe(true)
    expect(forge.can('threads.events', 'discussion')).toBe(false)
    await expect(forge.threads.events(discussion).page()).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it('reads GitHub reviews without asking GraphQL for their conversations', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ fetch })

    const reviews = await Array.fromAsync(forge.threads.reviews({ ...issue, kind: 'pull_request', number: '42' }))

    expect(reviews.length).toBeGreaterThan(0)
    expect(calls.some(call => call.url.endsWith('/graphql'))).toBe(false)
  })

  it('accepts `{ type: \'anonymous\' }` explicitly on every forge that allows it', () => {
    for (const forge of [gitlab({ auth: { type: 'anonymous' } }), forgejo({ auth: { type: 'anonymous' }, baseUrl: 'https://codeberg.org' })]) {
      expect(forge.can('threads.get', 'issue')).toBe(true)
      expect(forge.can('notifications.list')).toBe(false)
    }
  })
})

describe('auth kind', () => {
  it('reports the auth type each provider was created with', () => {
    expect(github({ auth: { type: 'token', token: 't' } }).authKind).toBe('token')
    expect(gitlab({ auth: { type: 'anonymous' } }).authKind).toBe('anonymous')
    expect(forgejo({ baseUrl: 'https://codeberg.org' }).authKind).toBe('anonymous')
    expect(github({ auth: { type: 'token', token: 't' }, readOnly: true }).authKind).toBe('token')
  })
})

describe('read-only providers', () => {
  it('rejects every write with ReadOnlyError and keeps reads', async () => {
    const { fetch, calls } = fixtureFetch('github')
    const forge = github({ auth: { type: 'token', token: 't' }, fetch, readOnly: true })

    expect(forge.can('threads.close', 'issue')).toBe(false)
    expect(forge.can('notifications.markDone')).toBe(false)
    expect(forge.can('notifications.list')).toBe(true)
    expect(forge.can('threads.subscription', 'issue')).toBe(true)
    expect(forge.can('threads.subscribe', 'issue')).toBe(false)
    await expect(forge.threads.unsubscribe(issue)).rejects.toThrow(ReadOnlyError)
    await expect(forge.threads.close(issue)).rejects.toThrow(ReadOnlyError)
    await expect(forge.threads.merge({ ...issue, kind: 'pull_request' })).rejects.toThrow(ReadOnlyError)
    await expect(forge.notifications.markRead({ forge: 'github', instance: 'github.com', id: '1' })).rejects.toBeInstanceOf(UnsupportedOperationError)
    await forge.repos.get(repo)
    expect(calls.map(call => call.method)).toEqual(['GET'])
  })
})
