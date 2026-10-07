import { describe, expect, it } from 'vitest'
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

  it('loads a fixture directory', async () => {
    const fixtures = await loadFixtures(new URL('../fixtures/github/recorded/github.com/', import.meta.url))

    expect(fixtures.length).toBeGreaterThan(0)
    expect(fixtures.every(fixture => fixture.request.url.startsWith('https://'))).toBe(true)
  })
})
