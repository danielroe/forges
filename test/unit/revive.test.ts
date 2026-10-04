import { describe, expect, it } from 'vitest'
import { github } from '../../src/github/index.ts'
import { DATE_FIELDS, reviveDates } from '../../src/index.ts'
import { schemas } from '../../src/schema/index.ts'
import { fixtureFetch } from '../../src/testing/index.ts'

describe('serialisation helpers', () => {
  it('revives model dates at any depth after a JSON round trip', () => {
    const value = { items: [{ createdAt: new Date('2026-01-02T03:04:05Z'), title: '2026-01-02', nested: { occurredAt: new Date(0) } }] }
    const revived = reviveDates(JSON.parse(JSON.stringify(value)))

    expect(revived).toEqual(value)
    expect(revived.items[0]!.title).toBe('2026-01-02')
  })

  it('revives delivery, commit signature and review dates', () => {
    const value = { deliveredAt: new Date(0), author: { date: new Date(1) }, submittedAt: new Date(2) }

    expect(reviveDates(JSON.parse(JSON.stringify(value)))).toEqual(value)
  })

  it('leaves the forge\'s own JSON in `raw` and `payload` untouched', () => {
    const value = { createdAt: new Date(0), raw: { createdAt: '2020-01-01T00:00:00Z' }, payload: [{ updatedAt: '2020-01-01T00:00:00Z' }] }
    const revived = reviveDates(JSON.parse(JSON.stringify(value)))

    expect(revived.createdAt).toEqual(new Date(0))
    expect(revived.raw.createdAt).toBe('2020-01-01T00:00:00Z')
    expect(revived.payload[0]!.updatedAt).toBe('2020-01-01T00:00:00Z')
  })

  it('lists every date-time field the model schemas declare', () => {
    const found = new Set<string>()
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'properties' && value && typeof value === 'object') {
          for (const [name, property] of Object.entries(value)) {
            if ((property as { format?: string }).format === 'date-time') {
              found.add(name)
            }
          }
        }
        visit(value)
      }
    }
    visit(schemas)

    expect([...found].filter(name => !DATE_FIELDS.has(name))).toEqual([])
  })

  it('reports the request budget on pages and raw responses', async () => {
    const headers = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1767225600' }
    const { fetch } = fixtureFetch([
      { request: { method: 'GET', url: 'https://api.github.com/user/repos?per_page=100' }, response: { status: 200, headers, body: [] } },
      { request: { method: 'GET', url: 'https://api.github.com/rate_limit' }, response: { status: 200, headers, body: {} } },
    ])
    const provider = github({ auth: { type: 'token', token: 't' }, fetch }).create()
    const expected = { limit: 5000, remaining: 4999, resetAt: new Date(1767225600 * 1000) }

    expect((await provider.repos.listPage({ perPage: 100 })).rateLimit).toEqual(expected)
    expect((await provider.request('GET', '/rate_limit')).rateLimit).toEqual(expected)
  })
})
