import { describe, expect, it } from 'vitest'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { fake } from '../../src/fake/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { toActor } from '../../src/github/normalise.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { UnsupportedOperationError } from '../../src/index.ts'
import { pushin } from '../../src/pushin/index.ts'
import { tangled } from '../../src/tangled/index.ts'
import { fixtureFetch } from '../../src/testing/index.ts'

describe('users.get', () => {
  it('reads a GitHub account anonymously', async () => {
    const { fetch, calls } = fixtureFetch([], {
      'GET https://api.github.com/users/octocat': { status: 200, body: { login: 'octocat', id: 1, type: 'User', name: 'The Octocat', blog: 'https://github.blog', followers: 10, public_repos: 8, created_at: '2011-01-25T18:44:36Z' } },
    })
    const user = await github({ fetch }).create().users.get('octocat')

    expect(user).toMatchObject({ login: 'octocat', name: 'The Octocat', websiteUrl: 'https://github.blog', followers: 10, publicRepos: 8, createdAt: new Date('2011-01-25T18:44:36Z') })
    expect(calls[0]!.authorization).toBeUndefined()
  })

  it('resolves a GitLab username to an id, then reads the profile', async () => {
    const { fetch, calls } = fixtureFetch([], {
      'GET https://gitlab.com/api/v4/users?username=grace': { status: 200, body: [{ id: 7, username: 'grace' }] },
      'GET https://gitlab.com/api/v4/users/7': { status: 200, body: { id: 7, username: 'grace', name: 'Grace', bio: 'Compilers', organization: 'Navy', followers: 3 } },
    })
    const user = await gitlab({ fetch }).create().users.get('grace')

    expect(user).toMatchObject({ login: 'grace', bio: 'Compilers', company: 'Navy', followers: 3 })
    expect(calls).toHaveLength(2)
  })

  it('reads a Forgejo account', async () => {
    const { fetch } = fixtureFetch([], {
      'GET https://codeberg.org/api/v1/users/ada': { status: 200, body: { id: 2, login: 'ada', full_name: 'Ada', description: 'Engines', followers_count: 5 } },
    })

    expect(await forgejo({ fetch, baseUrl: 'https://codeberg.org' }).create().users.get('ada')).toMatchObject({ login: 'ada', name: 'Ada', bio: 'Engines', followers: 5 })
  })

  it('rejects where the forge cannot read an account by login', async () => {
    const forge = bitbucket({}).create()

    expect(forge.can('users.get')).toBe(false)
    await expect(forge.users.get('someone')).rejects.toThrow(UnsupportedOperationError)
  })

  it('ties a GitHub App bot account to its app', () => {
    expect(toActor('github.com', { login: 'renovate[bot]', id: 2, type: 'Bot' })?.app).toEqual({ slug: 'renovate' })
    expect(toActor('github.com', { login: 'octocat', id: 1, type: 'User' })?.app).toBeUndefined()
  })
})

describe('users.me', () => {
  const auth = { type: 'token', token: 't' } as const

  it.each([
    ['github', 'https://api.github.com/user', { login: 'octocat', id: 1, type: 'User', name: 'The Octocat' }, (fetch: never) => github({ auth, fetch })],
    ['gitlab', 'https://gitlab.com/api/v4/user', { id: 7, username: 'octocat', name: 'The Octocat' }, (fetch: never) => gitlab({ auth, fetch })],
    ['forgejo', 'https://codeberg.org/api/v1/user', { id: 2, login: 'octocat', full_name: 'The Octocat' }, (fetch: never) => forgejo({ auth, fetch, baseUrl: 'https://codeberg.org' })],
    ['gitee', 'https://gitee.com/api/v5/user', { id: 3, login: 'octocat', name: 'The Octocat' }, (fetch: never) => gitee({ auth, fetch })],
    ['bitbucket', 'https://api.bitbucket.org/2.0/user', { uuid: '{1}', nickname: 'octocat', display_name: 'The Octocat' }, (fetch: never) => bitbucket({ auth, fetch })],
    ['pushin', 'https://pushin.eu/api/v1/user', { id: '4', login: 'octocat', name: 'The Octocat', company: 'Pushin' }, (fetch: never) => pushin({ auth, fetch })],
  ])('reads the authenticated %s account', async (_name, url, body, create) => {
    const { fetch, calls } = fixtureFetch([], { [`GET ${url}`]: { status: 200, body } })
    const forge = create(fetch as never).create()

    expect(forge.can('users.me')).toBe(true)
    expect(await forge.users.me()).toMatchObject({ login: 'octocat', name: 'The Octocat' })
    expect(calls.map(call => call.url)).toEqual([url])
  })

  it('reads the fake viewer', async () => {
    expect(await fake({ viewer: 'grace' }).create().users.me()).toMatchObject({ login: 'grace' })
  })

  it('needs a credential', async () => {
    for (const forge of [github({}).create(), gitlab({}).create(), tangled({}).create()]) {
      expect(forge.can('users.me')).toBe(false)
      await expect(forge.users.me()).rejects.toThrow(UnsupportedOperationError)
    }
  })

  it('is unsupported for a GitHub App installation', () => {
    expect(github({ auth: { type: 'app', appId: 1, privateKey: 'k', installationId: 2 } }).create().can('users.me')).toBe(false)
  })
})
