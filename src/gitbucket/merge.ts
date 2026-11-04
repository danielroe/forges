import type { Fetcher } from '../fetch.ts'
import type { ForgeOrigin, MergeMethod, MergeOptions, MergeResult, ThreadRef } from '../model.ts'
import { ForgeApiError, toMergeError, UnsupportedOperationError } from '../errors.ts'
import { requireThread } from '../utils.ts'

/** GitBucket's names for the merge methods it has; without one, it makes a merge commit. */
const STRATEGIES: Partial<Record<MergeMethod, string>> = { merge: 'merge-commit', squash: 'squash', rebase: 'rebase' }

/** What GitBucket sends for a merge: the outcome, with its real status and body inside an HTTP `200`. */
interface MergeEnvelope {
  status?: number
  body?: string
}

/**
 * Merges through `PUT /pulls/{number}/merge`. GitBucket responds with HTTP
 * `200` whether or not the merge happened, so the status inside the response
 * decides the outcome.
 */
export function mergePull(fetcher: Fetcher, origin: ForgeOrigin) {
  return async (thread: ThreadRef, options: MergeOptions = {}): Promise<MergeResult> => {
    const ref = requireThread(thread, origin)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError('Only pull requests can be merged', origin)
    }
    if (options.whenChecksPass) {
      throw new UnsupportedOperationError('GitBucket has no auto-merge', origin)
    }
    if (options.sha) {
      throw new UnsupportedOperationError('GitBucket merges whatever the head is, so `sha` is unsupported; read the pull request first if it matters', origin)
    }
    const strategy = options.method && STRATEGIES[options.method]
    if (options.method && !strategy) {
      throw new UnsupportedOperationError(`GitBucket does not support the ${options.method} merge method`, origin)
    }
    // GitBucket heads the commit message with a title of its own, so `title` joins the message below it.
    const message = [options.title, options.message].filter(Boolean).join('\n\n')
    const path = `/repos/${encodeURIComponent(ref.repo.owner)}/${encodeURIComponent(ref.repo.name)}/pulls/${encodeURIComponent(ref.number)}/merge`
    const { data } = await fetcher.json<MergeEnvelope>(path, {
      method: 'PUT',
      json: { merge_method: strategy, commit_message: message || undefined },
      mapError: toMergeError,
      signal: options.signal,
    })
    const status = data.status ?? 200
    if (status >= 300) {
      let message = `GitBucket did not merge pull request ${ref.number}`
      try {
        message = (JSON.parse(data.body ?? '') as { message?: string }).message ?? message
      }
      catch {}
      throw toMergeError(new ForgeApiError(message, status, data.body ?? '', {
        ...origin,
        url: fetcher.resolve(path),
        method: 'PUT',
      }))
    }
    // The body names the merge commit as `MergeResult(AnyObjectId[<sha>],...)`.
    const sha = /AnyObjectId\[([0-9a-f]{40})\]/.exec(data.body ?? '')?.[1]
    return {
      status: 'merged',
      ...sha && { sha },
      raw: data,
    }
  }
}
