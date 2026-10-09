import { describe, expect, it } from 'vitest'
import { github } from '../../src/github/index.ts'
import { fixtureFetch, loadFixtures, recordingFetch, signDelivery } from '../../src/testing/index.ts'
import { contracts, WEBHOOK_SECRET } from '../contract/providers.ts'

describe('forges/testing', () => {
  it.each(contracts.filter(contract => contract.name !== 'cursor-origin'))('signs a delivery $name verifies', async (contract) => {
    const { fetch } = fixtureFetch([])
    const provider = contract.create(fetch)
    const headers = await signDelivery(provider.forge, contract.webhook.body, WEBHOOK_SECRET)

    expect(await provider.webhooks.verify({ headers, body: contract.webhook.body })).toBe(true)
    expect(await provider.webhooks.verify({ headers: await signDelivery(provider.forge, contract.webhook.body, 'wrong'), body: contract.webhook.body })).toBe(false)
  })

  it('replays what it recorded', async () => {
    const upstream = fixtureFetch([{ request: { method: 'GET', url: 'https://api.example.com/a?x=1&y=2' }, response: { status: 200, headers: { etag: '"e"' }, body: { ok: true } } }])
    const recorder = recordingFetch(upstream.fetch)
    await recorder.fetch('https://api.example.com/a?x=1&y=2', { headers: { authorization: 'Bearer secret' } })
    const replay = fixtureFetch(recorder.fixtures)
    const response = await replay.fetch('https://api.example.com/a?y=2&x=1')

    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('etag')).toBe('"e"')
    expect(JSON.stringify(recorder.fixtures)).not.toContain('secret')
  })

  it('replays a binary body byte for byte', async () => {
    const bytes = Uint8Array.from([0x1F, 0x8B, 0x08, 0x00, 0xFF, 0xFE, 0x00, 0x80])
    const recorder = recordingFetch(async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
    await recorder.fetch('https://api.example.com/asset')
    const replay = fixtureFetch(JSON.parse(JSON.stringify(recorder.fixtures)))
    const response = await replay.fetch('https://api.example.com/asset')

    expect(recorder.fixtures[0]!.response.encoding).toBe('base64')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it('serves fixtures that share a request in recorded order when sequential', async () => {
    const url = 'https://api.example.com/issues/1'
    const fixtures = [1, 2].map(version => ({ request: { method: 'GET', url }, response: { status: 200, body: { version } } }))
    const sequential = fixtureFetch(fixtures, {}, { sequential: true })
    const last = fixtureFetch(fixtures)
    const read = async (fetch: typeof last.fetch) => ((await (await fetch(url)).json()) as { version: number }).version

    expect([await read(sequential.fetch), await read(sequential.fetch), await read(sequential.fetch)]).toEqual([1, 2, 2])
    expect(await read(last.fetch)).toBe(2)
  })

  it('records request bodies only when asked to', async () => {
    const upstream = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
    const init = { method: 'POST', body: JSON.stringify({ title: 'x' }) }
    const withBodies = recordingFetch(upstream, undefined, { requestBodies: true })
    const without = recordingFetch(upstream)
    await withBodies.fetch('https://api.example.com/issues', init)
    await without.fetch('https://api.example.com/issues', init)

    expect(withBodies.fixtures[0]!.request.body).toEqual({ title: 'x' })
    expect(without.fixtures[0]!.request).not.toHaveProperty('body')
  })

  it('replays an integer beyond the safe range exactly', async () => {
    const recorder = recordingFetch(async () => new Response('[{"id":3847328607500238881}]'))
    await recorder.fetch('https://api.github.com/repos/acme/widgets/hooks/1/deliveries')
    const provider = github({ auth: { type: 'token', token: 't' }, fetch: fixtureFetch(recorder.fixtures).fetch }).create()
    const hook = { forge: 'github', instance: 'github.com', target: { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }, id: '1' }

    expect((await provider.webhooks.deliveriesPage(hook)).items[0]!.ref.id).toBe('3847328607500238881')
  })

  it('loads a fixture directory', async () => {
    const fixtures = await loadFixtures(new URL('../fixtures/github/recorded/github.com/', import.meta.url))

    expect(fixtures.length).toBeGreaterThan(0)
    expect(fixtures.every(fixture => fixture.request.url.startsWith('https://'))).toBe(true)
  })
})
