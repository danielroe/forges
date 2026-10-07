import { describe, expect, it } from 'vitest'
import { forgesFromEnv, providersFromEnv } from '../../src/env.ts'

describe('providersFromEnv', () => {
  it('reads one provider set per kind and suffix', () => {
    const entries = providersFromEnv({
      FORGES_GITHUB_TOKEN: 'a',
      FORGES_GITHUB_TOKEN_WORK: 'b',
      FORGES_GITHUB_BASE_URL_WORK: 'https://ghe.example.com/api/v3',
      FORGES_GITLAB_INSTANCE_VERSION: '17.0',
      UNRELATED: 'x',
    })

    expect(entries.map(({ forge, suffix, instance, skipped }) => ({ forge, suffix, instance, skipped }))).toEqual([
      { forge: 'github', suffix: '', instance: 'github.com', skipped: undefined },
      { forge: 'github', suffix: 'WORK', instance: 'ghe.example.com', skipped: undefined },
      { forge: 'gitlab', suffix: '', instance: undefined, skipped: 'needs TOKEN, or ENABLED for anonymous reads' },
    ])
  })

  it('skips a set whose ENABLED is off, whatever else it sets', () => {
    const entries = providersFromEnv({ FORGES_TANGLED_ENABLED: 'false', FORGES_GITHUB_TOKEN: 'a', FORGES_GITHUB_ENABLED: '0' })

    expect(entries.map(entry => [entry.forge, entry.skipped])).toEqual([['tangled', 'ENABLED is off'], ['github', 'ENABLED is off']])
  })

  it('builds anonymous providers from ENABLED or DEMO_REPO', () => {
    const forges = forgesFromEnv({ FORGES_FORGEJO_ENABLED: '1', FORGES_FORGEJO_BASE_URL: 'https://codeberg.org', FORGES_GITLAB_DEMO_REPO: 'acme/platform/widgets' })

    expect(forges.providers.map(provider => provider.instance)).toEqual(['codeberg.org', 'gitlab.com'])
    expect(providersFromEnv({ FORGES_GITLAB_DEMO_REPO: 'acme/platform/widgets' })[0]!.demoRepo).toEqual({ owner: 'acme/platform', name: 'widgets' })
  })
})

describe('environment flags', () => {
  it('creates a read-only provider for `READ_ONLY`', () => {
    const [entry] = providersFromEnv({ FORGES_GITHUB_TOKEN: 't', FORGES_GITHUB_READ_ONLY: '1' })

    expect(entry!.factory!.create().capabilities.writes.comment.issue).toBe(false)
  })

  it('does not create a provider until `instance` is read', () => {
    let created = 0
    const [entry] = providersFromEnv({ FORGES_GITHUB_TOKEN: 't' })
    const factory = entry!.factory!
    const create = factory.create
    factory.create = () => {
      created++
      return create()
    }

    expect(created).toBe(0)
    expect(entry!.instance).toBe('github.com')
    expect(entry!.instance).toBe('github.com')
    expect(created).toBe(1)
  })

  it('lets `instance` be overwritten without creating a provider', () => {
    const [entry] = providersFromEnv({ FORGES_GITHUB_TOKEN: 't' })
    const factory = entry!.factory!
    factory.create = () => {
      throw new Error('not expected')
    }

    entry!.instance = 'ghe.example.com'

    expect(entry!.instance).toBe('ghe.example.com')
  })
})
