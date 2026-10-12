/**
 * Renames the identifiers that write recordings created to the ones the
 * recordings they replace created in their place, and keeps the files of the
 * steps that are then the same apart from timestamps:
 *
 *   node scripts/stabilise-recordings.ts [--previous <fixtures-directory>] [<forge>/<recording>]...
 *
 * Without recordings named, it stabilises every `-writes` recording that
 * differs from the one committed at `HEAD`, or from the one under
 * `--previous`, a directory laid out like `test/fixtures/`. A recording is
 * stabilised only when it replays as recorded, replays once renamed, and the
 * golden output of every rewritten step is the recorded one renamed in the
 * same way. Otherwise it is left as recorded.
 */
import type { Fixture } from '../src/testing/index.ts'
import type { Run } from './stabilise.ts'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { fixtureFileName, isFixtureFile, SETUP_DIRECTORY } from '../test/recording/layout.ts'
import { sameResponses } from './recording-store.ts'
import { rename, stabilise, withoutTimestamps } from './stabilise.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtures = `${root}test/fixtures/`

interface Recording extends Run {
  /** The directory of each step, relative to the recording, by step name. */
  paths: Map<string, string>
}

/** Stands for `setup/` among the step names; no step can have it. */
const SETUP = '\u0000setup'

function readGroup(directory: string): Fixture[] {
  return readdirSync(directory).filter(isFixtureFile).sort((a, b) => Number.parseInt(a) - Number.parseInt(b)).map(file => JSON.parse(readFileSync(`${directory}${file}`, 'utf8')) as Fixture)
}

function load(directory: string): Recording {
  const steps = new Map<string, Fixture[]>()
  const paths = new Map<string, string>()
  for (const slug of readdirSync(`${directory}steps/`)) {
    const { name } = JSON.parse(readFileSync(`${directory}steps/${slug}/step.json`, 'utf8')) as { name: string }
    steps.set(name, readGroup(`${directory}steps/${slug}/`))
    paths.set(name, `steps/${slug}/`)
  }
  if (existsSync(`${directory}${SETUP_DIRECTORY}/`)) {
    steps.set(SETUP, readGroup(`${directory}${SETUP_DIRECTORY}/`))
    paths.set(SETUP, `${SETUP_DIRECTORY}/`)
  }
  return { manifest: JSON.parse(readFileSync(`${directory}manifest.json`, 'utf8')) as Record<string, unknown>, steps, paths }
}

/** Replays one recording with `vitest -u`, so that its golden output is written; returns whether its tests ran and passed. */
function replay(recording: string): boolean {
  const report = join(mkdtempSync(join(tmpdir(), 'forges-replay-')), 'report.json')
  const result = spawnSync(`${root}node_modules/.bin/vitest`, ['run', '--project', 'unit', 'test/recorded.test.ts', '-u', '--reporter=json', `--outputFile=${report}`], { cwd: root, encoding: 'utf8', env: { ...process.env, FORGES_RECORDING: recording } })
  const { numPassedTests = 0, numFailedTests = 1 } = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) as { numPassedTests?: number, numFailedTests?: number } : {}
  rmSync(report.slice(0, -'/report.json'.length), { recursive: true, force: true })
  if (result.status !== 0 || numFailedTests || !numPassedTests) {
    process.stderr.write(`${recording} does not replay: ${numPassedTests} passed, ${numFailedTests} failed\n${result.stderr.slice(-4000)}`)
    return false
  }
  return true
}

function goldens(directory: string, recording: Recording): Map<string, string> {
  return new Map([...recording.paths].flatMap(([name, path]) => existsSync(`${directory}${path}golden.json`) ? [[name, readFileSync(`${directory}${path}golden.json`, 'utf8')] as const] : []))
}

/** The first path at which two JSON values differ, or `undefined` when they are the same. */
function firstDifference(a: unknown, b: unknown, path = ''): string | undefined {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }
  return a === b ? undefined : path || '.'
}

/** Replaces the fixtures of a step, named after their renamed requests. */
function writeFixtures(directory: string, fixtures: Fixture[]): void {
  for (const name of readdirSync(directory).filter(isFixtureFile)) {
    rmSync(`${directory}${name}`)
  }
  fixtures.forEach((fixture, index) => writeFileSync(`${directory}${fixtureFileName(fixture, index)}`, `${JSON.stringify(fixture, null, 2)}\n`))
}

/** Stabilises one recording, and returns what it did. */
function stabiliseRecording(recording: string, previousRoot: string): string {
  const directory = `${fixtures}${recording}/`
  const before = `${previousRoot}${recording}/`
  if (!existsSync(`${before}manifest.json`)) {
    return `${recording}: nothing to compare with`
  }
  if (!replay(recording)) {
    return `${recording}: left as recorded, as it does not replay`
  }
  const backup = mkdtempSync(join(tmpdir(), 'forges-raw-'))
  cpSync(directory, backup, { recursive: true })
  const current = load(directory)
  const previous = load(before)
  const raw = goldens(directory, current)
  const { manifest, steps, renamed, skipped } = stabilise(current, previous)
  const kept: string[] = []
  const rewritten: string[] = []
  for (const [name, stabilised] of steps) {
    const target = `${directory}${current.paths.get(name)}`
    const earlier = previous.steps.get(name)
    if (earlier && sameResponses(withoutTimestamps(earlier), withoutTimestamps(stabilised))) {
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      cpSync(`${before}${previous.paths.get(name)}`, target, { recursive: true })
      if (name !== SETUP) {
        kept.push(name)
      }
    }
    else {
      writeFixtures(target, stabilised)
      if (name !== SETUP) {
        rewritten.push(name)
      }
    }
  }
  if (JSON.stringify(manifest) === JSON.stringify(previous.manifest)) {
    cpSync(`${before}manifest.json`, `${directory}manifest.json`)
  }
  else {
    writeFileSync(`${directory}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  const restore = (reason: string) => {
    rmSync(directory, { recursive: true, force: true })
    cpSync(backup, directory, { recursive: true })
    return `${recording}: left as recorded, as ${reason}`
  }
  try {
    if (!replay(recording)) {
      return restore('it does not replay once renamed')
    }
    const after = goldens(directory, load(directory))
    const differing = rewritten.flatMap((name) => {
      const path = raw.has(name) ? firstDifference(rename(JSON.parse(raw.get(name)!), '', renamed), JSON.parse(after.get(name) ?? 'null')) : undefined
      return path === undefined ? [] : [`${name} (at \`${path}\`)`]
    })
    if (differing.length) {
      return restore(`renaming changes the replayed output of ${differing.join(', ')}`)
    }
    return `${recording}: ${kept.length} step(s) kept, ${rewritten.length} rewritten, ${renamed.size} identifier(s) renamed, ${skipped.size} left as recorded`
  }
  finally {
    rmSync(backup, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { previous: { type: 'string' } } })
  const changed = execFileSync('git', ['status', '--porcelain', '--', 'test/fixtures'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map(line => /test\/fixtures\/([^/]+\/recorded\/[^/]+-writes)\//.exec(line)?.[1])
    .filter((recording): recording is string => !!recording)
  const recordings = positionals.length ? positionals.map(name => name.includes('/recorded/') ? name : name.replace('/', '/recorded/')) : [...new Set(changed)]
  let previousRoot = values.previous?.replace(/\/?$/, '/')
  let archive: string | undefined
  if (!previousRoot) {
    archive = mkdtempSync(join(tmpdir(), 'forges-previous-'))
    for (const recording of recordings) {
      const listed = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', `test/fixtures/${recording}`], { cwd: root, encoding: 'utf8' }).trim()
      if (listed) {
        const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD', `test/fixtures/${recording}`], { cwd: root, maxBuffer: 512 * 1024 * 1024 })
        execFileSync('tar', ['-x', '-C', archive], { input: tar })
      }
    }
    previousRoot = `${archive}/test/fixtures/`
  }
  try {
    for (const recording of recordings) {
      console.info(stabiliseRecording(recording, previousRoot))
    }
  }
  finally {
    if (archive) {
      rmSync(archive, { recursive: true, force: true })
    }
  }
}
