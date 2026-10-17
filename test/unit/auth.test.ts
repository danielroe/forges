import type { FetchLike } from '../../src/fetch.ts'
import type { ForgeProvider } from '../../src/provider.ts'
import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { cloudflareArtifacts } from '../../src/cloudflare-artifacts/index.ts'
import { cursorOrigin } from '../../src/cursor-origin/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitea } from '../../src/gitea/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { pushin } from '../../src/pushin/index.ts'
import { sourcehut } from '../../src/sourcehut/index.ts'

type TokenFactory = (token: () => Promise<string>, fetch: FetchLike) => ForgeProvider

const FACTORIES: Record<string, TokenFactory> = {
  'github': (token, fetch) => github({ auth: { type: 'token', token }, fetch }),
  'gitlab': (token, fetch) => gitlab({ auth: { type: 'token', token }, fetch }),
  'forgejo': (token, fetch) => forgejo({ auth: { type: 'token', token }, baseUrl: 'https://codeberg.org', fetch }),
  'gitea': (token, fetch) => gitea({ auth: { type: 'token', token }, fetch }),
  'gitee': (token, fetch) => gitee({ auth: { type: 'token', token }, fetch }),
  'bitbucket': (token, fetch) => bitbucket({ auth: { type: 'token', token }, fetch }),
  'azure-devops': (token, fetch) => azureDevOps({ auth: { type: 'token', token }, organization: 'acme', fetch }),
  'cursor-origin': (token, fetch) => cursorOrigin({ auth: { type: 'token', token }, fetch }),
  'pushin': (token, fetch) => pushin({ auth: { type: 'token', token }, fetch }),
  'cloudflare-artifacts': (token, fetch) => cloudflareArtifacts({ auth: { type: 'token', token }, accountId: 'acme', fetch }),
  'sourcehut': (token, fetch) => sourcehut({ auth: { type: 'token', token }, fetch }),
}

describe('token auth', () => {
  it.each(Object.entries(FACTORIES))('reads a token function before every %s request', async (_name, factory) => {
    let issued = 0
    const sent: string[] = []
    const provider = factory(async () => `token-${++issued}`, async (_url, init) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return Response.json({})
    })

    await provider.request('GET', '/one')
    await provider.request('GET', '/two')

    expect(sent).toHaveLength(2)
    expect(sent[0]).not.toBe(sent[1])
    expect(provider.authKind).toBe('token')
  })
})
