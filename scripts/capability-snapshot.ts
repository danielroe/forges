/**
 * Prints every provider's declared support for every capability as JSON.
 * Pass `--ref <git-ref>` to snapshot another commit with that commit's own
 * code, and `--out <file>` to write to a file. A ref without this script
 * prints a notice and writes nothing.
 */
import type { SupportCell, SupportLevel } from './capabilities.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as forges from '../src/index.ts'
import { capabilityData } from './capabilities.ts'

/** Support levels keyed by capability path, or `<path>:<kind>` for capabilities declared per kind. */
export type SupportMap = Record<string, SupportLevel>

export interface SnapshotProvider {
  slug: string
  name: string
  experimental: boolean
  auth: string[]
  /** Support with credentials. */
  capabilities: SupportMap
  /** Support for the provider created without credentials. */
  anonymous: SupportMap
}

/** The capability matrix of one commit. */
export interface CapabilitySnapshot {
  version: 1
  providers: SnapshotProvider[]
}

export function capabilitySnapshot(): CapabilitySnapshot {
  const { providers, groups } = capabilityData(forges)
  const rows = groups.flatMap(group => group.rows)
  const flatten = (cells: (row: typeof rows[number]) => SupportCell[], index: number) => {
    const map: SupportMap = {}
    for (const row of rows) {
      const cell = cells(row)[index]!
      for (const { kind, level } of cell.kinds ?? [{ kind: '', level: cell.level }]) {
        map[kind ? `${row.capability}:${kind}` : row.capability] = level
      }
    }
    return map
  }
  return {
    version: 1,
    providers: providers.map(({ slug, name, experimental, auth }, index) => ({
      slug,
      name,
      experimental,
      auth,
      capabilities: flatten(row => row.cells, index),
      anonymous: flatten(row => row.anonymousCells, index),
    })),
  }
}

/** Runs this script as committed at `ref`, or returns `undefined` when `ref` has no such script. */
export function snapshotAt(ref: string): string | undefined {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'forges-capabilities-'))
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', ref, 'package.json', 'src', 'scripts'], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', directory], { input: archive })
    const script = join(directory, 'scripts/capability-snapshot.ts')
    return existsSync(script) ? execFileSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) : undefined
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { ref: { type: 'string' }, out: { type: 'string' } } })
  const json = values.ref ? snapshotAt(values.ref) : `${JSON.stringify(capabilitySnapshot(), null, 2)}\n`
  if (json === undefined) {
    console.info(`${values.ref} has no capability snapshot script; nothing to compare against.`)
  }
  else if (values.out) {
    writeFileSync(values.out, json)
  }
  else {
    process.stdout.write(json)
  }
}
