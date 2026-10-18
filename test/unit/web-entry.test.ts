import type { ForgeProvider, RepoRef } from '../../src/index.ts'
import type { ForgeWeb, WebOptions } from '../../src/web/index.ts'
import { describe, expect, it } from 'vitest'
import * as providers from '../../src/index.ts'
import * as web from '../../src/web/index.ts'

const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

const cases: Array<[keyof typeof web & keyof typeof providers, WebOptions, string[]]> = [
  ['github', {}, ['https://github.com/acme/widgets/pull/42#issuecomment-9', `https://github.com/acme/widgets/pull/42/commits/${sha}`, 'git@github.com:acme/widgets.git']],
  ['github', { baseUrl: 'https://ghe.example.com/api/v3' }, ['https://ghe.example.com/acme/widgets/issues/7']],
  ['github', { baseUrl: 'https://api.acme.ghe.com' }, ['https://acme.ghe.com/acme/widgets/issues/7']],
  ['gitlab', {}, ['https://gitlab.com/acme/platform/widgets/-/merge_requests/3', 'https://gitlab.com/acme/widgets/-/tags/v1.0.0']],
  ['gitlab', { baseUrl: 'https://example.com/gitlab' }, ['https://example.com/gitlab/acme/widgets/-/issues/1']],
  ['forgejo', {}, ['https://codeberg.org/acme/widgets/compare/main...feat']],
  ['gitea', {}, ['https://gitea.com/acme/widgets/pulls/2']],
  ['gitee', {}, ['https://gitee.com/acme/widgets/issues/I6XZ2N']],
  ['pushin', {}, ['https://pushin.eu/acme/widgets/pulls/2']],
  ['bitbucket', {}, ['https://bitbucket.org/acme/widgets/pull-requests/42']],
  ['azureDevOps', {}, ['https://dev.azure.com/contoso/Widgets/_git/widgets/pullrequest/42']],
  ['sourcehut', {}, [`https://git.sr.ht/~acme/widgets/commit/${sha}`]],
  ['tangled', {}, ['https://tangled.sh/@acme.dev/core/issues/4']],
]

describe('forges/web', () => {
  it.each(cases)('reads %s URLs as its provider does, with %o', (name, options, urls) => {
    const light = (web[name] as (options?: WebOptions) => ForgeWeb)(options)
    const provider = (providers[name] as (options: object) => ForgeProvider)({ ...options, organization: 'contoso', auth: { type: 'token', token: 't' } })

    expect(light).toMatchObject({ forge: provider.forge, instance: provider.instance, webOrigin: provider.webOrigin })
    for (const url of urls) {
      expect(light.parseUrl(url)).toBeDefined()
      expect(light.parseUrl(url)).toEqual(provider.parseUrl(url))
    }
    const repo: RepoRef = light.parseUrl(urls[0]!)!.repo
    expect(light.urlFor({ repo })).toBe(provider.urlFor({ repo }))
    expect(light.parseReferences('#1 and acme/tools!2', { from: repo })).toEqual(provider.parseReferences('#1 and acme/tools!2', { from: repo }))
  })

  it('routes URLs and references to the forge they belong to', () => {
    const forges = web.createForges([web.github(), web.gitlab(), web.forgejo()])
    const from = { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: 'widgets' } as const

    expect(forges.parseUrl('https://codeberg.org/acme/widgets/issues/1')).toMatchObject({ thread: { forge: 'forgejo', number: '1' }, provider: { forge: 'forgejo' } })
    expect(forges.parseReferences('!2', { from })).toMatchObject([{ ref: { forge: 'gitlab', kind: 'pull_request', number: '2' } }])
    expect(forges.get('gitlab')?.instance).toBe('gitlab.com')
    expect(() => web.createForges([web.github(), web.github()])).toThrow('Two providers are registered for github on github.com')
  })

  it('takes a provider in place of its web links', () => {
    const forges = web.createForges([providers.github(), web.gitlab()])

    expect(forges.parseUrl('https://github.com/acme/widgets/pull/1')?.provider.forge).toBe('github')
  })
})
