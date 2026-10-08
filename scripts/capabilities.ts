import type * as Forges from '../src/index.ts'
import { CAPABILITY_TABLE } from '../src/capability-table.ts'

export interface MatrixProvider {
  slug: string
  name: string
  factories: string[]
  provider: Forges.ForgeProvider
  anonymous: Forges.ForgeProvider
}

/** Providers as the matrix and provider pages show them, keyed by their `docs/content/4.providers/<slug>.md` page. */
export function matrixProviders(forges: typeof Forges): MatrixProvider[] {
  const { azureDevOps, bitbucket, cursorOrigin, forgejo, gitea, gitee, github, gitlab, pushin, tangled } = forges
  const auth = { type: 'token', token: 'token' } as const
  const entry = <O>(slug: string, name: string, factory: (options: O) => Forges.ForgeProviderFactory, options: O): MatrixProvider => {
    const exported = Object.keys(forges).find(key => (forges as Record<string, unknown>)[key] === factory)!
    const provider = factory(options).create()
    if (!provider.capabilities.authKinds.includes('anonymous')) {
      throw new Error(`${name} has no anonymous provider to show support without credentials for`)
    }
    const anonymous = factory({ ...options, auth: undefined }).create()
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
  /** Support per thread or alert kind, for capabilities declared per kind. */
  kinds?: Array<{ kind: string, label: string, level: SupportLevel }>
}

const LEVEL_RANK: SupportLevel[] = ['native', 'experimental', 'emulated', 'none']

function levelOf(value: unknown): SupportLevel {
  return value === true ? 'native' : value === 'experimental' || value === 'emulated' ? value : 'none'
}

/** A capability value as a level, with the level of each kind for per-kind values. */
export function supportCell(value: unknown): SupportCell {
  if (!value || typeof value !== 'object') {
    return { level: levelOf(value) }
  }
  const kinds = Object.entries(value).map(([kind, support]) => ({ kind, label: KINDS[kind] ?? kind, level: levelOf(support) }))
  const level = LEVEL_RANK.find(rank => kinds.some(kind => kind.level === rank)) ?? 'none'
  return { level, kinds }
}

function cell(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(item => `\`${item}\``).join(', ')
  }
  if (typeof value === 'string' && value !== 'experimental' && value !== 'emulated') {
    return value
  }
  const { level, kinds } = supportCell(value)
  if (!kinds) {
    return level === 'native' ? '✅' : level === 'none' ? '❌' : level
  }
  const supported = kinds.filter(kind => kind.level !== 'none')
  return supported.map(({ label, level }) => level === 'native' ? label : `${label} (${level})`).join(', ') || '❌'
}

function at(capabilities: Forges.ForgeCapabilities, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], capabilities)
}

/** One row per capability the table produces, in table order. */
const rows = CAPABILITY_TABLE.map(entry => ({
  name: entry.capability,
  read: entry.capability === 'limits'
    ? (c: Forges.ForgeCapabilities) => c.limits ? Object.entries(c.limits).map(([key, length]) => `${key.replace('Length', '')} ${length}`).join(', ') : 'unknown'
    : (c: Forges.ForgeCapabilities) => at(c, entry.capability),
}))

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
  /** The same cells for each provider's anonymous provider. */
  anonymousCells: SupportCell[]
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
  /** The same count for the anonymous provider. */
  anonymousSummary: Record<SupportLevel, number>
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
      cells: entries.map(({ provider }) => supportCell(at(provider.capabilities, entry.capability))),
      anonymousCells: entries.map(({ anonymous }) => supportCell(at(anonymous.capabilities, entry.capability))),
    })
  }
  const all = groups.flatMap(group => group.rows)
  const summarise = (cells: SupportCell[]) => {
    const summary: Record<SupportLevel, number> = { native: 0, experimental: 0, emulated: 0, none: 0 }
    for (const { level } of cells) {
      summary[level]++
    }
    return summary
  }
  const providers = entries.map(({ slug, name, factories, provider: { capabilities } }, index) => ({
    slug,
    name,
    import: `forges/${slug}`,
    factories,
    experimental: !!capabilities.experimental,
    auth: [...capabilities.authKinds],
    eventKinds: capabilities.eventKinds,
    ...capabilities.limits ? { limits: { ...capabilities.limits } } : {},
    summary: summarise(all.map(row => row.cells[index]!)),
    anonymousSummary: summarise(all.map(row => row.anonymousCells[index]!)),
  }))
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
    ...rows.map(row => `| \`${row.name}\` | ${providers.map(({ provider }) => cell(row.read(provider.capabilities))).join(' | ')} |`),
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
    '| Capability | Support | Without credentials |',
    '| --- | --- | --- |',
    ...rows.map(row => `| \`${row.name}\` | ${cell(row.read(provider.capabilities))} | ${cell(row.read(anonymous.capabilities))} |`),
    '::',
  ].join('\n')
}
