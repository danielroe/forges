import type { EventFeedOptions, ForgeEventInput, Page, SourceKind } from '../model.ts'
import type { ActivityRecord } from './normalise.ts'
import type { TangledRecord } from './types.ts'
import { sha256Hex } from '../crypto.ts'
import { mapConcurrent } from '../utils.ts'
import { parseAtUri } from './atproto.ts'
import { COLLECTIONS } from './normalise.ts'

/** The collections the index lists by author. */
const FEED_COLLECTIONS = [
  COLLECTIONS.ticket,
  COLLECTIONS.comment,
  COLLECTIONS.reaction,
] as const

export type FeedCollection = typeof FEED_COLLECTIONS[number]

/** How many records each collection that has more has given the feed so far. */
type Positions = Partial<Record<FeedCollection, number>>

export interface AccountFeedContext {
  /** The records of `collection` that `did` authored, newest first, from `offset`. */
  listActivity: (collection: FeedCollection, options: { limit: number, offset: number, signal?: AbortSignal }) => Promise<Array<{ uri: string, cid?: string, value?: unknown }>>
  recordEvent: (activity: ActivityRecord, source: SourceKind, fallbackTime: Date, signal?: AbortSignal) => Promise<ForgeEventInput>
}

/**
 * One page of what an account did, read from the collections the index lists
 * by author and merged by record key, which orders records by when they were
 * created. The first page's `etag` digests the records on it, so a page that
 * only repeats it resolves as not modified.
 */
export async function accountFeedPage({ listActivity, recordEvent }: AccountFeedContext, did: string, options: EventFeedOptions = {}): Promise<Page<ForgeEventInput>> {
  const limit = Math.min(options.perPage ?? 30, 100)
  const signal = options.signal
  const positions: Positions = options.cursor?.token
    ? JSON.parse(options.cursor.token) as Positions
    : Object.fromEntries(FEED_COLLECTIONS.map(collection => [collection, 0]))
  const listings = await Promise.all((Object.entries(positions) as Array<[FeedCollection, number]>).map(async ([collection, offset]) => ({
    collection,
    offset,
    records: await listActivity(collection, { limit, offset, signal }),
  })))
  const merged = listings
    .flatMap(({ collection, records }) => records.map(record => ({ collection, record, rkey: parseAtUri(record.uri)?.rkey ?? '' })))
    .sort((a, b) => a.rkey < b.rkey
      ? 1
      : a.rkey > b.rkey
        ? -1
        : 0)
    .slice(0, limit)
  const next: Positions = {}
  for (const { collection, offset, records } of listings) {
    const taken = merged.filter(item => item.collection === collection).length
    if (records.length === limit || taken < records.length) {
      next[collection] = offset + taken
    }
  }
  let etag: string | undefined
  if (!options.cursor?.token) {
    const digest = (await sha256Hex(merged.map(({ record }) => `${record.uri} ${record.cid ?? ''}`).join('\n'))).slice(0, 16)
    etag = digest
    if (digest === options.cursor?.etag) {
      return { items: [], notModified: true, etag }
    }
  }
  const items = await mapConcurrent(merged, 4, ({ collection, record }) =>
    recordEvent({
      uri: record.uri,
      collection,
      record: record.value as TangledRecord,
      operation: 'create',
    }, 'poll', new Date(), signal))
  return {
    items,
    ...Object.keys(next).length
      ? {
          cursor: {
            token: JSON.stringify(next),
          },
        }
      : {},
    ...etag
      ? { etag }
      : {},
  }
}
