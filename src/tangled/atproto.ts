import type { Fetcher } from '../fetch.ts'
import type { DidDocument } from './types.ts'
import { NotFoundError } from '../errors.ts'
import { abortable } from '../fetch.ts'

export interface AtUri {
  did: string
  collection: string
  rkey: string
}

export function parseAtUri(uri: string): AtUri | undefined {
  const match = /^at:\/\/(did:[^/]+)\/([^/]+)\/([^/?#]+)$/.exec(uri)
  return match
    ? { did: match[1]!, collection: match[2]!, rkey: match[3]! }
    : undefined
}

export function atUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}

export interface Identity {
  did: string
  /** For a repo DID, the knot: a knot is the PDS of the repositories it hosts. */
  pds?: string
  handle?: string
}

export interface AtprotoClient {
  resolveDid: (did: string, signal?: AbortSignal) => Promise<Identity>
  /** The DID a handle names, checked against the handle the DID document claims. */
  resolveHandle: (handle: string, signal?: AbortSignal) => Promise<string>
}

export interface AtprotoClientOptions {
  fetcher: Fetcher
  plcUrl: string
  /** Serves `com.atproto.identity.resolveHandle`. */
  handleResolverUrl: string
  context: { forge: string, instance: string }
}

/** Resolves identities from DID documents. */
export function createAtprotoClient(options: AtprotoClientOptions): AtprotoClient {
  const identities = new Map<string, Promise<Identity>>()

  function resolveDid(did: string, signal?: AbortSignal): Promise<Identity> {
    let identity = identities.get(did)
    if (!identity) {
      const url = did.startsWith('did:web:')
        ? `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
        : `${options.plcUrl}/${did}`
      identity = options.fetcher.json<DidDocument>(url).then(({ data }) => ({
        did,
        pds: data.service?.find(service => service.id.endsWith('#atproto_pds'))?.serviceEndpoint.replace(/\/$/, ''),
        handle: data.alsoKnownAs?.find(alias => alias.startsWith('at://'))?.slice('at://'.length),
      }))
      identity.catch(() => identities.delete(did))
      identities.set(did, identity)
    }
    return abortable(identity, signal)
  }

  const handles = new Map<string, Promise<string>>()

  function resolveHandle(handle: string, signal?: AbortSignal): Promise<string> {
    const key = handle.toLowerCase()
    let did = handles.get(key)
    if (!did) {
      did = (async () => {
        const { data } = await options.fetcher.json<{ did: string }>(`${options.handleResolverUrl}/xrpc/com.atproto.identity.resolveHandle`, {
          query: { handle: key },
        })
        if ((await resolveDid(data.did)).handle?.toLowerCase() !== key) {
          throw new NotFoundError(`${data.did} does not claim the handle ${handle}`, 404, '', options.context)
        }
        return data.did
      })()
      did.catch(() => handles.delete(key))
      handles.set(key, did)
    }
    return abortable(did, signal)
  }

  return { resolveDid, resolveHandle }
}
