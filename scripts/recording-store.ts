import type { Fixture } from '../src/testing/index.ts'
import type { RecordedStep } from '../test/recording/layout.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fixtureFileName, isFixtureFile, SETUP_DIRECTORY, stepSlug } from '../test/recording/layout.ts'

/** A step that ran, with the steps whose findings it read. */
export interface StepRun {
  name: string
  needs: string[]
}

/** The responses one step received, and when it ran. */
export interface StepRecording extends StepRun {
  recordedAt: string
  fixtures: Fixture[]
}

export interface RecordingResult {
  /** Steps whose responses changed, and were written. */
  written: string[]
  /** Steps outside `only` that were written as well, as they read or are read by a written step. */
  extra: string[]
  /** Steps whose responses differ only in values that change between any two requests, and kept their files. */
  unchanged: string[]
  /** Steps that failed and kept their earlier recording. */
  kept: string[]
  /** Steps that failed and lost their earlier recording, as it read findings recorded since. */
  dropped: string[]
  /** Steps that a full recording no longer has, and whose directories were removed. */
  removed: string[]
  /** Steps that did not run, and read or are read by a written step, so their recording may no longer replay. */
  stale: string[]
}

const VOLATILE_HEADERS = /^(?:x-)?ratelimit-|^etag$|^retry-after$/
/** Counters and activity timestamps of a repository or account, which change between any two recordings. */
const VOLATILE_KEYS = new Set(['stargazers_count', 'watchers_count', 'watchers', 'forks_count', 'forks', 'open_issues_count', 'open_issues', 'subscribers_count', 'network_count', 'star_count', 'download_count', 'total_count', 'size', 'updated_at', 'pushed_at', 'last_activity_at', 'last_activity_on', 'local_time', 'duration', 'queued_duration', 'followers', 'following', 'public_repos', 'public_gists'])
/** Query parameters of a signed download URL that hold when it was signed or when it expires. */
const SIGNATURE_TIMES = new Set(['se', 'st', 'ske', 'skt', 'x-amz-date', 'x-amz-expires', 'expires'])

function unsigned(url: string): string {
  if (!URL.canParse(url)) {
    return url
  }
  const parsed = new URL(url)
  for (const key of [...parsed.searchParams.keys()].filter(key => SIGNATURE_TIMES.has(key.toLowerCase()))) {
    parsed.searchParams.delete(key)
  }
  return parsed.toString()
}

function material(fixture: Fixture): string {
  const headers = Object.fromEntries(Object.entries(fixture.response.headers ?? {}).filter(([name]) => !VOLATILE_HEADERS.test(name)).map(([name, value]) => [name, name === 'location' ? unsigned(value) : value]))
  return JSON.stringify({ ...fixture, request: { ...fixture.request, url: unsigned(fixture.request.url) }, response: { ...fixture.response, headers } }, (key, value: unknown) => VOLATILE_KEYS.has(key) ? undefined : value)
}

function requestOf({ request: { method, url, operationName, variables } }: Fixture): string {
  return `${method} ${url} ${operationName ?? ''} ${JSON.stringify(variables ?? null)}`
}

/** The fixtures ordered by request, keeping the order of those that share one, so that requests sent together keep the same files whichever is answered first. */
export function inRequestOrder(fixtures: Fixture[]): Fixture[] {
  return fixtures.map((fixture, index) => ({ fixture, index, key: requestOf(fixture) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index).map(({ fixture }) => fixture)
}

/** Whether two recordings of a step hold the same requests and responses, apart from rate limits, ETags, counters, activity timestamps and signature times. */
export function sameResponses(before: Fixture[], after: Fixture[]): boolean {
  return before.length === after.length && before.every((fixture, index) => material(fixture) === material(after[index]!))
}

function readGroup(directory: string): Fixture[] {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory).filter(isFixtureFile).sort((a, b) => Number.parseInt(a) - Number.parseInt(b)).map(file => JSON.parse(readFileSync(`${directory}${file}`, 'utf8')) as Fixture)
}

function writeGroup(directory: string, fixtures: Fixture[]): void {
  mkdirSync(directory, { recursive: true })
  for (const file of readdirSync(directory).filter(isFixtureFile)) {
    rmSync(`${directory}${file}`)
  }
  fixtures.forEach((fixture, index) => writeFileSync(`${directory}${fixtureFileName(fixture, index)}`, `${JSON.stringify(fixture, null, 2)}\n`))
}

function writeStep(directory: string, step: RecordedStep): void {
  const { name, recordedAt, needs } = step
  writeFileSync(`${directory}step.json`, `${JSON.stringify({ name, recordedAt, ...needs?.length && { needs } }, null, 2)}\n`)
}

/** The steps recorded in `directory`, by name. */
function storedSteps(directory: string): Map<string, RecordedStep & { slug: string }> {
  const root = `${directory}steps/`
  const steps = new Map<string, RecordedStep & { slug: string }>()
  for (const slug of existsSync(root) ? readdirSync(root) : []) {
    if (existsSync(`${root}${slug}/step.json`)) {
      const step = JSON.parse(readFileSync(`${root}${slug}/step.json`, 'utf8')) as RecordedStep
      steps.set(step.name, { ...step, slug })
    }
  }
  return steps
}

/** The steps connected to `names` in `directory` through what they read from each other, `names` included. */
export function connectedSteps(directory: string, names: Iterable<string>): Set<string> {
  const edges = new Map<string, string[]>()
  for (const [name, { needs = [] }] of storedSteps(directory)) {
    for (const need of needs) {
      edges.set(name, [...edges.get(name) ?? [], need])
      edges.set(need, [...edges.get(need) ?? [], name])
    }
  }
  const connected = new Set(names)
  for (const name of connected) {
    for (const next of edges.get(name) ?? []) {
      connected.add(next)
    }
  }
  return connected
}

/**
 * Writes the steps of a recording to `directory`, each to `steps/<slug>/`,
 * and the responses received outside any step to `setup/`.
 *
 * - A step whose responses are the same as before, apart from values that
 *   change between any two requests, keeps its files and its `recordedAt`.
 * - A step that failed keeps its earlier recording, unless `keepFailed` is
 *   `false` or a step it read from, directly or through others, is missing
 *   or was recorded after it.
 * - With `only`, the steps outside it are written too where their responses
 *   changed and they read from or are read by a written step, so that every
 *   recorded step still replays. Without it, steps the recording no longer
 *   has are removed and `setup/` is rewritten.
 */
export function writeRecording(directory: string, { steps, failed, setup, only, keepFailed = true }: { steps: StepRecording[], failed: StepRun[], setup: Fixture[], only?: Set<string>, keepFailed?: boolean }): RecordingResult {
  const result: RecordingResult = { written: [], extra: [], unchanged: [], kept: [], dropped: [], removed: [], stale: [] }
  const stored = storedSteps(directory)
  const ran = new Map<string, StepRun>([...steps, ...failed].map(step => [step.name, step]))
  const needsOf = (name: string) => new Set([...ran.get(name)?.needs ?? [], ...stored.get(name)?.needs ?? []])
  const linked = (a: string, b: string) => needsOf(a).has(b) || needsOf(b).has(a)
  const ordered = new Map(steps.map(step => [step.name, inRequestOrder(step.fixtures)]))
  const changed = new Set(steps.filter(({ name }) => !stored.has(name) || !sameResponses(readGroup(`${directory}steps/${stored.get(name)!.slug}/`), ordered.get(name)!)).map(step => step.name))
  const write = new Set(only ? [...only].filter(name => changed.has(name)) : changed)
  for (let grew = Boolean(only); grew;) {
    grew = false
    for (const name of changed) {
      if (!write.has(name) && [...write].some(other => linked(name, other))) {
        write.add(name)
        result.extra.push(name)
        grew = true
      }
    }
  }
  if (only) {
    result.stale = [...stored.keys()].filter(name => !ran.has(name) && [...write].some(other => linked(name, other)))
  }
  const fresh = new Map(steps.filter(step => write.has(step.name)).map(step => [step.name, step.recordedAt]))
  const recordedAt = (name: string) => fresh.get(name) ?? stored.get(name)?.recordedAt
  /** Whether a step it read from, directly or through others, is missing or was recorded after it. */
  const outdated = (name: string, at = recordedAt(name)!, seen = new Set<string>()): boolean => [...needsOf(name)].some((need) => {
    const time = recordedAt(need)
    return !time || time > at || (!seen.has(need) && seen.add(need) && outdated(need, at, seen))
  })

  for (const step of steps) {
    const target = `${directory}steps/${stepSlug(step.name)}/`
    if (write.has(step.name)) {
      writeGroup(target, ordered.get(step.name)!)
      writeStep(target, step)
      result.written.push(step.name)
    }
    else if (!changed.has(step.name)) {
      const previous = stored.get(step.name)!
      if (JSON.stringify(previous.needs ?? []) !== JSON.stringify(step.needs)) {
        writeStep(`${directory}steps/${previous.slug}/`, { ...previous, needs: step.needs })
      }
      result.unchanged.push(step.name)
    }
  }
  for (const { name } of failed.filter(({ name }) => stored.has(name))) {
    if (keepFailed && !outdated(name)) {
      result.kept.push(name)
    }
    else {
      rmSync(`${directory}steps/${stored.get(name)!.slug}`, { recursive: true, force: true })
      result.dropped.push(name)
    }
  }
  if (only) {
    return result
  }
  for (const [name, { slug }] of stored) {
    if (!ran.has(name)) {
      rmSync(`${directory}steps/${slug}`, { recursive: true, force: true })
      result.removed.push(name)
    }
  }
  const setupDirectory = `${directory}${SETUP_DIRECTORY}/`
  if (!setup.length) {
    rmSync(setupDirectory, { recursive: true, force: true })
  }
  else if (!sameResponses(readGroup(setupDirectory), inRequestOrder(setup))) {
    writeGroup(setupDirectory, inRequestOrder(setup))
  }
  return result
}
