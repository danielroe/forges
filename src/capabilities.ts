import type { CapabilityEntry } from './capability-table.ts'
import type { AlertKind, CapabilityEnv, KindVerb, ProviderSpec, SupportInput, Verb, VerbKind } from './define.ts'
import type { Support } from './model.ts'
import type { ForgeCapabilities } from './provider.ts'
import { CAPABILITY_TABLE } from './capability-table.ts'

export const ALERT_KINDS: AlertKind[] = ['dependency', 'code_scanning', 'secret', 'advisory']

export const KINDS: VerbKind[] = ['issue', 'pull_request', 'discussion', 'commit']

const NOT_APPLICABLE_KINDS: Record<VerbKind, Support> = {
  issue: 'not_applicable',
  pull_request: 'not_applicable',
  discussion: 'not_applicable',
  commit: 'not_applicable',
}

const NOT_APPLICABLE_ALERTS: Record<AlertKind, Support> = {
  dependency: 'not_applicable',
  code_scanning: 'not_applicable',
  secret: 'not_applicable',
  advisory: 'not_applicable',
}

export function resolve(support: SupportInput | undefined, env: CapabilityEnv): Support {
  return typeof support === 'function' ? support(env) : support ?? false
}

export function resolveKinds(kinds: Partial<Record<VerbKind, SupportInput>> | undefined, env: CapabilityEnv) {
  return Object.fromEntries(KINDS.map(kind => [kind, resolve(kinds?.[kind], env)])) as Record<VerbKind, Support>
}

/** A capability composed of `parts` is `'not_applicable'` when any part is, else `false`, else `'unverified'`. */
function composed(parts: Support[], level: Support): Support {
  return parts.includes('not_applicable') ? 'not_applicable' : parts.includes(false) ? false : parts.includes('unverified') ? 'unverified' : level
}

/** A thread's events are read for each kind the provider reads threads of, at the weaker of the two levels. */
export function threadEventKinds(spec: ProviderSpec, env: CapabilityEnv): Record<VerbKind, Support> {
  const events = resolve(spec.threads.eventsPage.support, env)
  const threads = resolveKinds(spec.threads.get.kinds, env)
  return Object.fromEntries(KINDS.map(kind => [kind, composed([events, threads[kind]], events === true ? threads[kind] : events)])) as Record<VerbKind, Support>
}

/** `upsertComment` is composed of listing, creating and editing a comment, so it needs all three for the kind. */
export function upsertKinds(spec: ProviderSpec, env: CapabilityEnv): Record<VerbKind, Support> {
  if (spec.notApplicable?.includes('writes.upsertComment')) {
    return NOT_APPLICABLE_KINDS
  }
  const parts = [spec.threads.commentsPage, spec.threads.comment, spec.threads.editComment]
  return Object.fromEntries(KINDS.map(kind => [
    kind,
    composed(parts.map(part => resolve(part?.kinds[kind], env)), 'emulated'),
  ])) as Record<VerbKind, Support>
}

/** A single-item read the spec does not declare is emulated by walking its listing. */
function readOrEmulated(read: Support, listing: Support, emulated: SupportInput | undefined, env: CapabilityEnv): Support {
  return read === false ? composed([listing], emulated === undefined ? 'emulated' : resolve(emulated, env)) : read
}

/** `threads.getComment`, per kind: declared, or emulated from `threads.commentsPage`. */
export function getCommentKinds(spec: ProviderSpec, env: CapabilityEnv): Record<VerbKind, Support> {
  const read = resolveKinds(spec.threads.getComment?.kinds, env)
  const listing = resolveKinds(spec.threads.commentsPage.kinds, env)
  return Object.fromEntries(KINDS.map(kind => [kind, readOrEmulated(read[kind], listing[kind], spec.emulated?.getComment?.[kind], env)])) as Record<VerbKind, Support>
}

/** `threads.getReview`: declared, or emulated from `threads.reviewsPage`. */
export function getReviewSupport(spec: ProviderSpec, env: CapabilityEnv): Support {
  return readOrEmulated(resolve(spec.threads.getReview?.support, env), resolve(spec.threads.reviewsPage?.support, env), spec.emulated?.getReview, env)
}

/** `ci.job`: declared, or emulated from `ci.jobsPage` for a job ref that names its run. */
export function ciJobSupport(spec: ProviderSpec, env: CapabilityEnv): Support {
  return readOrEmulated(resolve(spec.ci?.job?.support, env), resolve(spec.ci?.jobsPage?.support, env), spec.emulated?.job, env)
}

/** Support for the composed verb, requiring both approval and merging. */
export function approveAndMergeSupport(spec: ProviderSpec, env: CapabilityEnv): Support {
  const merge = resolve(spec.threads.merge?.support, env)
  const approve = resolve((spec.threads.approve ?? spec.threads.createReview)?.support, env)
  const override = spec.threads.approveAndMerge ? resolve(spec.threads.approveAndMerge.support, env) : undefined
  return composed([merge, approve, ...override === undefined ? [] : [override]], override ?? merge)
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
function valueFor(entry: CapabilityEntry, spec: ProviderSpec, env: CapabilityEnv, flags: CapabilityFlags): unknown {
  switch (entry.derived) {
    case 'experimental':
      return undefined
    case 'poll':
      return resolve(spec.notifications?.listPage.support, env)
    case 'webhook':
      // The handler flag, not a declared verb, so `applyNotApplicable` cannot mark it.
      return flags.webhook || (spec.notApplicable?.includes('sources.webhook') ? 'not_applicable' : false)
    case 'threadEvents':
      return threadEventKinds(spec, env)
    case 'upsertComment':
      return upsertKinds(spec, env)
    case 'getComment':
      return getCommentKinds(spec, env)
    case 'getReview':
      return getReviewSupport(spec, env)
    case 'ciJob':
      return ciJobSupport(spec, env)
    case 'subscriptionSet':
      return resolveKinds((flags.readOnly ? unsupportedKinds(spec.threads.subscriptions) as KindVerb<unknown> | undefined : spec.threads.subscriptions)?.kinds, env)
    case 'approve':
      return resolve((spec.threads.approve ?? spec.threads.createReview)?.support, env)
    case 'approveAndMerge':
      return approveAndMergeSupport(spec, env)
    case 'alertKinds':
      return Object.fromEntries(ALERT_KINDS.map(kind => [kind, resolve(spec.securityAlerts?.kinds[kind], env)]))
    case 'eventKinds':
      return spec.traits.eventKinds
    case 'authKinds':
      return spec.traits.authKinds
    case 'limits':
      return spec.traits.limits
  }
  const declared = read(spec, entry.spec!) as KindVerb<unknown> | Verb<unknown> | undefined
  return entry.perKind
    ? resolveKinds((declared as KindVerb<unknown> | undefined)?.kinds, env)
    : resolve((declared as Verb<unknown> | undefined)?.support, env)
}

export interface CapabilityFlags {
  experimental: boolean
  readOnly: boolean
  /** Whether the provider has delivery handlers. */
  webhook: boolean
}

/** The capability object a spec declares, derived from {@link CAPABILITY_TABLE} with every support resolved against `env`. */
export function capabilitiesOf(spec: ProviderSpec, env: CapabilityEnv, flags: CapabilityFlags): ForgeCapabilities {
  const resolved = applyNotApplicable(spec)
  const capabilities: Record<string, unknown> = {
    version: env.version,
    ...flags.experimental ? { experimental: true as const } : {},
  }
  for (const entry of CAPABILITY_TABLE) {
    const value = valueFor(entry, resolved, env, flags)
    if (value !== undefined) {
      write(capabilities, entry.capability, value)
    }
  }
  return capabilities as unknown as ForgeCapabilities
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
  if (absent.has('writes.approveAndMerge')) {
    updated = update(updated, 'threads.approveAndMerge', notApplicable, true)
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
