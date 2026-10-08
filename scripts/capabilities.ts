import type { CapabilityEntry } from '../src/capability-table.ts'
import type * as Forges from '../src/index.ts'
import { CAPABILITY_TABLE } from '../src/capability-table.ts'

export interface MatrixProvider {
  slug: string
  name: string
  factories: string[]
  provider: Forges.ForgeProvider
  /** The same provider created without credentials, for a forge that accepts anonymous reads. */
  anonymous?: Forges.ForgeProvider
}

/** Providers as the matrix and provider pages show them, keyed by their `docs/content/4.providers/<slug>.md` page. */
export function matrixProviders(forges: typeof Forges): MatrixProvider[] {
  const { azureDevOps, bitbucket, cursorOrigin, forgejo, gitea, gitee, github, gitlab, pushin, tangled } = forges
  const auth = { type: 'token', token: 'token' } as const
  const entry = <O>(slug: string, name: string, factory: (options: O) => Forges.ForgeProviderFactory, options: O): MatrixProvider => {
    const exported = Object.keys(forges).find(key => (forges as Record<string, unknown>)[key] === factory)!
    const provider = factory(options).create()
    const anonymous = provider.capabilities.authKinds.includes('anonymous') ? factory({ ...options, auth: undefined }).create() : undefined
    return { slug, name, factories: [exported, `${exported}Lite`].filter(key => key in forges), provider, anonymous }
  }
  return [
    entry('github', 'GitHub', github, { auth: { type: 'app', appId: 1, privateKey: '', installationId: 1 } }),
    entry('gitlab', 'GitLab', gitlab, { auth }),
    entry('bitbucket', 'Bitbucket', bitbucket, { auth }),
    entry('forgejo', 'Forgejo', forgejo, { auth }),
    entry('gitea', 'Gitea', gitea, { auth }),
    entry('gitee', 'Gitee', gitee, { auth }),
    entry('azure-devops', 'Azure DevOps', azureDevOps, { auth, organization: 'acme' }),
    entry('cursor-origin', 'Cursor Origin', cursorOrigin, { auth }),
    entry('pushin', 'Pushin.eu', pushin, { auth }),
    entry('tangled', 'Tangled', tangled, { auth: { type: 'app_password', identifier: 'handle', password: 'password' }, notificationsUrl: 'https://notifications.example' }),
  ]
}

const KINDS: Record<string, string> = { issue: 'issue', pull_request: 'PR', discussion: 'discussion', commit: 'commit', dependency: 'dependency', code_scanning: 'code scanning', secret: 'secret', advisory: 'advisory' }

/** How far a provider supports a capability, as the docs show it. */
export type SupportLevel = 'native' | 'experimental' | 'emulated' | 'none'

export interface SupportCell {
  level: SupportLevel
  /** Supported with credentials, but not by an anonymous provider. */
  signedIn?: true
  /** Support per thread or alert kind, for capabilities declared per kind. */
  kinds?: Array<{ kind: string, label: string, level: SupportLevel, signedIn?: true }>
}

const LEVEL_RANK: SupportLevel[] = ['native', 'experimental', 'emulated', 'none']

function levelOf(value: unknown): SupportLevel {
  return value === true ? 'native' : value === 'experimental' || value === 'emulated' ? value : 'none'
}

function signedIn(level: SupportLevel, anonymous: unknown, compare: boolean): { signedIn?: true } {
  return compare && level !== 'none' && levelOf(anonymous) === 'none' ? { signedIn: true } : {}
}

/**
 * A capability value as a level, with the level of each kind for per-kind values.
 * Pass `anonymous`, the same capability on an anonymous provider, to mark
 * support that needs credentials.
 */
export function supportCell(value: unknown, ...anonymous: [] | [unknown]): SupportCell {
  const compare = anonymous.length > 0
  if (!value || typeof value !== 'object') {
    const level = levelOf(value)
    return { level, ...signedIn(level, anonymous[0], compare) }
  }
  const kinds = Object.entries(value).map(([kind, support]) => {
    const level = levelOf(support)
    return { kind, label: KINDS[kind] ?? kind, level, ...signedIn(level, (anonymous[0] as Record<string, unknown> | undefined)?.[kind], compare) }
  })
  const level = LEVEL_RANK.find(rank => kinds.some(kind => kind.level === rank)) ?? 'none'
  return { level, kinds }
}

function cell(value: unknown, ...anonymous: [] | [unknown]): string {
  if (Array.isArray(value)) {
    return value.map(item => `\`${item}\``).join(', ')
  }
  if (typeof value === 'string' && value !== 'experimental' && value !== 'emulated') {
    return value
  }
  const { level, kinds, signedIn } = supportCell(value, ...anonymous)
  if (!kinds) {
    const text = level === 'native' ? '✅' : level === 'none' ? '❌' : level
    return signedIn ? `${text} (needs credentials)` : text
  }
  const supported = kinds.filter(kind => kind.level !== 'none')
  return supported.map(({ label, level, signedIn }) => {
    const notes = [level === 'native' ? '' : level, signedIn ? 'needs credentials' : ''].filter(Boolean)
    return notes.length ? `${label} (${notes.join(', ')})` : label
  }).join(', ') || '❌'
}

function at(capabilities: Forges.ForgeCapabilities, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], capabilities)
}

/** Writes and account verbs need credentials on every forge, so only the other capabilities mark what does. */
function comparesAnonymous(entry: CapabilityEntry): boolean {
  return !entry.write && !entry.account
}

/** One row per capability the table produces, in table order. */
const rows = CAPABILITY_TABLE.map(entry => ({
  name: entry.capability,
  read: entry.capability === 'limits'
    ? (c: Forges.ForgeCapabilities) => c.limits ? Object.entries(c.limits).map(([key, length]) => `${key.replace('Length', '')} ${length}`).join(', ') : 'unknown'
    : (c: Forges.ForgeCapabilities) => at(c, entry.capability),
  compare: comparesAnonymous(entry),
}))

/** A row's cell for one provider, marking support its anonymous provider lacks. */
function rowCell(row: typeof rows[number], { provider, anonymous }: Pick<MatrixProvider, 'provider' | 'anonymous'>): string {
  return anonymous && row.compare ? cell(row.read(provider.capabilities), row.read(anonymous.capabilities)) : cell(row.read(provider.capabilities))
}

const META = new Set(['experimental', 'eventKinds', 'authKinds', 'limits'])

export interface CapabilityRow {
  /** Path on `ForgeCapabilities`, such as `threads.list`. */
  capability: string
  /** Verbs on `ForgeProvider` the capability covers. */
  verbs: readonly string[]
  write: boolean
  account: boolean
  /** One cell per provider, in `matrixProviders()` order. */
  cells: SupportCell[]
}

export interface CapabilityGroup {
  /** The first segment of each capability path in the group. */
  name: string
  rows: CapabilityRow[]
}

export interface CapabilityProvider {
  slug: string
  name: string
  /** The subpath the provider is imported from. */
  import: string
  factories: string[]
  experimental: boolean
  auth: string[]
  eventKinds: string
  limits?: Record<string, number>
  /** How many capabilities have each level. Per-kind capabilities count at their best level. */
  summary: Record<SupportLevel, number>
}

/** The capability matrix as structured data, grouped by namespace. */
export function capabilityData(forges: typeof Forges): { providers: CapabilityProvider[], groups: CapabilityGroup[] } {
  const entries = matrixProviders(forges)
  const groups: CapabilityGroup[] = []
  for (const entry of CAPABILITY_TABLE) {
    if (META.has(entry.capability)) {
      continue
    }
    const name = entry.capability.split('.')[0]!
    let group = groups.find(group => group.name === name)
    if (!group) {
      group = { name, rows: [] }
      groups.push(group)
    }
    group.rows.push({
      capability: entry.capability,
      verbs: entry.verbs ?? [],
      write: !!entry.write,
      account: !!entry.account,
      cells: entries.map(({ provider, anonymous }) => anonymous && comparesAnonymous(entry)
        ? supportCell(at(provider.capabilities, entry.capability), at(anonymous.capabilities, entry.capability))
        : supportCell(at(provider.capabilities, entry.capability))),
    })
  }
  const providers = entries.map(({ slug, name, factories, provider: { capabilities } }, index) => {
    const summary: Record<SupportLevel, number> = { native: 0, experimental: 0, emulated: 0, none: 0 }
    for (const row of groups.flatMap(group => group.rows)) {
      summary[row.cells[index]!.level]++
    }
    return { slug, name, import: `forges/${slug}`, factories, experimental: !!capabilities.experimental, auth: [...capabilities.authKinds], eventKinds: capabilities.eventKinds, ...capabilities.limits ? { limits: { ...capabilities.limits } } : {}, summary }
  })
  return { providers, groups }
}

const GENERATED = '<!-- Generated by `pnpm capability-matrix`; do not edit by hand. -->'

/** The capability matrix across every provider, as a Markdown table. */
export function matrix(forges: typeof Forges): string {
  const providers = matrixProviders(forges)
  return [
    GENERATED,
    '::capability-matrix',
    `| Capability | ${providers.map(({ name }) => name).join(' | ')} |`,
    `| --- | ${providers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| \`${row.name}\` | ${providers.map(provider => rowCell(row, provider)).join(' | ')} |`),
    '::',
  ].join('\n')
}

/** Every provider, as the generated section of the providers index page. */
export function providerIndex(forges: typeof Forges): string {
  return [
    GENERATED,
    '::provider-grid',
    '| Forge | Import | Factories |',
    '| --- | --- | --- |',
    ...matrixProviders(forges).map(({ slug, name, factories }) => `| [${name}](/providers/${slug}) | \`forges/${slug}\` | ${factories.map(factory => `\`${factory}()\``).join(', ')} |`),
    '::',
  ].join('\n')
}

/** One provider's capabilities, as the generated section of its page. */
export function providerSection({ slug, provider, anonymous }: MatrixProvider): string {
  return [
    '## Capabilities',
    '',
    GENERATED,
    `::provider-capabilities{provider="${slug}"}`,
    '| Capability | Support |',
    '| --- | --- |',
    ...rows.map(row => `| \`${row.name}\` | ${rowCell(row, { provider, anonymous })} |`),
    '::',
  ].join('\n')
}
