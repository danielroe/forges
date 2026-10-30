import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it } from 'vitest'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { fake } from '../../src/fake/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { toActor } from '../../src/github/normalise.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { NotFoundError, UnsupportedOperationError } from '../../src/index.ts'
import { tangled } from '../../src/tangled/index.ts'
import { fixtureFetch } from '../../src/testing/index.ts'

describe('users.get', () => {
  it('reads a GitHub account anonymously', async () => {
    const { fetch, calls } = fixtureFetch([], {
      'GET https://api.github.com/users/octocat': { status: 200, body: { login: 'octocat', id: 1, type: 'User', name: 'The Octocat', blog: 'https://github.blog', followers: 10, public_repos: 8, created_at: '2011-01-25T18:44:36Z' } },
    })
    const user = await github({ fetch }).users.get('octocat')

    expect(user).toMatchObject({ login: 'octocat', name: 'The Octocat', websiteUrl: 'https://github.blog', followers: 10, publicRepos: 8, createdAt: new Date('2011-01-25T18:44:36Z') })
    expect(calls[0]!.authorization).toBeUndefined()
  })

  it('resolves a GitLab username to an id, then reads the profile', async () => {
    const { fetch, calls } = fixtureFetch([], {
      'GET https://gitlab.com/api/v4/users?username=grace': { status: 200, body: [{ id: 7, username: 'grace' }] },
      'GET https://gitlab.com/api/v4/users/7': { status: 200, body: { id: 7, username: 'grace', name: 'Grace', bio: 'Compilers', organization: 'Navy', followers: 3 } },
    })
    const user = await gitlab({ fetch }).users.get('grace')

    expect(user).toMatchObject({ login: 'grace', bio: 'Compilers', company: 'Navy', followers: 3 })
    expect(calls).toHaveLength(2)
  })

  it('reads a Forgejo account', async () => {
    const { fetch } = fixtureFetch([], {
      'GET https://codeberg.org/api/v1/users/ada': { status: 200, body: { id: 2, login: 'ada', full_name: 'Ada', description: 'Engines', followers_count: 5 } },
    })

    expect(await forgejo({ fetch, baseUrl: 'https://codeberg.org' }).users.get('ada')).toMatchObject({ login: 'ada', name: 'Ada', bio: 'Engines', followers: 5 })
  })

  it('rejects where the forge cannot read an account by login', async () => {
    const forge = bitbucket({})

    expect(forge.can('users.get')).toBe(false)
    await expect(forge.users.get('someone')).rejects.toThrow(UnsupportedOperationError)
  })

  it('ties a GitHub App bot account to its app', () => {
    expect(toActor('github.com', { login: 'renovate[bot]', id: 2, type: 'Bot' })?.app).toEqual({ slug: 'renovate' })
    expect(toActor('github.com', { login: 'octocat', id: 1, type: 'User' })?.app).toBeUndefined()
  })
})

describe('users.sponsorable', () => {
  const auth = { type: 'token', token: 't' } as const

  it('rejects with NotFoundError for an unknown login', async () => {
    const { fetch } = fixtureFetch([], { 'POST https://api.github.com/graphql Sponsorable': { status: 200, body: { data: { repositoryOwner: null } } } })

    await expect(github({ auth, fetch }).users.sponsorable('nobody')).rejects.toThrow(NotFoundError)
  })

  it('is supported for a GitHub App installation', () => {
    expect(github({ auth: { type: 'app', appId: 1, privateKey: 'k', installationId: 2 } }).can('users.sponsorable')).toBe(true)
  })

  it('is unsupported without a credential, as an app without an installation, on GitHub Enterprise Server, and on a forge that cannot report it', async () => {
    const app = github({ auth: { type: 'app', appId: 1, privateKey: 'k' } })
    const ghes = github({ baseUrl: 'https://ghe.example.com/api/v3', auth })
    for (const provider of [github({}), app, ghes, bitbucket({})]) {
      expect(provider.can('users.sponsorable')).toBe(false)
      await expect(provider.users.sponsorable('danielroe')).rejects.toThrow(UnsupportedOperationError)
    }
  })
})

describe('users.sponsorableMany', () => {
  const auth = { type: 'token', token: 't' } as const

  it('reads several logins in one GraphQL request, in input order', async () => {
    const { fetch, calls } = fixtureFetch([], {
      'POST https://api.github.com/graphql SponsorableMany': {
        status: 200,
        body: { data: { u0: { hasSponsorsListing: true }, u1: { hasSponsorsListing: false }, u2: null } },
      },
    })

    const results = await github({ auth, fetch }).users.sponsorableMany(['danielroe', 'octocat', 'nobody'])

    expect(results).toEqual([
      { ok: true, login: 'danielroe', sponsorable: true },
      { ok: true, login: 'octocat', sponsorable: false },
      { ok: false, login: 'nobody', warning: { code: 'account_not_found', message: 'Account nobody not found', subject: 'nobody' } },
    ])
    expect(calls.filter(call => call.operationName === 'SponsorableMany')).toHaveLength(1)
  })

  it('sends no request for an empty list', async () => {
    const { fetch, calls } = fixtureFetch([], {})

    await expect(github({ auth, fetch }).users.sponsorableMany([])).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('chunks logins into several requests and keeps the input order', async () => {
    const logins = Array.from({ length: 51 }, (_, index) => `user${index}`)
    const bodies: Array<{ query: string, variables: Record<string, string> }> = []
    const fetch: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string, variables: Record<string, string> }
      bodies.push(body)
      const data = Object.fromEntries(Object.entries(body.variables).map(([key, login]) => [key.replace('l', 'u'), { hasSponsorsListing: login.endsWith('0') }]))
      return Response.json({ data })
    }

    const results = await github({ auth, fetch }).users.sponsorableMany(logins)

    expect(bodies.map(body => Object.keys(body.variables).length)).toEqual([50, 1])
    expect(bodies[0]!.query).toContain('u0: repositoryOwner(login: $l0)')
    expect(bodies[1]!.variables).toEqual({ l0: 'user50' })
    expect(results.map(result => result.ok && result.login)).toEqual(logins)
    expect(results[0]).toMatchObject({ ok: true, login: 'user0', sponsorable: true })
    expect(results[1]).toMatchObject({ ok: true, login: 'user1', sponsorable: false })
    expect(results[50]).toMatchObject({ ok: true, login: 'user50', sponsorable: true })
  })

  it('reports a rate limit rather than per-login warnings', async () => {
    const fetch: FetchLike = async () => Response.json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791885648' } })

    await expect(github({ auth, fetch }).users.sponsorableMany(['danielroe', 'octocat'])).rejects.toMatchObject({ name: 'RateLimitedError' })
  })

  it('reports each alias error on its own login', async () => {
    const fetch: FetchLike = async () => Response.json({
      data: { u0: null, u1: null, u2: null, u3: { hasSponsorsListing: false } },
      errors: [
        { type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted the required scopes to execute this query.', path: ['u0'] },
        { type: 'NOT_FOUND', message: 'Could not resolve to a User with the login of nobody.', path: ['u1'] },
        { type: 'FORBIDDEN', message: 'Resource not accessible by integration', path: ['u2'] },
      ],
    })

    const results = await github({ auth, fetch }).users.sponsorableMany(['scoped', 'nobody', 'blocked', 'octocat'])

    expect(results).toEqual([
      { ok: false, login: 'scoped', warning: expect.objectContaining({ code: 'insufficient_scope', subject: 'scoped', cause: expect.objectContaining({ name: 'InsufficientScopeError' }) }) },
      { ok: false, login: 'nobody', warning: { code: 'account_not_found', message: 'Could not resolve to a User with the login of nobody.', subject: 'nobody' } },
      { ok: false, login: 'blocked', warning: expect.objectContaining({ code: 'account_unreadable', subject: 'blocked', cause: expect.objectContaining({ name: 'ForgeApiError' }) }) },
      { ok: true, login: 'octocat', sponsorable: false },
    ])
  })

  it('reports a whole-chunk failure on every login in the chunk', async () => {
    const fetch: FetchLike = async () => Response.json({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] })

    const results = await github({ auth, fetch }).users.sponsorableMany(['danielroe', 'octocat'])

    expect(results.map(result => !result.ok && result.warning.code)).toEqual(['account_unreadable', 'account_unreadable'])
  })

  it('is supported for a GitHub App installation', () => {
    expect(github({ auth: { type: 'app', appId: 1, privateKey: 'k', installationId: 2 } }).can('users.sponsorableMany')).toBe(true)
  })

  it('is unsupported without a credential, as an app without an installation, on GitHub Enterprise Server, and on a forge that cannot report it', async () => {
    const app = github({ auth: { type: 'app', appId: 1, privateKey: 'k' } })
    const ghes = github({ baseUrl: 'https://ghe.example.com/api/v3', auth })
    for (const provider of [github({}), app, ghes, bitbucket({})]) {
      expect(provider.can('users.sponsorableMany')).toBe(false)
      await expect(provider.users.sponsorableMany(['danielroe'])).rejects.toThrow(UnsupportedOperationError)
    }
  })

  it('reads several logins on the fake forge in input order', async () => {
    const forge = fake({ seed: { sponsorable: ['octocat'] } })

    await expect(forge.users.sponsorableMany(['octocat', 'danielroe'])).resolves.toEqual([
      { ok: true, login: 'octocat', sponsorable: true },
      { ok: true, login: 'danielroe', sponsorable: false },
    ])
    await expect(forge.users.sponsorable('octocat')).resolves.toBe(true)
  })
})

describe('users.me', () => {
  const auth = { type: 'token', token: 't' } as const

  it('reads the authenticated Gitee account', async () => {
    const { fetch, calls } = fixtureFetch([], { 'GET https://gitee.com/api/v5/user': { status: 200, body: { id: 3, login: 'octocat', name: 'The Octocat' } } })

    expect(await gitee({ auth, fetch }).users.me()).toMatchObject({ login: 'octocat', name: 'The Octocat' })
    expect(calls.map(call => call.url)).toEqual(['https://gitee.com/api/v5/user'])
  })

  it('reads the fake viewer', async () => {
    expect(await fake({ viewer: 'grace' }).users.me()).toMatchObject({ login: 'grace' })
  })

  it('needs a credential', async () => {
    for (const forge of [github({}), gitlab({}), tangled({})]) {
      expect(forge.can('users.me')).toBe(false)
      await expect(forge.users.me()).rejects.toThrow(UnsupportedOperationError)
    }
  })

  it('is unsupported for a GitHub App installation', () => {
    expect(github({ auth: { type: 'app', appId: 1, privateKey: 'k', installationId: 2 } }).can('users.me')).toBe(false)
  })
})
