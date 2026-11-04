import type { Fetcher } from '../fetch.ts'
import type { GitHubIssue } from '../github/types.ts'
import type { BaseOptions, ForgeOrigin, Label, ThreadRef } from '../model.ts'
import { NotFoundError } from '../errors.ts'
import { toLabels } from '../github/normalise.ts'
import { requireIssueOrPull } from '../utils.ts'

/** Adds and removes labels, then reads what is left, since GitBucket answers with only the labels a write touched. */
export function labelWrites(fetcher: Fetcher, origin: ForgeOrigin) {
  const path = (thread: ThreadRef) => {
    const ref = requireIssueOrPull(thread, origin, 'label')
    return `/repos/${encodeURIComponent(ref.repo.owner)}/${encodeURIComponent(ref.repo.name)}/issues/${encodeURIComponent(ref.number)}/labels`
  }
  const labelsOf = async (labels: string, options?: BaseOptions): Promise<Label[]> => toLabels((await fetcher.json<GitHubIssue['labels']>(labels, { signal: options?.signal })).data)
  return {
    addLabels: async (thread: ThreadRef, labels: string[], options?: BaseOptions): Promise<Label[]> => {
      const labelsPath = path(thread)
      await fetcher.raw(labelsPath, { method: 'POST', json: { labels }, signal: options?.signal })
      return labelsOf(labelsPath, options)
    },
    removeLabels: async (thread: ThreadRef, labels: string[], options?: BaseOptions): Promise<Label[]> => {
      const labelsPath = path(thread)
      for (const label of labels) {
        try {
          await fetcher.raw(`${labelsPath}/${encodeURIComponent(label)}`, { method: 'DELETE', signal: options?.signal })
        }
        catch (error) {
          // GitBucket answers 404 for a label the repository doesn't have, which can't be on the thread either.
          if (!(error instanceof NotFoundError)) {
            throw error
          }
        }
      }
      return labelsOf(labelsPath, options)
    },
  }
}
