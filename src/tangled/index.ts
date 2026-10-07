import type { ProviderDefinition, ProviderFactoryFunction } from '../define.ts'
import type { FetchLike } from '../fetch.ts'
import type {
  ForgeEventInput,
  Page,
  Repo,
  RepoRef,
  ThreadKind,
  ThreadRef,
} from '../model.ts'
import type { AnonymousAuth, ForgeOptionsBase, ThreadsApi } from '../provider.ts'
import type { WebSocketFactory, WebSocketLike } from './subscribe.ts'
import type { FeedCommentRecord, IssueRecord, PullRecord, RepoRecord } from './types.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import {
  InsufficientScopeError,
  UnsupportedOperationError,
} from '../errors.ts'
import { forgeIterable, getManyConcurrently } from '../utils.ts'
import { atUri, createAtprotoClient, parseAtUri } from './atproto.ts'
import {
  COLLECTIONS,
  FORGE,
  THREAD_COLLECTIONS,
  toActivityEvent,
  toRecordComment,
  toThread,
  toThreadRef,
} from './normalise.ts'
import { createTangledNotifications } from './notifications.ts'
import { createTangledRecords, STATE_COLLECTION } from './records.ts'
import { createTangledSession } from './session.ts'
import { subscribeJetstream } from './subscribe.ts'
import { tangledWeb } from './web.ts'
import { tangledWebhooks } from './webhooks.ts'

export type { WebSocketFactory, WebSocketLike } from './subscribe.ts'

/**
 * Credentials for writing records. Reads are public and need none.
 *
 * - `app_password` creates a session on the account's PDS.
 * - `oauth` takes a `fetch` from an atproto OAuth client that already signs
 *   requests (DPoP) for `pds`.
 */
export type TangledAuth
  = | AnonymousAuth
    | { type: 'app_password', identifier: string, password: string, pds?: string }
    | { type: 'oauth', did: string, pds: string, fetch: FetchLike }

export interface TangledOptions extends ForgeOptionsBase {
  auth?: TangledAuth
  /** Appview web root, used for links and as the `instance`. Defaults to `https://tangled.org`. */
  baseUrl?: string
  /**
   * Base for `request()`: a Bobbin-compatible XRPC index. Defaults to
   * `https://api.tangled.org`, Tangled's public instance.
   */
  apiUrl?: string
  /** PLC directory for `did:plc` resolution. Defaults to the public directory, which is community infrastructure. */
  plcUrl?: string
  /** Constellation-compatible backlink index. */
  backlinksUrl?: string
  /**
   * Service for `com.atproto.identity.resolveHandle`, so a `RepoRef.owner` can
   * be a handle. Defaults to `https://public.api.bsky.app`.
   */
  handleResolverUrl?: string
  /**
   * Slingshot-compatible record cache, for example
   * `https://slingshot.microcosm.blue`. By default records are read from each
   * author's PDS.
   */
  recordsUrl?: string
  /** Jetstream `subscribe` endpoint. */
  jetstreamUrl?: string
  /** Defaults to the global `WebSocket`. */
  webSocket?: WebSocketFactory
  /**
   * Base URL of a service implementing the experimental
   * `org.tangled.temp.notification.*` lexicons (Tangled's deliberi). Its
   * service DID is derived as `did:web:<host>`. Requires `auth`. The lexicons
   * live in Tangled's `temp` namespace and may change or disappear, so the
   * resulting capabilities report `'experimental'`.
   */
  notificationsUrl?: string
  /**
   * Maps a per-repo display number (as carried by webhooks) to the thread's
   * AT-URI. When provided, `webhooks.ingest()` uses it to fill `number`.
   * Records carry no numbers; the mapping exists only in an index of the
   * appview's numbering.
   */
  resolveDisplayNumber?: (repo: RepoRef, kind: ThreadKind, displayNumber: string) => Promise<string | undefined>
  /** Maps a knot host to the host that accepts git over SSH for it. `knot1.tangled.sh` maps to `tangled.org` by default. */
  sshHosts?: Record<string, string>
  /**
   * Where `threads.list` reads from. `'records'` (the default) reads every
   * record and computes state with the appview's rule. `'index'` reads the
   * Bobbin index at `apiUrl` instead: one request per page, but its states may
   * lag behind the records, and every listing carries an `index_possibly_stale`
   * warning.
   */
  listSource?: 'records' | 'index'
}

const ISSUE_AND_PULL = { issue: true, pull_request: true } as const

const TANGLED: ProviderDefinition<TangledOptions> = {
  forge: FORGE,
  baseUrl: 'https://tangled.org',
  headers: { accept: 'application/json' },
  setup({ options, instance, baseUrl: webUrl, origin: context, fetcher, createFetcher: fetcherFor }) {
    const atproto = createAtprotoClient({
      fetcher,
      plcUrl: (options.plcUrl ?? 'https://plc.directory').replace(/\/$/, ''),
      backlinksUrl: (options.backlinksUrl ?? 'https://constellation.microcosm.blue').replace(/\/$/, ''),
      handleResolverUrl: (options.handleResolverUrl ?? 'https://public.api.bsky.app').replace(/\/$/, ''),
      recordsUrl: options.recordsUrl?.replace(/\/$/, ''),
      context,
    })
    const api = fetcherFor({ baseUrl: (options.apiUrl ?? 'https://api.tangled.org').replace(/\/$/, '') })
    const { writable, viewerDid, pdsCall, createRecord, putOwnRecord, deleteOwnRecord, ownRecords } = createTangledSession({ options, fetcher, atproto, context })

    /** The repo DID a thread record must reference, from the ref or the repo record. */
    const { stateAuthors, actorFor, resolveRepo, threadFor, subjectUri, activity, toStreamEvent, canonicalRepo, canonicalRef, repoDidOf, toRepo, readThread, wholePage, listPage, listComments, findSubscription } = createTangledRecords({ options, instance, webUrl, context, atproto, api, fetcher, ownRecords })

    const threads = {
      get: perKind(ISSUE_AND_PULL, readThread),
      getMany: verb(true, (refs: ThreadRef[]) => getManyConcurrently(refs, readThread)),
      listPage: perKind({ issue: 'experimental', pull_request: true }, listPage),
      eventsPage: verb(true, async (thread: ThreadRef): Promise<Page<ForgeEventInput>> => {
        const { ref, uri, kind } = subjectUri(thread)
        const target = atUri(uri.did, uri.collection, uri.rkey)
        return wholePage(forgeIterable(async function* (warn) {
          const events: ForgeEventInput[] = []
          for await (const item of activity(target, kind, await stateAuthors(uri.did, ref.repo, warn), warn)) {
            const author = parseAtUri(item.uri)!.did
            events.push(toActivityEvent(instance, { ...item, operation: 'create' }, await actorFor(author), ref, 'poll', new Date(0)))
          }
          yield* events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        }))
      }),
      commentsPage: perKind(ISSUE_AND_PULL, (thread: ThreadRef) => wholePage(listComments(thread))),
    }

    const comment: ThreadsApi['comment'] = async (thread, body) => {
      const { ref, uri } = subjectUri(thread)
      const target = atUri(uri.did, uri.collection, uri.rkey)
      const { cid } = await atproto.getRecord(target)
      const record: FeedCommentRecord = {
        body: { $type: 'sh.tangled.markup.markdown', text: body, original: body },
        subject: { uri: target, cid: cid ?? '' },
        createdAt: new Date().toISOString(),
      }
      const created = await createRecord(COLLECTIONS.comment, { ...record })
      return toRecordComment(ref, created.uri, record, await actorFor(await viewerDid()))
    }
    const editComment: ThreadsApi['editComment'] = async (ref, body) => {
      const record = await putOwnRecord(ref.id, current => ({
        ...current,
        body: typeof (current as FeedCommentRecord).body === 'string' ? body : { $type: 'sh.tangled.markup.markdown', text: body, original: body },
      }))
      return toRecordComment(ref.thread, ref.id, record as FeedCommentRecord, await actorFor(await viewerDid()))
    }
    const deleteComment: ThreadsApi['deleteComment'] = ref => deleteOwnRecord(ref.id)
    const create: ThreadsApi['create'] = async (repo, input) => {
      if (input.kind !== 'issue') {
        throw new UnsupportedOperationError('Tangled pull requests are patches; only issues can be created', context)
      }
      if (input.labels?.length || input.assignees?.length) {
        throw new UnsupportedOperationError('Tangled labels and assignees are not written yet', context)
      }
      const [address, repoDid] = await Promise.all([canonicalRef(repo), repoDidOf(repo)])
      const record: IssueRecord = { repo: repoDid, title: input.title, body: input.body, createdAt: new Date().toISOString() }
      const created = await createRecord(COLLECTIONS.issue, { ...record })
      const ref = toThreadRef(instance, { ...address, externalId: repoDid }, parseAtUri(created.uri)!)
      return toThread(ref, record, await actorFor(await viewerDid()), {}, 0)
    }
    const update: ThreadsApi['update'] = async (thread, input) => {
      const { ref, uri } = subjectUri(thread)
      const record = await putOwnRecord(atUri(uri.did, uri.collection, uri.rkey), current => ({
        ...current,
        ...input.title === undefined ? {} : { title: input.title },
        ...input.body === undefined ? {} : { body: input.body },
      }))
      return toThread(ref, record as IssueRecord | PullRecord, await actorFor(uri.did), {}, 0)
    }
    const subscription: ThreadsApi['subscription'] = async thread => await findSubscription(thread) ? 'subscribed' : 'none'
    const subscribe: ThreadsApi['subscribe'] = async (thread) => {
      if (await findSubscription(thread)) {
        return
      }
      const { uri } = subjectUri(thread)
      await createRecord(COLLECTIONS.subscription, {
        subject: { $type: `${COLLECTIONS.subscription}#uri`, uri: atUri(uri.did, uri.collection, uri.rkey) },
        createdAt: new Date().toISOString(),
      })
    }
    const unsubscribe: ThreadsApi['unsubscribe'] = async (thread) => {
      const existing = await findSubscription(thread)
      if (existing) {
        await deleteOwnRecord(existing)
      }
    }
    const setState = async (thread: ThreadRef, state: 'open' | 'closed') => {
      const { uri, kind } = subjectUri(thread)
      const target = atUri(uri.did, uri.collection, uri.rkey)
      const { ref } = await threadFor(target)
      const [viewer, allowed] = await Promise.all([viewerDid(), stateAuthors(uri.did, ref.repo)])
      if (!allowed.has(viewer)) {
        throw new InsufficientScopeError(
          'Only the author, the repo owner or a collaborator can change this state; the appview would ignore the record',
          403,
          '',
          context,
        )
      }
      await createRecord(STATE_COLLECTION[kind].collection, kind === 'issue'
        ? { issue: target, state: `${COLLECTIONS.issueState}.${state}`, createdAt: new Date().toISOString() }
        : { pull: target, status: `${COLLECTIONS.pullStatus}.${state}`, createdAt: new Date().toISOString() })
    }
    const close: ThreadsApi['close'] = thread => setState(thread, 'closed')
    const reopen: ThreadsApi['reopen'] = thread => setState(thread, 'open')

    const notificationsUrl = options.notificationsUrl?.replace(/\/$/, '')
    const notifications = writable && notificationsUrl
      ? createTangledNotifications(notificationsUrl, { instance, context, fetcher, atproto, pdsCall, resolveRepo, actorFor })
      : undefined

    const createWebSocket: WebSocketFactory = options.webSocket
      ?? (url => new globalThis.WebSocket(url) as unknown as WebSocketLike)

    const unverified = { issue: writable && 'experimental', pull_request: writable && 'experimental' } as const
    return {
      traits: { poll: false, eventKinds: 'native', authKinds: ['anonymous', 'app_password', 'oauth'] },
      request: api,
      repos: {
        get: verb(true, async (ref) => {
          const { ref: found, record } = await canonicalRepo(ref)
          return toRepo(found, record.value, record)
        }),
        listPage: verb(writable && 'experimental', async (): Promise<Page<Repo>> => {
          if (!writable) {
            throw new UnsupportedOperationError('Listing your repositories needs auth', context)
          }
          return wholePage(forgeIterable(async function* () {
            const owner = await viewerDid()
            for await (const record of ownRecords<RepoRecord>(COLLECTIONS.repo)) {
              const rkey = parseAtUri(record.uri)!.rkey
              yield toRepo({ forge: FORGE, instance, owner, name: rkey }, record.value, record)
            }
          }))
        }),
      },
      notifications,
      users: {
        me: verb(writable && 'experimental', async () => ({ ...await actorFor(await viewerDid()), raw: undefined })),
      },
      threads: {
        ...threads,
        comment: perKind({ issue: writable && 'experimental', pull_request: writable }, comment),
        editComment: perKind(unverified, editComment),
        deleteComment: perKind(unverified, deleteComment),
        create: perKind({ issue: writable && 'experimental' }, create),
        update: perKind(unverified, update),
        close: perKind({ issue: writable && 'experimental', pull_request: writable }, close),
        reopen: perKind({ issue: writable && 'experimental', pull_request: writable }, reopen),
        subscriptions: perKind(unverified, { subscription, subscribe, unsubscribe }),
      },
      sources: {
        subscribe: verb(true, subscribeOptions => subscribeJetstream({
          ...subscribeOptions,
          url: options.jetstreamUrl ?? 'wss://jetstream2.us-east.bsky.network/subscribe',
          collections: THREAD_COLLECTIONS,
          createWebSocket,
          toEvent: toStreamEvent,
          context,
        })),
      },
      web: tangledWeb(webUrl),
      scopes: () => ({ note: 'An atproto app password or OAuth session; Tangled has no per-verb scopes' }),
      webhooks: {},
    }
  },
}

/** Creates a Tangled provider. Records are read from PDSes; pushes arrive through Jetstream. */
export const tangled: ProviderFactoryFunction<TangledOptions> = /* @__PURE__ */ defineForgeProvider({ ...TANGLED, webhooks: tangledWebhooks })

/** `tangled()` without webhook ingestion, for bundles that never receive a delivery. */
export const tangledLite: ProviderFactoryFunction<TangledOptions> = /* @__PURE__ */ defineForgeProvider(TANGLED)
