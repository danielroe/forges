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
