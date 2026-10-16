import type { FetchLike } from '../../src/fetch.ts'
import type { Fixture, FixtureCall, FixtureFetch, FixtureFetchOptions } from '../../src/testing/index.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toBase64 } from '../../src/crypto.ts'
import { fixtureFetch as serveFixtures } from '../../src/testing/index.ts'
import { recordedSteps, SETUP_DIRECTORY } from '../recording/layout.ts'
import { markPayload, markResponse } from './provenance.ts'

export type { Fixture, FixtureCall, FixtureFetch } from '../../src/testing/index.ts'

export function fixtureDirectory(provider: string): string {
  return fileURLToPath(new URL(`../fixtures/${provider}/`, import.meta.url))
}

/**
 * The fixtures under `test/fixtures/<provider>/`, in the order their numbered
 * names give. For a recording, the fixtures of `setup/` and of every step, in
 * the order the steps run.
 */
export function loadFixtures(provider: string): Fixture[] {
  const directory = fixtureDirectory(provider)
  const steps = recordedSteps(directory)
  if (steps.length) {
    const groups = [...existsSync(`${directory}${SETUP_DIRECTORY}/`) ? [SETUP_DIRECTORY] : [], ...steps.map(step => `steps/${step.slug}`)]
    return groups.flatMap(group => loadFixtures(`${provider}/${group}`))
  }
  return readdirSync(directory)
    .filter(file => file.endsWith('.json') && !['manifest.json', 'step.json', 'golden.json'].includes(file))
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

/** A `fetch` that serves a recording one step at a time, as `fixtureFetch()` does. */
export interface StepFixtureFetch extends FixtureFetch {
  /** Serves the fixtures of the step in `steps/<slug>/` from now on, falling back to `setup/`. */
  use: (slug: string) => void
}

/**
 * Serves the recording under `test/fixtures/<recording>/` so that each step
 * reads only the responses recorded for it, and those recorded outside any
 * step.
 */
export function stepFixtureFetch(recording: string, options: FixtureFetchOptions = {}): StepFixtureFetch {
  const setup = existsSync(`${fixtureDirectory(recording)}${SETUP_DIRECTORY}/`) ? fixtureFetch(`${recording}/${SETUP_DIRECTORY}`, {}, options) : undefined
  const steps = new Map<string, FixtureFetch>()
  const calls: FixtureCall[] = []
  let current = ''
  const fetch: FetchLike = async (input, init) => {
    if (!steps.has(current)) {
      steps.set(current, fixtureFetch(`${recording}/steps/${current}`, {}, options))
    }
    for (const source of [steps.get(current)!, setup]) {
      const index = source?.calls.length ?? 0
      try {
        const response = await source?.fetch(input, init)
        if (response) {
          calls.push(source!.calls[index]!)
          return response
        }
      }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('No fixture for')) {
          throw error
        }
      }
    }
    throw new Error(`No fixture for ${(init?.method ?? 'GET').toUpperCase()} ${input} in step ${current} or ${SETUP_DIRECTORY}`)
  }
  const use = (slug: string) => {
    current = slug
  }
  return { fetch, calls, use }
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

/**
 * Builds a `fetch` that stays pending until its request is aborted, then rejects
 * with the caller's reason. `started` resolves once the first request arrives, so
 * a test can abort deterministically instead of racing the provider's setup.
 */
export function hangingFetch(): { fetch: FetchLike, started: Promise<void> } {
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const fetch: FetchLike = (_input, init) => {
    markStarted()
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!
      const onAbort = () => reject(signal.reason)
      if (signal.aborted) {
        onAbort()
      }
      else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
  return { fetch, started }
}

/** A contents API directory listing as GitHub, Forgejo and Gitea serve it, where a path ending in `/` is a directory. */
export function contentsListing(...paths: string[]): Fixture['response'] {
  return { status: 200, body: paths.map(contentsEntry) }
}

/** One file from the contents API, base64 encoded the way GitHub, Forgejo and Gitea serve it. */
export function contentsFile(path: string, text: string): Fixture['response'] {
  return { status: 200, body: { ...contentsEntry(path), encoding: 'base64', content: toBase64(new TextEncoder().encode(text)) } }
}

function contentsEntry(path: string) {
  const directory = path.endsWith('/')
  const clean = directory ? path.slice(0, -1) : path
  return { type: directory ? 'dir' : 'file', name: clean.split('/').at(-1), path: clean, sha: directory ? 'd' : 'f' }
}
