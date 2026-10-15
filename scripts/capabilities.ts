import type * as Forges from '../src/index.ts'
import { CAPABILITY_TABLE } from '../src/capability-table.ts'

/** One kind of credential a provider accepts, where support depends on the kind. */
export interface MatrixCredential {
  /** Short name for the tables, such as `classic`. */
  id: string
  /** Name for the docs UI, such as `Classic token`. */
  label: string
  /** What the credential is, as inline Markdown. */
  description: string
  /** The `FORGES_<KIND>_<FIELD>` fields that make up the credential. */
  env: string[]
  provider: Forges.ForgeProvider
}

export interface MatrixProvider {
  slug: string
  name: string
  factories: string[]
  provider: Forges.ForgeProvider
  anonymous: Forges.ForgeProvider
  /** A provider per kind of credential, for forges where support depends on the kind. */
  credentials?: MatrixCredential[]
}

type CredentialOptions<O> = Omit<MatrixCredential, 'provider'> & { options: O }

/** Traits describe the provider, not an operation, so they stay the same without credentials. */
const TRAITS = new Set(['experimental', 'eventKinds', 'authKinds', 'limits'])

/** Without anonymous reads, a provider reaches nothing without credentials. Its traits stay. */
function withoutCredentials(provider: Forges.ForgeProvider): Forges.ForgeProvider {
  const capabilities = structuredClone(provider.capabilities) as unknown as Record<string, Record<string, unknown>>
  for (const { capability } of CAPABILITY_TABLE.filter(entry => !TRAITS.has(entry.capability))) {
    const [group, name] = capability.split('.') as [string, string | undefined]
    if (name) {
      capabilities[group]![name] = false
    }
    else {
      (capabilities as Record<string, unknown>)[group] = false
    }
  }
  return { ...provider, capabilities: capabilities as unknown as Forges.ForgeCapabilities }
}

/** Providers as the matrix and provider pages show them, keyed by their `docs/content/4.providers/<slug>.md` page. */
export function matrixProviders(forges: typeof Forges): MatrixProvider[] {
  const { azureDevOps, bitbucket, cloudflareArtifacts, cursorOrigin, forgejo, gitea, gitee, github, gitlab, pushin, sourcehut, tangled } = forges
  const auth = { type: 'token', token: 'token' } as const
  const entry = <O>(slug: string, name: string, factory: (options: O) => Forges.ForgeProviderFactory, options: O, credentials?: CredentialOptions<O>[]): MatrixProvider => {
    const exported = Object.keys(forges).find(key => (forges as Record<string, unknown>)[key] === factory)!
    const provider = factory(options).create()
    const anonymous = provider.capabilities.authKinds.includes('anonymous') ? factory({ ...options, auth: undefined }).create() : withoutCredentials(provider)
    return {
      slug,
      name,
      factories: [exported, `${exported}Lite`].filter(key => key in forges),
      provider,
      anonymous,
      ...credentials ? { credentials: credentials.map(({ options, ...credential }) => ({ ...credential, provider: factory(options).create() })) } : {},
    }
  }
  const githubApp = { type: 'app', appId: 1, privateKey: '' } as const
  const githubInstallation = { auth: { ...githubApp, installationId: 1 } }
  const originApp = { type: 'app', appId: '1', privateKey: '' } as const
  const originInstallation = { auth: { ...originApp, installationId: '1' } }
  return [
    entry('github', 'GitHub', github, githubInstallation, [
      { id: 'classic', label: 'Classic token', description: 'A personal access token (classic) or an OAuth app token', env: ['TOKEN'], options: { auth: { type: 'token', token: 'ghp_token' } } },
      { id: 'fine-grained', label: 'Fine-grained token', description: 'A fine-grained personal access token or a GitHub App user access token', env: ['TOKEN'], options: { auth: { type: 'token', token: 'github_pat_token' } } },
      { id: 'installation', label: 'App installation', description: 'An app with an `installationId`, or an installation access token such as the `GITHUB_TOKEN` of a workflow', env: ['APP_ID', 'PRIVATE_KEY', 'INSTALLATION_ID'], options: githubInstallation },
      { id: 'app', label: 'App', description: 'An app without an `installationId`', env: ['APP_ID', 'PRIVATE_KEY'], options: { auth: githubApp } },
    ]),
    entry('gitlab', 'GitLab', gitlab, { auth }),
    entry('bitbucket', 'Bitbucket', bitbucket, { auth }),
    entry('forgejo', 'Forgejo', forgejo, { auth }),
    entry('gitea', 'Gitea', gitea, { auth }),
    entry('gitee', 'Gitee', gitee, { auth }),
    entry('azure-devops', 'Azure DevOps', azureDevOps, { auth, organization: 'acme' }),
    entry('cursor-origin', 'Cursor Origin', cursorOrigin, { auth }, [
      { id: 'token', label: 'User token', description: 'A user access token, as the Origin CLI reads from `CURSOR_AUTH_TOKEN`', env: ['TOKEN'], options: { auth } },
      { id: 'installation', label: 'App installation', description: 'An app with an `installationId`', env: ['APP_ID', 'PRIVATE_KEY', 'INSTALLATION_ID'], options: originInstallation },
      { id: 'app', label: 'App', description: 'An app without an `installationId`', env: ['APP_ID', 'PRIVATE_KEY'], options: { auth: originApp } },
    ]),
    entry('pushin', 'Pushin.eu', pushin, { auth }),
    entry('tangled', 'Tangled', tangled, { auth: { type: 'app_password', identifier: 'handle', password: 'password' }, notificationsUrl: 'https://notifications.example' }),
    entry('cloudflare-artifacts', 'Cloudflare Artifacts', cloudflareArtifacts, { auth, accountId: 'acme' }),
    entry('sourcehut', 'Sourcehut', sourcehut, { auth }),
  ]
}

/** Labels for the thread and alert kinds of per-kind capabilities. */
export const KINDS: Record<string, string> = { issue: 'issue', pull_request: 'PR', discussion: 'discussion', commit: 'commit', dependency: 'dependency', code_scanning: 'code scanning', secret: 'secret', advisory: 'advisory' }

/** How far a provider supports a capability, as the docs show it. */
export type SupportLevel = 'native' | 'experimental' | 'emulated' | 'unverified' | 'none'

export interface SupportCell {
  level: SupportLevel
  /** Support per thread or alert kind, for capabilities declared per kind. */
  kinds?: Array<{ kind: string, label: string, level: SupportLevel }>
  /** The ids of the credentials that have this support, when they are not the provider's usual credentials. */
  credentials?: string[]
  /** Support with each of the provider's credentials, by credential id. */
  byCredential?: Record<string, SupportCell>
}

const LEVEL_RANK: SupportLevel[] = ['native', 'experimental', 'emulated', 'unverified', 'none']

function levelOf(value: unknown): SupportLevel {
  return value === true ? 'native' : value === 'experimental' || value === 'emulated' || value === 'unverified' ? value : 'none'
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

function at(capabilities: Forges.ForgeCapabilities, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], capabilities)
}

const CAPABILITIES = CAPABILITY_TABLE.map(entry => entry.capability).filter(capability => !TRAITS.has(capability))

const signature = (cell: SupportCell) => JSON.stringify([cell.level, cell.kinds?.map(kind => kind.level)])

interface CredentialedCells {
  cells: Map<string, SupportCell>
  /** The ids of the credentials that have most capabilities in common. */
  usual?: string[]
}

const credentialedCache = new WeakMap<MatrixProvider, CredentialedCells>()

/**
 * A provider's cells across its credentials: each has the strongest support
 * any credential has, and names the credentials that have it when they are
 * not the usual ones.
 */
function credentialedCells(entry: MatrixProvider): CredentialedCells {
  const cached = credentialedCache.get(entry)
  if (cached) {
    return cached
  }
  const { provider, credentials } = entry
  if (!credentials) {
    const result = { cells: new Map(CAPABILITIES.map(capability => [capability, supportCell(at(provider.capabilities, capability))])) }
    credentialedCache.set(entry, result)
    return result
  }
  const found = CAPABILITIES.map((capability) => {
    const byCredential = Object.fromEntries(credentials.map(({ id, provider }) => [id, supportCell(at(provider.capabilities, capability))]))
    const level = LEVEL_RANK.find(rank => Object.values(byCredential).some(cell => cell.level === rank))!
    const best = Object.values(byCredential).find(cell => cell.level === level)!
    const having = credentials.map(({ id }) => id).filter(id => signature(byCredential[id]!) === signature(best))
    return { capability, best, having, byCredential }
  })
  const counts = new Map<string, number>()
  for (const { best, having } of found) {
    if (best.level !== 'none') {
      counts.set(having.join(), (counts.get(having.join()) ?? 0) + 1)
    }
  }
  const usual = [...counts].sort(([, a], [, b]) => b - a)[0]?.[0]
  const result = {
    usual: usual?.split(','),
    cells: new Map(found.map(({ capability, best, having, byCredential }) => [capability, {
      ...best,
      ...best.level !== 'none' && having.length < credentials.length && having.join() !== usual ? { credentials: having } : {},
      byCredential,
    }])),
  }
  credentialedCache.set(entry, result)
  return result
}

function supportText({ level, kinds, credentials }: SupportCell): string {
  const text = kinds
    ? kinds.filter(kind => kind.level !== 'none').map(({ label, level }) => level === 'native' ? label : `${label} (${level})`).join(', ') || '❌'
    : level === 'native' ? '✅' : level === 'none' ? '❌' : level
  return credentials ? `${text} (only with ${credentials.map(id => `\`${id}\``).join(' or ')})` : text
}

function cell(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(item => `\`${item}\``).join(', ')
  }
  if (typeof value === 'string' && value !== 'experimental' && value !== 'emulated' && value !== 'unverified') {
    return value
  }
  return supportText(supportCell(value))
}

/** One row per capability the table produces, in table order. */
const rows = CAPABILITY_TABLE.map((entry) => {
  const read = entry.capability === 'limits'
    ? (c: Forges.ForgeCapabilities) => c.limits ? Object.entries(c.limits).map(([key, length]) => `${key.replace('Length', '')} ${length}`).join(', ') : 'unknown'
    : (c: Forges.ForgeCapabilities) => at(c, entry.capability)
  return {
    name: entry.capability,
    read,
    best: (provider: MatrixProvider) => TRAITS.has(entry.capability)
      ? cell(read(provider.provider.capabilities))
      : supportText(credentialedCells(provider).cells.get(entry.capability)!),
  }
})

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

export interface CapabilityCredential {
  id: string
  label: string
  /** What the credential is, as inline Markdown. */
  description: string
  /** The `FORGES_<KIND>_<FIELD>` fields that make up the credential. */
  env: string[]
  /** How many capabilities have each level with this credential. */
  summary: Record<SupportLevel, number>
  /** Whether the credential is one of the provider's usual credentials, whose support goes unmarked. */
  usual: boolean
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
  /** How many capabilities have each level with any credential. Per-kind capabilities count at their best level. */
  summary: Record<SupportLevel, number>
  /** The same count for the anonymous provider. */
  anonymousSummary: Record<SupportLevel, number>
  /** The kinds of credential, where support depends on the kind. */
  credentials?: CapabilityCredential[]
}

function summarise(cells: SupportCell[]): Record<SupportLevel, number> {
  const summary: Record<SupportLevel, number> = { native: 0, experimental: 0, emulated: 0, unverified: 0, none: 0 }
  for (const { level } of cells) {
    summary[level]++
  }
  return summary
}

/** The capability matrix as structured data, grouped by namespace. */
export function capabilityData(forges: typeof Forges): { providers: CapabilityProvider[], groups: CapabilityGroup[] } {
  const entries = matrixProviders(forges)
  const groups: CapabilityGroup[] = []
  for (const entry of CAPABILITY_TABLE) {
    if (TRAITS.has(entry.capability)) {
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
      cells: entries.map(provider => credentialedCells(provider).cells.get(entry.capability)!),
      anonymousCells: entries.map(({ anonymous }) => supportCell(at(anonymous.capabilities, entry.capability))),
    })
  }
  const all = groups.flatMap(group => group.rows)
  const providers = entries.map((entry, index) => {
    const { slug, name, factories, provider: { capabilities }, credentials } = entry
    const { usual } = credentialedCells(entry)
    return {
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
      ...credentials
        ? {
            credentials: credentials.map(({ id, label, description, env }) => ({
              id,
              label,
              description,
              env,
              summary: summarise(all.map(row => row.cells[index]!.byCredential![id]!)),
              usual: !!usual?.includes(id),
            })),
          }
        : {},
    }
  })
  return { providers, groups }
}

const GENERATED = '<!-- Generated by `pnpm capability-matrix`; do not edit by hand. -->'

function credentialList({ credentials }: MatrixProvider, prefix = ''): string[] {
  return credentials?.map(({ id, label, description }) => `- ${prefix}\`${id}\` (${label}): ${description}`) ?? []
}

function usualText(entry: MatrixProvider): string {
  const usual = credentialedCells(entry).usual ?? []
  return new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(usual.map(id => `\`${id}\``))
}

/** The capability matrix across every provider, as a Markdown table. */
export function matrix(forges: typeof Forges): string {
  const providers = matrixProviders(forges)
  const credentialed = providers.filter(provider => provider.credentials)
  return [
    GENERATED,
    '::capability-matrix',
    `| Capability | ${providers.map(({ name }) => name).join(' | ')} |`,
    `| --- | ${providers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| \`${row.name}\` | ${providers.map(provider => row.best(provider)).join(' | ')} |`),
    '',
    `Each cell shows the best support of any credential. Where support depends on the kind of credential, a cell names the credentials that have it, unless they are the forge's usual ones: ${new Intl.ListFormat('en-GB').format(credentialed.map(provider => `${usualText(provider)} on ${provider.name}`))}.`,
    '',
    ...credentialed.flatMap(provider => credentialList(provider, `${provider.name} `)),
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

/** One provider's capabilities, as the generated section of its page, with a column per kind of credential. */
export function providerSection(entry: MatrixProvider): string {
  const { slug, provider, anonymous, credentials } = entry
  const columns = credentials ?? [{ id: '', label: 'Support', provider }]
  const supportWith = (row: typeof rows[number], credential: Pick<MatrixCredential, 'id' | 'provider'>) => TRAITS.has(row.name) || !credentials
    ? cell(row.read(credential.provider.capabilities))
    : supportText(credentialedCells(entry).cells.get(row.name)!.byCredential![credential.id]!)
  return [
    '## Capabilities',
    '',
    GENERATED,
    `::provider-capabilities{provider="${slug}"}`,
    `| Capability | ${columns.map(({ label }) => label).join(' | ')} | Without credentials |`,
    `| --- | ${columns.map(() => '---').join(' | ')} | --- |`,
    ...rows.map(row => `| \`${row.name}\` | ${columns.map(credential => supportWith(row, credential)).join(' | ')} | ${cell(row.read(anonymous.capabilities))} |`),
    ...credentials ? ['', 'Support depends on the kind of credential:', '', ...credentialList(entry)] : [],
    '::',
  ].join('\n')
}
