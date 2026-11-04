import { fixtureFetch } from '@forges-examples/fixture-fetch'
import { bitbucket, createForges, forgejo, github, gitlab } from 'forges'
import { describe, expect, it } from 'vitest'
import { buildDigest, formatDigest } from '../src/digest.ts'

function setup() {
  const { fetch, calls } = fixtureFetch([
    'github',
    'gitlab',
    'forgejo',
    'bitbucket',
  ])
  const forges = createForges([
    github({
      auth: { type: 'token', token: 'ghp_test' },
      fetch,
    }),
    gitlab({
      auth: { type: 'token', token: 'glpat_test' },
      fetch,
    }),
    forgejo({
      baseUrl: 'https://codeberg.org',
      auth: { type: 'token', token: 'cb_test' },
      fetch,
    }),
    bitbucket({
      auth: { type: 'basic', username: 'tester', password: 'app-password' },
      fetch,
    }),
  ])
  return { forges, calls }
}

const repos = [
  {
    forge: 'github',
    instance: 'github.com',
    owner: 'acme',
    name: 'widgets',
  },
  {
    forge: 'gitlab',
    instance: 'gitlab.com',
    owner: 'acme/platform',
    name: 'widgets',
  },
  {
    forge: 'forgejo',
    instance: 'codeberg.org',
    owner: 'acme',
    name: 'widgets',
  },
] as const

describe('release digest', () => {
  it('should report the latest release and the failing pull requests of every repo', async () => {
    const { forges } = setup()

    const result = await buildDigest(forges, repos)

    expect(formatDigest(result)).toMatchInlineSnapshot(`
      "github  acme/widgets  v1.2.0 (2025-09-10)
        #42  Add retry handling to the uploader 1/3 failed  [lint]
      gitlab  acme/platform/widgets  v2.0.0 (2025-09-10)
        #23  Cache compiled templates 1/3 failed  [test: lint]
      forgejo  acme/widgets  v0.4.0 (2025-09-10)
        #7  Support custom cache directory 1/2 failed  [ci/woodpecker/push/lint]"
    `)
  })

  it('should read the checks of each open pull once', async () => {
    const { forges, calls } = setup()

    await buildDigest(forges, [repos[0]])

    expect(calls.filter(call => call.url.includes('/check-runs'))).toHaveLength(1)
  })

  it('should name the individual failing checks where the forge lists them', async () => {
    const { forges } = setup()

    const result = await buildDigest(forges, [repos[0]])

    expect(result.entries[0]?.failing[0]?.checks).toEqual(['lint'])
  })

  it('should warn instead of failing for a forge with no releases', async () => {
    const { forges } = setup()

    const result = await buildDigest(forges, [
      {
        forge: 'bitbucket',
        instance: 'bitbucket.org',
        owner: 'acme',
        name: 'widgets',
      },
    ])

    expect(result.warnings.map(warning => warning.code)).toContain('releases_unsupported')
    expect(result.entries[0]?.release).toBeUndefined()
  })

  it('should warn when no provider is configured for a repo', async () => {
    const { forges } = setup()

    const result = await buildDigest(forges, [
      {
        forge: 'gitea',
        instance: 'gitea.com',
        owner: 'acme',
        name: 'widgets',
      },
    ])

    expect(result.warnings.map(warning => warning.code)).toEqual(['provider_missing'])
  })
})
