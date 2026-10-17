import type { BaseOptions, Comment, CommitComment, CommitRef, ThreadRef } from './model.ts'
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
