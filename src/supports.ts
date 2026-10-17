import type { ForgeVerb } from './capability-table.ts'
import type { SecurityAlertKind, Support, ThreadKind } from './model.ts'
import type { ForgeCapabilities } from './provider.ts'
import { CAPABILITY_TABLE } from './capability-table.ts'
import { isUnsupported } from './model.ts'

export type { ForgeVerb }

const VERBS = new Set<string>(CAPABILITY_TABLE.flatMap(entry => entry.verbs ?? []))

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
  return !isUnsupported(support(capabilities, verb, kind))
}

/** Levels from strongest to weakest, as the capability matrix ranks them. */
const LEVELS: Support[] = [true, 'emulated']

/**
 * How well `verb` is supported according to `capabilities`: `true`,
 * `'emulated'`, `'not_applicable'` or `false`, for `kind` where support differs
 * by thread kind (or by alert kind for `securityAlerts`). Without `kind`, a
 * per-kind verb reports its strongest available level, or `'not_applicable'`
 * when no kind is available and any kind is, else `false`.
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
  return LEVELS.find(level => levels.includes(level)) ?? (levels.includes('not_applicable') ? 'not_applicable' : false)
}

/** The capability entry behind `verb`: one support level, or one per kind. */
export function capabilityOf(capabilities: ForgeCapabilities, verb: ForgeVerb): Support | Record<string, Support> {
  if (!VERBS.has(verb)) {
    throw new TypeError(`Unknown verb ${JSON.stringify(verb)}; verbs are named by their path on the provider, such as 'threads.createComment'`)
  }
  return verb.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], capabilities) as Support | Record<string, Support>
}
