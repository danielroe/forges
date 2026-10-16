import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it } from 'vitest'
import { patientFetch, rateLimitWait } from '../../scripts/rate-limits.ts'

const now = Date.parse('2026-10-12T12:00:00Z')

function response(status: number, headers: Record<string, string> = {}, body = '{}'): Response {
  return new Response(body, { status, headers })
}

describe('reading the wait a rate limit asks for', () => {
  it('reads `retry-after` in seconds or as a date', async () => {
    expect(await rateLimitWait(response(429, { 'retry-after': '30' }), now)).toBe(30_000)
    expect(await rateLimitWait(response(403, { 'retry-after': 'Mon, 12 Oct 2026 12:02:00 GMT' }), now)).toBe(120_000)
  })

  it('reads the reset of an exhausted budget', async () => {
    expect(await rateLimitWait(response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }), now)).toBe(600_000)
    expect(await rateLimitWait(response(429, { 'ratelimit-remaining': '0', 'ratelimit-reset': '45' }), now)).toBe(45_000)
    expect(await rateLimitWait(response(429, { ratelimit: '"baseline";r=0;t=120' }), now)).toBe(120_000)
    expect(await rateLimitWait(response(429, { 'x-ratelimit-limit': '60, 60;w=3600', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3476' }), now)).toBe(3_476_000)
  })

  it('finds a limit named only in the body, with no wait', async () => {
    expect(await rateLimitWait(response(422, {}, '{"message":"Validation Failed","errors":[{"message":"was submitted too quickly"}]}'), now)).toBeNaN()
    expect(await rateLimitWait(response(403, { 'x-ratelimit-remaining': '4000' }, '{"message":"You have exceeded a secondary rate limit."}'), now)).toBeNaN()
  })

  it('reads the window of a limit named in the body', async () => {
    expect(await rateLimitWait(response(429, {}, '{"message":"newIssue: NewIssue: \\"roebot\\" posted 5 issues in under 5 minutes: rate limited","url":"https://codeberg.org/api/swagger"}'), now)).toBe(300_000)
  })

  it('leaves other refusals alone', async () => {
    expect(await rateLimitWait(response(403, { 'x-ratelimit-remaining': '4973' }, '{"message":"Resource not accessible by personal access token"}'), now)).toBeUndefined()
    expect(await rateLimitWait(response(422, {}, '{"message":"Validation Failed"}'), now)).toBeUndefined()
    expect(await rateLimitWait(response(201), now)).toBeUndefined()
  })
})

describe('sending requests patiently', () => {
  function clock() {
    let time = now
    const slept: number[] = []
    return { now: () => time, slept, sleep: async (ms: number) => {
      slept.push(ms)
      time += ms
    } }
  }

  function replies(...responses: Response[]): { fetch: FetchLike, sent: string[] } {
    const sent: string[] = []
    return { sent, fetch: async (input, init) => {
      sent.push(`${init?.method ?? 'GET'} ${input}`)
      return responses.shift()!
    } }
  }

  it('spaces out writes and not reads', async () => {
    const time = clock()
    const { fetch } = replies(response(201), response(200), response(201))
    const patient = patientFetch(fetch, { writeGap: 1000, ...time })
    await patient.fetch('https://forge.test/issues', { method: 'POST' })
    await patient.fetch('https://forge.test/issues')
    await patient.fetch('https://forge.test/issues', { method: 'POST' })

    expect(time.slept).toEqual([0, 1000])
  })

  it('sends a request again once the wait the forge names has passed, and returns only the last response', async () => {
    const time = clock()
    const { fetch, sent } = replies(response(429, { 'retry-after': '20' }), response(201))
    const patient = patientFetch(fetch, time)
    const result = await patient.fetch('https://forge.test/issues', { method: 'POST', body: '{}' })

    expect(result.status).toBe(201)
    expect(sent).toHaveLength(2)
    expect(time.slept).toEqual([21_000])
    expect(patient.limited()).toBeUndefined()
  })

  it('does not send a request again once the caller has given up on it', async () => {
    const controller = new AbortController()
    const time = clock()
    const { fetch, sent } = replies(response(429, { 'retry-after': '20' }), response(201))
    const patient = patientFetch(fetch, { ...time, sleep: async (ms) => {
      await time.sleep(ms)
      controller.abort(new Error('timed out'))
    } })

    await expect(patient.fetch('https://forge.test/issues', { method: 'POST', body: '{}', signal: controller.signal })).rejects.toThrow('timed out')
    expect(sent).toHaveLength(1)
  })

  it('waits once for a limit that names no wait, then passes it on', async () => {
    const time = clock()
    const limited = () => response(422, {}, '{"message":"was submitted too quickly"}')
    const { fetch, sent } = replies(limited(), limited())
    const patient = patientFetch(fetch, { unnamedWait: 60_000, ...time })
    const result = await patient.fetch('https://forge.test/issues', { method: 'POST', body: '{}' })

    expect(result.status).toBe(422)
    expect(sent).toHaveLength(2)
    expect(time.slept).toEqual([60_000])
    expect(patient.limited()).toBe('POST https://forge.test/issues was rate limited with no wait named')
  })

  it('passes on a limit that asks for a longer wait than it allows', async () => {
    const time = clock()
    const { fetch, sent } = replies(response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 3600) }))
    const patient = patientFetch(fetch, { maxWait: 300_000, ...time })
    const result = await patient.fetch('https://forge.test/issues', { method: 'POST', body: '{}' })

    expect(result.status).toBe(403)
    expect(sent).toHaveLength(1)
    expect(patient.limited()).toBe('POST https://forge.test/issues was rate limited for 60 minute(s)')
  })
})
