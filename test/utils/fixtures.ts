import type { FetchLike } from '../../src/fetch.ts'
import type { Fixture, FixtureFetch, FixtureFetchOptions } from '../../src/testing/index.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fixtureFetch as serveFixtures } from '../../src/testing/index.ts'
import { markPayload, markResponse } from './provenance.ts'

export type { Fixture, FixtureCall, FixtureFetch } from '../../src/testing/index.ts'

export function fixtureDirectory(provider: string): string {
  return fileURLToPath(new URL(`../fixtures/${provider}/`, import.meta.url))
}

/** The fixtures under `test/fixtures/<provider>/`, in the order their numbered names give. */
export function loadFixtures(provider: string): Fixture[] {
  const directory = fixtureDirectory(provider)
  return readdirSync(directory)
    .filter(file => file.endsWith('.json') && file !== 'manifest.json')
    .sort((a, b) => Number.parseInt(a) - Number.parseInt(b) || a.localeCompare(b))
    .map(file => JSON.parse(readFileSync(`${directory}${file}`, 'utf8')) as Fixture)
    .filter(fixture => fixture.request !== undefined)
}

/**
 * Serves the fixtures under `test/fixtures/<provider>/`; see `fixtureFetch` in
 * `forges/testing`. Responses from a recording, or from a fixture
 * hand-authored from documentation, carry their provenance; overrides do not.
 */
export function fixtureFetch(provider: string, overrides: Record<string, Fixture['response']> = {}, options: FixtureFetchOptions = {}): FixtureFetch {
  const recorded = provider.includes('/recorded/')
  const served = serveFixtures(loadFixtures(provider), overrides, options)
  const fetch: FetchLike = async (input, init) => {
    const index = served.calls.length
    const response = await served.fetch(input, init)
    const fixture = served.calls[index]?.fixture
    if (fixture && (recorded || fixture.handAuthored)) {
      markResponse(response, recorded ? 'recorded' : 'documented')
    }
    return response
  }
  return { fetch, calls: served.calls }
}

/** A webhook body hand-authored from the forge's documentation, under `test/fixtures/<provider>/`. */
export function payloadFixture(provider: string, name: string): string {
  return markPayload(readFileSync(`${fixtureDirectory(provider)}${name}.json`, 'utf8').trim(), 'documented')
}

/** Builds a `fetch` that always returns the same response. */
export function stubFetch(
  status: number,
  headers: Record<string, string> = {},
  body: unknown = { message: 'stub' },
): FetchLike {
  return async () => new Response(JSON.stringify(body), { status, headers })
}
