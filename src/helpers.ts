import type { BaseOptions, Comment, ThreadRef } from './model.ts'
import type { ForgeProvider } from './provider.ts'

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
export interface UpsertCommentResult {
  /** The comment that was created or edited. */
  comment: Comment
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
 * `body` with the marker for `key` at the end, unless it carries it already. Post it with `threads.comment()` so that
 * {@link upsertComment} with the same key edits that comment instead of posting another.
 * @example
 * ```ts
 * await provider.threads.comment(ref, withCommentMarker('Deployed to staging', mutationId))
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
 * of the thread on every call, which `since` bounds, so the provider needs `threads.comments()`, `threads.comment()`
 * and `threads.editComment()` for the kind of thread.
 * @param provider The provider to comment with.
 * @param ref The thread to comment on.
 * @param input The `key` that identifies the comment across runs, its `body`, and `since` to look at recent comments only.
 * @example
 * ```ts
 * import { upsertComment } from 'forges/helpers'
 *
 * await upsertComment(provider, ref, { key: 'preview', body: 'Preview: https://pr-42.example.com' })
 * ```
 */
export async function upsertComment(provider: ForgeProvider, ref: ThreadRef, input: UpsertCommentInput, options?: BaseOptions): Promise<UpsertCommentResult> {
  const body = withCommentMarker(input.body, input.key)
  let existing: Comment | undefined
  for await (const candidate of provider.threads.comments(ref, { ...options, since: input.since })) {
    if (hasCommentMarker(candidate.body, input.key)) {
      existing = candidate
    }
  }
  if (!existing) {
    return { comment: await provider.threads.comment(ref, body, options), created: true }
  }
  return {
    comment: sameBody(existing.body, body) ? existing : await provider.threads.editComment(existing.ref, body, options),
    created: false,
  }
}
