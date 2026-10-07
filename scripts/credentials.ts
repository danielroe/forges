import type * as Forges from '../src/index.ts'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { CAPABILITY_TABLE } from '../src/capability-table.ts'
import { providersFromEnv } from '../src/env.ts'
import { capabilityData, matrixProviders, supportCell } from './capabilities.ts'

/** Forge-specific fields. `providersFromEnv()` is probed with combinations of them. */
const CANDIDATES = ['TOKEN', 'APP_ID', 'PRIVATE_KEY', 'INSTALLATION_ID', 'USERNAME', 'IDENTIFIER', 'PASSWORD', 'PDS', 'ORGANIZATION', 'API_URL', 'NOTIFICATIONS_URL']

const KEYS = [
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
]

function probeValue(field: string, key = KEYS[0]!): string {
  const name = `probe-${field.toLowerCase().replaceAll('_', '-')}`
  return field === 'PRIVATE_KEY' ? key : field === 'PDS' || field.endsWith('_URL') ? `https://${name}.invalid` : name
}

export interface CredentialSet {
  /** Fields that together form the credential, such as `['APP_ID', 'PRIVATE_KEY']`. */
  fields: string[]
  /** Fields the provider also reads with this credential, and the capabilities each one makes available. */
  optional: Array<{ field: string, unlocks: string[] }>
  /** Capabilities the forge supports that this credential does not reach. */
  unavailable: string[]
}

export interface ForgeRequirements {
  slug: string
  name: string
  /** `<KIND>` in `FORGES_<KIND>_<FIELD>`. */
  kind: string
  /** Fields without which the set is skipped, credential or not. */
  required: string[]
  credentials: CredentialSet[]
  /** How the set behaves without a credential. */
  anonymous: {
    /** `true` when a set without a credential creates an anonymous provider. */
    default: boolean
    /** Fields that create an anonymous provider when no credential is set. */
    with: string[]
    /** Capabilities the forge supports that an anonymous provider does not reach. */
    unavailable: string[]
  }
}

function at(capabilities: Forges.ForgeCapabilities, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], capabilities)
}

const CAPABILITIES = CAPABILITY_TABLE.filter(entry => !entry.alias)
const ACCOUNT = CAPABILITIES.filter(entry => entry.write || entry.account).map(entry => entry.capability)

function probe(kind: string, fields: Record<string, string>) {
  const env = Object.fromEntries(Object.entries(fields).map(([field, value]) => [`FORGES_${kind}_${field}`, value]))
  const [entry, ...rest] = providersFromEnv(env)
  if (!entry || rest.length) {
    throw new Error(`Expected one provider set for ${kind} from ${Object.keys(fields).join(', ')}`)
  }
  return { skipped: entry.skipped, provider: entry.factory?.create() }
}

function authenticated(provider?: Forges.ForgeProvider): boolean {
  return !!provider && ACCOUNT.some(capability => supportCell(at(provider.capabilities, capability)).level !== 'none')
}

/** The fields whose values reach the forge in a request, for a set made of `fields`. */
async function leaks(kind: string, fields: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (const key of fields.includes('PRIVATE_KEY') ? KEYS : KEYS.slice(0, 1)) {
    const sent: string[] = []
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push(request.url, ...request.headers.values(), await request.text())
      return Response.json({})
    }
    const values = Object.fromEntries(fields.map(field => [field, probeValue(field, key)]))
    // Tangled only opens an atproto session for calls such as notifications, which need a notifications service.
    const env = Object.fromEntries(Object.entries({ NOTIFICATIONS_URL: probeValue('NOTIFICATIONS_URL'), ...values }).map(([field, value]) => [`FORGES_${kind}_${field}`, value]))
    const provider = providersFromEnv(env, { fetch })[0]?.factory?.create()
    await provider?.request('GET', '/probe').catch(() => {})
    await provider?.notifications.listPage().catch(() => {})
    const text = sent.flatMap(value => [value, ...[...value.matchAll(/(?:Basic|Bearer) ([\w.=-]+)/g)].flatMap(([, token]) => token!.split('.').map(part => Buffer.from(part, 'base64').toString()))]).join('\n')
    for (const field of fields) {
      if (text.includes(values[field]!)) {
        found.add(field)
      }
    }
  }
  return found
}

function subsets<T>(items: T[], size: number): T[][] {
  if (!size) {
    return [[]]
  }
  return items.flatMap((item, index) => subsets(items.slice(index + 1), size - 1).map(rest => [item, ...rest]))
}

/** What each forge needs in `FORGES_<KIND>_*`, found by probing `providersFromEnv()`. */
export async function forgeRequirements(forges: typeof Forges): Promise<ForgeRequirements[]> {
  return Promise.all(matrixProviders(forges).map(async ({ slug, name, provider: reference }) => {
    const kind = slug.toUpperCase().replaceAll('-', '_')
    const values = (fields: string[]) => Object.fromEntries(fields.map(field => [field, probeValue(field)]))
    const required = CANDIDATES.filter(field => probe(kind, { ...values(CANDIDATES.filter(other => other !== field)), ENABLED: '1' }).skipped)
    const supported = capabilityData(forges).groups.flatMap(group => group.rows.map(row => row.capability)).filter(capability => supportCell(at(reference.capabilities, capability)).level !== 'none')
    const unavailable = (provider?: Forges.ForgeProvider) => provider ? supported.filter(capability => supportCell(at(provider.capabilities, capability)).level === 'none') : supported

    const rest = CANDIDATES.filter(field => !required.includes(field))
    const minimal: string[][] = []
    for (let size = 1; size <= 3; size++) {
      for (const fields of subsets(rest, size)) {
        if (!minimal.some(set => set.every(field => fields.includes(field))) && authenticated(probe(kind, values([...required, ...fields])).provider)) {
          minimal.push(fields)
        }
      }
    }
    const credentials = await Promise.all(minimal.map(async (fields) => {
      const others = rest.filter(field => !fields.includes(field))
      const without = unavailable(probe(kind, values([...required, ...fields])).provider)
      const optional = (await Promise.all(others.map(async (field) => {
        const unlocks = without.filter(capability => !unavailable(probe(kind, values([...required, ...fields, field])).provider).includes(capability))
        return unlocks.length || (await leaks(kind, [...required, ...fields, field])).has(field) ? [{ field, unlocks }] : []
      }))).flat()
      return { fields, optional, unavailable: unavailable(probe(kind, values([...required, ...fields, ...optional.map(({ field }) => field)])).provider) }
    }))

    const bare = probe(kind, { ...values(required), INSTANCE: 'probe.invalid' })
    const anonymousWith = ['ENABLED', 'DEMO_REPO'].filter((field) => {
      const { provider } = probe(kind, { ...values(required), [field]: field === 'ENABLED' ? '1' : 'probe/repo' })
      return provider && !authenticated(provider)
    })
    const anonymous = bare.provider ?? (anonymousWith.length ? probe(kind, { ...values(required), ENABLED: '1' }).provider : undefined)
    return {
      slug,
      name,
      kind,
      required,
      credentials,
      anonymous: {
        default: !!bare.provider,
        with: anonymousWith,
        unavailable: unavailable(anonymous),
      },
    }
  }))
}

function code(fields: string[]): string {
  const names = fields.map(field => `\`${field}\``)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? ''
}

function credentialCell({ required, credentials }: ForgeRequirements): string {
  const sets = credentials.map(({ fields }) => code(fields)).join(', or ')
  return required.length ? `${code(required)}, and ${sets}` : sets
}

function optionalCell({ credentials }: ForgeRequirements): string {
  const cells = credentials.filter(set => set.optional.length).map((set) => {
    const list = code(set.optional.map(({ field }) => field))
    return credentials.length > 1 ? `${list} with ${code(set.fields)}` : list
  })
  return cells.join('; ') || 'None'
}

function anonymousCell({ anonymous }: ForgeRequirements): string {
  const enable = anonymous.with.map(field => `\`${field}\``).join(' or ')
  if (anonymous.default) {
    return 'Anonymous reads'
  }
  return enable ? `Anonymous reads with ${enable}. Skipped otherwise` : `Skipped, even with \`ENABLED\``
}

/** The generated "What each forge needs" section of the environment variables page. Forges with the same needs share a row. */
export async function requirementsTable(forges: typeof Forges): Promise<string> {
  const rows = new Map<string, string[]>()
  for (const forge of await forgeRequirements(forges)) {
    const cells = `${credentialCell(forge)} | ${optionalCell(forge)} | ${anonymousCell(forge)}`
    rows.set(cells, [...rows.get(cells) ?? [], forge.name])
  }
  return [
    '<!-- Generated by `pnpm capability-matrix`; do not edit by hand. -->',
    '::forge-requirements',
    '| Forge | Credentials | Optional | Without a credential |',
    '| --- | --- | --- | --- |',
    ...[...rows].map(([cells, names]) => `| ${names.join(', ')} | ${cells} |`),
    '::',
  ].join('\n')
}

/** A thing to do with a forge, as the credentials wizard offers it. */
export interface CredentialTask {
  id: string
  label: string
  group: string
  /** Paths on `ForgeCapabilities` the task uses. */
  capabilities: string[]
  /** Fields the task needs besides a credential. */
  fields?: string[]
}

const TASKS: CredentialTask[] = [
  { id: 'repos', group: 'Read', label: 'Repositories and people', capabilities: ['repos.get', 'repos.list', 'repos.labels', 'repos.milestones', 'repos.collaborators', 'repos.permissionFor', 'repos.assignableUsers', 'repos.reviewerCandidates', 'users.get', 'users.me'] },
  { id: 'threads', group: 'Read', label: 'Issues and PRs', capabilities: ['threads.get', 'threads.list', 'threads.getMany', 'comments.list', 'reactions.list', 'reviews.list', 'contents.threadFiles', 'contents.threadCommits'] },
  { id: 'code', group: 'Read', label: 'Code and history', capabilities: ['contents.file', 'contents.tree', 'contents.branches', 'contents.tags', 'contents.resolveRef', 'contents.commits', 'contents.commit', 'contents.compare'] },
  { id: 'releases', group: 'Read', label: 'Releases', capabilities: ['releases.list', 'releases.get', 'releases.latest', 'releases.getByTag', 'releases.downloadAsset'] },
  { id: 'ci', group: 'Read', label: 'Checks and CI', capabilities: ['checks.thread', 'checks.list', 'ci.runs', 'ci.run', 'ci.jobs', 'ci.log'] },
  { id: 'search', group: 'Read', label: 'Search', capabilities: ['search.threads', 'search.repos', 'search.commits'] },
  { id: 'security', group: 'Read', label: 'Security alerts', capabilities: ['securityAlerts'] },
  { id: 'notifications', group: 'Read', label: 'Notifications', capabilities: ['notifications.list', 'notifications.unreadCount', 'subscriptions.get'] },
  { id: 'comment', group: 'Write', label: 'Comment and react', capabilities: ['writes.comment', 'writes.upsertComment', 'comments.edit', 'comments.delete', 'writes.react'] },
  { id: 'edit', group: 'Write', label: 'Open, edit and close', capabilities: ['writes.create', 'writes.update', 'writes.close', 'writes.reopen', 'writes.transfer', 'writes.markDuplicate'] },
  { id: 'triage', group: 'Write', label: 'Labels, assignees and milestones', capabilities: ['writes.setLabels', 'writes.addLabels', 'writes.removeLabels', 'writes.setMilestone', 'writes.setAssignees', 'repos.createLabel'] },
  { id: 'review', group: 'Write', label: 'Review PRs', capabilities: ['writes.requestReview', 'reviews.create', 'reviews.submit', 'reviews.approve', 'reviews.resolveThread'] },
  { id: 'merge', group: 'Write', label: 'Merge PRs', capabilities: ['writes.merge', 'writes.approveAndMerge'] },
  { id: 'checks', group: 'Write', label: 'Report checks', capabilities: ['checks.report', 'checks.rerun'] },
  { id: 'inbox', group: 'Write', label: 'Triage notifications', capabilities: ['notifications.markRead', 'notifications.markDone', 'notifications.unsubscribe', 'notifications.markAllRead', 'notifications.markAllDone', 'subscriptions.set'] },
  { id: 'receive', group: 'Events', label: 'Receive webhooks', capabilities: ['sources.webhook'], fields: ['WEBHOOK_SECRET'] },
  { id: 'events', group: 'Events', label: 'Poll or stream events', capabilities: ['sources.poll', 'sources.subscribe'] },
  { id: 'webhooks', group: 'Administer', label: 'Manage webhooks', capabilities: ['webhooks.list', 'webhooks.create', 'webhooks.update', 'webhooks.delete', 'webhooks.rotateSecret', 'webhooks.deliveries', 'webhooks.redeliver'] },
  { id: 'collaborators', group: 'Administer', label: 'Add collaborators', capabilities: ['repos.addCollaborator'] },
  { id: 'installations', group: 'Administer', label: 'App installations', capabilities: ['installations'] },
]

/** The wizard's tasks. Throws unless every capability in the matrix belongs to exactly one task. */
export function credentialTasks(forges: typeof Forges): CredentialTask[] {
  const matrix = capabilityData(forges).groups.flatMap(group => group.rows.map(row => row.capability))
  const listed = TASKS.flatMap(task => task.capabilities)
  const missing = matrix.filter(capability => !listed.includes(capability))
  const extra = listed.filter((capability, index) => !matrix.includes(capability) || listed.indexOf(capability) !== index)
  if (missing.length || extra.length) {
    throw new Error(`Credential tasks are out of step with the capability table: ${[...missing.map(name => `missing ${name}`), ...extra.map(name => `unknown or repeated ${name}`)].join(', ')}`)
  }
  return TASKS
}

/** Distinct `scopesFor()` results for the verbs of each task a forge supports, keyed by task id. */
export function taskScopes(forges: typeof Forges): Record<string, Record<string, Forges.VerbScopes[]>> {
  const verbs = new Map(CAPABILITIES.map(entry => [entry.capability, CAPABILITY_TABLE.filter(other => other.capability === entry.capability).flatMap(other => other.verbs ?? [])]))
  return Object.fromEntries(matrixProviders(forges).map(({ slug, provider }) => [slug, Object.fromEntries(credentialTasks(forges).map((task) => {
    const scopes = task.capabilities
      .filter(capability => supportCell(at(provider.capabilities, capability)).level !== 'none')
      .flatMap(capability => verbs.get(capability)!)
      .map(verb => provider.scopesFor(verb as Forges.ForgeVerb))
      .filter(scopes => Object.keys(scopes).length)
    return [task.id, [...new Map(scopes.map(scopes => [JSON.stringify(scopes), scopes])).values()]]
  }))]))
}

/** The tasks the credentials wizard offers, as the Markdown inside its block on the environment guide. */
export function taskTable(forges: typeof Forges): string {
  return [
    '<!-- Generated by `pnpm capability-matrix`; do not edit by hand. -->',
    '::credentials-wizard',
    '| Task | Capabilities |',
    '| --- | --- |',
    ...credentialTasks(forges).map(task => `| ${task.group}: ${task.label} | ${task.capabilities.map(capability => `\`${capability}\``).join(', ')} |`),
    '::',
  ].join('\n')
}
