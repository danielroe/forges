import type { ProviderDefinition, ProviderFactoryFunction } from '../define.ts'
import type { FetchLike } from '../fetch.ts'
import type {
  Actor,
  BaseOptions,
  ChangedFile,
  CommentRef,
  Commit,
  ForgeEventInput,
  Label,
  ListOptions,
  Page,
  PageOptions,
  Repo,
  RepoRef,
  ThreadCreateInput,
  ThreadKind,
  ThreadRef,
  ThreadUpdateInput,
} from '../model.ts'
import type { AnonymousAuth, ForgeOptionsBase, ReposApi, ThreadsApi } from '../provider.ts'
import type { TangledContents } from './knot.ts'
import type { TangledLabels } from './records.ts'
import type { WebSocketFactory, WebSocketLike } from './subscribe.ts'
import type { FeedCommentRecord, IssueRecord, LabelDefinitionRecord, ProfileRecord, PullRecord, ReactionRecord, RepoRecord } from './types.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import {
  InsufficientScopeError,
  NotFoundError,
  UnsupportedOperationError,
} from '../errors.ts'
import { degradesToWarning, forgeIterable, getManyConcurrently } from '../utils.ts'
import { atUri, createAtprotoClient, parseAtUri } from './atproto.ts'
import { accountFeedPage } from './feed.ts'
import {
  COLLECTIONS,
  FORGE,
  isAssigneeLabel,
  REACTION_EMOJI,
  THREAD_COLLECTIONS,
  toActivityEvent,
  toLabel,
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
   * resulting capabilities report `'experimental'`, or `'unverified'`.
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

const TANGLED: ProviderDefinition<TangledOptions, undefined, true> = {
  forge: FORGE,
  hasWeb: true,
  experimental: true,
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
    const { writable, viewerDid, pdsCall, createRecord, putOwnRecord, deleteOwnRecord, ownRecords, serviceAuth, uploadBlob } = createTangledSession({ options, fetcher, atproto, context })

    /** The repo DID a thread record must reference, from the ref or the repo record. */
    const { forgetRepos, forgetCollaborators, labelsOf, repoLabels, threadUri, reactionsPage, collaboratorsPage, permissionFor, stateAuthors, actorFor, resolveRepo, threadFor, subjectUri, activity, recordEvent, toStreamEvent, canonicalRepo, canonicalRef, repoDidOf, toRepo, repoCounts, readThread, wholePage, listPage, listComments, findSubscription } = createTangledRecords({ options, instance, webUrl, context, atproto, api, fetcher, ownRecords })

    let loaded: Promise<TangledContents> | undefined
    const knot = () => loaded ??= import('./knot.ts').then(({ createTangledContents }) => createTangledContents({ fetcher, instance, webUrl, context, canonicalRepo, serviceAuth }))
    const contentsVerb = <K extends Exclude<keyof TangledContents, 'defaultBranch'>>(name: K) =>
      verb(true, (async (...args: unknown[]) => ((await knot())[name] as (...args: unknown[]) => unknown)(...args)) as unknown as TangledContents[K])

    /** The latest round of a pull, from its patch blob or, in older records, its inline patch. */
    async function pullPatch(thread: ThreadRef, signal?: AbortSignal) {
      const { uri, kind } = subjectUri(thread)
      if (kind !== 'pull_request') {
        throw new UnsupportedOperationError('Only pull requests have changed files and commits', context)
      }
      const { ref, record } = await threadFor(atUri(uri.did, uri.collection, uri.rkey), signal)
      const pull = record as PullRecord
      const blob = pull.rounds?.at(-1)?.patchBlob
      const text = blob ? await patchText(await atproto.getBlob(uri.did, blob.ref.$link, signal)) : pull.patch
      if (text === undefined) {
        throw new NotFoundError(`${ref.number} has no patch`, 404, '', context)
      }
      return { ref, record: pull, text, patch: await import('./patch.ts') }
    }

    const threads = {
      get: perKind(ISSUE_AND_PULL, readThread),
      getMany: verb(true, (refs: ThreadRef[], options?: BaseOptions) => getManyConcurrently(refs, readThread, options)),
      listPage: perKind({ issue: true, pull_request: true }, listPage),
      eventsPage: verb(true, async (thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> => {
        const { ref, uri, kind } = subjectUri(thread)
        const target = atUri(uri.did, uri.collection, uri.rkey)
        return wholePage(forgeIterable(async function* (warn) {
          const events: ForgeEventInput[] = []
          for await (const item of activity(target, kind, await stateAuthors(uri.did, ref.repo, warn, listOptions.signal), warn, listOptions)) {
            const author = parseAtUri(item.uri)!.did
            events.push(toActivityEvent(instance, { ...item, operation: 'create' }, await actorFor(author, listOptions.signal), ref, 'poll', new Date(0)))
          }
          yield* events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        }))
      }),
      filesPage: verb(true, async (thread: ThreadRef, listOptions?: PageOptions): Promise<Page<ChangedFile>> => {
        const { text, patch } = await pullPatch(thread, listOptions?.signal)
        return patch.patchFiles(patch.parsePatch(text))
      }),
      commitsPage: verb(true, async (thread: ThreadRef, listOptions?: PageOptions): Promise<Page<Commit>> => {
        const { ref, text, patch } = await pullPatch(thread, listOptions?.signal)
        return { items: patch.patchCommits(patch.parsePatch(text), { forge: FORGE, instance, repo: ref.repo }) }
      }),
      commentsPage: perKind(ISSUE_AND_PULL, (thread: ThreadRef, listOptions?: ListOptions) => wholePage(listComments(thread, listOptions))),
    }

    const comment: ThreadsApi['comment'] = async (thread, body, options) => {
      const { ref, uri } = subjectUri(thread)
      const target = atUri(uri.did, uri.collection, uri.rkey)
      const { cid } = await atproto.getRecord(target, options?.signal)
      const record: FeedCommentRecord = {
        body: { $type: 'sh.tangled.markup.markdown', text: body, original: body },
        subject: { uri: target, cid: cid ?? '' },
        createdAt: new Date().toISOString(),
      }
      const created = await createRecord(COLLECTIONS.comment, { ...record }, options?.signal)
      return toRecordComment(ref, created.uri, record, await actorFor(await viewerDid(), options?.signal))
    }
    const editComment: ThreadsApi['editComment'] = async (ref, body, options) => {
      const record = await putOwnRecord(ref.id, current => ({
        ...current,
        body: typeof (current as FeedCommentRecord).body === 'string' ? body : { $type: 'sh.tangled.markup.markdown', text: body, original: body },
      }), options?.signal)
      return toRecordComment(ref.thread, ref.id, record as FeedCommentRecord, await actorFor(await viewerDid(), options?.signal))
    }
    const deleteComment: ThreadsApi['deleteComment'] = (ref, options) => deleteOwnRecord(ref.id, options?.signal)
    const didOf = async (actor: string | Actor, signal?: AbortSignal) => {
      const login = typeof actor === 'string' ? actor.replace(/^@/, '') : actor.id
      return login.startsWith('did:') ? login : atproto.resolveHandle(login, signal)
    }
    const resolveActor = async (actor: string, signal?: AbortSignal) => actorFor(await didOf(actor, signal), signal)

    /** A pull from `head` to `base` in the same repo, carrying the knot's format-patch of `head` as its first round. */
    async function pullRecord(repo: RepoRef, repoDid: string, input: ThreadCreateInput, signal?: AbortSignal): Promise<PullRecord> {
      if (!input.head) {
        throw new UnsupportedOperationError('A Tangled pull request needs a head branch', context)
      }
      if (input.head.includes(':')) {
        throw new UnsupportedOperationError('Tangled pull requests from forks are not created yet', context)
      }
      if (input.draft) {
        throw new UnsupportedOperationError('Tangled has no draft pull requests', context)
      }
      const contents = await knot()
      const base = input.base ?? await contents.defaultBranch(repo, signal)
      if (!base) {
        throw new UnsupportedOperationError('The repo reports no default branch; pass `base`', context)
      }
      const patch = await contents.formatPatch(repo, base, input.head, signal)
      if (!patch.trim()) {
        throw new UnsupportedOperationError(`${input.head} has no commits that ${base} lacks`, context)
      }
      const compressed = new Uint8Array(await new Response(new Blob([patch]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
      const now = new Date().toISOString()
      return {
        title: input.title,
        ...input.body === undefined ? {} : { body: input.body },
        target: { repo: repoDid, branch: base },
        source: { branch: input.head },
        rounds: [{ createdAt: now, patchBlob: await uploadBlob(compressed, 'application/gzip', signal) }],
        createdAt: now,
      }
    }

    const editRecord = async (thread: ThreadRef, input: ThreadUpdateInput, signal?: AbortSignal) => {
      const { ref, uri } = subjectUri(thread)
      const record = await putOwnRecord(atUri(uri.did, uri.collection, uri.rkey), current => ({
        ...current,
        ...input.title === undefined ? {} : { title: input.title },
        ...input.body === undefined ? {} : { body: input.body },
      }), signal)
      return toThread(ref, record as IssueRecord | PullRecord, await actorFor(uri.did, signal), {}, 0)
    }
    const subscription: ThreadsApi['subscription'] = async (thread, options) => await findSubscription(thread, options?.signal) ? 'subscribed' : 'none'
    const subscribe: ThreadsApi['subscribe'] = async (thread, options) => {
      if (await findSubscription(thread, options?.signal)) {
        return
      }
      const { uri } = subjectUri(thread)
      await createRecord(COLLECTIONS.subscription, {
        subject: { $type: `${COLLECTIONS.subscription}#uri`, uri: atUri(uri.did, uri.collection, uri.rkey) },
        createdAt: new Date().toISOString(),
      }, options?.signal)
    }
    const unsubscribe: ThreadsApi['unsubscribe'] = async (thread, options) => {
      const existing = await findSubscription(thread, options?.signal)
      if (existing) {
        await deleteOwnRecord(existing, options?.signal)
      }
    }
    const setState = async (thread: ThreadRef, state: 'open' | 'closed' | 'merged', signal?: AbortSignal) => {
      const { uri, kind } = subjectUri(thread)
      const target = atUri(uri.did, uri.collection, uri.rkey)
      const { ref } = await threadFor(target, signal)
      const [viewer, allowed] = await Promise.all([viewerDid(), stateAuthors(uri.did, ref.repo, undefined, signal)])
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
        : { pull: target, status: `${COLLECTIONS.pullStatus}.${state}`, createdAt: new Date().toISOString() }, signal)
    }
    const merge: ThreadsApi['merge'] = async (thread, options = {}) => {
      if (options.method && options.method !== 'rebase') {
        throw new UnsupportedOperationError('Tangled applies the commits of a pull onto its target branch, so only `rebase` merges', context)
      }
      if (options.sha || options.whenChecksPass) {
        throw new UnsupportedOperationError('Tangled cannot check the head sha or wait for checks before merging', context)
      }
      const { ref, record, text } = await pullPatch(thread, options.signal)
      await (await knot()).merge(ref.repo, record.target.branch, text, options.signal)
      await setState(ref, 'merged', options.signal)
    }
    const addCollaborator: ReposApi['addCollaborator'] = async (repo, actor, role, options) => {
      if (role !== 'write') {
        throw new UnsupportedOperationError('Tangled collaborators can push; `write` is the only role', context)
      }
      await (await knot()).addCollaborator(repo, await didOf(actor, options?.signal), options?.signal)
      forgetCollaborators()
      return { status: 'added' }
    }
    const close: ThreadsApi['close'] = (thread, options) => setState(thread, 'closed', options?.signal)
    const reopen: ThreadsApi['reopen'] = (thread, options) => setState(thread, 'open', options?.signal)

    /** Writes one label op that moves the thread's labels to what `change` returns, given the current values per definition. */
    async function changeLabels(thread: ThreadRef, signal: AbortSignal | undefined, change: (labels: TangledLabels) => Array<{ key: string, value: string, add: boolean }>) {
      const { uri } = subjectUri(thread)
      const target = atUri(uri.did, uri.collection, uri.rkey)
      const { ref } = await threadFor(target, signal)
      const warn = () => {}
      const [viewer, allowed, definitions, { state }] = await Promise.all([
        viewerDid(),
        stateAuthors(ref.repo.owner, ref.repo, warn, signal),
        repoLabels(ref.repo, warn, signal),
        labelsOf(target, ref.repo, warn, signal),
      ])
      if (!allowed.has(viewer)) {
        throw new InsufficientScopeError('Only the repo owner or a collaborator can change labels; the appview would ignore the record', 403, '', context)
      }
      const usable = definitions.filter(({ definition }) => !definition.scope?.length || definition.scope.includes(uri.collection))
      const operands = change({ definitions: usable, state })
      if (!operands.length) {
        return
      }
      await createRecord(COLLECTIONS.labelOp, {
        subject: target,
        add: operands.filter(operand => operand.add).map(({ key, value }) => ({ key, value })),
        delete: operands.filter(operand => !operand.add).map(({ key, value }) => ({ key, value })),
        performedAt: new Date().toISOString(),
      }, signal)
    }

    /** The definition and value each label name names: `name` for a label without values, `name:value` otherwise. */
    function operandsFor({ definitions }: TangledLabels, names: string[]) {
      return names.map((name) => {
        const found = definitions.find(({ definition }) => !isAssigneeLabel(definition) && (!definition.valueType || definition.valueType.type === 'null'
          ? name === definition.name
          : name.startsWith(`${definition.name}:`)))
        if (!found) {
          throw new NotFoundError(`No label named ${name} in this repository`, 404, '', context)
        }
        return { key: found.uri, value: name === found.definition.name ? 'null' : name.slice(found.definition.name.length + 1) }
      })
    }

    const labelled = ({ definitions, state }: TangledLabels) => definitions
      .filter(({ definition }) => !isAssigneeLabel(definition))
      .flatMap(({ uri }) => [...state.get(uri) ?? []].map(value => ({ key: uri, value })))
    const has = (list: Array<{ key: string, value: string }>, item: { key: string, value: string }) => list.some(other => other.key === item.key && other.value === item.value)

    /** What moves the thread's labels to `names`, leaving the assignee label alone. */
    const labelChanges = (labels: TangledLabels, names: string[]) => {
      const wanted = operandsFor(labels, names)
      const current = labelled(labels)
      return [
        ...current.filter(item => !has(wanted, item)).map(item => ({ ...item, add: false })),
        ...wanted.filter(item => !has(current, item)).map(item => ({ ...item, add: true })),
      ]
    }
    /** What moves the thread's assignee label to `dids`; a repo without one has nothing to clear. */
    const assigneeChanges = ({ definitions, state }: TangledLabels, dids: string[]) => {
      const assignee = definitions.find(({ definition }) => isAssigneeLabel(definition))
      if (!assignee) {
        if (!dids.length) {
          return []
        }
        throw new UnsupportedOperationError('This repository has no assignee label', context)
      }
      const current = [...state.get(assignee.uri) ?? []]
      return [
        ...current.filter(did => !dids.includes(did)).map(value => ({ key: assignee.uri, value, add: false })),
        ...[...new Set(dids)].filter(did => !current.includes(did)).map(value => ({ key: assignee.uri, value, add: true })),
      ]
    }

    const setLabels: ThreadsApi['setLabels'] = (thread, names, options) => changeLabels(thread, options?.signal, labels => labelChanges(labels, names))
    const addLabels: ThreadsApi['addLabels'] = (thread, names, options) => changeLabels(thread, options?.signal, (labels) => {
      const current = labelled(labels)
      return operandsFor(labels, names).filter(item => !has(current, item)).map(item => ({ ...item, add: true }))
    })
    const removeLabels: ThreadsApi['removeLabels'] = (thread, names, options) => changeLabels(thread, options?.signal, (labels) => {
      const current = labelled(labels)
      return current.filter(item => names.includes(toLabel(labels.definitions.find(({ uri }) => uri === item.key)!.definition, item.value).name)).map(item => ({ ...item, add: false }))
    })
    const setAssignees: ThreadsApi['setAssignees'] = async (thread, assignees, options) => {
      const dids = await Promise.all(assignees.map(assignee => didOf(assignee, options?.signal)))
      await changeLabels(thread, options?.signal, labels => assigneeChanges(labels, dids))
    }
    /** Labels and assignees go in one label op, written first so an unknown name fails before any other write. The returned thread reflects the writes, since the backlink index lags. */
    const update: ThreadsApi['update'] = async (thread, input, options) => {
      const signal = options?.signal
      if (!input.state && !input.labels && !input.assignees) {
        return editRecord(thread, input, signal)
      }
      const edits = input.title !== undefined || input.body !== undefined
      if (edits && subjectUri(thread).uri.did !== await viewerDid()) {
        throw new InsufficientScopeError('Records can only be edited by the account that wrote them', 403, '', context)
      }
      const dids = input.assignees && await Promise.all(input.assignees.map(assignee => didOf(assignee, signal)))
      let written: Label[] | undefined
      if (input.labels || dids) {
        await changeLabels(thread, signal, (labels) => {
          written = input.labels && operandsFor(labels, input.labels).map(({ key, value }) => toLabel(labels.definitions.find(({ uri }) => uri === key)!.definition, value))
          return [...input.labels ? labelChanges(labels, input.labels) : [], ...dids ? assigneeChanges(labels, dids) : []]
        })
      }
      if (input.state) {
        await setState(thread, input.state, signal)
      }
      if (edits) {
        await editRecord(thread, input, signal)
      }
      const current = await readThread(thread, options)
      return {
        ...current,
        state: input.state ?? current.state,
        labels: written ?? current.labels,
        assignees: dids ? await Promise.all([...new Set(dids)].map(did => actorFor(did, signal))) : current.assignees,
      }
    }

    const create: ThreadsApi['create'] = async (repo, input, options) => {
      if (input.kind === 'discussion') {
        throw new UnsupportedOperationError('Tangled has no discussions', context)
      }
      const [address, repoDid] = await Promise.all([canonicalRef(repo, options?.signal), repoDidOf(repo, options?.signal)])
      const record: IssueRecord | PullRecord = input.kind === 'issue'
        ? { repo: repoDid, title: input.title, body: input.body, createdAt: new Date().toISOString() }
        : await pullRecord(address, repoDid, input, options?.signal)
      const created = await createRecord(input.kind === 'issue' ? COLLECTIONS.issue : COLLECTIONS.pull, { ...record }, options?.signal)
      const ref = toThreadRef(instance, { ...address, externalId: repoDid }, parseAtUri(created.uri)!)
      if (input.labels?.length) {
        await setLabels(ref, input.labels, options)
      }
      if (input.assignees?.length) {
        await setAssignees(ref, input.assignees, options)
      }
      return {
        ...toThread(ref, record, await actorFor(await viewerDid(), options?.signal), {}, 0),
        labels: (input.labels ?? []).map(name => ({ name })),
        assignees: await Promise.all((input.assignees ?? []).map(assignee => typeof assignee === 'string' ? resolveActor(assignee, options?.signal) : assignee)),
      }
    }

    const createLabel: ReposApi['createLabel'] = async (repo, input, options) => {
      const { ref, record } = await canonicalRepo(repo, options?.signal)
      if (ref.owner !== await viewerDid()) {
        throw new InsufficientScopeError('Only the repo owner can add a label to its repo record', 403, '', context)
      }
      const definition: LabelDefinitionRecord = {
        name: input.name,
        ...input.colour ? { color: `#${input.colour}` } : {},
        valueType: { type: 'null', format: 'any' },
        scope: [COLLECTIONS.issue, COLLECTIONS.pull],
        multiple: false,
        createdAt: new Date().toISOString(),
      }
      const created = await createRecord(COLLECTIONS.labelDefinition, { ...definition }, options?.signal)
      await putOwnRecord(record.uri, current => ({ ...current, labels: [...(current as RepoRecord).labels ?? [], created.uri] }) as RepoRecord, options?.signal)
      forgetRepos()
      return { name: input.name, colour: input.colour }
    }

    /** The account's own reactions on `subject`, as AT-URIs. */
    async function ownReactions(subject: string, emoji: string, signal?: AbortSignal): Promise<string[]> {
      const found: string[] = []
      for await (const record of ownRecords<ReactionRecord>(COLLECTIONS.reaction, signal)) {
        if (record.value.subject === subject && record.value.reaction === emoji) {
          found.push(record.uri)
        }
      }
      return found
    }
    const reactionSubject = (target: ThreadRef | CommentRef) => 'thread' in target ? target.id : threadUri(target)
    const react: ThreadsApi['react'] = async (target, reaction, options) => {
      const subject = reactionSubject(target)
      const emoji = REACTION_EMOJI[reaction]
      if ((await ownReactions(subject, emoji, options?.signal)).length) {
        return
      }
      await createRecord(COLLECTIONS.reaction, { subject, reaction: emoji, createdAt: new Date().toISOString() }, options?.signal)
    }
    const unreact: ThreadsApi['unreact'] = async (target, reaction, options) => {
      for (const uri of await ownReactions(reactionSubject(target), REACTION_EMOJI[reaction], options?.signal)) {
        await deleteOwnRecord(uri, options?.signal)
      }
    }

    const notificationsUrl = options.notificationsUrl?.replace(/\/$/, '')
    const notifications = writable && notificationsUrl
      ? createTangledNotifications(notificationsUrl, { instance, context, fetcher, atproto, pdsCall, resolveRepo, actorFor })
      : undefined

    const createWebSocket: WebSocketFactory = options.webSocket
      ?? (url => new globalThis.WebSocket(url) as unknown as WebSocketLike)

    const signedIn = { issue: writable, pull_request: writable } as const
    return {
      traits: { eventKinds: 'native', authKinds: ['anonymous', 'app_password', 'oauth'] },
      request: api,
      repos: {
        get: verb(true, async (ref, options) => {
          const { ref: found, record } = await canonicalRepo(ref, options?.signal)
          const [defaultBranch, counts] = await Promise.all([
            knot().then(contents => contents.defaultBranch(found, options?.signal)).catch((error: unknown) => {
              if (!degradesToWarning(error)) {
                throw error
              }
              return undefined
            }),
            repoCounts(record, options?.signal),
          ])
          return { ...toRepo(found, record.value, record, counts), defaultBranch }
        }),
        collaboratorsPage: verb(true, collaboratorsPage),
        addCollaborator: verb(writable, addCollaborator),
        permissionFor: verb(true, permissionFor),
        labelsPage: verb(true, (repo: RepoRef, listOptions: PageOptions = {}): Promise<Page<Label>> => wholePage(forgeIterable(async function* (warn) {
          for (const { definition } of await repoLabels(repo, warn, listOptions.signal)) {
            if (!isAssigneeLabel(definition)) {
              yield { name: definition.name, colour: definition.color?.replace(/^#/, '') }
            }
          }
        }))),
        createLabel: verb(writable, createLabel),
        listPage: verb(writable, async (listOptions: PageOptions = {}): Promise<Page<Repo>> => {
          if (!writable) {
            throw new UnsupportedOperationError('Listing your repositories needs auth', context)
          }
          return wholePage(forgeIterable(async function* () {
            const owner = await viewerDid()
            for await (const record of ownRecords<RepoRecord>(COLLECTIONS.repo, listOptions.signal)) {
              const rkey = parseAtUri(record.uri)!.rkey
              yield toRepo({ forge: FORGE, instance, owner, name: rkey }, record.value, record)
            }
          }))
        }),
        byOwnerPage: verb(true, (owner, query = {}) => wholePage(forgeIterable(async function* (warn) {
          if (query.sort) {
            warn({ code: 'sort_unsupported', message: 'Tangled lists repositories in the order of their records' })
          }
          const did = owner.owner.startsWith('did:') ? owner.owner : await atproto.resolveHandle(owner.owner.replace(/^@/, ''), query.signal)
          for await (const record of atproto.listRecords<RepoRecord>(did, COLLECTIONS.repo, query.signal)) {
            yield toRepo({ forge: FORGE, instance, owner: did, name: parseAtUri(record.uri)!.rkey }, record.value, record)
          }
        }))),
      },
      notifications,
      contents: {
        file: contentsVerb('file'),
        treePage: contentsVerb('treePage'),
        branchesPage: contentsVerb('branchesPage'),
        tagsPage: contentsVerb('tagsPage'),
        resolveRef: contentsVerb('resolveRef'),
        commitsPage: contentsVerb('commitsPage'),
        commit: contentsVerb('commit'),
        compare: contentsVerb('compare'),
      },
      users: {
        get: verb(true, async (login, options) => {
          const handle = login.replace(/^@/, '')
          const did = handle.startsWith('did:') ? handle : await atproto.resolveHandle(handle, options?.signal)
          const [actor, identity, profile] = await Promise.all([
            actorFor(did, options?.signal),
            atproto.resolveDid(did, options?.signal),
            atproto.getRecord<ProfileRecord>(atUri(did, COLLECTIONS.profile, 'self'), options?.signal).then(({ value }) => value, (error: unknown) => {
              if (error instanceof NotFoundError) {
                return undefined
              }
              throw error
            }),
          ])
          const avatar = profile?.avatar?.ref.$link
          return {
            ...actor,
            bio: profile?.description || undefined,
            location: profile?.location || undefined,
            websiteUrl: profile?.links?.find(Boolean),
            avatarUrl: avatar && identity.pds ? `${identity.pds.replace(/\/$/, '')}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${avatar}` : undefined,
            raw: profile ?? identity,
          }
        }),
        me: verb(writable, async (options?: BaseOptions) => ({ ...await actorFor(await viewerDid(), options?.signal), raw: undefined })),
        eventsPage: verb(true, async (login, listOptions = {}) => {
          const handle = login.replace(/^@/, '')
          const did = handle.startsWith('did:') ? handle : await atproto.resolveHandle(handle, listOptions.signal)
          return accountFeedPage({ atproto, recordEvent }, did, listOptions)
        }),
      },
      threads: {
        ...threads,
        comment: perKind(signedIn, comment),
        editComment: perKind(signedIn, editComment),
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

async function patchText(bytes: Uint8Array): Promise<string> {
  if (bytes[0] !== 0x1F || bytes[1] !== 0x8B) {
    return new TextDecoder().decode(bytes)
  }
  return new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
}

/** Creates a Tangled provider. Records are read from PDSes; pushes arrive through Jetstream. */
export const tangled: ProviderFactoryFunction<TangledOptions, true, 'tangled', true> = /* @__PURE__ */ defineForgeProvider({ ...TANGLED, webhooks: tangledWebhooks })

/** `tangled()` without webhook ingestion, for bundles that never receive a delivery. */
export const tangledLite: ProviderFactoryFunction<TangledOptions, true, 'tangled', true> = /* @__PURE__ */ defineForgeProvider(TANGLED)
