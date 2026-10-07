import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher, RequestOptions } from '../fetch.ts'
import type { AtprotoClient } from './atproto.ts'
import type { TangledAuth, TangledOptions } from './index.ts'
import type { Session, TangledRecord } from './types.ts'
import { AuthenticationRequiredError, ForgeApiError, InsufficientScopeError, TokenRevokedError } from '../errors.ts'
import { createFetcher } from '../fetch.ts'
import { parseAtUri } from './atproto.ts'

/** The authenticated account: its PDS session, and writes to its own records. */
export interface TangledSession {
  writable: boolean
  viewerDid: () => Promise<string>
  /** Calls an XRPC method on the authenticated account's PDS, refreshing an expired session once. */
  pdsCall: <T>(nsid: string, init?: RequestOptions) => Promise<T>
  createRecord: (collection: string, record: Record<string, unknown>) => Promise<{ uri: string, cid: string }>
  /** Rewrites one of the account's own records, refusing records it does not own. */
  putOwnRecord: (uri: string, update: (record: TangledRecord) => TangledRecord) => Promise<TangledRecord>
  deleteOwnRecord: (uri: string) => Promise<void>
  ownRecords: <T>(collection: string) => AsyncGenerator<{ uri: string, value: T }>
}

export function createTangledSession({ options, fetcher, atproto, context }: { options: TangledOptions, fetcher: Fetcher, atproto: AtprotoClient, context: ForgeErrorContext }): TangledSession {
  const writable = options.auth !== undefined && options.auth.type !== 'anonymous'
  let session: Promise<Session> | undefined
  let pdsUrl: string | undefined

  async function createSession(refresh?: Session): Promise<Session> {
    const auth = options.auth as Extract<TangledAuth, { type: 'app_password' }>
    if (!pdsUrl) {
      pdsUrl = auth.pds
        ?? (auth.identifier.startsWith('did:') ? (await atproto.resolveDid(auth.identifier)).pds : undefined)
        ?? 'https://bsky.social'
    }
    const { data } = await fetcher.json<Session>(
      `${pdsUrl}/xrpc/com.atproto.server.${refresh ? 'refreshSession' : 'createSession'}`,
      refresh
        ? { method: 'POST', headers: { authorization: `Bearer ${refresh.refreshJwt}` } }
        : { method: 'POST', json: { identifier: auth.identifier, password: auth.password }, mapError: rejectedPassword },
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
    return auth.type === 'oauth' ? auth.did : (await currentSession()).did
  }

  /** Calls an XRPC method on the authenticated account's PDS, refreshing an expired session once. */
  async function pdsCall<T>(nsid: string, init: RequestOptions = {}): Promise<T> {
    const auth = options.auth!
    if (auth.type === 'oauth') {
      const client = createFetcher({ baseUrl: auth.pds, fetch: auth.fetch, authenticated: true, timeout: options.timeout, context })
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

  async function createRecord(collection: string, record: Record<string, unknown>): Promise<{ uri: string, cid: string }> {
    return pdsCall<{ uri: string, cid: string }>('com.atproto.repo.createRecord', {
      method: 'POST',
      json: { repo: await viewerDid(), collection, record: { $type: collection, ...record } },
    })
  }

  /** Rewrites one of the account's own records, refusing records it does not own. */
  async function putOwnRecord(uri: string, update: (record: TangledRecord) => TangledRecord): Promise<TangledRecord> {
    const parsed = parseAtUri(uri)
    const viewer = await viewerDid()
    if (!parsed || parsed.did !== viewer) {
      throw new InsufficientScopeError('Records can only be edited by the account that wrote them', 403, '', context)
    }
    const current = await atproto.getRecord(uri)
    const record = update(current.value)
    await pdsCall('com.atproto.repo.putRecord', {
      method: 'POST',
      json: { repo: viewer, collection: parsed.collection, rkey: parsed.rkey, record, swapRecord: current.cid },
    })
    return record
  }

  async function deleteOwnRecord(uri: string): Promise<void> {
    const parsed = parseAtUri(uri)
    const viewer = await viewerDid()
    if (!parsed || parsed.did !== viewer) {
      throw new InsufficientScopeError('Records can only be deleted by the account that wrote them', 403, '', context)
    }
    await pdsCall('com.atproto.repo.deleteRecord', {
      method: 'POST',
      json: { repo: viewer, collection: parsed.collection, rkey: parsed.rkey },
    })
  }

  async function* ownRecords<T>(collection: string): AsyncGenerator<{ uri: string, value: T }> {
    const repo = await viewerDid()
    let cursor: string | undefined
    do {
      const data: { records: Array<{ uri: string, value: T }>, cursor?: string } = await pdsCall('com.atproto.repo.listRecords', {
        query: { repo, collection, limit: 100, cursor },
      })
      yield* data.records
      cursor = data.records.length ? data.cursor : undefined
    } while (cursor)
  }

  return { writable, viewerDid, pdsCall, createRecord, putOwnRecord, deleteOwnRecord, ownRecords }
}

function rejectedPassword(error: unknown): unknown {
  if (!(error instanceof AuthenticationRequiredError)) {
    return error
  }
  const context = { forge: error.forge, instance: error.instance, url: error.url, method: error.method }
  return new TokenRevokedError('Identifier or app password was rejected by the PDS', error.status, error.body, context, { cause: error })
}
