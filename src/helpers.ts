import type { BaseOptions, Check, ChecksSummary, Comment, CommitComment, CommitRef, ForgeWarning, Page, RepoRef, ThreadRef } from './model.ts'
import type { ForgeProvider } from './provider.ts'
import { sleep } from './fetch.ts'
import { summariseChecks } from './utils.ts'

/** What {@link upsertComment} needs. */
export interface UpsertCommentInput {
  /**
   * Identifies the comment to replace across runs. It is written into the
   * body as an HTML comment, so it is invisible when rendered but matchable
   * on the next run.
   */
  key: string
  body: string
  /**
   * Only comments updated at or after this time are searched for the key. When retrying a change, pass the time of its
   * first attempt, less a margin for clock skew, so the retry lists only recent comments. A comment with the same key
   * from before `since` is not found, and a new one is created.
   */
  since?: Date
}

/** What {@link upsertComment} did. */
export interface UpsertCommentResult<T extends Comment | CommitComment = Comment> {
  /** The comment that was created or edited. */
  comment: T
  /** `false` when a comment with the same key already existed, and was edited or already had the body. */
  created: boolean
}

/**
 * The hidden marker that {@link upsertComment} writes into a comment body to
 * find it again. It renders as nothing on every forge that renders Markdown
 * as HTML.
 */
export function commentMarker(key: string): string {
  const end = ['-->', '--!>'].find(token => key.includes(token))
  if (end) {
    throw new TypeError(`Comment key ${JSON.stringify(key)} contains \`${end}\`, which would end the hidden marker early`)
  }
  return `<!-- forges:key=${key} -->`
}

/** Whether `body` carries the marker for `key`. */
export function hasCommentMarker(body: string, key: string): boolean {
  return body.includes(commentMarker(key))
}

/**
 * `body` with the marker for `key` at the end, unless it carries it already. Post it with `threads.createComment()` so that
 * {@link upsertComment} with the same key edits that comment instead of posting another.
 * @example
 * ```ts
 * await provider.threads.createComment(ref, withCommentMarker('Deployed to staging', mutationId))
 * ```
 */
export function withCommentMarker(body: string, key: string): string {
  return hasCommentMarker(body, key) ? body : `${body}\n\n${commentMarker(key)}`
}

function sameBody(a: string, b: string): boolean {
  const normalise = (body: string) => body.replaceAll('\r\n', '\n').trim()
  return normalise(a) === normalise(b)
}

/**
 * Creates the comment, or edits the one an earlier call with the same `key` left behind, unless that one already has
 * the same body. The key is carried in the body as a hidden marker; see {@link commentMarker}. It lists the comments
 * of the thread on every call, which `since` bounds, so the provider needs `threads.comments()`, `threads.createComment()`
 * and `threads.updateComment()` for the kind of thread. On a commit it uses `commits.comments()`, `commits.createComment()`
 * and `commits.updateComment()`, and reads every comment of the commit.
 * @param provider The provider to comment with.
 * @param ref The thread or commit to comment on.
 * @param input The `key` that identifies the comment across runs, its `body`, and `since` to look at recent comments only.
 * @example
 * ```ts
 * import { upsertComment } from 'forges/helpers'
 *
 * await upsertComment(provider, ref, { key: 'preview', body: 'Preview: https://pr-42.example.com' })
 * ```
 */
export async function upsertComment(provider: ForgeProvider, ref: CommitRef, input: UpsertCommentInput, options?: BaseOptions): Promise<UpsertCommentResult<CommitComment>>
export async function upsertComment(provider: ForgeProvider, ref: ThreadRef, input: UpsertCommentInput, options?: BaseOptions): Promise<UpsertCommentResult>
export async function upsertComment(provider: ForgeProvider, ref: ThreadRef | CommitRef, input: UpsertCommentInput, options?: BaseOptions): Promise<UpsertCommentResult<Comment | CommitComment>> {
  const body = withCommentMarker(input.body, input.key)
  if ('sha' in ref) {
    let existing: CommitComment | undefined
    for await (const candidate of provider.commits.comments(ref, options)) {
      const at = candidate.updatedAt ?? candidate.createdAt
      if (hasCommentMarker(candidate.body, input.key) && (!input.since || !at || at >= input.since)) {
        existing = candidate
      }
    }
    if (!existing) {
      return { comment: await provider.commits.createComment(ref, body, options), created: true }
    }
    return {
      comment: sameBody(existing.body, body) ? existing : await provider.commits.updateComment(existing.ref, body, options),
      created: false,
    }
  }
  let existing: Comment | undefined
  for await (const candidate of provider.threads.comments(ref, { ...options, since: input.since })) {
    if (hasCommentMarker(candidate.body, input.key)) {
      existing = candidate
    }
  }
  if (!existing) {
    return { comment: await provider.threads.createComment(ref, body, options), created: true }
  }
  return {
    comment: sameBody(existing.body, body) ? existing : await provider.threads.updateComment(existing.ref, body, options),
    created: false,
  }
}

/** Options for {@link waitForChecks}. */
export interface WaitForChecksOptions extends BaseOptions {
  /** Milliseconds before it gives up. `Infinity` waits for good. @default 600000 */
  timeout?: number
  /** Milliseconds between reads. Each read is a `checks.list()`, so mind the rate limit. @default 15000 */
  interval?: number
}

/** What {@link waitForChecks} found on its last read. */
export interface WaitForChecksResult {
  /** Time ran out with checks still running, or with none at all. */
  timedOut: boolean
  /**
   * Summed up like `Thread.checks`: `failure` when any check failed, even if others are still pending at the timeout,
   * and `unknown` when the commit has no checks.
   */
  state: ChecksSummary['state']
  /** Every check from the last read. */
  checks: Check[]
  /** The checks from the last read that were still running. */
  pending: Check[]
  /** Sources the last read could not reach, whose checks are missing from `checks` and `state`. */
  warnings?: ForgeWarning[]
}

/** Anything longer and `setTimeout()` fires right away. */
const MAX_TIMER = 2 ** 31 - 1

function assertTimings(timeout: number, interval: number): void {
  if (Number.isNaN(timeout) || timeout < 0) {
    throw new TypeError('`timeout` must be zero or more milliseconds')
  }
  if (Number.isNaN(interval) || interval <= 0 || interval > MAX_TIMER) {
    throw new TypeError(`\`interval\` must be a positive number of milliseconds, at most ${MAX_TIMER}`)
  }
}

function waitResult({ items, warnings }: Page<Check>, timedOut: boolean): WaitForChecksResult {
  return {
    timedOut,
    state: summariseChecks(items.map(check => check.state)).state,
    checks: items,
    pending: items.filter(check => check.state === 'pending'),
    ...warnings?.length ? { warnings } : {},
  }
}

/**
 * Polls `checks.list()` until every check on the commit has finished, or `timeout` runs out. No checks yet counts as
 * pending, and `neutral` or `unknown` as finished; a failure does not end the wait. It sees only the checks a read
 * returns, so a check that registers late, or one that a read with `warnings` leaves out, can still be running.
 * @param provider The provider to read the checks with.
 * @param repo The repository of the commit.
 * @param sha The commit to wait for.
 * @param options The `timeout`, the `interval` between reads, and a `signal` to stop waiting.
 * @example
 * ```ts
 * import { waitForChecks } from 'forges/helpers'
 *
 * const { state, timedOut, warnings } = await waitForChecks(provider, repo, sha)
 * ```
 */
export async function waitForChecks(provider: ForgeProvider, repo: RepoRef, sha: string, options: WaitForChecksOptions = {}): Promise<WaitForChecksResult> {
  const { timeout = 600_000, interval = 15_000, signal } = options
  assertTimings(timeout, interval)
  const deadline = Date.now() + timeout
  while (true) {
    const page = await provider.checks.list(repo, sha, { signal })
    const done = page.items.length > 0 && page.items.every(check => check.state !== 'pending')
    const left = deadline - Date.now()
    if (done || left <= 0) {
      return waitResult(page, !done)
    }
    await sleep(Math.min(interval, left), signal)
  }
}
