import type { EventFeedOptions, ForgeEventInput, Page, ResolvedThreadRef, SourceKind } from '../model.ts'
import type { AtprotoClient } from './atproto.ts'
import type { ActivityRecord } from './normalise.ts'
import type { RecordResponse } from './types.ts'
import { mapConcurrent } from '../utils.ts'
import { parseAtUri } from './atproto.ts'
import { THREAD_COLLECTIONS } from './normalise.ts'

export interface AccountFeedContext {
  atproto: AtprotoClient
  recordEvent: (activity: ActivityRecord, source: SourceKind, fallbackTime: Date, threads: Map<string, Promise<ResolvedThreadRef | undefined>>, signal?: AbortSignal) => Promise<ForgeEventInput>
}

/** Where each collection's listing continues, by record key; `''` starts from the newest record. */
type Positions = Record<string, string>

/**
 * One page of what an account did, read from the thread collections of its
 * repository and merged by record key, which orders records by when they
 * were created. The first page carries the repository's revision as its
 * `etag`; an unchanged revision means no record was written since.
 */
export async function accountFeedPage({ atproto, recordEvent }: AccountFeedContext, did: string, options: EventFeedOptions = {}): Promise<Page<ForgeEventInput>> {
  const limit = Math.min(options.perPage ?? 30, 100)
  const signal = options.signal
  let positions: Positions
  let etag: string | undefined
  if (options.cursor?.token) {
    positions = JSON.parse(options.cursor.token) as Positions
  }
  else {
    etag = await atproto.revisionOf(did, signal)
    if (etag === options.cursor?.etag) {
      return { items: [], notModified: true, etag }
    }
    const held = new Set(await atproto.collectionsOf(did, signal))
    positions = Object.fromEntries(THREAD_COLLECTIONS.filter(collection => held.has(collection)).map(collection => [collection, '']))
  }
  const listings = await Promise.all(Object.entries(positions).map(async ([collection, cursor]) => ({
    collection,
    records: await atproto.listRecordsPage(did, collection, { limit, cursor: cursor || undefined, signal }),
  })))
  const merged = listings
    .flatMap(({ collection, records }) => records.map(record => ({ collection, record, rkey: parseAtUri(record.uri)?.rkey ?? '' })))
    .sort((a, b) => a.rkey < b.rkey ? 1 : a.rkey > b.rkey ? -1 : 0)
    .slice(0, limit)
  const next: Positions = {}
  for (const { collection, records } of listings) {
    const taken = merged.filter(item => item.collection === collection)
    if (records.length === limit || taken.length < records.length) {
      next[collection] = taken.at(-1)?.rkey ?? positions[collection]!
    }
  }
  const threads = new Map<string, Promise<ResolvedThreadRef | undefined>>()
  const items = await mapConcurrent(merged, 4, ({ collection, record }: { collection: string, record: RecordResponse }) =>
    recordEvent({ uri: record.uri, collection, record: record.value, operation: 'create' }, 'poll', new Date(), threads, signal))
  return {
    items,
    ...Object.keys(next).length ? { cursor: { token: JSON.stringify(next) } } : {},
    ...etag ? { etag } : {},
  }
}
