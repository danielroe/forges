/**
 * Fails for every capability a provider declares `true` that no test
 * exercised, and for every capability an anonymous provider declares `true`
 * that no test exercised without credentials. Reads `test/.verbs/`, written by
 * `test/setup/verbs.ts` during `vitest run`; pass `--report` to print without
 * failing.
 */
import type { ForgeCapabilities, ForgeProvider } from '../src/index.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { CAPABILITY_TABLE } from '../src/capability-table.ts'
import { azureDevOps, bitbucket, cursorOrigin, forgejo, gitea, gitee, github, gitlab, pushin, tangled } from '../src/index.ts'

const directory = new URL('../test/.verbs/', import.meta.url)
if (!existsSync(directory)) {
  console.error('No test/.verbs/ directory; run `vitest run` first.')
  process.exit(1)
}

const exercised = new Map<string, Set<string>>()
for (const file of readdirSync(directory)) {
  const data = JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as Record<string, string[]>
  for (const [forge, verbs] of Object.entries(data)) {
    const set = exercised.get(forge) ?? new Set<string>()
    exercised.set(forge, set)
    for (const verb of verbs) {
      set.add(verb)
    }
  }
}

/** Forges sharing one implementation, so a test on either exercises both. */
for (const [left, right] of [['forgejo', 'gitea'], ['forgejo:anonymous', 'gitea:anonymous']]) {
  const merged = new Set([...exercised.get(left!) ?? [], ...exercised.get(right!) ?? []])
  exercised.set(left!, merged)
  exercised.set(right!, merged)
}

const auth = { type: 'token', token: 't' } as const
const providers: Array<[string, ForgeProvider]> = [
  ['github', github({ auth }).create()],
  ['github', github({ auth: { type: 'app', appId: 1, privateKey: '', installationId: 1 } }).create()],
  ['gitlab', gitlab({ auth }).create()],
  ['bitbucket', bitbucket({ auth }).create()],
  ['forgejo', forgejo({ auth }).create()],
  ['gitea', gitea({ auth }).create()],
  ['gitee', gitee({ auth }).create()],
  ['azure-devops', azureDevOps({ auth, organization: 'acme' }).create()],
  ['cursor-origin', cursorOrigin({ auth }).create()],
  ['tangled', tangled({ auth: { type: 'app_password', identifier: 'h', password: 'p' }, notificationsUrl: 'https://notifications.example' }).create()],
  ['pushin', pushin({ auth }).create()],
  ['github:anonymous', github({}).create()],
  ['gitlab:anonymous', gitlab({}).create()],
  ['bitbucket:anonymous', bitbucket({}).create()],
  ['forgejo:anonymous', forgejo({}).create()],
  ['gitea:anonymous', gitea({}).create()],
  ['gitee:anonymous', gitee({}).create()],
  ['azure-devops:anonymous', azureDevOps({ organization: 'acme' }).create()],
  ['cursor-origin:anonymous', cursorOrigin({}).create()],
  ['tangled:anonymous', tangled({}).create()],
  ['pushin:anonymous', pushin({}).create()],
]

function read(capabilities: ForgeCapabilities, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], capabilities)
}

const untested: string[] = []
for (const [forge, provider] of providers) {
  const seen = exercised.get(forge) ?? new Set<string>()
  for (const entry of CAPABILITY_TABLE) {
    // Verifying and translating a webhook delivery sends no request, so credentials make no difference to it.
    if (!entry.verbs?.length || (provider.authKind === 'anonymous' && entry.derived === 'webhook')) {
      continue
    }
    const value = read(provider.capabilities, entry.capability)
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
