import type { FetchLike } from '../../src/fetch.ts'
import type { ForgeProviderFactory } from '../../src/provider.ts'
import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { cursorOrigin } from '../../src/cursor-origin/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { pushin } from '../../src/pushin/index.ts'

type TokenFactory = (token: () => Promise<string>, fetch: FetchLike) => ForgeProviderFactory

const FACTORIES: Record<string, TokenFactory> = {
  'github': (token, fetch) => github({ auth: { type: 'token', token }, fetch }),
  'gitlab': (token, fetch) => gitlab({ auth: { type: 'token', token }, fetch }),
  'forgejo': (token, fetch) => forgejo({ auth: { type: 'token', token }, baseUrl: 'https://codeberg.org', fetch }),
  'gitee': (token, fetch) => gitee({ auth: { type: 'token', token }, fetch }),
  'bitbucket': (token, fetch) => bitbucket({ auth: { type: 'token', token }, fetch }),
  'azure-devops': (token, fetch) => azureDevOps({ auth: { type: 'token', token }, organization: 'acme', fetch }),
  'cursor-origin': (token, fetch) => cursorOrigin({ auth: { type: 'token', token }, fetch }),
  'pushin': (token, fetch) => pushin({ auth: { type: 'token', token }, fetch }),
}

describe('token auth', () => {
  it.each(Object.entries(FACTORIES))('reads a token function before every %s request', async (_name, factory) => {
    let issued = 0
    const sent: string[] = []
    const provider = factory(async () => `token-${++issued}`, async (_url, init) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return Response.json({})
    }).create()

    await provider.request('GET', '/one')
    await provider.request('GET', '/two')

    expect(sent).toHaveLength(2)
    expect(sent[0]).not.toBe(sent[1])
    expect(provider.authKind).toBe('token')
  })
})
