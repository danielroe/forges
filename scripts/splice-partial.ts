/**
 * Splices each write run that `record-fixtures.ts --defer-splice` saved in a
 * recording's `partial.json` into the committed recording, and removes the
 * file:
 *
 *   node scripts/splice-partial.ts
 *
 * Exits with 1 when a run could not be spliced. Its recording is then left
 * as committed.
 */
import type { PendingSplice } from './partial-writes.ts'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { WRITE_STEPS } from '../test/recording/write-steps.ts'
import { PENDING_SPLICE, reportSplice, spliceWrites } from './partial-writes.ts'
import { fixtures } from './stabilise-recordings.ts'

const STEP_NAMES = new Set(WRITE_STEPS.map(step => step.name))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The saved run, once its step names are known write steps. */
export function parsePendingSplice(text: string): PendingSplice {
  const value = JSON.parse(text) as unknown
  if (!isRecord(value) || !isRecord(value.manifest) || !Array.isArray(value.steps) || !Array.isArray(value.setup) || !Array.isArray(value.only) || !Array.isArray(value.remove)) {
    throw new Error(`${PENDING_SPLICE} is not a saved write run`)
  }
  const steps = value.steps as unknown[]
  if (!steps.every(step => isRecord(step) && Array.isArray(step.fixtures))) {
    throw new Error(`${PENDING_SPLICE} has a step without fixtures`)
  }
  const names = [...value.only, ...value.remove, ...steps.map(step => (step as Record<string, unknown>).name)]
  const unknown = names.filter(name => typeof name !== 'string' || !STEP_NAMES.has(name))
  if (unknown.length) {
    throw new Error(`${PENDING_SPLICE} names steps that are not write steps: ${unknown.map(name => JSON.stringify(name).slice(0, 80)).join(', ')}`)
  }
  return value as unknown as PendingSplice
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = false
  for (const forge of readdirSync(fixtures)) {
    const recorded = `${fixtures}${forge}/recorded/`
    for (const label of existsSync(recorded) ? readdirSync(recorded) : []) {
      const file = `${recorded}${label}/${PENDING_SPLICE}`
      if (!existsSync(file)) {
        continue
      }
      const { only, remove, ...run } = parsePendingSplice(readFileSync(file, 'utf8'))
      rmSync(file)
      console.info(`${forge}/recorded/${label}:`)
      failed = !reportSplice(spliceWrites(`${forge}/recorded/${label}`, run, new Set(only), remove)) || failed
    }
  }
  process.exitCode = failed ? 1 : 0
}
