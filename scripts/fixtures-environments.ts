/**
 * Creates the GitHub environments that the `fixtures` workflow records in,
 * and stores each forge's credentials from `.env` in them:
 *
 *   node scripts/fixtures-environments.ts [--env-file .env] [--repo owner/name] [--reviewer <login>] [--forge <name>]... [--dry-run]
 *
 * Each forge gets `fixtures-<forge>`, holding what its read recordings need,
 * and, where it records writes, `fixtures-<forge>-writes`, which holds the
 * bot and reviewer credentials instead of the GitHub App and waits for
 * `--reviewer` (you, by default) to approve each run. Both deploy from
 * `main` only. The variables of each forge are stored as one `FIXTURES_ENV`
 * secret, in `.env` format.
 * `--forge`, which repeats, limits the run to the environments of those forges.
 * `--dry-run` prints the environments and the names of their variables.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs, parseEnv } from 'node:util'
import { PLANS } from './record-forge.ts'

/** The prefixes of the variables each forge reads. */
const PREFIXES: Record<string, string[]> = {
  'github': ['GITHUB_', 'FIXTURE_GITHUB_'],
  'gitlab': ['GITLAB_', 'FIXTURE_GITLAB_'],
  'bitbucket': ['BITBUCKET_', 'FIXTURE_BITBUCKET_'],
  'forgejo': ['CODEBERG_', 'CODE_FORGEJO_', 'FIXTURE_FORGEJO_'],
  'gitea': ['GITEA_', 'FIXTURE_GITEA_'],
  'gitee': ['GITEE_', 'FIXTURE_GITEE_'],
  'azure-devops': ['AZURE_DEVOPS_', 'FIXTURE_AZURE_DEVOPS_'],
  'pushin': ['PUSHIN_', 'FIXTURE_PUSHIN_'],
  'tangled': ['TANGLED_', 'FIXTURE_TANGLED_'],
  'cloudflare-artifacts': ['CLOUDFLARE_ARTIFACTS_', 'FIXTURE_CLOUDFLARE_ARTIFACTS_'],
}

/** Variables only write recordings and seeding use: the bot accounts and the Tangled reviewer. */
const WRITE_ONLY = /_BOT_|^TANGLED_REVIEWER_/
/** Variables only read recordings use: the GitHub App. */
const READ_ONLY = /^GITHUB_APP_/

function serialise(env: Record<string, string>): string {
  return Object.entries(env).map(([name, value]) => {
    if (value.includes('"')) {
      throw new Error(`${name} holds a double quote, which .env values here cannot`)
    }
    return `${name}="${value.replaceAll('\n', '\\n')}"`
  }).join('\n')
}

function gh(args: string[], input?: string): string {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] })
}

const { values } = parseArgs({ options: { 'env-file': { type: 'string', default: '.env' }, 'repo': { type: 'string', default: 'danielroe/forges' }, 'reviewer': { type: 'string' }, 'forge': { type: 'string', multiple: true }, 'dry-run': { type: 'boolean', default: false } } })
const unknown = values.forge?.filter(forge => !(forge in PLANS)) ?? []
if (unknown.length) {
  throw new Error(`Unknown forge: ${unknown.join(', ')}. Choose from ${Object.keys(PLANS).join(', ')}`)
}
const forges = Object.entries(PLANS).filter(([forge]) => !values.forge || values.forge.includes(forge))
const env = parseEnv(readFileSync(values['env-file'], 'utf8')) as Record<string, string>
const dry = values['dry-run']
const reviewer = dry ? 0 : Number(gh(['api', values.reviewer ? `users/${values.reviewer}` : 'user', '--jq', '.id']).trim())

for (const [forge, plan] of forges) {
  const own = Object.fromEntries(Object.entries(env).filter(([name]) => PREFIXES[forge]!.some(prefix => name.startsWith(prefix))))
  const environments = [
    { name: `fixtures-${forge}`, variables: Object.fromEntries(Object.entries(own).filter(([name]) => !WRITE_ONLY.test(name))), approve: false },
    ...plan.writes.length ? [{ name: `fixtures-${forge}-writes`, variables: Object.fromEntries(Object.entries(own).filter(([name]) => !READ_ONLY.test(name))), approve: true }] : [],
  ]
  for (const { name, variables, approve } of environments) {
    console.info(`${name}${approve ? ' (approval)' : ''}: ${Object.keys(variables).join(', ') || 'no variables'}`)
    if (dry) {
      continue
    }
    const settings = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, ...approve && { reviewers: [{ type: 'User', id: reviewer }], prevent_self_review: false } }
    gh(['api', '--method', 'PUT', `repos/${values.repo}/environments/${name}`, '--input', '-', '--silent'], JSON.stringify(settings))
    const branches = JSON.parse(gh(['api', `repos/${values.repo}/environments/${name}/deployment-branch-policies`])) as { branch_policies: Array<{ name: string, type?: string }> }
    if (!branches.branch_policies.some(policy => policy.name === 'main')) {
      gh(['api', '--method', 'POST', `repos/${values.repo}/environments/${name}/deployment-branch-policies`, '-f', 'name=main', '-f', 'type=branch', '--silent'])
    }
    gh(['secret', 'set', 'FIXTURES_ENV', '--env', name, '--repo', values.repo], serialise(variables))
  }
}
