import { describe, expect, it } from 'vitest'
import { cloudflareArtifacts } from '../../src/cloudflare-artifacts/index.ts'
import { ForgeError } from '../../src/errors.ts'
import { fixtureFetch } from '../../src/testing/index.ts'

const account = '023e105f4ecef8ad9ca31a8372d0c353'

function provider() {
  const fixtures = fixtureFetch([])
  return { ...fixtures, forge: cloudflareArtifacts({ accountId: account, auth: { type: 'token', token: 't' }, fetch: fixtures.fetch }).create() }
}

describe('cloudflare artifacts', () => {
  it('keys refs by the account\'s Git host and has no threads', () => {
    const { forge } = provider()
    expect(forge.instance).toBe(`${account}.artifacts.cloudflare.net`)
    expect(forge.webOrigin).toBeUndefined()
    expect(forge.can('threads.get', 'issue')).toBe(false)
  })

  it('lists nothing for filters no Artifacts repository matches, without a request', async () => {
    const { forge, calls } = provider()
    expect((await forge.repos.listPage({ affiliation: ['collaborator'] })).items).toEqual([])
    expect((await forge.repos.listPage({ visibility: 'public' })).items).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it.each(['more-agents', '"agents"', '{"repos":"x"}'])('rejects a listing cursor that `repos.list()` did not return: %s', async (token) => {
    const { forge, calls } = provider()
    await expect(forge.repos.listPage({ cursor: { token } })).rejects.toThrow(ForgeError)
    expect(calls).toHaveLength(0)
  })
})
