/**
 * Renders the capability changes between two snapshots written by
 * `scripts/capability-snapshot.ts` as Markdown:
 *
 * - `pnpm capability-diff [ref]` compares the working tree with `ref`,
 *   `main` by default;
 * - `pnpm capability-diff --base <file> --head <file>` compares two snapshot
 *   files. A missing `--base` file renders nothing.
 *
 * With `--body <file>`, it prints that pull request body with its capability
 * section replaced, added, or removed when nothing changed, and with `--out`
 * writes nothing when the body stays the same. `--before <prefix>` adds a new
 * section above the first line starting with `prefix` rather than at the end. `--coverage` adds a chart of
 * the verified capabilities each provider gained and lost. `--icons <url>`
 * shows the logos in `assets/providers/` served from `url` in place of
 * provider names. `--out <file>` writes to a file. Snapshots are validated before use, as a
 * pull request can write them.
 */
import type { SupportLevel } from './capabilities.ts'
import type { CapabilitySnapshot, SnapshotCredential, SnapshotProvider, SupportMap } from './capability-snapshot.ts'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { KINDS } from './capabilities.ts'
import { capabilitySnapshot, snapshotAt } from './capability-snapshot.ts'

type Transition = readonly [from: SupportLevel, to: SupportLevel]

interface CapabilityChange {
  /** The capability path, or `<path>:<kind>`. */
  key: string
  authenticated?: Transition
  anonymous?: Transition
  /** Kinds of credential whose support changed other than `authenticated` did. */
  credentials?: Array<{ id: string, label: string, transition: Transition }>
}

export interface ProviderDiff {
  slug: string
  name: string
  status: 'added' | 'removed' | 'changed'
  /** Capabilities verified with credentials: native, experimental or emulated. */
  coverage: Coverage
  /** The new `experimental` flag, where it changed. */
  experimental?: boolean
  authAdded: string[]
  authRemoved: string[]
  /** The ids of the kinds of credential either snapshot tells apart, in `head` order. */
  credentials?: string[]
  changes: CapabilityChange[]
}

const LEVELS: readonly SupportLevel[] = ['native', 'experimental', 'emulated', 'unverified', 'not_applicable', 'none']
const KEY = /^[a-z][a-z\d]*(?:\.[a-z][a-z\d]*)*(?::[a-z]\w*)?$/i
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

function invalid(reason: string): never {
  throw new Error(`Invalid capability snapshot: ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function supportMap(value: unknown, where: string): SupportMap {
  if (!isRecord(value)) {
    invalid(`${where} is not an object`)
  }
  const entries = Object.entries(value)
  if (entries.length > 2000) {
    invalid(`${where} has ${entries.length} entries`)
  }
  const map: SupportMap = {}
  for (const [key, level] of entries) {
    if (key.length > 100 || !KEY.test(key) || !LEVELS.includes(level as SupportLevel)) {
      invalid(`${where} has an unexpected entry ${JSON.stringify(key).slice(0, 100)}`)
    }
    map[key] = level as SupportLevel
  }
  return map
}

function snapshotProvider(value: unknown, index: number): SnapshotProvider {
  if (!isRecord(value)) {
    invalid(`provider ${index} is not an object`)
  }
  const { slug, name, experimental, auth, capabilities, anonymous, credentials } = value
  if (typeof slug !== 'string' || !/^[a-z\d-]{1,40}$/.test(slug)) {
    invalid(`provider ${index} has an unexpected slug`)
  }
  if (typeof name !== 'string' || !/^[\w .-]{1,40}$/.test(name)) {
    invalid(`${slug} has an unexpected name`)
  }
  if (typeof experimental !== 'boolean') {
    invalid(`${slug} has no experimental flag`)
  }
  if (!Array.isArray(auth) || auth.length > 16 || !auth.every(kind => typeof kind === 'string' && /^[a-z_]{1,32}$/.test(kind))) {
    invalid(`${slug} has unexpected auth kinds`)
  }
  return {
    slug,
    name,
    experimental,
    auth: [...auth] as string[],
    capabilities: supportMap(capabilities, slug),
    anonymous: supportMap(anonymous, `${slug} anonymous`),
    ...credentials !== undefined && { credentials: snapshotCredentials(credentials, slug) },
  }
}

function snapshotCredentials(value: unknown, slug: string): SnapshotCredential[] {
  if (!Array.isArray(value) || value.length > 16) {
    invalid(`${slug} has unexpected credentials`)
  }
  const credentials = value.map((credential: unknown) => {
    if (!isRecord(credential) || typeof credential.id !== 'string' || !/^[a-z][a-z\d-]{0,31}$/.test(credential.id)) {
      invalid(`${slug} has a credential with an unexpected id`)
    }
    if (typeof credential.label !== 'string' || !/^[\w .()-]{1,40}$/.test(credential.label)) {
      invalid(`${slug} has a credential with an unexpected label`)
    }
    return { id: credential.id, label: credential.label, capabilities: supportMap(credential.capabilities, `${slug} ${credential.id}`) }
  })
  if (new Set(credentials.map(credential => credential.id)).size !== credentials.length) {
    invalid(`${slug} has two credentials with one id`)
  }
  return credentials
}

/** Parses and validates a snapshot, keeping only the fields it knows. */
export function parseSnapshot(text: string): CapabilitySnapshot {
  const value = JSON.parse(text) as unknown
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.providers) || value.providers.length > 64) {
    invalid('expected version 1 with at most 64 providers')
  }
  const providers = value.providers.map(snapshotProvider)
  if (new Set(providers.map(provider => provider.slug)).size !== providers.length) {
    invalid('two providers share a slug')
  }
  return { version: 1, providers }
}

function levelAt(map: SupportMap, key: string): SupportLevel {
  return Object.hasOwn(map, key) ? map[key]! : 'none'
}

function transition(base: SupportMap, head: SupportMap, key: string): Transition | undefined {
  const from = levelAt(base, key)
  const to = levelAt(head, key)
  return from === to ? undefined : [from, to]
}

interface Coverage {
  /** Verified before and after. */
  kept: number
  /** Verified after only. */
  gained: number
  /** Verified before only. */
  lost: number
  /** Capabilities either snapshot lists. */
  total: number
}

const VERIFIED: readonly SupportLevel[] = ['native', 'experimental', 'emulated']

function coverageOf(base: SupportMap, head: SupportMap): Coverage {
  const keys = new Set([...Object.keys(base), ...Object.keys(head)])
  const coverage: Coverage = { kept: 0, gained: 0, lost: 0, total: keys.size }
  for (const key of keys) {
    const before = VERIFIED.includes(levelAt(base, key))
    const after = VERIFIED.includes(levelAt(head, key))
    if (before && after) {
      coverage.kept++
    }
    else if (after) {
      coverage.gained++
    }
    else if (before) {
      coverage.lost++
    }
  }
  return coverage
}

/** What happened to a capability on one provider. */
type Cell = 'kept' | 'gained' | 'changed' | 'lost' | 'absent'

/** One capability across every provider. */
interface Row {
  /** A cell per provider, in `head` order. */
  cells: Cell[]
  /** Providers with the capability verified, before and after. */
  before: number
  after: number
}

export interface CapabilityDiff {
  providers: ProviderDiff[]
  /** The providers of `head`, in order: the columns of each row. */
  columns: Array<Pick<SnapshotProvider, 'slug' | 'name'>>
  /** A row per capability that changed on any provider, with and without credentials. */
  rows: Record<'authenticated' | 'anonymous', Map<string, Row>>
}

function cellOf(from: SupportLevel, to: SupportLevel): Cell {
  if (from === to) {
    return VERIFIED.includes(to) ? 'kept' : 'absent'
  }
  if (isRegression([from, to])) {
    return 'lost'
  }
  return !VERIFIED.includes(from) && VERIFIED.includes(to) ? 'gained' : 'changed'
}

function rowsOf(base: CapabilitySnapshot, head: CapabilitySnapshot, pick: (provider: SnapshotProvider) => SupportMap): Map<string, Row> {
  const previous = new Map(base.providers.map(provider => [provider.slug, pick(provider)]))
  const keys = new Set([...base.providers, ...head.providers].flatMap(provider => Object.keys(pick(provider))))
  const rows = new Map<string, Row>()
  for (const key of keys) {
    const cells = head.providers.map(provider => cellOf(levelAt(previous.get(provider.slug) ?? {}, key), levelAt(pick(provider), key)))
    if (cells.some(cell => cell !== 'kept' && cell !== 'absent')) {
      rows.set(key, {
        cells,
        before: base.providers.filter(provider => VERIFIED.includes(levelAt(pick(provider), key))).length,
        after: head.providers.filter(provider => VERIFIED.includes(levelAt(pick(provider), key))).length,
      })
    }
  }
  return rows
}

/** What changed per provider, in `head` order followed by providers `head` drops, and each changed capability across every provider. */
export function diffSnapshots(base: CapabilitySnapshot, head: CapabilitySnapshot): CapabilityDiff {
  return {
    providers: providerDiffs(base, head),
    columns: head.providers.map(({ slug, name }) => ({ slug, name })),
    rows: { authenticated: rowsOf(base, head, provider => provider.capabilities), anonymous: rowsOf(base, head, provider => provider.anonymous) },
  }
}

/** Support with one kind of credential, or with any where the snapshot does not tell them apart. */
function credentialSupport(provider: SnapshotProvider, id: string): SupportMap {
  return provider.credentials?.find(credential => credential.id === id)?.capabilities ?? provider.capabilities
}

function providerDiffs(base: CapabilitySnapshot, head: CapabilitySnapshot): ProviderDiff[] {
  const before = new Map(base.providers.map(provider => [provider.slug, provider]))
  const kept = new Set(head.providers.map(provider => provider.slug))
  const diffs: ProviderDiff[] = []
  for (const provider of head.providers) {
    const previous = before.get(provider.slug)
    if (!previous) {
      diffs.push({ slug: provider.slug, name: provider.name, status: 'added', coverage: coverageOf({}, provider.capabilities), authAdded: [], authRemoved: [], changes: [] })
      continue
    }
    const credentials = [...new Map([...provider.credentials ?? [], ...previous.credentials ?? []].map(({ id, label }) => [id, label]))]
    const keys = new Set([provider, previous].flatMap(side => [side.capabilities, side.anonymous, ...(side.credentials ?? []).map(credential => credential.capabilities)].flatMap(map => Object.keys(map))))
    const changes: CapabilityChange[] = []
    for (const key of keys) {
      const authenticated = transition(previous.capabilities, provider.capabilities, key)
      const anonymous = transition(previous.anonymous, provider.anonymous, key)
      const byCredential = credentials.flatMap(([id, label]) => {
        const item = transition(credentialSupport(previous, id), credentialSupport(provider, id), key)
        return item && item.join() !== authenticated?.join() ? [{ id, label, transition: item }] : []
      })
      if (authenticated || anonymous || byCredential.length) {
        changes.push({ key, ...authenticated && { authenticated }, ...anonymous && { anonymous }, ...byCredential.length && { credentials: byCredential } })
      }
    }
    const diff: ProviderDiff = {
      slug: provider.slug,
      name: provider.name,
      status: 'changed',
      coverage: coverageOf(previous.capabilities, provider.capabilities),
      ...previous.experimental !== provider.experimental && { experimental: provider.experimental },
      authAdded: provider.auth.filter(kind => !previous.auth.includes(kind)),
      authRemoved: previous.auth.filter(kind => !provider.auth.includes(kind)),
      ...credentials.length && { credentials: credentials.map(([id]) => id) },
      changes,
    }
    if (changes.length || diff.experimental !== undefined || diff.authAdded.length || diff.authRemoved.length) {
      diffs.push(diff)
    }
  }
  for (const provider of base.providers.filter(provider => !kept.has(provider.slug))) {
    diffs.push({ slug: provider.slug, name: provider.name, status: 'removed', coverage: coverageOf(provider.capabilities, {}), authAdded: [], authRemoved: [], changes: [] })
  }
  return diffs
}

const ICONS: Record<SupportLevel, string> = { native: '✅', experimental: '🧪', emulated: '🧩', unverified: '❔', not_applicable: '∅', none: '❌' }
const SQUARES: Record<Cell, string> = { kept: '🟦', gained: '🟩', changed: '🟨', lost: '🟥', absent: '⬜' }
const ALSO_ANONYMOUS = '🔓'
/** Each line of the legend, of which only the symbols a section uses are shown. */
const LEGEND: Array<Array<[symbol: string, meaning: string]>> = [
  [['🟦', 'verified'], ['🟩', 'newly verified'], ['🟨', 'changed'], ['🟥', 'no longer verified'], ['⬜', 'not verified'], [ALSO_ANONYMOUS, 'same without credentials']],
  [['✅', 'native'], ['🧪', 'experimental'], ['🧩', 'emulated'], ['❔', 'unverified'], ['∅', 'not applicable'], ['❌', 'not available']],
]

/**
 * GitHub sets no line height on `<sub>`, so text that wraps inside one
 * overlaps itself; each entry is its own `<sub>` that cannot wrap.
 */
function legend(markdown: string): string {
  return LEGEND
    .map(line => line.filter(([symbol]) => markdown.includes(symbol)).map(([symbol, meaning]) => `<sub>${`${symbol} ${meaning}`.replaceAll(' ', '&nbsp;')}</sub>`).join(' <sub>·</sub> '))
    .filter(Boolean)
    .join('\n\n')
}

/** A drop from an available level to an unavailable one is a regression; reclassifying between `'none'` and `'not_applicable'` is not. */
function isRegression([from, to]: Transition): boolean {
  return from !== 'none' && from !== 'not_applicable' && (to === 'none' || to === 'not_applicable' || to === 'unverified')
}

function regresses(change: CapabilityChange): boolean {
  return [change.authenticated, change.anonymous].some(item => item && isRegression(item))
}

/** Whether the change shows with or without credentials, rather than for some kinds of credential only. */
function isShared(change: CapabilityChange): boolean {
  return !!(change.authenticated || change.anonymous)
}

function arrow([from, to]: Transition): string {
  return `${ICONS[from]} → ${ICONS[to]}`
}

function code(items: string[]): string {
  return items.map(item => `\`${item}\``).join(', ')
}

/** Regressions, then capabilities now on every provider, then those catching up, then those new to all providers, then the rest. */
function rank({ cells, before, after }: Row): number {
  if (cells.includes('lost')) {
    return 0
  }
  if (after === cells.length && before < after) {
    return 1
  }
  if (before > 0 && after > before) {
    return 2
  }
  return before === 0 && after > 0 ? 3 : 4
}

interface Line {
  key: string
  /** The line without its capability label; lines for kinds of one capability merge when it matches. */
  text: string
  regression: boolean
  /** The capability across every provider, which orders the lines. */
  row: Row
}

/** Lines in order of rank and then of how many providers have the capability, merging kinds of one capability whose text matches, as `capability` (issue, PR). */
function merged(lines: Line[], format: (label: string, text: string, regression: boolean) => string): string[] {
  const items: Array<{ capability: string, kinds: string[], text: string, regression: boolean }> = []
  for (const { key, text, regression } of lines.toSorted((a, b) => rank(a.row) - rank(b.row) || b.row.after - a.row.after)) {
    const [capability = '', kind] = key.split(':')
    const match = kind && items.find(item => item.capability === capability && item.kinds.length && item.text === text)
    if (match) {
      match.kinds.push(kind)
    }
    else {
      items.push({ capability, kinds: kind ? [kind] : [], text, regression })
    }
  }
  return items.map(({ capability, kinds, text, regression }) => format(kinds.length ? `\`${capability}\` (${kinds.map(kind => KINDS[kind] ?? kind).join(', ')})` : `\`${capability}\``, text, regression))
}

/** Capabilities of one namespace as one label, as `threads` react (issue, PR), merge. */
function groupLabel(keys: string[]): string {
  const capabilities = new Map<string, string[]>()
  for (const key of keys) {
    const [capability = '', kind] = key.split(':')
    capabilities.set(capability, [...capabilities.get(capability) ?? [], ...kind ? [kind] : []])
  }
  const named = (name: string, kinds: string[]) => kinds.length ? `${name} (${kinds.map(kind => KINDS[kind] ?? kind).join(', ')})` : name
  const entries = [...capabilities]
  if (entries.length === 1) {
    return named(`\`${entries[0]![0]}\``, entries[0]![1])
  }
  const namespace = entries[0]![0].split('.')[0]!
  return `\`${namespace}\` ${entries.map(([capability, kinds]) => named(capability.slice(namespace.length + 1), kinds)).join(', ')}`
}

/**
 * A row of squares per changed capability, with a column per provider. Rows
 * of one namespace whose squares match share a row, and `open` marks the
 * capabilities that changed the same way without credentials.
 */
function grid(columns: string[], rows: Map<string, Row>, open: Set<string>): string[] {
  if (!rows.size) {
    return []
  }
  const groups = new Map<string, { keys: string[], text: string }>()
  for (const [key, row] of [...rows].toSorted(([, a], [, b]) => rank(a) - rank(b) || b.after - a.after)) {
    const text = row.cells.map(cell => SQUARES[cell]).join(' | ')
    const id = `${key.split('.')[0]} ${text} ${open.has(key)}`
    const group = groups.get(id) ?? { keys: [], text }
    group.keys.push(key)
    groups.set(id, group)
  }
  return [
    `| | ${columns.join(' | ')} |`,
    `| --- | ${columns.map(() => ':-:').join(' | ')} |`,
    ...[...groups.values()].map(({ keys, text }) => `| ${groupLabel(keys)}${open.has(keys[0]!) ? ` ${ALSO_ANONYMOUS}` : ''} | ${text} |`),
    '',
  ]
}

function providerNotes(diff: ProviderDiff): string[] {
  if (diff.status === 'added') {
    return [`New provider, with ${diff.coverage.gained} verified ${diff.coverage.gained === 1 ? 'capability' : 'capabilities'}`]
  }
  if (diff.status === 'removed') {
    return ['Provider removed ⚠️']
  }
  return [
    ...diff.experimental === undefined ? [] : [diff.experimental ? 'Now marked experimental' : 'No longer marked experimental'],
    ...diff.authAdded.length ? [`Signs in with ${code(diff.authAdded)}`] : [],
    ...diff.authRemoved.length ? [`No longer signs in with ${code(diff.authRemoved)} ⚠️`] : [],
  ]
}

/** One list per provider, for changes that touch one or two providers. */
function byProvider(diffs: ProviderDiff[], rows: CapabilityDiff['rows']): string[] {
  return diffs.flatMap((diff) => {
    const lines = diff.changes.filter(isShared).map(({ key, authenticated, anonymous }) => {
      const without = !anonymous
        ? ''
        : !authenticated
            ? `${arrow(anonymous)} {label} without credentials`
            : anonymous[0] === authenticated[0] && anonymous[1] === authenticated[1]
              ? ', also without credentials'
              : `, without credentials ${arrow(anonymous)}`
      const text = authenticated ? `${arrow(authenticated)} {label}${without}` : without
      return { key, text, regression: regresses({ key, authenticated, anonymous }), row: (authenticated ? rows.authenticated : rows.anonymous).get(key)! }
    })
    const items = [
      ...providerNotes(diff).map(note => `- ${note}`),
      ...merged(lines, (label, text, regression) => `- ${text.replace('{label}', label)}${regression ? ' ⚠️' : ''}`),
    ]
    return items.length ? [`**${diff.name}**`, '', ...items, ''] : []
  })
}

/** One line per capability, naming the providers each change applies to. */
function capabilityLines(diffs: ProviderDiff[], pick: (change: CapabilityChange) => Transition | undefined, rows: Map<string, Row>): string[] {
  const keys = [...new Set(diffs.flatMap(diff => diff.changes.filter(pick).map(change => change.key)))]
  const lines = keys.map((key) => {
    const groups = new Map<string, { transition: Transition, names: string[] }>()
    for (const diff of diffs) {
      const change = diff.changes.find(change => change.key === key)
      const item = change && pick(change)
      if (item) {
        const group = groups.get(arrow(item)) ?? { transition: item, names: [] }
        group.names.push(diff.name)
        groups.set(arrow(item), group)
      }
    }
    const text = [...groups.entries()].map(([label, { transition, names }]) => `${label} ${names.join(', ')}${isRegression(transition) ? ' ⚠️' : ''}`).join('; ')
    return { key, text, regression: [...groups.values()].some(group => isRegression(group.transition)), row: rows.get(key)! }
  })
  return merged(lines, (label, text) => `- ${label}: ${text}`)
}

/** One list per capability, for changes that touch three or more providers. */
function byCapability(diffs: ProviderDiff[], rows: CapabilityDiff['rows']): string[] {
  const notes = diffs.flatMap(diff => providerNotes(diff).map(note => `- **${diff.name}**: ${note}`))
  const authenticated = capabilityLines(diffs, change => change.authenticated, rows.authenticated)
  const anonymous = capabilityLines(diffs, change => change.anonymous, rows.anonymous)
  return [
    ...notes.length ? [...notes, ''] : [],
    ...authenticated.length ? [...authenticated, ''] : [],
    ...anonymous.length ? ['Without credentials:', '', ...anonymous, ''] : [],
  ]
}

/** Lists with more capabilities than this name only how many there are. */
const MAX_LISTED = 12

/** Capabilities across namespaces as one label, as `notifications` list, get, `sources.subscribe`. */
function listLabel(keys: string[]): string {
  const namespaces = new Map<string, string[]>()
  for (const key of keys) {
    const namespace = key.split(/[.:]/)[0]!
    namespaces.set(namespace, [...namespaces.get(namespace) ?? [], key])
  }
  return [...namespaces.values()].map(groupLabel).join(', ')
}

/** One list per provider of the changes that apply to some kinds of credential only. */
function byCredential(diffs: ProviderDiff[]): string[] {
  return diffs.flatMap((diff) => {
    const groups = new Map<string, { id: string, label: string, transition: Transition, keys: string[] }>()
    for (const { key, credentials = [] } of diff.changes) {
      for (const { id, label, transition } of credentials) {
        const group = groups.get(`${id} ${transition.join()}`) ?? { id, label, transition, keys: [] }
        group.keys.push(key)
        groups.set(`${id} ${transition.join()}`, group)
      }
    }
    if (!groups.size) {
      return []
    }
    return [
      `**${diff.name}**`,
      '',
      ...[...groups.values()].toSorted((a, b) => diff.credentials!.indexOf(a.id) - diff.credentials!.indexOf(b.id)).map(({ id, label, transition, keys }) => {
        const what = keys.length > MAX_LISTED ? `${keys.length} capabilities` : listLabel(keys)
        return `- \`${id}\` (${label}): ${arrow(transition)} ${what}${isRegression(transition) ? ' ⚠️' : ''}`
      }),
      '',
    ]
  })
}

const BAR_WIDTH = 10

/**
 * A bar chart of the verified capabilities each provider gained and lost,
 * with losses growing left and gains right, scaled to the largest change.
 */
function coverage(diffs: ProviderDiff[], heading: (provider: Pick<ProviderDiff, 'slug' | 'name'>) => string): string[] {
  const changed = diffs.filter(({ coverage }) => coverage.gained || coverage.lost)
  if (!changed.length) {
    return []
  }
  const unit = Math.ceil(Math.max(...changed.map(({ coverage }) => Math.max(coverage.gained, coverage.lost))) / BAR_WIDTH)
  const losses = changed.some(({ coverage }) => coverage.lost)
  const rows = changed.map(({ slug, name, coverage: { kept, gained, lost } }) => {
    const cells = [
      ...losses ? [lost ? `-${lost} ${'🟥'.repeat(Math.ceil(lost / unit))}` : ''] : [],
      gained ? `${'🟩'.repeat(Math.ceil(gained / unit))} +${gained}` : '',
      `${kept + lost} → ${kept + gained}`,
    ]
    const label = heading({ slug, name })
    return `| ${label === name ? name : `${label} ${name}`} | ${cells.join(' | ')} |`
  })
  return [
    `| Provider | ${losses ? 'Lost | ' : ''}Gained | Verified |`,
    `| --- | ${losses ? '---: | ' : ''}:--- | ---: |`,
    ...rows,
    '',
    `<sub>Verified capabilities with credentials: native, experimental or emulated.${unit > 1 ? ` Each square stands for up to ${unit}.` : ''}</sub>`,
    '',
  ]
}

export interface RenderOptions {
  /** Adds a chart of the verified capabilities each provider gained and lost. */
  coverage?: boolean
  /** The URL of a provider's logo, shown in place of its name with the name as alt text and linking to its docs page. */
  icon?: (slug: string) => string | undefined
}

/** The changes as Markdown, or `''` when nothing changed. */
export function renderDiff({ providers: diffs, columns: providers, rows }: CapabilityDiff, options: RenderOptions = {}): string {
  if (!diffs.length) {
    return ''
  }
  const heading = ({ slug, name }: Pick<ProviderDiff, 'slug' | 'name'>) => {
    const url = options.icon?.(slug)
    return url ? `<a href="https://forges.link/providers/${slug}"><img src="${url}" alt="${name}" title="${name}" width="16" height="16"></a>` : name
  }
  const columns = providers.map(heading)
  const cells = diffs.flatMap(diff => diff.changes).filter(isShared).map(change => regresses(change) ? 'lost' : cellOf(...(change.authenticated ?? change.anonymous)!))
  const count = (cell: Cell) => cells.filter(item => item === cell).length
  const lost = count('lost') + diffs.filter(diff => diff.status === 'removed' || diff.authRemoved.length).length
  const everywhere = [...rows.authenticated.values()].filter(({ cells, before, after }) => after === cells.length && before < after).length
  const credentialChanges = diffs.flatMap(diff => diff.changes.filter(change => change.credentials).map(change => `${diff.slug} ${change.key}`)).length
  const summary = [
    count('gained') && `🟩 **${count('gained')}** gained`,
    count('changed') && `🟨 **${count('changed')}** changed`,
    lost && `🟥 **${lost}** removed or downgraded`,
    everywhere && `✨ **${everywhere}** now on every provider`,
    credentialChanges && `🔑 **${credentialChanges}** changed for some kinds of credential`,
  ].filter(Boolean).join(' · ')
  const body = diffs.filter(diff => diff.changes.some(isShared)).length >= 3 ? byCapability(diffs, rows) : byProvider(diffs, rows)
  const credentials = byCredential(diffs)
  const credentialsLost = diffs.some(diff => diff.changes.some(change => change.credentials?.some(credential => isRegression(credential.transition))))
  const same = (key: string) => rows.anonymous.get(key)?.cells.join() === rows.authenticated.get(key)?.cells.join()
  const open = new Set([...rows.authenticated.keys()].filter(same))
  const differing = new Map([...rows.anonymous].filter(([key]) => !same(key)))
  const anonymous = grid(columns, differing, new Set())
  const anonymousLost = [...differing.values()].some(row => row.cells.includes('lost'))
  const markdown = [
    '### Capability changes',
    '',
    ...summary ? [summary, ''] : [],
    ...options.coverage ? coverage(diffs, heading) : [],
    ...grid(columns, rows.authenticated, open),
    ...anonymous.length ? [`<details${anonymousLost ? ' open' : ''}><summary>Without credentials, where that differs</summary>`, '', ...anonymous, '</details>', ''] : [],
    ...credentials.length ? [`<details${credentialsLost ? ' open' : ''}><summary>With some kinds of credential, where that differs</summary>`, '', ...credentials, '</details>', ''] : [],
    ...body.length ? ['<details><summary>In detail</summary>', '', ...body, '</details>', ''] : [],
  ].join('\n')
  return `${markdown}\n${legend(markdown)}`
}

const SECTION_START = '<!-- forges:capabilities:start -->'
const SECTION_END = '<!-- forges:capabilities:end -->'
const SECTION = new RegExp(`^${SECTION_START}\\r?$[\\s\\S]+?^${SECTION_END}\\r?$`, 'm')

function lineStarting(body: string, prefix: string): number {
  if (body.startsWith(prefix)) {
    return 0
  }
  const index = body.indexOf(`\n${prefix}`)
  return index < 0 ? -1 : index + 1
}

/**
 * `body` with its capability section, between markers on lines of their own,
 * replaced, or removed when `section` is empty. A new section goes above the
 * first line that starts with `anchor`, or at the end.
 */
export function withCapabilitySection(body: string, section: string, anchor?: string): string {
  const block = section && `${SECTION_START}\n${section}\n${SECTION_END}`
  const match = SECTION.exec(body)
  const at = match ? match.index : anchor ? lineStarting(body, anchor) : -1
  const end = match ? match.index + match[0].length : at
  const [before, after] = at < 0 ? [body, ''] : [body.slice(0, at), body.slice(end)]
  return [before.trimEnd(), block, after.trim()].filter(Boolean).join('\n\n')
}

function readSnapshot(path: string): CapabilitySnapshot {
  if (statSync(path).size > MAX_SNAPSHOT_BYTES) {
    invalid(`${path} is larger than ${MAX_SNAPSHOT_BYTES} bytes`)
  }
  return parseSnapshot(readFileSync(path, 'utf8'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: 'string' }, head: { type: 'string' }, body: { type: 'string' }, out: { type: 'string' }, coverage: { type: 'boolean', default: false }, icons: { type: 'string' }, before: { type: 'string' } } })
  if (values.icons !== undefined && !/^https:\/\/\S+\/$/.test(values.icons)) {
    throw new Error('--icons takes an https URL ending in /')
  }
  const icon = (slug: string) => values.icons && existsSync(fileURLToPath(new URL(`../assets/providers/${slug}.svg`, import.meta.url))) ? `${values.icons}${slug}.svg` : undefined
  let base: CapabilitySnapshot | undefined
  let head: CapabilitySnapshot
  if (values.head) {
    base = values.base && existsSync(values.base) ? readSnapshot(values.base) : undefined
    head = readSnapshot(values.head)
  }
  else {
    const ref = positionals[0] ?? 'main'
    const json = snapshotAt(ref)
    if (json === undefined) {
      console.error(`${ref} has no capability snapshot script; nothing to compare against.`)
    }
    base = json === undefined ? undefined : parseSnapshot(json)
    head = capabilitySnapshot()
  }
  const markdown = base ? renderDiff(diffSnapshots(base, head), { coverage: values.coverage, icon }) : ''
  const body = values.body === undefined ? undefined : readFileSync(values.body, 'utf8')
  const output = body === undefined ? markdown : withCapabilitySection(body, markdown, values.before)
  if (body !== undefined && output.trim() === body.trim()) {
    console.info('The capability section is up to date.')
  }
  else if (values.out) {
    writeFileSync(values.out, output ? `${output}\n` : '')
  }
  else if (output) {
    process.stdout.write(`${output}\n`)
  }
}
