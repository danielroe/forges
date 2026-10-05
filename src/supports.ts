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
 */
export function supports(capabilities: ForgeCapabilities, verb: ForgeVerb, kind?: ThreadKind | SecurityAlertKind): boolean {
  const support = capabilityOf(capabilities, verb)
  if (typeof support !== 'object') {
    return support !== false
  }
  return kind ? (support[kind] ?? false) !== false : Object.values(support).some(value => value !== false)
}

/** The capability entry behind `verb`: one support level, or one per kind. */
export function capabilityOf(capabilities: ForgeCapabilities, verb: ForgeVerb): Support | Record<string, Support> {
  const capability = VERBS.get(verb)
  if (!capability) {
    throw new TypeError(`Unknown verb ${JSON.stringify(verb)}; verbs are named by their path on the provider, such as 'threads.comment'`)
  }
  return capability.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], capabilities) as Support | Record<string, Support>
}
