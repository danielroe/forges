import type { ProviderDefinition, ProviderFactoryFunction } from '../define.ts'
import type { FetchLike } from '../fetch.ts'
import type {
  BaseOptions,
  ChangedFile,
  CommentRef,
  Commit,
  Label,
  ListOptions,
  Page,
  PageOptions,
  Repo,
  Thread,
  ThreadRef,
} from '../model.ts'
import type { AnonymousAuth, ForgeOptionsBase, ThreadsApi } from '../provider.ts'
import type { Identity } from './atproto.ts'
import type { TangledContents } from './knot.ts'
import type { TicketKind } from './normalise.ts'
import type { RepoHandle, TangledRecords } from './records.ts'
import type { KnotWrite } from './session.ts'
import type { WebSocketFactory, WebSocketLike } from './subscribe.ts'
import type {
  CommentRecord,
  ReactionRecord,
  RecordResponse,
  RepoManifest,
  SubscriptionRecord,
  TicketRecord,
  TicketState,
} from './types.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import {
  ForgeApiError,
  InsufficientScopeError,
  NotFoundError,
  UnsupportedOperationError,
} from '../errors.ts'
import { degradesToWarning, getManyConcurrently, mapConcurrent, mergeCommitMessage, requireThread } from '../utils.ts'
import { createAtprotoClient, parseAtUri } from './atproto.ts'
import { accountFeedPage } from './feed.ts'
import {
  COLLECTIONS,
  FORGE,
  REACTION_EMOJI,
  THREAD_COLLECTIONS,
  ticketKind,
  toComment,
  toLabel,
  toThreadRef,
  toThreadState,
} from './normalise.ts'
import { createTangledNotifications } from './notifications.ts'
import { createTangledRecords } from './records.ts'
import { createTangledSession } from './session.ts'
import { subscribeJetstream } from './subscribe.ts'
import { TANGLED_WEB } from './web.ts'
import { createTangledWebhooks, tangledWebhooks } from './webhooks.ts'

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

/** Options for `tangled()`. */
export interface TangledOptions extends ForgeOptionsBase {
  /** An app password session, an OAuth client that signs requests, or none for anonymous reads. */
  auth?: TangledAuth
  /**
   * Appview web root, used for links and as the `instance`.
   * @default https://tangled.org
   */
  baseUrl?: string
  /**
   * Base for `request()`: a Bobbin-compatible XRPC index, whose mirror serves
   * the git reads. Defaults to `https://api.tangled.org`, Tangled's public
   * instance.
   */
  apiUrl?: string
  /** PLC directory for `did:plc` resolution. Defaults to the public directory, which is community infrastructure. */
  plcUrl?: string
  /**
   * Service for `com.atproto.identity.resolveHandle`, so a `RepoRef.owner` can
   * be a handle. Defaults to `https://public.api.bsky.app`.
   */
  handleResolverUrl?: string
  /** Jetstream `subscribe` endpoint. */
  jetstreamUrl?: string
  /** Defaults to the global `WebSocket`. */
  webSocket?: WebSocketFactory
  /**
   * Base URL of a service implementing the experimental
   * `org.tangled.temp.notification.*` lexicons (Tangled's deliberi). Its
   * service DID is derived as `did:web:<host>`. Requires `auth`. The lexicons
   * live in Tangled's `temp` namespace and may change or disappear.
   */
  notificationsUrl?: string
  /** Maps a knot host to the host that accepts git over SSH for it. `knot1.tangled.sh` maps to `tangled.org` by default. */
  sshHosts?: Record<string, string>
}

const ISSUE_AND_PULL = { issue: true, pull_request: true } as const

const TANGLED: ProviderDefinition<TangledOptions, undefined, true> = {
  forge: FORGE,
  hasWeb: true,
  experimental: true,
  baseUrl: 'https://tangled.org',
  headers: { accept: 'application/json' },
  webhooks: tangledWebhooks,
  setup({ options, instance, baseUrl: webUrl, origin: context, fetcher, createFetcher: fetcherFor }) {
    const atproto = createAtprotoClient({
      fetcher,
      plcUrl: (options.plcUrl ?? 'https://plc.directory').replace(/\/$/, ''),
      handleResolverUrl: (options.handleResolverUrl ?? 'https://public.api.bsky.app').replace(/\/$/, ''),
      context,
    })
    const apiUrl = (options.apiUrl ?? 'https://api.tangled.org').replace(/\/$/, '')
    const api = fetcherFor({ baseUrl: apiUrl })
    const session = createTangledSession({ options, fetcher, atproto, context })
    const { writable, viewerDid, pdsCall, createOwnRecord, putOwnRecord, deleteOwnRecord, ownRecords, serviceAuth, knotCall, attest } = session
    const records: TangledRecords = createTangledRecords({
      options,
      instance,
      webUrl,
      context,
      atproto,
      api,
      fetcher,
    })
    const {
      actorFor,
      didOf,
      repoFor,
      repoByDid,
      toRepo,
      repoCounts,
      repoLabels,
      forgetLabels,
      ticketFor,
      subjectUri: subjectUriOf,
      ticketThread,
      readThread,
      listPage,
      searchThreadsPage,
      searchReposPage,
      commentsPage,
      getComment,
      reactionsPage,
      collaboratorsPage,
      permissionFor,
      eventsPage,
      recordEvent,
      toStreamEvent,
      awaitIndexed,
      latestPatch,
      listActivity,
      knotRecord,
      query,
    } = records

    let loaded: Promise<TangledContents> | undefined
    const knot = () => loaded ??= import('./knot.ts').then(({ createTangledContents }) => createTangledContents({
      instance,
      webUrl,
      context,
      apiUrl,
      fetcher,
      repoFor,
      serviceAuth,
    }))
    const contentsVerb = <K extends Exclude<keyof TangledContents, 'defaultBranch' | 'merge' | 'addCollaborator'>>(name: K) =>
      verb(true, (async (...args: unknown[]) => ((await knot())[name] as (...args: unknown[]) => unknown)(...args)) as unknown as TangledContents[K])

    /** Writes one knot record for the signed-in account and waits for the index to have it. */
    async function writeKnot<T extends KnotWrite>(handle: RepoHandle, nsid: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      const written = await knotCall<T>(handle.knot, handle.did, nsid, input, { signal })
      await attest(written, signal)
      await awaitIndexed(written.uri, written.cid, signal)
      return written
    }

    /** The record key and label tokens the display names name, checked against the repository's definitions. */
    async function labelTokens(handle: RepoHandle, names: string[], signal?: AbortSignal): Promise<NonNullable<TicketRecord['tangledLabels']>> {
      const definitions = await repoLabels(handle.did, signal)
      return names.map((name) => {
        for (const [key, definition] of definitions) {
          if (definition.name === name || key === name) {
            return { key }
          }
        }
        throw new NotFoundError(`No label named ${name} in this repository`, 404, '', context)
      })
    }

    /**
     * Whether the signed-in account may change the ticket: its author, or a moderator of the repository.
     * `editor` wrote the latest version, which is the author only until a moderator edits it, so the
     * author is read from the index when the editor and the role don't settle it.
     */
    async function mayEdit(handle: RepoHandle, uri: string, editor: string | undefined, signal?: AbortSignal): Promise<boolean> {
      const viewer = await viewerDid()
      const role = await permissionFor(handle.ref, viewer, { signal }).catch(() => 'read' as const)
      if (viewer === editor || role !== 'read') {
        return true
      }
      const view = await query<{ author?: { did: string } }>('org.tangled.track.getTicketView', { uri }, signal)
      return view.author?.did === viewer
    }

    /** Puts a new version of a ticket, checking the author-or-moderator rule. */
    async function putTicket(thread: ThreadRef, mutate: (record: TicketRecord) => TicketRecord, signal?: AbortSignal): Promise<void> {
      const { repo, rkey, uri } = await ticketFor(thread, signal)
      const current = await knotRecord<TicketRecord>(repo, COLLECTIONS.ticket, rkey, signal)
      if (!await mayEdit(repo, uri, current.value['x-tngl-editor'], signal)) {
        throw new InsufficientScopeError('Only the author, the repo owner or a collaborator can change this record; the knot would refuse the write', 403, '', context)
      }
      const { 'x-tngl-editor': _editor, ...stored } = current.value
      const record = mutate(stored)
      // The knot refuses a put that changes nothing.
      if (JSON.stringify(record) !== JSON.stringify(stored)) {
        await writeKnot(repo, 'com.atproto.repo.putRecord', {
          collection: COLLECTIONS.ticket,
          rkey,
          swapRecord: current.cid,
          record,
        }, signal)
      }
    }

    const threads = {
      get: perKind(ISSUE_AND_PULL, readThread),
      getMany: verb(true, (refs: ThreadRef[], readOptions?: BaseOptions) => getManyConcurrently(refs, readThread, readOptions)),
      listPage: perKind(ISSUE_AND_PULL, listPage),
      eventsPage: verb(true, (thread: ThreadRef, listOptions: ListOptions = {}) => eventsPage(thread, listOptions)),
      filesPage: verb(true, async (thread: ThreadRef, listOptions?: PageOptions): Promise<Page<ChangedFile>> => {
        const diff = await pullDiff(thread, listOptions?.signal)
        return { items: diff.files }
      }),
      commitsPage: verb(true, async (thread: ThreadRef, listOptions?: PageOptions): Promise<Page<Commit>> => {
        const diff = await pullDiff(thread, listOptions?.signal)
        return { items: diff.commits }
      }),
      commentsPage: perKind(ISSUE_AND_PULL, (thread: ThreadRef, listOptions: ListOptions = {}) => commentsPage(thread, listOptions)),
    }

    /** The files and commits of a pull request's latest round. */
    async function pullDiff(thread: ThreadRef, signal?: AbortSignal) {
      const { repo, rkey, uri } = await ticketFor(thread, signal)
      const ticket = await knotRecord<TicketRecord>(repo, COLLECTIONS.ticket, rkey, signal)
      if (!ticket.value.targetBranch) {
        throw new UnsupportedOperationError('Only pull requests have changed files and commits', context)
      }
      const patch = await latestPatch(uri, signal)
      if (!patch) {
        throw new NotFoundError(`No patch for ${rkey}`, 404, '', context)
      }
      const { diffOf } = await knot()
      return diffOf(repo.ref, patch.base.oid, patch.head.oid, signal)
    }

    /** The account's reaction records for a subject and emoji. */
    async function ownReactions(subject: string, emoji: string, signal?: AbortSignal): Promise<string[]> {
      const found: string[] = []
      for await (const record of ownRecords<ReactionRecord>(COLLECTIONS.reaction, signal)) {
        if (record.value.subject.uri === subject && record.value.reaction === emoji) {
          found.push(record.uri)
        }
      }
      return found
    }

    /** The AT-URI of the ticket or comment a reaction is on, with its current cid. */
    async function reactionSubject(target: ThreadRef | CommentRef, signal?: AbortSignal): Promise<{ subject: { uri: string, cid: string } }> {
      const { repo, uri } = await subjectUriOf(target, signal)
      const collection = 'thread' in target
        ? COLLECTIONS.comment
        : COLLECTIONS.ticket
      const rkey = parseAtUri(uri)!.rkey
      const current = await knotRecord(repo, collection, rkey, signal)
      return {
        subject: { uri, cid: current.cid },
      }
    }

    const createComment: ThreadsApi['createComment'] = async (thread, body, options) => {
      const { repo, rkey, uri } = await ticketFor(thread, options?.signal)
      const ticket = await knotRecord<TicketRecord>(repo, COLLECTIONS.ticket, rkey, options?.signal)
      const record: CommentRecord = {
        $type: COLLECTIONS.comment,
        body: { $type: 'org.tangled.markup.markdown', text: body },
        subject: { $type: 'com.atproto.repo.strongRef', uri, cid: ticket.cid },
        createdAt: new Date().toISOString(),
      }
      const written = await writeKnot<KnotWrite>(repo, 'com.atproto.repo.createRecord', { collection: COLLECTIONS.comment, record }, options?.signal)
      const ref = toThreadRef(instance, repo.ref, rkey, thread.kind === 'pull_request'
        ? 'pull_request'
        : 'issue')
      return toComment(ref, parseAtUri(written.uri)!.rkey, record, await actorFor(await viewerDid(), options?.signal), webUrl)
    }

    const commentRef = async (ref: CommentRef, signal?: AbortSignal) => {
      const { repo } = await ticketFor(ref.thread, signal)
      return { repo, rkey: ref.id }
    }

    const updateComment: ThreadsApi['updateComment'] = async (ref, body, options) => {
      const { repo, rkey } = await commentRef(ref, options?.signal)
      const current = await knotRecord<CommentRecord>(repo, COLLECTIONS.comment, rkey, options?.signal)
      const { 'x-tngl-editor': _editor, ...stored } = current.value
      const record: CommentRecord = {
        ...stored,
        body: { $type: 'org.tangled.markup.markdown', text: body },
      }
      if (JSON.stringify(record) !== JSON.stringify(stored)) {
        await writeKnot(repo, 'com.atproto.repo.putRecord', {
          collection: COLLECTIONS.comment,
          rkey,
          swapRecord: current.cid,
          record,
        }, options?.signal)
      }
      return toComment(requireThread(ref.thread, context), rkey, record, await actorFor(await viewerDid(), options?.signal), webUrl)
    }

    const deleteComment: ThreadsApi['deleteComment'] = async (ref, options) => {
      const { repo, rkey } = await commentRef(ref, options?.signal)
      const current = await knotRecord<CommentRecord>(repo, COLLECTIONS.comment, rkey, options?.signal)
      await writeKnot(repo, 'com.atproto.repo.deleteRecord', {
        collection: COLLECTIONS.comment,
        rkey,
        swapRecord: current.cid,
      }, options?.signal)
    }

    /** A pull request's head branch and the range its round will span, from the merge base up to the head. */
    async function pullRange(handle: RepoHandle, targetBranch: string, head: string, signal?: AbortSignal): Promise<{ base: string, head: string }> {
      const { resolveRef, mergeBaseOf } = await knot()
      const [base, headOid] = await Promise.all([
        resolveRef(handle.ref, `refs/heads/${targetBranch}`, { signal }),
        resolveRef(handle.ref, `refs/heads/${head}`, { signal }),
      ])
      if (headOid === base) {
        throw new UnsupportedOperationError(`${head} has no commits that ${targetBranch} lacks`, context)
      }
      return {
        base: await mergeBaseOf(handle.ref, base, headOid, signal) ?? base,
        head: headOid,
      }
    }

    const create: ThreadsApi['create'] = async (repo, input, options) => {
      if (input.kind === 'discussion') {
        throw new UnsupportedOperationError('Tangled has no discussions', context)
      }
      if (input.draft) {
        throw new UnsupportedOperationError('Tangled has no draft pull requests', context)
      }
      if (input.kind === 'pull_request' && !input.head) {
        throw new UnsupportedOperationError('A Tangled pull request needs a head branch', context)
      }
      if (input.head?.includes(':')) {
        throw new UnsupportedOperationError('Tangled pull requests from forks are not created yet', context)
      }
      const signal = options?.signal
      const handle = await repoFor(repo, signal)
      const assignees = input.assignees
        ? await Promise.all(input.assignees.map(assignee => didOf(assignee, signal)))
        : undefined
      const record: TicketRecord = {
        title: { $type: 'org.tangled.markup.markdown#inline', text: input.title },
        ...input.body === undefined
          ? {}
          : {
              body: { $type: 'org.tangled.markup.markdown', text: input.body },
            },
        state: 'open',
        ...input.labels
          ? { tangledLabels: await labelTokens(handle, input.labels, signal) }
          : {},
        ...assignees
          ? { assignees }
          : {},
        ...input.kind === 'pull_request'
          ? { targetBranch: input.base ?? await (await knot()).defaultBranch(repo, signal) ?? 'main' }
          : {},
        createdAt: new Date().toISOString(),
      }
      const written = await writeKnot<KnotWrite>(handle, 'com.atproto.repo.createRecord', { collection: COLLECTIONS.ticket, record }, signal)
      const rkey = parseAtUri(written.uri)!.rkey
      if (input.kind === 'pull_request') {
        try {
          const range = await pullRange(handle, record.targetBranch!, input.head!, signal)
          await writeKnot(handle, 'org.tangled.review.submitPatch', {
            patch: {
              ticket: rkey,
              base: { oid: range.base },
              head: { oid: range.head },
              sourceRepo: handle.did,
              sourceBranch: input.head,
            },
          }, signal)
        }
        catch (error) {
          // Erase the ticket again, so there is no pull without a patch.
          await writeKnot(handle, 'com.atproto.repo.deleteRecord', {
            collection: COLLECTIONS.ticket,
            rkey,
            swapRecord: written.cid,
          }, signal).catch(() => undefined)
          throw error
        }
      }
      return ticketThread(handle, rkey, record, { author: await viewerDid(), commentCount: 0 }, signal)
    }

    /** Writes the state, and reports it even where the index has yet to catch up. */
    const changeState = async (thread: ThreadRef, state: (options: { pull: boolean }) => TicketState, options?: BaseOptions): Promise<Thread> => {
      let raw: TicketState = 'open'
      let kind: TicketKind = 'issue'
      await putTicket(thread, (record) => {
        kind = ticketKind(record)
        raw = state({ pull: kind === 'pull_request' })
        return { ...record, state: raw }
      }, options?.signal)
      const { stateReason: _stale, ...read } = await readThread(thread, options)
      return {
        ...read,
        ...toThreadState(kind, raw),
        stateRaw: raw,
      }
    }

    // A completed pull request is a merged one, so only an issue closes as completed.
    const close: ThreadsApi['close'] = (thread, options) => changeState(thread, ({ pull }) => !pull && options?.reason === 'completed'
      ? 'completed'
      : 'closed', options)
    const reopen: ThreadsApi['reopen'] = (thread, options) => changeState(thread, () => 'open', options)

    const merge: ThreadsApi['merge'] = async (thread, options = {}) => {
      if (options.sha || options.whenChecksPass) {
        throw new UnsupportedOperationError('Tangled cannot check the head sha or wait for checks before merging', context)
      }
      const method = options.method ?? 'merge'
      if (method !== 'merge' && method !== 'rebase') {
        throw new UnsupportedOperationError(`Tangled merges with a merge commit or a rebase, not ${method}`, context)
      }
      const { repo, rkey, uri } = await ticketFor(thread, options.signal)
      const ticket = await knotRecord<TicketRecord>(repo, COLLECTIONS.ticket, rkey, options.signal)
      if (!ticket.value.targetBranch) {
        throw new UnsupportedOperationError('Only pull requests can be merged', context)
      }
      const patch = await latestPatch(uri, options.signal)
      if (!patch) {
        throw new NotFoundError(`No patch for ${rkey}`, 404, '', context)
      }
      await (await knot()).merge(repo.ref, ticket.value.targetBranch, patch.head.oid, {
        style: method,
        message: mergeCommitMessage(options),
        signal: options.signal,
      })
      await putTicket(thread, record => ({ ...record, state: 'completed' }), options.signal)
      return { status: 'merged' }
    }

    /** The signed-in account's own subscription record for a thread, read from its PDS. */
    async function findOwnSubscription(thread: ThreadRef, signal?: AbortSignal): Promise<{ uri: string, ignore?: boolean } | undefined> {
      const { uri } = await ticketFor(thread, signal)
      for await (const record of ownRecords<SubscriptionRecord>(COLLECTIONS.subscription, signal)) {
        if (record.value.subject.uri === uri) {
          return { uri: record.uri, ignore: record.value.ignore }
        }
      }
      return undefined
    }

    const subscription: ThreadsApi['subscription'] = async (thread, options) => {
      const found = await findOwnSubscription(thread, options?.signal)
      return found
        ? found.ignore ? 'ignored' : 'subscribed'
        : 'none'
    }
    const subscribe: ThreadsApi['subscribe'] = async (thread, options) => {
      const { uri } = await ticketFor(thread, options?.signal)
      const found = await findOwnSubscription(thread, options?.signal)
      const subject = { $type: 'org.tangled.feed.subscription#record', uri }
      if (found?.ignore) {
        await putOwnRecord(found.uri, {
          subject,
          createdAt: new Date().toISOString(),
        }, options?.signal)
      }
      else if (!found) {
        await createOwnRecord(COLLECTIONS.subscription, {
          subject,
          createdAt: new Date().toISOString(),
        }, options?.signal)
      }
    }
    const unsubscribe: ThreadsApi['unsubscribe'] = async (thread, options) => {
      const found = await findOwnSubscription(thread, options?.signal)
      if (found) {
        await deleteOwnRecord(found.uri, options?.signal)
      }
    }

    const update: ThreadsApi['update'] = async (thread, input, options) => {
      const signal = options?.signal
      const assignees = input.assignees
        ? await Promise.all(input.assignees.map(assignee => didOf(assignee, signal)))
        : undefined
      const { repo } = await ticketFor(thread, signal)
      const tokens = input.labels
        ? await labelTokens(repo, input.labels, signal)
        : undefined
      await putTicket(thread, record => ({
        ...record,
        ...input.title === undefined
          ? {}
          : {
              title: { $type: 'org.tangled.markup.markdown#inline', text: input.title },
            },
        ...input.body === undefined
          ? {}
          : {
              body: { $type: 'org.tangled.markup.markdown', text: input.body },
            },
        ...input.state === undefined
          ? {}
          : { state: input.state },
        ...tokens || input.assignees
          ? {
              tangledLabels: tokens ?? record.tangledLabels,
              assignees: input.assignees ? assignees : record.assignees,
            }
          : {},
      }), signal)
      return readThread(thread, options)
    }

    const freshLabels = async (thread: ThreadRef, options?: BaseOptions) => (await readThread(thread, options)).labels!

    const setLabels: ThreadsApi['setLabels'] = async (thread, names, options) => {
      const { repo } = await ticketFor(thread, options?.signal)
      const tokens = await labelTokens(repo, names, options?.signal)
      await putTicket(thread, record => ({ ...record, tangledLabels: tokens }), options?.signal)
      return freshLabels(thread, options)
    }
    const addLabels: ThreadsApi['addLabels'] = async (thread, names, options) => {
      const { repo } = await ticketFor(thread, options?.signal)
      const tokens = await labelTokens(repo, names, options?.signal)
      await putTicket(thread, record => ({
        ...record,
        tangledLabels: [
          ...record.tangledLabels ?? [],
          ...tokens.filter(token => !(record.tangledLabels ?? []).some(existing => existing.key === token.key)),
        ],
      }), options?.signal)
      return freshLabels(thread, options)
    }
    const removeLabels: ThreadsApi['removeLabels'] = async (thread, names, options) => {
      const { repo } = await ticketFor(thread, options?.signal)
      const tokens = await labelTokens(repo, names, options?.signal)
      await putTicket(thread, record => ({
        ...record,
        tangledLabels: (record.tangledLabels ?? []).filter(token => !tokens.some(drop => drop.key === token.key)),
      }), options?.signal)
      return freshLabels(thread, options)
    }
    const setAssignees: ThreadsApi['setAssignees'] = async (thread, assignees, options) => {
      const dids = await Promise.all(assignees.map(assignee => didOf(assignee, options?.signal)))
      await putTicket(thread, record => ({ ...record, assignees: dids }), options?.signal)
      return Promise.all(dids.map(did => actorFor(did, options?.signal)))
    }

    const react: ThreadsApi['react'] = async (target, reaction, options) => {
      const emoji = REACTION_EMOJI[reaction]
      const { subject } = await reactionSubject(target, options?.signal)
      if ((await ownReactions(subject.uri, emoji, options?.signal)).length) {
        return
      }
      await createOwnRecord(COLLECTIONS.reaction, {
        subject,
        reaction: emoji,
        createdAt: new Date().toISOString(),
      }, options?.signal)
    }
    const unreact: ThreadsApi['unreact'] = async (target, reaction, options) => {
      const { subject } = await reactionSubject(target, options?.signal)
      for (const uri of await ownReactions(subject.uri, REACTION_EMOJI[reaction], options?.signal)) {
        await deleteOwnRecord(uri, options?.signal)
      }
    }

    const notifications = writable && options.notificationsUrl
      ? createTangledNotifications(options.notificationsUrl.replace(/\/$/, ''), {
          instance,
          context,
          fetcher,
          pdsCall,
          query: records.query,
          resolveRepo: async did => (await repoByDid(did)).ref,
          actorFor,
        })
      : undefined

    const createWebSocket: WebSocketFactory = options.webSocket
      ?? (url => new globalThis.WebSocket(url) as unknown as WebSocketLike)

    const signedIn = { issue: writable, pull_request: writable } as const

    const profileOf = async (did: string, signal?: AbortSignal) => {
      const identity = await atproto.resolveDid(did, signal).catch((error: unknown) => {
        if (signal?.aborted) {
          throw error
        }
        return {} as Identity
      })
      if (!identity.pds) {
        return { profile: undefined, identity }
      }
      const { data } = await fetcher.json<{ value: { description?: string, location?: string, links?: string[], avatar?: { ref?: { $link: string } }, createdAt?: string }, cid?: string }>(
        `${identity.pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${COLLECTIONS.profile}&rkey=self`,
        { signal },
      ).catch((error: unknown) => {
        // A PDS reports a missing record as a bad request, which for a profile is the same as none.
        if (error instanceof ForgeApiError && (error.status === 400 || error.status === 404)) {
          return { data: undefined }
        }
        throw error
      })
      return { profile: data?.value, identity }
    }

    /** One page of the repositories `ownerDid` owns, from the index's listing. */
    async function listedRepos(ownerDid: string, options: PageOptions = {}): Promise<Page<Repo>> {
      const signal = options.signal
      const data = await query<{ items: Array<RecordResponse<RepoManifest>>, cursor?: string, total?: number }>('org.tangled.repo.listRepos', {
        subject: ownerDid,
        limit: Math.min(options.perPage ?? 50, 100),
        cursor: options.cursor?.token,
      }, signal)
      const items = await mapConcurrent(data.items, 4, async ({ uri }: RecordResponse<RepoManifest>) => {
        const handle = await repoByDid(parseAtUri(uri)!.did, signal)
        const counts = await repoCounts(handle.did, signal).catch((error: unknown) => {
          if (!degradesToWarning(error)) {
            throw error
          }
          return {}
        })
        return toRepo(handle, signal, counts)
      })
      return {
        items,
        ...data.total === undefined
          ? {}
          : { total: data.total },
        cursor: data.items.length && data.cursor
          ? { token: data.cursor }
          : undefined,
      }
    }

    return {
      traits: {
        eventKinds: 'native',
        authKinds: ['anonymous', 'app_password', 'oauth'],
      },
      notApplicable: [
        'users.sponsorable',
        'users.sponsorableMany',
        'threads.reviews',
        'threads.createReview',
        'threads.submitReview',
        'threads.approve',
        'threads.replyToReviewComment',
        'threads.reviewThreads',
        'threads.resolveReviewThread',
        'threads.requestReview',
        'threads.checks',
        'checks.list',
        'checks.get',
        'checks.report',
        'checks.rerun',
        'releases.list',
        'releases.get',
        'releases.latest',
        'releases.getByTag',
        'releases.downloadAsset',
        'releases.create',
        'releases.update',
        'securityAlerts.list',
        'users.block',
        'orgs.block',
        'repos.templates',
        'threads.hideComment',
        'threads.lock',
        'threads.updateBranch',
        'repos.issueTypes',
        'threads.setIssueType',
      ],
      request: api,
      repos: {
        get: verb(true, async (ref, options) => {
          const handle = await repoFor(ref, options?.signal)
          const counts = await repoCounts(handle.did, options?.signal).catch((error: unknown) => {
            if (!degradesToWarning(error)) {
              throw error
            }
            return {}
          })
          return toRepo(handle, options?.signal, counts)
        }),
        collaboratorsPage: verb(true, collaboratorsPage),
        addCollaborator: verb(writable, async (repo, actor, role, options) => {
          if (role !== 'write') {
            throw new UnsupportedOperationError('Tangled collaborators can push; `write` is the only role', context)
          }
          await (await knot()).addCollaborator(repo, await didOf(actor, options?.signal), options?.signal)
          return { status: 'added' }
        }),
        permissionFor: verb(true, (repo, actor, options) => permissionFor(repo, actor, options)),
        labelsPage: verb(true, async (repo, options: PageOptions = {}): Promise<Page<Label>> => {
          const handle = await repoFor(repo, options.signal)
          return {
            items: [
              ...(await repoLabels(handle.did, options.signal)).values(),
            ].map(toLabel),
          }
        }),
        createLabel: verb(writable, async (repo, input, options) => {
          const handle = await repoFor(repo, options?.signal)
          if (handle.ref.owner !== await viewerDid()) {
            throw new InsufficientScopeError('Only the repo owner can add a label to its repository', 403, '', context)
          }
          const slug = input.name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._~-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64)
          await writeKnot(handle, 'com.atproto.repo.createRecord', {
            collection: COLLECTIONS.labelDefinition,
            rkey: slug,
            record: {
              $type: COLLECTIONS.labelDefinition,
              name: input.name,
              ...input.colour
                ? { color: `#${input.colour}` }
                : {},
              createdAt: new Date().toISOString(),
            },
          }, options?.signal)
          forgetLabels(handle.did)
          return { name: input.name, colour: input.colour }
        }),
        listPage: verb(writable, async (listOptions: PageOptions = {}): Promise<Page<Repo>> => listedRepos(await viewerDid(), listOptions)),
        byOwnerPage: verb(true, async (owner, query = {}) => listedRepos(await didOf(owner.owner, query.signal), query)),
      },
      notifications,
      contents: {
        getFile: contentsVerb('file'),
        treePage: contentsVerb('treePage'),
        branchesPage: contentsVerb('branchesPage'),
        tagsPage: contentsVerb('tagsPage'),
        resolveRef: contentsVerb('resolveRef'),
        compare: contentsVerb('compare'),
      },
      commits: {
        listPage: contentsVerb('commitsPage'),
        get: verb(true, async ({ repo, sha }, options) => (await knot()).commit(repo, sha, options)),
      },
      users: {
        get: verb(true, async (login, options) => {
          const handle = login.replace(/^@/, '')
          const did = handle.startsWith('did:')
            ? handle
            : await atproto.resolveHandle(handle, options?.signal)
          const [actor, { profile, identity }] = await Promise.all([
            actorFor(did, options?.signal),
            profileOf(did, options?.signal),
          ])
          const avatar = profile?.avatar?.ref?.$link
          return {
            ...actor,
            bio: profile?.description || undefined,
            location: profile?.location || undefined,
            websiteUrl: profile?.links?.find(Boolean),
            avatarUrl: avatar && 'pds' in identity && identity.pds
              ? `${identity.pds.replace(/\/$/, '')}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${avatar}`
              : undefined,
            raw: profile ?? identity,
          }
        }),
        me: verb(writable, async (options?: BaseOptions) => ({
          ...await actorFor(await viewerDid(), options?.signal),
          raw: undefined,
        })),
        eventsPage: verb(true, async (login, listOptions = {}) => {
          const handle = login.replace(/^@/, '')
          const did = handle.startsWith('did:')
            ? handle
            : await atproto.resolveHandle(handle, listOptions.signal)
          return accountFeedPage({
            listActivity: (collection, listingOptions) => listActivity(did, collection, listingOptions),
            recordEvent,
          }, did, listOptions)
        }),
      },
      threads: {
        ...threads,
        createComment: perKind(signedIn, createComment),
        updateComment: perKind(signedIn, updateComment),
        deleteComment: perKind(signedIn, deleteComment),
        create: perKind(signedIn, create),
        merge: verb(writable, merge),
        update: perKind(signedIn, update),
        close: perKind(signedIn, close),
        reopen: perKind(signedIn, reopen),
        subscriptions: perKind(signedIn, { subscription, subscribe, unsubscribe }),
        reactionsPage: perKind(ISSUE_AND_PULL, reactionsPage),
        reactions: perKind(signedIn, { react, unreact }),
        setLabels: perKind(signedIn, setLabels),
        addLabels: perKind(signedIn, addLabels),
        removeLabels: perKind(signedIn, removeLabels),
        setAssignees: perKind(signedIn, setAssignees),
        getComment: perKind(ISSUE_AND_PULL, getComment),
      },
      search: {
        threadsPage: verb(true, searchThreadsPage),
        reposPage: verb(true, searchReposPage),
        queryRaw: true,
      },
      sources: {
        stream: verb(true, streamOptions => subscribeJetstream({
          ...streamOptions,
          url: options.jetstreamUrl ?? 'wss://jetstream2.us-east.bsky.network/subscribe',
          collections: THREAD_COLLECTIONS,
          createWebSocket,
          toEvent: toStreamEvent,
          context,
        })),
      },
      web: TANGLED_WEB.links({ baseUrl: webUrl, instance }),
      scopes: () => ({ note: 'An atproto app password or OAuth session; Tangled has no per-verb scopes' }),
      webhooks: writable
        ? createTangledWebhooks({
            instance,
            context,
            fetcher,
            repoFor,
            serviceAuth,
          })
        : {},
    }
  },
}

/** Creates a Tangled provider. Records are read from the index; pushes arrive through Jetstream. */
export const tangled: ProviderFactoryFunction<TangledOptions, true, 'tangled'> = /* @__PURE__ */ defineForgeProvider(TANGLED)
