import type { ForgeVerb } from './capability-table.ts'
import type { SecurityAlertKind, Support, ThreadKind } from './model.ts'
import type { ForgeCapabilities } from './provider.ts'
import { CAPABILITY_TABLE } from './capability-table.ts'

export type { ForgeVerb }

/** Where each verb's support lives in {@link ForgeCapabilities}, from {@link CAPABILITY_TABLE}. */
const VERBS = new Map<string, string>(
  CAPABILITY_TABLE.flatMap(entry => (entry.verbs ?? []).map(verb => [verb, entry.capability] as const)),
)

/**
 * Whether `verb` is supported according to `capabilities`, for `kind` where
 * support differs by thread kind (or by alert kind for `securityAlerts`).
 * Without `kind`, a per-kind verb counts as supported when any kind is.
 * @param capabilities The capabilities of a provider, such as `provider.capabilities`.
 * @param verb The operation, named by its path on the provider, such as `threads.createComment`.
 * @param kind The thread or alert kind, for an operation whose support differs by kind.
 * @example
 * ```ts
 * if (can(provider.capabilities, 'threads.merge')) {
 *   await provider.threads.merge(ref)
 * }
 * ```
 */
export function can(capabilities: ForgeCapabilities, verb: ForgeVerb, kind?: ThreadKind | SecurityAlertKind): boolean {
  return support(capabilities, verb, kind) !== false
}

/** Levels from strongest to weakest, as the capability matrix ranks them. */
const LEVELS: Support[] = [true, 'emulated']

/**
 * How well `verb` is supported according to `capabilities`: `true`,
 * `'emulated'` or `false`, for `kind` where support differs
 * by thread kind (or by alert kind for `securityAlerts`). Without `kind`, a
 * per-kind verb reports its strongest level across kinds.
 * @param capabilities The capabilities of a provider, such as `provider.capabilities`.
 * @param verb The operation, named by its path on the provider, such as `threads.createComment`.
 * @param kind The thread or alert kind, for an operation whose support differs by kind.
 */
export function support(capabilities: ForgeCapabilities, verb: ForgeVerb, kind?: ThreadKind | SecurityAlertKind): Support {
  const declared = capabilityOf(capabilities, verb)
  if (typeof declared !== 'object') {
    return declared
  }
  if (kind) {
    return declared[kind] ?? false
  }
  const levels = Object.values(declared)
  return LEVELS.find(level => levels.includes(level)) ?? false
}

/** The capability entry behind `verb`: one support level, or one per kind. */
export function capabilityOf(capabilities: ForgeCapabilities, verb: ForgeVerb): Support | Record<string, Support> {
  const capability = VERBS.get(verb)
  if (!capability) {
    throw new TypeError(`Unknown verb ${JSON.stringify(verb)}; verbs are named by their path on the provider, such as 'threads.createComment'`)
  }
  return capability.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], capabilities) as Support | Record<string, Support>
}
