/**
 * Fails for every capability a provider declares `true` that no test
 * exercised, and for every capability an anonymous provider declares `true`
 * that no test exercised without credentials. Reads `test/.verbs/`, written by
 * `test/setup/verbs.ts` during `vitest run`; pass `--report` to print without
 * failing.
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

const untested: string[] = []
for (const [forge, provider] of CHECKED_PROVIDERS) {
  const seen = exercised.get(forge) ?? new Set<string>()
  for (const entry of CAPABILITY_TABLE) {
    // Verifying and translating a webhook delivery sends no request, so credentials make no difference to it.
    if (!entry.verbs?.length || (provider.authKind === 'anonymous' && entry.derived === 'webhook')) {
      continue
    }
    const value = capabilityAt(provider.capabilities, entry.capability)
    const covered = (kind?: string) => entry.verbs!.some(verb => seen.has(kind ? `${verb}:${kind}` : verb))
    if (value === true && !covered()) {
      untested.push(`${forge}: ${entry.capability}`)
    }
    else if (value && typeof value === 'object') {
      for (const [kind, support] of Object.entries(value)) {
        if (support === true && !covered(kind)) {
          untested.push(`${forge}: ${entry.capability} (${kind})`)
        }
      }
    }
  }
}

const unique = [...new Set(untested)]
if (unique.length) {
  console.error(`${unique.length} capabilities are declared true without a test exercising them:\n  ${unique.join('\n  ')}`)
  if (!process.argv.includes('--report')) {
    process.exit(1)
  }
}
else {
  console.info('Every capability declared true is exercised by a test.')
}
