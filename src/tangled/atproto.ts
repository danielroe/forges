import type { Fetcher } from '../fetch.ts'
import type { BacklinksResponse, DidDocument, RecordResponse, TangledRecord } from './types.ts'
import { ForgeApiError, ForgeError, NotFoundError } from '../errors.ts'

export interface AtUri {
  did: string
  collection: string
  rkey: string
}

export function parseAtUri(uri: string): AtUri | undefined {
  const match = /^at:\/\/(did:[^/]+)\/([^/]+)\/([^/?#]+)$/.exec(uri)
  return match ? { did: match[1]!, collection: match[2]!, rkey: match[3]! } : undefined
}

export function atUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}

export interface Identity {
  did: string
  pds?: string
  handle?: string
}

export interface AtprotoClient {
  resolveDid: (did: string) => Promise<Identity>
  /** The DID a handle names, checked against the handle the DID document claims. */
  resolveHandle: (handle: string) => Promise<string>
  getRecord: <T extends TangledRecord = TangledRecord>(uri: string) => Promise<RecordResponse<T>>
  /** Every record in one collection of an account's repository, from its PDS. */
  listRecords: <T extends TangledRecord = TangledRecord>(did: string, collection: string) => AsyncGenerator<RecordResponse<T>>
  /** Every record in `collection` whose `path` field points at `target`. */
  backlinks: (target: string, collection: string, path: string) => AsyncGenerator<AtUri>
}

export interface AtprotoClientOptions {
  fetcher: Fetcher
  plcUrl: string
  backlinksUrl: string
  /** Serves `com.atproto.identity.resolveHandle`. */
  handleResolverUrl: string
  /** Slingshot-compatible record cache. When absent, records are read from each author's PDS. */
  recordsUrl?: string
  context: { forge: string, instance: string }
}

/**
 * Resolves identities and reads records straight from each author's PDS.
 * Backlinks come from a Constellation-compatible index, since no PDS can
 * list the records that point at a given one.
 */
export function createAtprotoClient(options: AtprotoClientOptions): AtprotoClient {
  const identities = new Map<string, Promise<Identity>>()

  function resolveDid(did: string): Promise<Identity> {
    let identity = identities.get(did)
    if (!identity) {
      const url = did.startsWith('did:web:')
        ? `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
        : `${options.plcUrl}/${did}`
      identity = options.fetcher.json<DidDocument>(url).then(({ data }) => ({
        did,
        pds: data.service?.find(service => service.id.endsWith('#atproto_pds'))?.serviceEndpoint,
        handle: data.alsoKnownAs?.find(alias => alias.startsWith('at://'))?.slice('at://'.length),
      }))
      identity.catch(() => identities.delete(did))
      identities.set(did, identity)
    }
    return identity
  }

  const handles = new Map<string, Promise<string>>()

  function resolveHandle(handle: string): Promise<string> {
    const key = handle.toLowerCase()
    let did = handles.get(key)
    if (!did) {
      did = (async () => {
        const { data } = await options.fetcher.json<{ did: string }>(`${options.handleResolverUrl}/xrpc/com.atproto.identity.resolveHandle`, { query: { handle: key } })
        if ((await resolveDid(data.did)).handle?.toLowerCase() !== key) {
          throw new NotFoundError(`${data.did} does not claim the handle ${handle}`, 404, '', options.context)
        }
        return data.did
      })()
      did.catch(() => handles.delete(key))
      handles.set(key, did)
    }
    return did
  }

  async function pdsOf(did: string): Promise<string> {
    const host = (await resolveDid(did)).pds
    if (!host) {
      throw new ForgeError(`No PDS in the DID document for ${did}`, options.context)
    }
    return host.replace(/\/$/, '')
  }

  async function* listRecords<T extends TangledRecord>(did: string, collection: string): AsyncGenerator<RecordResponse<T>> {
    const host = await pdsOf(did)
    let cursor: string | undefined
    do {
      const { data }: { data: { records: Array<RecordResponse<T>>, cursor?: string } } = await options.fetcher.json(`${host}/xrpc/com.atproto.repo.listRecords`, {
        query: { repo: did, collection, limit: 100, cursor },
      })
      yield* data.records
      cursor = data.records.length ? data.cursor : undefined
    } while (cursor)
  }

  async function getRecord<T extends TangledRecord>(uri: string): Promise<RecordResponse<T>> {
    const parsed = parseAtUri(uri)
    if (!parsed) {
      throw new ForgeError(`Not an AT-URI: ${uri}`, options.context)
    }
    const host = options.recordsUrl ?? await pdsOf(parsed.did)
    const { data } = await options.fetcher.json<RecordResponse<T>>(`${host.replace(/\/$/, '')}/xrpc/com.atproto.repo.getRecord`, {
      query: { repo: parsed.did, collection: parsed.collection, rkey: parsed.rkey },
      // A PDS responds 400 `RecordNotFound` for a missing record.
      mapError: error => error instanceof ForgeApiError && error.status === 400 ? new NotFoundError(`No record at ${uri}`, 400, error.body, options.context) : error,
    })
    return data
  }

  async function* backlinks(target: string, collection: string, path: string): AsyncGenerator<AtUri> {
    let cursor: string | undefined
    do {
      const { data }: { data: BacklinksResponse } = await options.fetcher.json<BacklinksResponse>(`${options.backlinksUrl}/links`, {
        query: { target, collection, path, limit: 100, cursor },
        headers: { accept: 'application/json' },
      })
      for (const link of data.linking_records) {
        yield { did: link.did, collection: link.collection, rkey: link.rkey }
      }
      cursor = data.cursor ?? undefined
    } while (cursor)
  }

  return { resolveDid, resolveHandle, getRecord, listRecords, backlinks }
}
