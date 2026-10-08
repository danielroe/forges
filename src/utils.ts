import type { ForgeErrorContext } from './errors.ts'
import type { Fetcher, FetchResult, PaginateOptions } from './fetch.ts'
import type { Actor, ChecksSummary, CheckState, Cursor, FileStatus, ForgeWarning, GetManyResult, ListOptions, Milestone, Page, PageOptions, RateLimit, ResolvedThreadRef, Review, ReviewState, Thread, ThreadRef } from './model.ts'
import type { ForgeIterable, MilestoneListOptions, TokenAuth } from './provider.ts'
import { ForgeApiError, UnresolvedThreadError, UnsupportedOperationError } from './errors.ts'
import { rateLimitOf } from './fetch.ts'
import { isResolvedThread } from './model.ts'

/**
 * Wraps a generator so warnings it reports are collected on the returned
 * iterable rather than interrupting iteration.
 */
export function forgeIterable<T>(run: (warn: (warning: ForgeWarning) => void) => AsyncIterable<T>): ForgeIterable<T> {
  const warnings: ForgeWarning[] = []
  return {
    warnings,
    [Symbol.asyncIterator]: () => run(warning => warnings.push(warning))[Symbol.asyncIterator](),
  }
}

/** Drives a `page()` function until it reports no further cursor, collecting page warnings. */
export function iteratePages<T, O extends { cursor?: Cursor } = ListOptions>(
  page: (options: O) => Promise<Page<T>>,
  options: O = {} as O,
): ForgeIterable<T> {
  return forgeIterable(async function* (warn) {
    let cursor: Cursor | undefined = options.cursor
    while (true) {
      const result: Page<T> = await page({ ...options, cursor })
      result.warnings?.forEach(warn)
      yield* result.items
      if ((!result.cursor?.nextUrl && !result.cursor?.token) || result.notModified) {
        return
      }
      cursor = result.cursor
    }
  })
}

/** Turns a caught error into a serialisable warning. */
export function toWarning(code: string, error: unknown, subject?: string): ForgeWarning {
  const err = error instanceof Error ? error : new Error(String(error))
  return {
    code,
    message: err.message,
    subject,
    cause: { name: err.name, message: err.message, status: err instanceof ForgeApiError ? err.status : undefined },
  }
}

/** Maps with at most `limit` calls in flight, preserving order. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }))
  return results
}

/** `threads.getMany` for forges without a batch endpoint. */
export function getManyConcurrently(
  refs: ThreadRef[],
  get: (ref: ThreadRef) => Promise<Thread>,
  limit = 4,
): Promise<GetManyResult[]> {
  return mapConcurrent(refs, limit, ref => get(ref).then(
    thread => ({ ok: true, ref, thread }),
    (error: unknown) => ({ ok: false, ref, warning: toWarning(error instanceof UnresolvedThreadError ? 'thread_unresolved' : 'thread_unreadable', error, ref.number) }),
  ))
}

/** Compares dotted numeric versions, ignoring any suffix after the numbers. */
export function versionAtLeast(version: string | undefined, minimum: string): boolean {
  if (!version) {
    return false
  }
  const parts = (value: string) => (/^\D*(\d+(?:\.\d+)*)/.exec(value)?.[1] ?? '0').split('.').map(Number)
  const [a, b] = [parts(version), parts(minimum)]
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) {
      return difference > 0
    }
  }
  return true
}

/** Reads a timestamp from a forge response, or `undefined` when it is empty or not a date. */
export function toDate(value: string | number | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** The host of `baseUrl`, including the port when there is one. */
export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host
}

/** Narrows a ref to one a provider can address, or throws {@link UnresolvedThreadError}. */
export function requireThread(ref: ThreadRef, context?: ForgeErrorContext): ResolvedThreadRef {
  if (ref.kind === 'other' || !isResolvedThread(ref)) {
    throw new UnresolvedThreadError(
      ref.kind === 'other'
        ? `${ref.typeRaw ?? 'This'} subject has no thread API`
        : 'Thread ref has no number; resolve it before calling the forge',
      context ?? { forge: ref.forge, instance: ref.instance },
    )
  }
  return ref
}

/**
 * Narrows a ref to an issue or pull request, or throws
 * {@link UnsupportedOperationError} naming the verb that needs one.
 */
export function requireIssueOrPull(ref: ThreadRef, context: ForgeErrorContext, verb: string): ResolvedThreadRef & { kind: 'issue' | 'pull_request' } {
  const thread = requireThread(ref, context)
  if (thread.kind !== 'issue' && thread.kind !== 'pull_request') {
    throw new UnsupportedOperationError(`${context.forge ?? 'This forge'} cannot ${verb} a ${thread.kind}`, context)
  }
  return thread as ResolvedThreadRef & { kind: 'issue' | 'pull_request' }
}

/** The token in `auth`, read again on every call when it is a function. */
export async function resolveToken(auth: TokenAuth): Promise<string> {
  return typeof auth.token === 'function' ? await auth.token() : auth.token
}

/**
 * The forge-native id `threads.setMilestone` sends: the milestone's `id`, a
 * string of digits as it is, or the id of the milestone with that title.
 */
export async function milestoneId(
  milestone: Milestone | string,
  page: (options: MilestoneListOptions) => Promise<Page<Milestone>>,
  context: ForgeErrorContext,
): Promise<number> {
  const value = typeof milestone === 'string' ? milestone : milestone.id
  if (/^\d+$/.test(value)) {
    return Number(value)
  }
  for await (const candidate of iteratePages(page, { state: 'all' })) {
    if (candidate.title === value) {
      return Number(candidate.id)
    }
  }
  throw new UnsupportedOperationError(`No milestone titled ${value}`, context)
}

/** A login from either a login string or an actor. */
export function actorLogin(actor: string | Actor): string {
  return typeof actor === 'string' ? actor : actor.login
}

/** Maps one fetched page into a {@link Page}. The cursor is kept only when there is a next page. */
export function toPage<R, T>(result: FetchResult<R[]>, map: (raw: R) => T | undefined, warnings?: ForgeWarning[]): Page<T> {
  return {
    items: (result.data ?? []).flatMap((raw) => {
      const item = map(raw)
      return item === undefined ? [] : [item]
    }),
    cursor: result.cursor?.nextUrl || result.cursor?.token ? result.cursor : undefined,
    notModified: result.notModified || undefined,
    ...warnings?.length ? { warnings } : {},
    ...rateLimitPart(result.response),
  }
}

/** Extra options for a listing: the query, how to select the items and map errors, and where to collect warnings. */
export interface ListingExtras extends Pick<PaginateOptions, 'query' | 'select' | 'mapError'> {
  /** Collects the non-fatal warnings of the listing. */
  warnings?: ForgeWarning[]
}

/** One page of `path` as the model, with `options` mapped onto the forge's page-size parameter. */
export type Listing = <R, T>(path: string, options: PageOptions, map: (raw: R) => T | undefined, extras?: ListingExtras) => Promise<Page<T>>

/** Builds a {@link Listing} for a forge that names its page-size parameter `pageParam`. */
export function createListing(fetcher: Fetcher, pageParam: string, defaultPerPage?: number): Listing {
  return async <R, T>(path: string, options: PageOptions, map: (raw: R) => T | undefined, { warnings, query, ...extras }: ListingExtras = {}) => toPage(
    await fetcher.page<R>(path, { ...extras, query: { ...query, [pageParam]: options.perPage ?? defaultPerPage }, cursor: options.cursor, signal: options.signal }),
    map,
    warnings,
  )
}

function rateLimitPart(response: Response | undefined): { rateLimit?: RateLimit } {
  const rateLimit = response && rateLimitOf(response)
  return rateLimit ? { rateLimit } : {}
}

/**
 * Chains listings that a forge serves from separate endpoints. The cursor
 * `token` records which phase is next, ahead of the phase's own token.
 */
export async function phased<T>(phases: Array<(cursor?: Cursor) => Promise<Page<T>>>, cursor?: Cursor): Promise<Page<T>> {
  const match = /^(\d+):(.*)$/s.exec(cursor?.token ?? '')
  const index = match ? Number(match[1]) : 0
  const inner = cursor && (cursor.nextUrl || match?.[2]) ? { ...cursor, token: match?.[2] || undefined } : undefined
  const page = await phases[index]!(inner)
  if (page.cursor) {
    return { ...page, cursor: { ...page.cursor, token: `${index}:${page.cursor.token ?? ''}` } }
  }
  return index + 1 < phases.length ? { ...page, cursor: { token: `${index + 1}:` } } : page
}

/** Whether `labels` include every name in `wanted`; true when nothing is wanted. */
export function hasEveryLabel(labels: ReadonlyArray<{ name: string }> | undefined, wanted: readonly string[] | undefined): boolean {
  return !wanted?.length || wanted.every(name => labels?.some(label => label.name === name))
}

/** Any failure fails, else any pending is pending, else any unknown (or none at all) is unknown, else success. */
export function summariseChecks(states: CheckState[], url?: string): ChecksSummary {
  const failed = states.filter(state => state === 'failure').length
  const state = failed
    ? 'failure'
    : states.includes('pending')
      ? 'pending'
      : !states.length || states.includes('unknown') ? 'unknown' : 'success'
  return { state, total: states.length, failed, ...url ? { url } : {} }
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])

/**
 * State of a check run reported as a status plus a conclusion once completed.
 * Cancelled, timed-out, action-required and startup failures count as
 * failures; skipped and neutral runs as neutral.
 */
export function checkRunState(status: string, conclusion?: string | null): CheckState {
  if (status !== 'completed') {
    return 'pending'
  }
  if (conclusion === 'success') {
    return 'success'
  }
  if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) {
    return 'failure'
  }
  return conclusion === 'neutral' || conclusion === 'skipped' ? 'neutral' : 'unknown'
}

/** Maps a forge's own file-change word onto {@link FileStatus}; unknown words become `'changed'`. */
export function toFileStatus(raw: string | undefined | null): FileStatus {
  switch (raw?.toLowerCase()) {
    case 'added':
    case 'new':
    case 'add':
      return 'added'
    case 'removed':
    case 'deleted':
    case 'remove':
      return 'removed'
    case 'renamed':
    case 'rename':
      return 'renamed'
    case 'copied':
    case 'copy':
      return 'copied'
    case 'modified':
    case 'edit':
    case 'change':
      return 'modified'
    default:
      return 'changed'
  }
}

/**
 * Caches the result of `load` after its first call. A rejected load is
 * forgotten so the next call retries; with `ttl` (milliseconds) a resolved
 * value is reloaded once it is older than that.
 */
export function memo<T>(load: () => Promise<T>, ttl?: number): () => Promise<T> {
  let cached: { promise: Promise<T>, at: number } | undefined
  return () => {
    if (!cached || (ttl !== undefined && Date.now() - cached.at > ttl)) {
      const promise = load()
      cached = { promise, at: Date.now() }
      promise.catch(() => {
        if (cached?.promise === promise) {
          cached = undefined
        }
      })
    }
    return cached.promise
  }
}

/** {@link memo} per key. */
export function memoBy<K, T>(load: (key: K) => Promise<T>): (key: K) => Promise<T> {
  const cache = new Map<K, () => Promise<T>>()
  return (key) => {
    let entry = cache.get(key)
    if (!entry) {
      entry = memo(() => load(key))
      cache.set(key, entry)
    }
    return entry()
  }
}

/**
 * A review standing in for an approval, vote or participant state on a forge
 * that has no review objects. `comments` is `false` because there is nothing
 * to hang inline comments on.
 */
export function syntheticReview(thread: ResolvedThreadRef, id: string, state: ReviewState, extras: { author?: Actor, stateRaw?: string, submittedAt?: Date, raw: unknown }): Review {
  const { author, stateRaw, submittedAt, raw } = extras
  return { ref: { forge: thread.forge, instance: thread.instance, thread, id }, author, state, stateRaw, submittedAt, comments: false, raw }
}

/** A label colour as six hex digits, with the `#` prefix the forge expects. `ededed` when none is given. */
export function hexColour(colour: string | undefined, prefix: '#' | '' = ''): string {
  return `${prefix}${(colour ?? 'ededed').replace(/^#/, '')}`
}
