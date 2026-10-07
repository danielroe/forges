import type { CapabilityEntry } from './capability-table.ts'
import type { AlertKind, CapabilityEnv, KindVerb, ProviderSpec, SupportInput, Verb, VerbKind } from './define.ts'
import type { ForgeCapabilities } from './provider.ts'
import { CAPABILITY_TABLE } from './capability-table.ts'

export const ALERT_KINDS: AlertKind[] = ['dependency', 'code_scanning', 'secret', 'advisory']

export const KINDS: VerbKind[] = ['issue', 'pull_request', 'discussion', 'commit']

export function resolve(support: SupportInput | undefined, env: CapabilityEnv): boolean | 'emulated' | 'experimental' {
  return typeof support === 'function' ? support(env) : support ?? false
}

export function resolveKinds(kinds: Partial<Record<VerbKind, SupportInput>> | undefined, env: CapabilityEnv) {
  return Object.fromEntries(KINDS.map(kind => [kind, resolve(kinds?.[kind], env)])) as Record<VerbKind, boolean | 'emulated' | 'experimental'>
}

/** `upsertComment` is composed of listing, creating and editing a comment, so it needs all three for the kind. */
export function upsertKinds(spec: ProviderSpec, env: CapabilityEnv): Record<VerbKind, boolean | 'emulated' | 'experimental'> {
  const parts = [spec.threads.commentsPage, spec.threads.comment, spec.threads.editComment]
  return Object.fromEntries(KINDS.map(kind => [
    kind,
    parts.every(part => resolve(part?.kinds[kind], env) !== false) ? 'emulated' as const : false,
  ])) as Record<VerbKind, boolean | 'emulated' | 'experimental'>
}

/** Support for the composed verb, requiring both approval and merging. */
export function approveAndMergeSupport(spec: ProviderSpec, env: CapabilityEnv): boolean | 'emulated' | 'experimental' {
  const merge = resolve(spec.threads.merge?.support, env)
  if (!merge || !resolve((spec.threads.approve ?? spec.threads.createReview)?.support, env)) {
    return false
  }
  return resolve(spec.threads.approveAndMerge?.support ?? merge, env)
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

/** What `entry` contributes to the capability object; `undefined` leaves the field to core. */
function valueFor(entry: CapabilityEntry, spec: ProviderSpec, env: CapabilityEnv, flags: CapabilityFlags): unknown {
  switch (entry.derived) {
    case 'experimental':
      return undefined
    case 'poll':
      return spec.traits.poll
    case 'webhook':
      return flags.webhook
    case 'upsertComment':
      return upsertKinds(spec, env)
    case 'subscriptionSet':
      return resolveKinds(flags.readOnly ? undefined : spec.threads.subscriptions?.kinds, env)
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
  const capabilities: Record<string, unknown> = {
    version: env.version,
    ...flags.experimental ? { experimental: true as const } : {},
  }
  for (const entry of CAPABILITY_TABLE) {
    if (entry.alias) {
      continue
    }
    const value = valueFor(entry, spec, env, flags)
    if (value !== undefined) {
      write(capabilities, entry.capability, value)
    }
  }
  return capabilities as unknown as ForgeCapabilities
}

/** Verbs `readOnly` blocks, by their {@link ForgeVerb} name. */
export const WRITE_VERBS = new Set<string>(CAPABILITY_TABLE.flatMap(entry => entry.write ? entry.verbs ?? [] : []))

function update(target: unknown, path: string, change: (value: unknown) => unknown): unknown {
  const [key, ...rest] = path.split('.')
  const node = target as Record<string, unknown> | undefined
  if (!key) {
    return change(target)
  }
  if (node?.[key] === undefined) {
    return target
  }
  return { ...node, [key]: update(node[key], rest.join('.'), change) }
}

const unsupported = (declared: unknown) => declared && { ...declared as object, support: false }
const unsupportedKinds = (declared: unknown) => declared && { ...declared as object, kinds: {} }

/** Marks writes unsupported, and with `anonymous` everything that needs an account. */
export function restrict(spec: ProviderSpec, anonymous: boolean): ProviderSpec {
  let restricted: unknown = spec
  for (const entry of CAPABILITY_TABLE) {
    if (entry.spec && (entry.write || (anonymous && entry.account))) {
      restricted = update(restricted, entry.spec, entry.perKind ? unsupportedKinds : unsupported)
    }
  }
  const result = restricted as ProviderSpec
  return anonymous ? { ...result, traits: { ...result.traits, poll: false } } : result
}
