import type { ForgeCapabilities, ForgeProvider } from '../src/index.ts'
import type { VerbRun } from '../test/setup/verbs-directory.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { azureDevOps, bitbucket, cloudflareArtifacts, cursorOrigin, forgejo, gitea, gitee, github, gitlab, pushin, sourcehut, tangled } from '../src/index.ts'
import { VERB_RUN } from '../test/setup/verbs-directory.ts'
import { withDeclared } from './capabilities.ts'

/** Why the run that wrote `directory` left verbs out, or an empty list when it ran every test of the unit project. */
export function partialRun(directory: URL): string[] {
  const file = new URL(VERB_RUN, directory)
  if (!existsSync(file)) {
    return ['the run did not finish']
  }
  const run = JSON.parse(readFileSync(file, 'utf8')) as VerbRun
  const list = (files: string[]) => files.length > 5 ? `${files.slice(0, 5).join(', ')} and ${files.length - 5} more` : files.join(', ')
  return [
    ...run.missing.length ? [`${run.missing.length} test files did not run: ${list(run.missing)}`] : [],
    ...run.failed.length ? [`${run.failed.length} test files failed: ${list(run.failed)}`] : [],
    ...run.testNamePattern ? [`it ran only the tests matching /${run.testNamePattern}/`] : [],
    ...run.recording ? [`FORGES_RECORDING limited it to ${run.recording}`] : [],
  ]
}

/** The verbs a test run called, keyed `<forge>` and `<forge>:anonymous`, read from the files `test/setup/verbs.ts` writes. */
export function readExercised(directory: URL): Map<string, Set<string>> {
  const exercised = new Map<string, Set<string>>()
  if (!existsSync(directory)) {
    return exercised
  }
  for (const file of readdirSync(directory).filter(file => file !== VERB_RUN)) {
    const data = JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as Record<string, string[]>
    for (const [forge, verbs] of Object.entries(data)) {
      const set = exercised.get(forge) ?? new Set<string>()
      exercised.set(forge, set)
      for (const verb of verbs) {
        set.add(verb)
      }
    }
  }
  return exercised
}

const auth = { type: 'token', token: 't' } as const

const checked: Array<[string, ForgeProvider]> = [
  ['github', github({ auth })],
  ['github', github({ auth: { type: 'app', appId: 1, privateKey: '', installationId: 1 } })],
  ['gitlab', gitlab({ auth })],
  ['bitbucket', bitbucket({ auth })],
  ['forgejo', forgejo({ auth })],
  ['gitea', gitea({ auth })],
  ['gitee', gitee({ auth })],
  ['azure-devops', azureDevOps({ auth, organization: 'acme' })],
  ['cursor-origin', cursorOrigin({ auth })],
  ['tangled', tangled({ auth: { type: 'app_password', identifier: 'h', password: 'p' }, notificationsUrl: 'https://notifications.example' })],
  ['pushin', pushin({ auth })],
  ['cloudflare-artifacts', cloudflareArtifacts({ auth, accountId: 'acme' })],
  ['sourcehut', sourcehut({ auth })],
  ['github:anonymous', github({})],
  ['gitlab:anonymous', gitlab({})],
  ['bitbucket:anonymous', bitbucket({})],
  ['forgejo:anonymous', forgejo({})],
  ['gitea:anonymous', gitea({})],
  ['gitee:anonymous', gitee({})],
  ['azure-devops:anonymous', azureDevOps({ organization: 'acme' })],
  ['cursor-origin:anonymous', cursorOrigin({})],
  ['tangled:anonymous', tangled({})],
  ['pushin:anonymous', pushin({})],
]

/** Every provider whose declarations are checked, keyed like `readExercised()`, with each auth kind that changes them and the levels it declares as its capabilities. */
export const CHECKED_PROVIDERS: Array<[string, ForgeProvider]> = checked.map(([key, provider]) => [key, withDeclared(provider)])

export function capabilityAt(capabilities: ForgeCapabilities, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], capabilities)
}
