import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher, RequestOptions } from '../fetch.ts'
import type { AtprotoClient } from './atproto.ts'
import type { TangledAuth, TangledOptions } from './index.ts'
import type { Session } from './types.ts'
import { AuthenticationRequiredError, ForgeApiError, TokenRevokedError } from '../errors.ts'
import { createFetcher } from '../fetch.ts'
import { degradesToWarning } from '../utils.ts'
import { parseAtUri } from './atproto.ts'

const ATTESTATION = 'org.tangled.graph.attestation'

/** What a knot returns for a record it wrote. */
export interface KnotWrite {
  'uri': string
  'cid': string
  /** The change that made this version, which the author's attestation names. */
  'x-tngl-change'?: string
}

/** The authenticated account: its PDS session, its own records, and writes to knots on its behalf. */
export interface TangledSession {
  writable: boolean
  viewerDid: () => Promise<string>
  /** Calls an XRPC method on the authenticated account's PDS, refreshing an expired session once. */
  pdsCall: <T>(nsid: string, init?: RequestOptions) => Promise<T>
  createOwnRecord: (collection: string, record: Record<string, unknown>, signal?: AbortSignal) => Promise<{ uri: string, cid: string }>
  putOwnRecord: (uri: string, record: Record<string, unknown>, signal?: AbortSignal) => Promise<void>
  deleteOwnRecord: (uri: string, signal?: AbortSignal) => Promise<void>
  ownRecords: <T>(collection: string, signal?: AbortSignal) => AsyncGenerator<{ uri: string, value: T }>
  /** A token from the PDS that lets the account call `lxm` on the service or repository `aud`. */
  serviceAuth: (aud: string, lxm: string, signal?: AbortSignal) => Promise<string>
  /** Calls a procedure of the knot at `origin` for the repository `repo`, as the signed-in account. */
  knotCall: <T>(origin: string, repo: string, nsid: string, input: Record<string, unknown>, options?: Pick<RequestOptions, 'signal' | 'mapError'>) => Promise<T>
  /** Writes the account's claim to a record version that a knot wrote for it, where its PDS accepts one. */
  attest: (written: KnotWrite, signal?: AbortSignal) => Promise<void>
}

export function createTangledSession({ options, fetcher, atproto, context }: { options: TangledOptions, fetcher: Fetcher, atproto: AtprotoClient, context: ForgeErrorContext }): TangledSession {
  const writable = options.auth !== undefined && options.auth.type !== 'anonymous'
  let session: Promise<Session> | undefined
  let pdsUrl: string | undefined

  async function createSession(refresh?: Session): Promise<Session> {
    const auth = options.auth as Extract<TangledAuth, { type: 'app_password' }>
    if (!pdsUrl) {
      const did = auth.pds
        ? undefined
        : auth.identifier.startsWith('did:')
          ? auth.identifier
          : await atproto.resolveHandle(auth.identifier).catch(() => undefined)
      pdsUrl = auth.pds ?? (did
        ? (await atproto.resolveDid(did)).pds
        : undefined) ?? 'https://bsky.social'
    }
    const { data } = await fetcher.json<Session>(
      `${pdsUrl}/xrpc/com.atproto.server.${refresh ? 'refreshSession' : 'createSession'}`,
      refresh
        ? {
            method: 'POST',
            headers: { authorization: `Bearer ${refresh.refreshJwt}` },
          }
        : {
            method: 'POST',
            json: { identifier: auth.identifier, password: auth.password },
            mapError: rejectedPassword,
          },
    )
    return data
  }

  async function currentSession(): Promise<Session> {
    session ??= createSession()
    session.catch(() => {
      session = undefined
    })
    return session
  }

  async function viewerDid(): Promise<string> {
    const auth = options.auth!
    return auth.type === 'oauth'
      ? auth.did
      : (await currentSession()).did
  }

  async function pdsCall<T>(nsid: string, init: RequestOptions = {}): Promise<T> {
    const auth = options.auth!
    if (auth.type === 'oauth') {
      const client = createFetcher({
        baseUrl: auth.pds,
        fetch: auth.fetch,
        authenticated: true,
        timeout: options.timeout,
        context,
      })
      return (await client.json<T>(`${auth.pds.replace(/\/$/, '')}/xrpc/${nsid}`, init)).data
    }
    const send = async (current: Session) => (await fetcher.json<T>(`${pdsUrl}/xrpc/${nsid}`, {
      ...init,
      headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${current.accessJwt}` },
    })).data
    const current = await currentSession()
    try {
      return await send(current)
    }
    catch (error) {
      if (!(error instanceof ForgeApiError) || error.status !== 400 || !error.body.includes('ExpiredToken')) {
        throw error
      }
      session = createSession(current)
      return send(await session)
    }
  }

  async function createOwnRecord(collection: string, record: Record<string, unknown>, signal?: AbortSignal): Promise<{ uri: string, cid: string }> {
    return pdsCall<{ uri: string, cid: string }>('com.atproto.repo.createRecord', {
      method: 'POST',
      json: {
        repo: await viewerDid(),
        collection,
        record: { $type: collection, ...record },
      },
      signal,
    })
  }

  async function putOwnRecord(uri: string, record: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const { collection, rkey } = parseAtUri(uri)!
    await pdsCall('com.atproto.repo.putRecord', {
      method: 'POST',
      json: {
        repo: await viewerDid(),
        collection,
        rkey,
        record: { $type: collection, ...record },
      },
      signal,
    })
  }

  async function deleteOwnRecord(uri: string, signal?: AbortSignal): Promise<void> {
    const { collection, rkey } = parseAtUri(uri)!
    await pdsCall('com.atproto.repo.deleteRecord', {
      method: 'POST',
      json: { repo: await viewerDid(), collection, rkey },
      signal,
    })
  }

  async function* ownRecords<T>(collection: string, signal?: AbortSignal): AsyncGenerator<{ uri: string, value: T }> {
    const repo = await viewerDid()
    let cursor: string | undefined
    do {
      const data: { records: Array<{ uri: string, value: T }>, cursor?: string } = await pdsCall('com.atproto.repo.listRecords', {
        query: { repo, collection, limit: 100, cursor },
        signal,
      })
      yield* data.records
      cursor = data.records.length ? data.cursor : undefined
    } while (cursor)
  }

  async function serviceAuth(aud: string, lxm: string, signal?: AbortSignal): Promise<string> {
    return (await pdsCall<{ token: string }>('com.atproto.server.getServiceAuth', {
      query: { aud, lxm },
      signal,
    })).token
  }

  async function knotCall<T>(origin: string, repo: string, nsid: string, input: Record<string, unknown>, { signal, mapError }: Pick<RequestOptions, 'signal' | 'mapError'> = {}): Promise<T> {
    // A knot accepts a token for each repository it hosts, with the repo DID as its audience.
    const token = await serviceAuth(repo, nsid, signal)
    return (await fetcher.json<T>(`${origin}/xrpc/${nsid}`, {
      method: 'POST',
      json: { repo, ...input },
      headers: { authorization: `Bearer ${token}` },
      mapError,
      signal,
    })).data
  }

  async function attest(written: KnotWrite, signal?: AbortSignal): Promise<void> {
    try {
      await createOwnRecord(ATTESTATION, {
        subject: { uri: written.uri, cid: written.cid },
        ...written['x-tngl-change']
          ? { change: written['x-tngl-change'] }
          : {},
        createdAt: new Date().toISOString(),
      }, signal)
    }
    catch (error) {
      if (signal?.aborted || !degradesToWarning(error)) {
        throw error
      }
    }
  }

  return {
    writable,
    viewerDid,
    pdsCall,
    createOwnRecord,
    putOwnRecord,
    deleteOwnRecord,
    ownRecords,
    serviceAuth,
    knotCall,
    attest,
  }
}

function rejectedPassword(error: unknown): unknown {
  if (!(error instanceof AuthenticationRequiredError)) {
    return error
  }
  const context = {
    forge: error.forge,
    instance: error.instance,
    url: error.url,
    method: error.method,
  }
  return new TokenRevokedError('Identifier or app password was rejected by the PDS', error.status, error.body, context, { cause: error })
}
