import type { Fixture } from '../src/testing/index.ts'
import type { StepRecording } from './recording-store.ts'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stepSlug } from '../test/recording/layout.ts'
import { withAncestors, writeRecording } from './recording-store.ts'
import { fixtures, load, replay, stabiliseRecording } from './stabilise-recordings.ts'
import { identifiersIn } from './stabilise.ts'

/** What a write run of some steps recorded. */
export interface PartialRun {
  manifest: object
  steps: StepRecording[]
  setup: Fixture[]
}

/** The file in a recording's directory that holds a run saved with `--defer-splice`. */
export const PENDING_SPLICE = 'partial.json'

/** A run saved with `--defer-splice`, and the arguments to splice it with. */
export interface PendingSplice extends PartialRun {
  only: string[]
  remove: string[]
}

export interface SpliceResult {
  /** Whether the steps were written; otherwise the committed recording is left as it was. */
  saved: boolean
  /** Why the steps were not written. */
  reason?: string
  /** Steps written into the recording. */
  written: string[]
  /** Steps written that were not selected, as a selected step read from them and their responses changed. */
  extra: string[]
  /** Selected steps whose responses are the same as the committed ones apart from timestamps. */
  unchanged: string[]
}

/**
 * Which stabilised steps to write: the selected steps and the steps they read
 * from whose responses changed, and the identifiers in those that could not be
 * renamed to the committed recording's.
 */
export function planSplice({ selected, ancestors, rewritten, skipped, steps }: { selected: string[], ancestors: Set<string>, rewritten: string[], skipped: Map<string, string>, steps: Map<string, Fixture[]> }): { write: string[], extra: string[], unchanged: string[], unrenamed: string[] } {
  const changed = new Set(rewritten)
  const write = [...ancestors].filter(name => changed.has(name))
  const unrenamed = write.flatMap(name => [...identifiersIn(steps.get(name) ?? [])].filter(token => skipped.has(token)).map(token => `${name}: ${token} ${skipped.get(token)}`))
  return { write, extra: write.filter(name => !selected.includes(name)), unchanged: selected.filter(name => !changed.has(name)), unrenamed }
}

/** Replaces the directories of the steps `names` in the recording `into` with those in `from`, and removes those of the steps in `remove`. */
export function spliceSteps(from: string, into: string, names: string[], remove: string[] = []): void {
  for (const name of remove) {
    rmSync(`${into}steps/${stepSlug(name)}`, { recursive: true, force: true })
  }
  for (const name of names) {
    const slug = stepSlug(name)
    rmSync(`${into}steps/${slug}`, { recursive: true, force: true })
    cpSync(`${from}steps/${slug}`, `${into}steps/${slug}`, { recursive: true })
  }
}

/** The top-level keys whose values differ between two manifests. */
export function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const sorted = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x.localeCompare(y))) : item)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => sorted(a[key]) !== sorted(b[key]))
}

/**
 * Writes the selected steps of a write run into the committed recording
 * `recording`, such as `github/recorded/github.com-writes`, with the
 * identifiers the run created renamed to the committed ones, and removes the
 * steps in `remove`.
 *
 * Every step that succeeded is stabilised against the committed recording,
 * as providers carry state such as cached lookups from one step to the next.
 * The selected steps, and the steps they read from whose responses changed,
 * are then written only if every identifier in them could be renamed, the
 * manifest is the committed one once renamed, and the recording then replays
 * with every golden output matching. Otherwise the committed recording is
 * left as it was.
 */
/** Logs what a splice wrote or why it did not; returns whether it did. */
export function reportSplice(result: SpliceResult): boolean {
  if (!result.saved) {
    console.error(`Kept the committed recording, as ${result.reason}`)
    return false
  }
  console.info(`${result.written.length} step(s) written, ${result.unchanged.length} unchanged apart from timestamps.`)
  if (result.extra.length) {
    console.info(`Also wrote these steps, which changed and are read by a written step:${result.extra.map(name => `\n  ${name}`).join('')}`)
  }
  return true
}

export function spliceWrites(recording: string, run: PartialRun, only: Set<string>, remove: string[] = []): SpliceResult {
  const directory = `${fixtures}${recording}/`
  const refused = (reason: string): SpliceResult => ({ saved: false, reason, written: [], extra: [], unchanged: [] })
  if (!existsSync(`${directory}manifest.json`)) {
    return refused(`${recording} has no committed recording to add steps to`)
  }
  const selected = run.steps.filter(step => only.has(step.name)).map(step => step.name)
  if (!selected.length) {
    return refused('none of the selected steps succeeded')
  }
  const ancestors = withAncestors(selected, run.steps)
  const work = mkdtempSync(join(tmpdir(), 'forges-partial-'))
  const previousRoot = `${work}/previous/`
  const committed = `${previousRoot}${recording}/`
  const stabilised = `${work}/stabilised/`
  cpSync(directory, committed, { recursive: true })
  const restore = () => {
    rmSync(directory, { recursive: true, force: true })
    cpSync(committed, directory, { recursive: true })
  }
  const refuse = (reason: string): SpliceResult => {
    const kept = mkdtempSync(join(tmpdir(), 'forges-refused-'))
    cpSync(directory, kept, { recursive: true })
    restore()
    return refused(`${reason}. The recording as it was then is in ${kept}`)
  }
  try {
    rmSync(directory, { recursive: true, force: true })
    writeRecording(directory, { steps: run.steps, failed: [], setup: run.setup })
    writeFileSync(`${directory}manifest.json`, `${JSON.stringify(run.manifest, null, 2)}\n`)
    const result = stabiliseRecording(recording, previousRoot)
    if (!result.stabilised) {
      return refuse(result.message)
    }
    const manifest = (path: string) => JSON.parse(readFileSync(`${path}manifest.json`, 'utf8')) as Record<string, unknown>
    const differing = differingKeys(manifest(committed), manifest(directory))
    if (differing.length) {
      return refuse(`${differing.map(key => `\`${key}\``).join(', ')} in the manifest differ from the committed one once renamed`)
    }
    const plan = planSplice({ selected, ancestors, rewritten: result.rewritten, skipped: result.skipped, steps: load(directory).steps })
    if (plan.unrenamed.length) {
      return refuse(`these identifiers could not be renamed to the committed recording's:${plan.unrenamed.map(line => `\n  ${line}`).join('')}`)
    }
    cpSync(directory, stabilised, { recursive: true })
    restore()
    spliceSteps(stabilised, directory, plan.write, remove)
    if (!replay(recording, { update: false })) {
      return refuse('the recording does not replay with the steps written into it')
    }
    return { saved: true, written: plan.write, extra: plan.extra, unchanged: plan.unchanged }
  }
  catch (error) {
    restore()
    throw error
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}
