import type { Fetcher, FetchResult, PaginateOptions } from '../fetch.ts'
import type { Cursor } from '../model.ts'

/** A full page is followed even when `x-total-count` disagrees, because timelines report the page's own length. */
export function countedNextUrl(url: string, count: number, totalHeader: string | null): string | undefined {
  const next = new URL(url)
  const page = Number(next.searchParams.get('page')) || 1
  const limit = Number(next.searchParams.get('limit')) || undefined
  if (count === 0 || (limit !== undefined && count > limit)) {
    return undefined
  }
  const size = limit ?? count
  const total = totalHeader === null ? Number.NaN : Number(totalHeader)
  const remaining = Number.isFinite(total) && (page - 1) * size + count < total
  if (!remaining && count !== limit) {
    return undefined
  }
  next.searchParams.set('page', String(page + 1))
  next.searchParams.set('limit', String(Math.min(count, size)))
  return next.toString()
}

/** `fetcher` with `page` and `items` that also continue listings Forgejo and Gitea page without a `Link` header. */
export function countedPages(fetcher: Fetcher): Fetcher {
  async function page<T>(path: string, options: PaginateOptions & { cursor?: Cursor } = {}): Promise<FetchResult<T[]>> {
    const result = await fetcher.page<T>(path, options)
    if (result.cursor?.nextUrl || result.notModified) {
      return result
    }
    const url = options.cursor?.nextUrl ? fetcher.resolve(options.cursor.nextUrl) : fetcher.resolve(path, options.query)
    const nextUrl = countedNextUrl(url, result.data.length, result.response.headers.get('x-total-count'))
    return nextUrl ? { ...result, cursor: { ...result.cursor, nextUrl } } : result
  }

  async function* items<T>(path: string, options: PaginateOptions = {}): AsyncGenerator<T> {
    let cursor: Cursor | undefined
    do {
      const result: FetchResult<T[]> = await page<T>(path, { ...options, cursor })
      yield* result.data
      cursor = result.notModified ? undefined : result.cursor
    } while (cursor?.nextUrl)
  }

  return { ...fetcher, page, items }
}
