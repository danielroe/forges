/**
 * Copies the recordings that the `fixtures` workflow downloaded into
 * `test/fixtures/`, after checking that they hold only fixture JSON:
 *
 *   node scripts/apply-recordings.ts <directory> --kind reads|writes [--summary <file>]
 *
 * Each `<directory>/recording-<kind>-<forge>/` holds the forge's `recorded/`
 * directory and a `summary.md`. Reads replace every recording of the forge
 * apart from its `-writes` and `-webhooks` ones, and writes replace only its
 * `-writes` recording. `--summary` writes the summaries of every forge to one
 * file. Prints the forges whose recordings it copied.
 */
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PLANS } from './record-forge.ts'

const RECORDING = /^[a-z\d.-]+$/
const FILE = /^(?:manifest|jetstream|golden|partial)\.json$|^\d+-[\w.-]+\.delivery\.json$/
const STEP_FILE = /^(?:step|golden)\.json$|^\d+-[\w.-]+\.json$/
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024

function fail(reason: string): never {
  throw new Error(`Refusing the recordings: ${reason}`)
}

function entries(directory: string): string[] {
  return readdirSync(directory).filter(entry => !lstatSync(`${directory}/${entry}`).isSymbolicLink() || fail(`${directory}/${entry} is a symbolic link`))
}

/** Checks that `recorded` holds only directories and fixture files with the names a recording uses, and returns its size. */
function check(recorded: string): number {
  let total = 0
  const file = (path: string, pattern: RegExp, name: string) => {
    const stat = lstatSync(path)
    if (!stat.isFile() || !pattern.test(name) || stat.size > MAX_FILE_BYTES) {
      fail(`${path} is not a fixture file`)
    }
    try {
      JSON.parse(readFileSync(path, 'utf8'))
    }
    catch {
      fail(`${path} is not JSON`)
    }
    total += stat.size
  }
  const directory = (path: string) => lstatSync(path).isDirectory() || fail(`${path} is not a directory`)
  for (const recording of entries(recorded)) {
    const root = `${recorded}/${recording}`
    if (!RECORDING.test(recording) || !directory(root)) {
      fail(`${root} is not a recording`)
    }
    for (const entry of entries(root)) {
      if (entry === 'steps') {
        directory(`${root}/steps`)
        for (const step of entries(`${root}/steps`)) {
          if (!/^[a-z\d-]+$/.test(step) || !directory(`${root}/steps/${step}`)) {
            fail(`${root}/steps/${step} is not a step`)
          }
          for (const name of entries(`${root}/steps/${step}`)) {
            file(`${root}/steps/${step}/${name}`, STEP_FILE, name)
          }
        }
      }
      else if (entry === 'setup') {
        directory(`${root}/setup`)
        for (const name of entries(`${root}/setup`)) {
          file(`${root}/setup/${name}`, /^\d+-[\w.-]+\.json$/, name)
        }
      }
      else {
        file(`${root}/${entry}`, FILE, entry)
      }
    }
  }
  return total
}

/** Whether a recording directory belongs to `kind`. */
function ofKind(recording: string, kind: 'reads' | 'writes'): boolean {
  return kind === 'writes' ? recording.endsWith('-writes') : !recording.endsWith('-writes') && !recording.endsWith('-webhooks')
}

/** Copies the recordings of `kind` from `directory` into `fixtures`, and returns the forges copied with their summaries. */
export function applyRecordings(directory: string, kind: 'reads' | 'writes', fixtures: string): Array<{ forge: string, summary: string }> {
  const applied: Array<{ forge: string, summary: string }> = []
  let total = 0
  const artifacts = entries(directory).sort()
  for (const artifact of artifacts) {
    const forge = artifact.slice(`recording-${kind}-`.length)
    if (!artifact.startsWith(`recording-${kind}-`) || !(forge in PLANS)) {
      fail(`${artifact} is not a recording of a known forge`)
    }
    const recorded = `${directory}/${artifact}/recorded`
    if (existsSync(recorded)) {
      total += check(recorded)
    }
    if (total > MAX_TOTAL_BYTES) {
      fail(`the recordings are larger than ${MAX_TOTAL_BYTES} bytes`)
    }
  }
  for (const artifact of artifacts) {
    const forge = artifact.slice(`recording-${kind}-`.length)
    const recorded = `${directory}/${artifact}/recorded`
    for (const recording of existsSync(recorded) ? entries(recorded).filter(entry => ofKind(entry, kind)) : []) {
      const target = `${fixtures}/${forge}/recorded/${recording}`
      rmSync(target, { recursive: true, force: true })
      cpSync(`${recorded}/${recording}`, target, { recursive: true })
    }
    const summary = `${directory}/${artifact}/summary.md`
    applied.push({ forge, summary: existsSync(summary) && lstatSync(summary).isFile() ? readFileSync(summary, 'utf8').slice(0, 20_000) : '' })
  }
  return applied
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals: [directory], values } = parseArgs({ allowPositionals: true, options: { kind: { type: 'string' }, summary: { type: 'string' } } })
  if (!directory || (values.kind !== 'reads' && values.kind !== 'writes')) {
    console.error('Usage: node scripts/apply-recordings.ts <directory> --kind reads|writes [--summary <file>]')
    process.exit(1)
  }
  const applied = applyRecordings(directory, values.kind, fileURLToPath(new URL('../test/fixtures', import.meta.url)))
  if (values.summary) {
    writeFileSync(values.summary, applied.map(({ summary }) => summary).join('\n'))
  }
  console.info(applied.map(({ forge }) => forge).join('\n'))
}
