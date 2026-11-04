import type { Fetcher } from '../fetch.ts'
import type { GitHubIssue } from '../github/types.ts'
import type { BaseOptions, ForgeOrigin, Label, ThreadRef } from '../model.ts'
import { toLabels } from '../github/normalise.ts'
import { requireIssueOrPull } from '../utils.ts'

/**
 * Label writes that send each label once and read the thread's labels around
 * each change: GitBucket fails with a `500` when it adds a label the thread
 * already has, and responds to an addition or removal with only the labels it touched.
 */
export function labelWrites(fetcher: Fetcher, origin: ForgeOrigin) {
  const path = (thread: ThreadRef) => {
    const ref = requireIssueOrPull(thread, origin, 'label')
    return `/repos/${encodeURIComponent(ref.repo.owner)}/${encodeURIComponent(ref.repo.name)}/issues/${encodeURIComponent(ref.number)}/labels`
  }
  const labelsOf = async (labels: string, options?: BaseOptions): Promise<Label[]> => toLabels((await fetcher.json<GitHubIssue['labels']>(labels, { signal: options?.signal })).data)
  return {
    setLabels: async (thread: ThreadRef, labels: string[], options?: BaseOptions): Promise<Label[]> => toLabels((await fetcher.json<GitHubIssue['labels']>(path(thread), { method: 'PUT', json: { labels: [...new Set(labels)] }, signal: options?.signal })).data),
    addLabels: async (thread: ThreadRef, labels: string[], options?: BaseOptions): Promise<Label[]> => {
      const labelsPath = path(thread)
      const current = await labelsOf(labelsPath, options)
      const missing = [...new Set(labels)].filter(label => !current.some(item => item.name === label))
      if (!missing.length) {
        return current
      }
      await fetcher.raw(labelsPath, { method: 'POST', json: { labels: missing }, signal: options?.signal })
      return labelsOf(labelsPath, options)
    },
    removeLabels: async (thread: ThreadRef, labels: string[], options?: BaseOptions): Promise<Label[]> => {
      const labelsPath = path(thread)
      const current = await labelsOf(labelsPath, options)
      const present = [...new Set(labels)].filter(label => current.some(item => item.name === label))
      if (!present.length) {
        return current
      }
      for (const label of present) {
        await fetcher.raw(`${labelsPath}/${encodeURIComponent(label)}`, { method: 'DELETE', signal: options?.signal })
      }
      return labelsOf(labelsPath, options)
    },
  }
}
