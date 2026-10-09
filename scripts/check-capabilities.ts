/**
 * Checks every capability a provider declares against the forge data the
 * tests used, read from `test/.verbs/` (written by `test/setup/verbs.ts`
 * during `vitest run`):
 *
 * - `true`, `'experimental'` and `'emulated'` need a call that used a
 *   recording of the live forge or a fixture hand-authored from its
 *   documentation, or that sends no request;
 * - `'unverified'` fails once such a call exists, so that it is promoted.
 *
 * Anonymous providers are checked against calls made without credentials.
 * Pass `--report` to print without failing, and `--documented` to list the
 * capabilities that only documentation fixtures verify, which are still to
 * be recorded.
 */
import { existsSync } from 'node:fs'
import process from 'node:process'
import { CAPABILITY_TABLE } from '../src/capability-table.ts'
import { capabilityAt, CHECKED_PROVIDERS, readExercised } from './exercised.ts'

const directory = new URL('../test/.verbs/', import.meta.url)
if (!existsSync(directory)) {
  console.error('No test/.verbs/ directory; run `vitest run` first.')
  process.exit(1)
}

const exercised = readExercised(directory)

/** Forges sharing one implementation, so a test on either exercises both. */
for (const [left, right] of [['forgejo', 'gitea'], ['forgejo:anonymous', 'gitea:anonymous']]) {
  const merged = new Set([...exercised.get(left!) ?? [], ...exercised.get(right!) ?? []])
  exercised.set(left!, merged)
  exercised.set(right!, merged)
}

const unverified: string[] = []
const promotable: string[] = []
const documented: string[] = []
for (const [forge, provider] of CHECKED_PROVIDERS) {
  const seen = exercised.get(forge) ?? new Set<string>()
  for (const entry of CAPABILITY_TABLE) {
    // Verifying and translating a webhook delivery sends no request, so credentials make no difference to it.
    if (!entry.verbs?.length || (provider.authKind === 'anonymous' && entry.derived === 'webhook')) {
      continue
    }
    const value = capabilityAt(provider.capabilities, entry.capability)
    const cells = value && typeof value === 'object' ? Object.entries(value) : [['', value] as const]
    for (const [kind, support] of cells) {
      const name = `${forge}: ${entry.capability}${kind ? ` (${kind})` : ''}`
      const has = (provenance: string) => entry.verbs!.some(verb => seen.has(`${kind ? `${verb}:${kind}` : verb}#${provenance}`))
      const verified = has('recorded') || has('documented') || has('offline')
      if (support === 'unverified' && verified && !entry.derived) {
        promotable.push(name)
      }
      else if (support !== false && support !== 'unverified' && !verified) {
        unverified.push(`${name} is ${support === true ? 'true' : `'${support}'`}`)
      }
      else if (verified && !has('recorded') && !has('offline')) {
        documented.push(name)
      }
    }
  }
}

const failures = [
  ...[...new Set(unverified)].map(line => `${line}, but no test verifies it against a recording or documentation; declare it 'unverified'`),
  ...[...new Set(promotable)].map(line => `${line} is 'unverified', but a recording or documentation verifies it; declare it true, 'experimental' or 'emulated'`),
]
const onlyDocumented = [...new Set(documented)]
console.info(process.argv.includes('--documented')
  ? `${onlyDocumented.length} capabilities are verified only by fixtures written from documentation:\n  ${onlyDocumented.join('\n  ')}`
  : `${onlyDocumented.length} capabilities are verified only by fixtures written from documentation, and are still to be recorded; pass --documented to list them.`)
if (failures.length) {
  console.error(`${failures.length} capabilities do not match what the tests verify:\n  ${failures.join('\n  ')}`)
  if (!process.argv.includes('--report')) {
    process.exit(1)
  }
}
else {
  console.info('Every declared capability matches what the tests verify.')
}
