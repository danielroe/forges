import type { Fixture } from '../../src/testing/index.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { STEPS } from './steps.ts'
import { WRITE_STEPS } from './write-steps.ts'

/**
 * A recording keeps each step in `steps/<slug>/`: a `step.json` naming the
 * step, when it was recorded and the steps it read from, the responses it
 * received as numbered fixtures, and its normalised output in `golden.json`. Responses received
 * outside any step go to `setup/`, which every step falls back to.
 */
export interface RecordedStep {
  name: string
  /** When the step was recorded; replay runs it at this instant. */
  recordedAt: string
  /** The steps whose findings it read. */
  needs?: string[]
}

export const SETUP_DIRECTORY = 'setup'

const READ_ORDER = new Map(STEPS.map((step, index) => [step.name, index]))
const WRITE_ORDER = new Map(WRITE_STEPS.map((step, index) => [step.name, index]))

export function stepSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z\d]+/g, '-').replace(/^-|-$/g, '')
}

/** The steps a recording directory holds, in the order they run. */
export function recordedSteps(directory: string): Array<RecordedStep & { slug: string }> {
  const root = `${directory}steps/`
  if (!existsSync(root)) {
    return []
  }
  const order = 'run' in JSON.parse(readFileSync(`${directory}manifest.json`, 'utf8')) ? WRITE_ORDER : READ_ORDER
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ slug: entry.name, ...JSON.parse(readFileSync(`${root}${entry.name}/step.json`, 'utf8')) as RecordedStep }))
    .sort((a, b) => (order.get(a.name) ?? Infinity) - (order.get(b.name) ?? Infinity))
}

/** Whether `name` is the file of a fixture rather than `step.json` or `golden.json`. */
export function isFixtureFile(name: string): boolean {
  return /^\d+-.*\.json$/.test(name)
}

const SEGMENTS: Array<[RegExp, string]> = [
  [/^\d+$/, 'N'],
  [/^[\da-f]{7,64}$/i, 'SHA'],
  [/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i, 'ID'],
]

/**
 * The file name of the `index`th fixture of a step, from its method and the
 * GraphQL operation or the last two path segments, with ids and SHAs replaced
 * so that the name stays the same when a recording returns new ones.
 */
export function fixtureFileName(fixture: Fixture, index: number): string {
  const { method, url, operationName } = fixture.request
  const path = new URL(url).pathname.split('/').filter(Boolean).slice(-2).map(segment => SEGMENTS.find(([pattern]) => pattern.test(segment))?.[1] ?? segment)
  const label = (operationName ?? path.join('-')).replace(/[^\w.-]+/g, '-').slice(0, 80)
  return `${String(index + 1).padStart(2, '0')}-${method.toLowerCase()}-${label || 'root'}.json`
}
