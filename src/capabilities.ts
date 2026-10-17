import type { CapabilityEntry } from './capability-table.ts'
import type { AlertKind, CapabilityEnv, DeclaredSupport, KindVerb, ProviderSpec, SupportInput, Verb, VerbKind } from './define.ts'
import type { ForgeCapabilities, ForgeProvider } from './provider.ts'
import { CAPABILITY_TABLE } from './capability-table.ts'

export const ALERT_KINDS: AlertKind[] = ['dependency', 'code_scanning', 'secret', 'advisory']

export const KINDS: VerbKind[] = ['issue', 'pull_request', 'discussion', 'commit']

const NOT_APPLICABLE_KINDS: Record<VerbKind, DeclaredSupport> = {
  issue: 'not_applicable',
  pull_request: 'not_applicable',
  discussion: 'not_applicable',
  commit: 'not_applicable',
}

const NOT_APPLICABLE_ALERTS: Record<AlertKind, DeclaredSupport> = {
  dependency: 'not_applicable',
  code_scanning: 'not_applicable',
  secret: 'not_applicable',
  advisory: 'not_applicable',
}

/**
 * The level `support` declares. Unless `declared` is set, `'experimental'` and
 * `'unverified'` resolve to `true`, as `capabilities` reports them.
 */
export function resolve(support: SupportInput | undefined, env: CapabilityEnv, declared = false): DeclaredSupport {
  const level = typeof support === 'function' ? support(env) : support ?? false
  return declared || (level !== 'experimental' && level !== 'unverified') ? level : true
}

export function resolveKinds(kinds: Partial<Record<VerbKind, SupportInput>> | undefined, env: CapabilityEnv, declared = false) {
  return Object.fromEntries(KINDS.map(kind => [kind, resolve(kinds?.[kind], env, declared)])) as Record<VerbKind, DeclaredSupport>
}

/** A capability composed of `parts` is `'not_applicable'` when any part is, else `false`, else `'unverified'`. */
function composed(parts: DeclaredSupport[], level: DeclaredSupport): DeclaredSupport {
  return parts.includes('not_applicable') ? 'not_applicable' : parts.includes(false) ? false : parts.includes('unverified') ? 'unverified' : level
}

/** A thread's events are read for each kind the provider reads threads of, at the weaker of the two levels. */
export function threadEventKinds(spec: ProviderSpec, env: CapabilityEnv, declared = false): Record<VerbKind, DeclaredSupport> {
  const events = resolve(spec.threads.eventsPage.support, env, declared)
  const threads = resolveKinds(spec.threads.get.kinds, env, declared)
  return Object.fromEntries(KINDS.map(kind => [kind, composed([events, threads[kind]], events === true ? threads[kind] : events)])) as Record<VerbKind, DeclaredSupport>
}

/** A single-item read the spec does not declare is emulated by walking its listing. */
function readOrEmulated(read: DeclaredSupport, listing: DeclaredSupport, emulated: SupportInput | undefined, env: CapabilityEnv, declared: boolean): DeclaredSupport {
  if (read !== false) {
    return read
  }
  const level = emulated === undefined ? 'emulated' : resolve(emulated, env, declared)
  return composed([listing], level === true ? 'emulated' : level)
}

/** `threads.getComment`, per kind: declared, or emulated from `threads.commentsPage`. */
export function getCommentKinds(spec: ProviderSpec, env: CapabilityEnv, declared = false): Record<VerbKind, DeclaredSupport> {
  const read = resolveKinds(spec.threads.getComment?.kinds, env, declared)
  const listing = resolveKinds(spec.threads.commentsPage.kinds, env, declared)
  return Object.fromEntries(KINDS.map(kind => [kind, readOrEmulated(read[kind], listing[kind], spec.emulated?.getComment?.[kind], env, declared)])) as Record<VerbKind, DeclaredSupport>
}

/** `threads.getReview`: declared, or emulated from `threads.reviewsPage`. */
export function getReviewSupport(spec: ProviderSpec, env: CapabilityEnv, declared = false): DeclaredSupport {
  return readOrEmulated(resolve(spec.threads.getReview?.support, env, declared), resolve(spec.threads.reviewsPage?.support, env, declared), spec.emulated?.getReview, env, declared)
}

/** `ci.job`: declared, or emulated from `ci.jobsPage` for a job ref that names its run. */
export function ciJobSupport(spec: ProviderSpec, env: CapabilityEnv, declared = false): DeclaredSupport {
  return readOrEmulated(resolve(spec.ci?.job?.support, env, declared), resolve(spec.ci?.jobsPage?.support, env, declared), spec.emulated?.job, env, declared)
}

function read(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], source)
}

function write(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  const leaf = keys.pop()!
  const parent = keys.reduce<Record<string, unknown>>((node, key) => (node[key] ??= {}) as Record<string, unknown>, target)
  parent[leaf] = value
}

function unsupported(declared: unknown) {
  return declared && {
    ...declared as object,
    support: (declared as { support?: unknown }).support === 'not_applicable' ? 'not_applicable' : false,
  }
}

/** Keeps the kinds that are `'not_applicable'`, which no credential or mode changes. */
function unsupportedKinds(declared: unknown) {
  return declared && {
    ...declared as object,
    kinds: Object.fromEntries(Object.entries((declared as { kinds?: Record<string, unknown> }).kinds ?? {}).filter(([, value]) => value === 'not_applicable')),
  }
}

/** What `entry` contributes to the capability object; `undefined` leaves the field to core. */
function valueFor(entry: CapabilityEntry, spec: ProviderSpec, env: CapabilityEnv, flags: CapabilityFlags, declared: boolean): unknown {
  switch (entry.derived) {
    case 'experimental':
      return undefined
    case 'poll':
      return resolve(spec.notifications?.listPage.support, env, declared)
    case 'webhook':
      // The handler flag, not a declared verb, so `applyNotApplicable` cannot mark it.
      return flags.webhook || (spec.notApplicable?.includes('sources.webhook') ? 'not_applicable' : false)
    case 'threadEvents':
      return threadEventKinds(spec, env, declared)
    case 'getComment':
      return getCommentKinds(spec, env, declared)
    case 'getReview':
      return getReviewSupport(spec, env, declared)
    case 'ciJob':
      return ciJobSupport(spec, env, declared)
    case 'subscriptionSet':
      return resolveKinds((flags.readOnly ? unsupportedKinds(spec.threads.subscriptions) as KindVerb<unknown> | undefined : spec.threads.subscriptions)?.kinds, env, declared)
    case 'approve':
      return resolve((spec.threads.approve ?? spec.threads.createReview)?.support, env, declared)
    case 'alertKinds':
      return Object.fromEntries(ALERT_KINDS.map(kind => [kind, resolve(spec.securityAlerts?.kinds[kind], env, declared)]))
    case 'eventKinds':
      return spec.traits.eventKinds
    case 'authKinds':
      return spec.traits.authKinds
    case 'limits':
      return spec.traits.limits
  }
  const verb = read(spec, entry.spec!) as KindVerb<unknown> | Verb<unknown> | undefined
  return entry.perKind
    ? resolveKinds((verb as KindVerb<unknown> | undefined)?.kinds, env, declared)
    : resolve((verb as Verb<unknown> | undefined)?.support, env, declared)
}

export interface CapabilityFlags {
  experimental: boolean
  readOnly: boolean
  /** Whether the provider has delivery handlers. */
  webhook: boolean
}

/**
 * The capability object a spec declares, derived from {@link CAPABILITY_TABLE} with every support resolved against `env`.
 * With `declared`, it keeps the `'experimental'` and `'unverified'` levels that `capabilities` reports as `true`.
 */
export function capabilitiesOf(spec: ProviderSpec, env: CapabilityEnv, flags: CapabilityFlags, declared = false): ForgeCapabilities {
  const resolved = applyNotApplicable(spec)
  const capabilities: Record<string, unknown> = {
    version: env.version,
    ...flags.experimental ? { experimental: true as const } : {},
  }
  for (const entry of CAPABILITY_TABLE) {
    const value = valueFor(entry, resolved, env, flags, declared)
    if (value !== undefined) {
      write(capabilities, entry.capability, value)
    }
  }
  return capabilities as unknown as ForgeCapabilities
}

const DECLARED = Symbol.for('forges.declaredCapabilities')

/** Records how to read the declared levels of `provider`, for {@link declaredCapabilities}. */
export function trackDeclared<P extends object>(provider: P, read: () => ForgeCapabilities): P {
  return Object.defineProperty(provider, DECLARED, { value: read })
}

/**
 * The capabilities of `provider` with the levels it declares, including the
 * `'experimental'` and `'unverified'` levels that `provider.capabilities`
 * reports as `true`. The capability matrix and `pnpm test:capabilities` read
 * them.
 */
export function declaredCapabilities(provider: ForgeProvider): ForgeCapabilities {
  return (provider as { [DECLARED]?: () => ForgeCapabilities })[DECLARED]?.() ?? provider.capabilities
}

/** Verbs `readOnly` blocks, by their {@link ForgeVerb} name. */
export const WRITE_VERBS: Set<string> = new Set<string>(CAPABILITY_TABLE.flatMap(entry => entry.write ? entry.verbs ?? [] : []))

function update(target: unknown, path: string, change: (value: unknown) => unknown, create = false): unknown {
  const [key, ...rest] = path.split('.')
  const node = target as Record<string, unknown> | undefined
  if (!key) {
    return change(target)
  }
  if (!create && node?.[key] === undefined) {
    return target
  }
  return { ...node, [key]: update(node?.[key], rest.join('.'), change, create) }
}

const notApplicable = (declared: unknown) => ({ ...declared as object, support: 'not_applicable' as const })
const notApplicableKinds = (declared: unknown) => ({ ...declared as object, kinds: NOT_APPLICABLE_KINDS })

/** Fills `spec` with `'not_applicable'` entries before anything resolves it, so derived capabilities inherit the level from their parts. */
export function applyNotApplicable<T extends ProviderSpec>(spec: T): T {
  if (!spec.notApplicable?.length) {
    return spec
  }
  const absent = new Set<string>(spec.notApplicable)
  let updated: unknown = spec
  for (const entry of CAPABILITY_TABLE) {
    if (entry.spec && absent.has(entry.capability)) {
      updated = update(updated, entry.spec, entry.perKind ? notApplicableKinds : notApplicable, true)
    }
  }
  if (absent.has('sources.poll')) {
    updated = update(updated, 'notifications.listPage', notApplicable, true)
  }
  if (absent.has('subscriptions.set')) {
    updated = update(updated, 'threads.subscriptions', notApplicableKinds, true)
  }
  if (absent.has('securityAlerts')) {
    updated = update(updated, 'securityAlerts', declared => ({ ...declared as object, kinds: NOT_APPLICABLE_ALERTS }), true)
  }
  return updated as T
}

/**
 * Marks writes unsupported, with `anonymous` everything that needs an account,
 * and with `webhooksOnly` every declared verb, leaving only webhook ingestion.
 */
export function restrict(spec: ProviderSpec, anonymous: boolean, webhooksOnly = false): ProviderSpec {
  let restricted: unknown = applyNotApplicable(spec)
  for (const entry of CAPABILITY_TABLE) {
    if (entry.spec && (entry.write || (anonymous && (entry.account || webhooksOnly)))) {
      restricted = update(restricted, entry.spec, entry.perKind ? unsupportedKinds : unsupported)
    }
  }
  const result = restricted as ProviderSpec
  return anonymous && webhooksOnly ? update(result, 'securityAlerts', unsupportedKinds) as ProviderSpec : result
}

/**
 * Marks every declared verb unsupported except the capabilities in `keep` and
 * anything under them, for a credential that reaches only part of the API.
 * @param spec The spec that `setup()` declares.
 * @param keep Capability paths, such as `installations`, that stay as declared.
 * @example
 * ```ts
 * return appItself ? supportOnly(spec, ['installations']) : spec
 * ```
 */
export function supportOnly<T extends ProviderSpec>(spec: T, keep: readonly string[]): T {
  const kept = (capability: string) => keep.some(path => capability === path || capability.startsWith(`${path}.`))
  let restricted: unknown = applyNotApplicable(spec)
  for (const entry of CAPABILITY_TABLE) {
    if (entry.spec && !kept(entry.capability)) {
      restricted = update(restricted, entry.spec, entry.perKind ? unsupportedKinds : unsupported)
    }
  }
  return (kept('securityAlerts') ? restricted : update(restricted, 'securityAlerts', unsupportedKinds)) as T
}
