/**
 * Prints every provider's declared support for every capability as JSON.
 * Pass `--ref <git-ref>` to snapshot another commit with that commit's own
 * code, and `--out <file>` to write to a file. A ref without this script or
 * a baseline in `capability-baselines/` prints a notice and writes nothing.
 */
import type { SupportCell, SupportLevel } from './capabilities.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as forges from '../src/index.ts'
import { capabilityData } from './capabilities.ts'

/** Support levels keyed by capability path, or `<path>:<kind>` for capabilities declared per kind. */
export type SupportMap = Record<string, SupportLevel>

/** Support with one kind of credential, for providers where support depends on the kind. */
export interface SnapshotCredential {
  /** Short name, such as `fine-grained`. */
  id: string
  label: string
  capabilities: SupportMap
}

export interface SnapshotProvider {
  slug: string
  name: string
  experimental: boolean
  auth: string[]
  /** Support with credentials: the strongest support any kind of credential has. */
  capabilities: SupportMap
  /** Support for the provider created without credentials. */
  anonymous: SupportMap
  credentials?: SnapshotCredential[]
}

/** The capability matrix of one commit. */
export interface CapabilitySnapshot {
  version: 1
  providers: SnapshotProvider[]
}

export function capabilitySnapshot(): CapabilitySnapshot {
  const { providers, groups } = capabilityData(forges)
  const rows = groups.flatMap(group => group.rows)
  const flatten = (cellOf: (row: typeof rows[number]) => SupportCell) => {
    const map: SupportMap = {}
    for (const row of rows) {
      const cell = cellOf(row)
      for (const { kind, level } of cell.kinds ?? [
        { kind: '', level: cell.level },
      ]) {
        map[kind
          ? `${row.capability}:${kind}`
          : row.capability] = level
      }
    }
    return map
  }
  return {
    version: 1,
    providers: providers.map(({ slug, name, experimental, auth, credentials }, index) => ({
      slug,
      name,
      experimental,
      auth,
      capabilities: flatten(row => row.cells[index]!),
      anonymous: flatten(row => row.anonymousCells[index]!),
      ...credentials && {
        credentials: credentials.map(({ id, label }) => ({
          id,
          label,
          capabilities: flatten(row => row.cells[index]!.byCredential![id]!),
        })),
      },
    })),
  }
}

/**
 * Runs this script as committed at `ref`. For a release tag without the
 * script, reads `capability-baselines/<tag>.json` instead. Returns
 * `undefined` when neither exists.
 */
export function snapshotAt(ref: string): string | undefined {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const baseline = /^v\d+\.\d+\.\d+$/.test(ref)
    ? fileURLToPath(new URL(`./capability-baselines/${ref}.json`, import.meta.url))
    : undefined
  const directory = mkdtempSync(join(tmpdir(), 'forges-capabilities-'))
  try {
    const archive = execFileSync('git', [
      'archive',
      '--format=tar',
      ref,
      'package.json',
      'src',
      'scripts',
    ], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', directory], { input: archive })
    const script = join(directory, 'scripts/capability-snapshot.ts')
    if (existsSync(script)) {
      return execFileSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    }
    return baseline && existsSync(baseline)
      ? readFileSync(baseline, 'utf8')
      : undefined
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      ref: { type: 'string' },
      out: { type: 'string' },
    },
  })
  const json = values.ref
    ? snapshotAt(values.ref)
    : `${JSON.stringify(capabilitySnapshot(), null, 2)}\n`
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
