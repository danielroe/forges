import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher } from '../fetch.ts'
import type {
  Actor,
  BaseOptions,
  Collaborator,
  Comment,
  CommentRef,
  Cursor,
  ForgeEventInput,
  ForgeWarning,
  Label,
  Page,
  Reaction,
  ReactionContent,
  Repo,
  RepoRef,
  RepoRole,
  ResolvedThreadRef,
  SourceKind,
  Thread,
  ThreadQuery,
  ThreadRef,
} from '../model.ts'
import type { ForgeIterable } from '../provider.ts'
import type { AtprotoClient, AtUri } from './atproto.ts'
import type { TangledOptions } from './index.ts'
import type { ActivityRecord, ThreadRead } from './normalise.ts'
import type { TangledSession } from './session.ts'
import type { FeedCommentRecord, IssueRecord, JetstreamCommitEvent, LabelDefinitionRecord, LabelOpRecord, PullRecord, ReactionRecord, RecordResponse, RepoRecord, StateRecord, SubscriptionRecord, TangledRecord } from './types.ts'
import { ForgeApiError, ForgeError, NotFoundError, RateLimitedError, UnresolvedThreadError } from '../errors.ts'
import { abortable } from '../fetch.ts'
import { degradesToWarning, forgeIterable, isFirstPage, mapConcurrent, phased, requireThread, toDate, toWarning } from '../utils.ts'
import { atUri, parseAtUri } from './atproto.ts'
import {
  COLLECTIONS,
  FORGE,
  isAssigneeLabel,
  REACTION_EMOJI,
  stateToken,
  subjectOf,
  threadKindOf,
  toActivityEvent,
  toActor,
  toLabel,
  toRecordComment,
  toThread,
  toThreadRef,
} from './normalise.ts'

const TANGLED_DID = 'did:plc:wshs7t2adsemcrrd4snkeqli'

/** Knots that accept git over SSH on a different host. */
const DEFAULT_SSH_HOSTS: Record<string, string> = {
  'knot1.tangled.sh': 'tangled.org',
}

const REACTIONS: Record<string, ReactionContent> = Object.fromEntries(Object.entries(REACTION_EMOJI).map(([name, emoji]) => [emoji, name as ReactionContent]))

/** A repo's label definitions, and the values each definition has on a thread. */
export interface TangledLabels {
  definitions: Array<{ uri: string, definition: LabelDefinitionRecord }>
  state: Map<string, Set<string>>
}

/** Applies one label operand to `state`: a value replaces the value of a definition that takes one, and joins the rest. */
export function applyLabelOp(state: Map<string, Set<string>>, definition: LabelDefinitionRecord, { add, key, value }: { add: boolean, key: string, value: string }): void {
  const values = state.get(key)
  if (add) {
    state.set(key, definition.multiple ? new Set([...values ?? [], value]) : new Set([value]))
  }
  else if (values?.has(value)) {
    if (definition.multiple) {
      values.delete(value)
    }
    else {
      state.delete(key)
    }
  }
}

/** The labels and assignee DIDs that `state` holds. */
export function labelsIn(state: Map<string, Set<string>>, definitions: Map<string, LabelDefinitionRecord | undefined>): { labels: Label[], assignees: string[] } {
  const labels: Label[] = []
  const assignees: string[] = []
  for (const [key, values] of state) {
    const definition = definitions.get(key)
    if (!definition) {
      continue
    }
    if (isAssigneeLabel(definition)) {
      assignees.push(...values)
      continue
    }
    for (const value of values) {
      labels.push(toLabel(definition, value))
    }
  }
  return { labels, assignees }
}

const OWNER_PERMISSIONS = { admin: true, maintain: true, push: true, triage: true, pull: true }
const COLLABORATOR_PERMISSIONS = { admin: false, maintain: false, push: true, triage: true, pull: true }

export const STATE_COLLECTION: Record<'issue' | 'pull_request', { collection: string, path: string }> = {
  issue: { collection: COLLECTIONS.issueState, path: '.issue' },
  pull_request: { collection: COLLECTIONS.pullStatus, path: '.pull' },
}

const COMMENT_SOURCES: Record<'issue' | 'pull_request', Array<{ collection: string, path: string }>> = {
  issue: [
    { collection: COLLECTIONS.comment, path: '.subject.uri' },
    { collection: COLLECTIONS.issueComment, path: '.issue' },
  ],
  pull_request: [
    { collection: COLLECTIONS.comment, path: '.subject.uri' },
    { collection: COLLECTIONS.pullComment, path: '.pull' },
  ],
}

function ACTIVITY_SOURCES(kind: 'issue' | 'pull_request') {
  return [
    ...COMMENT_SOURCES[kind],
    STATE_COLLECTION[kind],
    { collection: COLLECTIONS.reaction, path: '.subject' },
    { collection: COLLECTIONS.labelOp, path: '.subject' },
  ]
}

interface RecordDeps extends Pick<TangledSession, 'ownRecords'> {
  options: TangledOptions
  instance: string
  webUrl: string
  context: ForgeErrorContext
  atproto: AtprotoClient
  api: Fetcher
  fetcher: Fetcher
}

export function createTangledRecords({ options, instance, webUrl, context, atproto, api, fetcher, ownRecords }: RecordDeps) {
  const repos = new Map<string, Promise<RepoRef>>()
  const collaborators = new Map<string, Promise<{ dids: Set<string>, warning?: ForgeWarning }>>()

  /**
   * Repo collaborators, from the knot that hosts the repo DID. Knots older
   * than v1.15 do not serve this, and an empty set is returned.
   */
  function collaboratorsOf(repo: RepoRef, signal?: AbortSignal): Promise<{ dids: Set<string>, warning?: ForgeWarning }> {
    const repoDid = repo.externalId
    if (!repoDid) {
      return Promise.resolve({ dids: new Set<string>() })
    }
    let found = collaborators.get(repoDid)
    if (!found) {
      found = (async () => {
        const identity = await atproto.resolveDid(repoDid)
        const knot = identity.knot ?? identity.pds
        const dids = new Set<string>()
        if (!knot) {
          return { dids }
        }
        let cursor: string | undefined
        do {
          const { data }: { data: { items: Array<{ subject: string }>, cursor?: string } } = await fetcher.json(
            `${knot.replace(/\/$/, '')}/xrpc/sh.tangled.repo.listCollaborators`,
            { query: { subject: repoDid, limit: 1000, cursor } },
          )
          for (const item of data.items) {
            dids.add(item.subject)
          }
          cursor = data.cursor
        } while (cursor)
        return { dids }
      })().catch((error: unknown) => {
        if (error instanceof ForgeApiError && !(error instanceof RateLimitedError)) {
          return { dids: new Set<string>() }
        }
        if (error instanceof ForgeError) {
          return { dids: new Set<string>(), warning: toWarning('collaborators_unreachable', error, repoDid) }
        }
        throw error
      })
      collaborators.set(repoDid, found)
    }
    return abortable(found, signal)
  }

  /**
   * Accounts whose state records the appview accepts: the thread author, the
   * repo owner, collaborators with push access, and Tangled's own account.
   */
  async function stateAuthors(authorDid: string, repo: RepoRef, warn?: (warning: ForgeWarning) => void, signal?: AbortSignal): Promise<Set<string>> {
    const { dids, warning } = await collaboratorsOf(repo, signal)
    if (warning) {
      warn?.(warning)
    }
    return new Set([authorDid, repo.owner, TANGLED_DID, ...dids])
  }

  async function reactionsPage(target: ThreadRef | CommentRef, options: BaseOptions = {}): Promise<Page<Reaction>> {
    const subject = 'thread' in target ? target.id : threadUri(target)
    return wholePage(forgeIterable(async function* (warn) {
      const reactions: Reaction[] = []
      for await (const link of atproto.backlinks(subject, COLLECTIONS.reaction, '.subject', options.signal)) {
        const record = await readLinked<ReactionRecord>(atUri(link.did, link.collection, link.rkey), warn, options.signal)
        if (record) {
          reactions.push({
            content: REACTIONS[record.reaction] ?? 'other',
            contentRaw: record.reaction,
            actor: await actorFor(link.did, options.signal),
            createdAt: toDate(record.createdAt),
            raw: record,
          })
        }
      }
      yield* reactions.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    }))
  }

  function threadUri(thread: ThreadRef): string {
    const { uri } = subjectUri(thread)
    return atUri(uri.did, uri.collection, uri.rkey)
  }

  async function withRepoDid(repo: RepoRef, signal?: AbortSignal): Promise<RepoRef> {
    const { ref, record } = await canonicalRepo(repo, signal)
    return record.value.repoDid ? { ...ref, externalId: record.value.repoDid } : ref
  }

  /** The repo owner, then the collaborators with push access. */
  async function collaboratorsPage(repo: RepoRef, options: BaseOptions = {}): Promise<Page<Collaborator>> {
    const ref = await withRepoDid(repo, options.signal)
    const { dids, warning } = await collaboratorsOf(ref, options.signal)
    const items = await Promise.all([ref.owner, ...[...dids].filter(did => did !== ref.owner)].map(async (did): Promise<Collaborator> => {
      const owner = did === ref.owner
      return {
        actor: await actorFor(did, options.signal),
        role: owner ? 'admin' : 'write',
        roleRaw: owner ? 'owner' : 'collaborator',
        permissions: owner ? OWNER_PERMISSIONS : COLLABORATOR_PERMISSIONS,
        raw: { did },
      }
    }))
    return warning ? { items, warnings: [warning] } : { items }
  }

  async function permissionFor(repo: RepoRef, actor: string | Actor, options: BaseOptions = {}): Promise<RepoRole> {
    const login = typeof actor === 'string' ? actor.replace(/^@/, '') : actor.id
    const [ref, did] = await Promise.all([
      withRepoDid(repo, options.signal),
      login.startsWith('did:') ? login : atproto.resolveHandle(login, options.signal),
    ])
    if (did === ref.owner) {
      return 'admin'
    }
    const { dids, warning } = await collaboratorsOf(ref, options.signal)
    if (warning) {
      throw new ForgeError(warning.message, context)
    }
    return dids.has(did) ? 'write' : 'read'
  }

  async function actorFor(did: string, signal?: AbortSignal) {
    const identity = await atproto.resolveDid(did, signal).catch((error: unknown) => {
      if (signal?.aborted) {
        throw error
      }
      return { did }
    })
    return toActor(instance, identity, webUrl)
  }

  /** Resolves a record's `repo` field, a repo DID or, in older records, an `sh.tangled.repo` AT-URI. */
  function resolveRepo(field: string, signal?: AbortSignal): Promise<RepoRef> {
    let repo = repos.get(field)
    if (!repo) {
      repo = (async () => {
        const legacy = parseAtUri(field)
        if (legacy) {
          return { forge: FORGE, instance, owner: legacy.did, name: legacy.rkey }
        }
        const { value: link } = await atproto.backlinks(field, COLLECTIONS.repo, '.repoDid').next()
        if (!link) {
          throw new UnresolvedThreadError(`No sh.tangled.repo record declares ${field}`, context)
        }
        return { forge: FORGE, instance, owner: link.did, name: link.rkey, externalId: field }
      })()
      repo.catch(() => repos.delete(field))
      repos.set(field, repo)
    }
    return abortable(repo, signal)
  }

  async function threadFor(subject: string, signal?: AbortSignal): Promise<ThreadRead & { cid?: string }> {
    const uri = parseAtUri(subject)
    if (!uri || !threadKindOf(uri.collection)) {
      throw new UnresolvedThreadError(`${subject} is not an issue or pull request`, context)
    }
    const { value, cid } = await atproto.getRecord<IssueRecord | PullRecord>(subject, signal)
    const repoField = 'target' in value ? value.target.repo : value.repo
    return { ref: toThreadRef(instance, await resolveRepo(repoField, signal), uri), record: value, cid }
  }

  function subjectUri(thread: ThreadRef): { ref: ResolvedThreadRef, uri: AtUri, kind: 'issue' | 'pull_request' } {
    const ref = requireThread(thread, context)
    const uri = parseAtUri(ref.number)
    if (!uri || (ref.kind !== 'issue' && ref.kind !== 'pull_request') || threadKindOf(uri.collection) !== ref.kind) {
      throw new UnresolvedThreadError('Tangled thread refs carry the issue or pull AT-URI as their number', context)
    }
    return { ref, uri, kind: ref.kind }
  }

  /**
   * Reads one record that another record points at. Any failure is a
   * warning: each record lives on its author's own PDS, and one unreachable
   * participant must not fail the whole read. Deleted records are skipped
   * silently.
   */
  async function readLinked<T extends TangledRecord>(uri: string, warn: (warning: ForgeWarning) => void, signal?: AbortSignal): Promise<T | undefined> {
    try {
      return (await atproto.getRecord<T>(uri, signal)).value
    }
    catch (error) {
      if (error instanceof NotFoundError) {
        return undefined
      }
      if (!degradesToWarning(error)) {
        throw error
      }
      warn(toWarning('record_unreachable', error, uri))
      return undefined
    }
  }

  async function* activity(
    target: string,
    kind: 'issue' | 'pull_request',
    allowedState: Set<string>,
    warn: (warning: ForgeWarning) => void,
    { sources = ACTIVITY_SOURCES(kind), signal }: BaseOptions & { sources?: Array<{ collection: string, path: string }> } = {},
  ): AsyncGenerator<{ uri: string, collection: string, record: TangledRecord }> {
    for (const source of sources) {
      for await (const link of atproto.backlinks(target, source.collection, source.path, signal)) {
        if (source === STATE_COLLECTION[kind] && !allowedState.has(link.did)) {
          continue
        }
        const uri = atUri(link.did, link.collection, link.rkey)
        const record = await readLinked(uri, warn, signal)
        if (record) {
          yield { uri, collection: link.collection, record }
        }
      }
    }
  }

  async function stateOf(target: string, kind: 'issue' | 'pull_request', allowed: Set<string>, warn: (warning: ForgeWarning) => void, signal?: AbortSignal): Promise<{ token?: string, at?: string }> {
    let latest: { token?: string, at?: string } = {}
    const source = STATE_COLLECTION[kind]
    for await (const link of atproto.backlinks(target, source.collection, source.path, signal)) {
      if (!allowed.has(link.did)) {
        continue
      }
      const value = await readLinked<StateRecord>(atUri(link.did, link.collection, link.rkey), (warning) => {
        warn({ ...warning, code: 'state_record_unreachable', message: `State may be stale: ${warning.message}` })
      }, signal)
      if (!value) {
        continue
      }
      if (!latest.at || (toDate(value.createdAt)?.getTime() ?? 0) > (toDate(latest.at)?.getTime() ?? 0)) {
        latest = { token: stateToken(value), at: value.createdAt }
      }
    }
    return latest
  }

  const definitions = new Map<string, Promise<LabelDefinitionRecord | undefined>>()

  function definitionOf(uri: string, signal?: AbortSignal): Promise<LabelDefinitionRecord | undefined> {
    let found = definitions.get(uri)
    if (!found) {
      found = atproto.getRecord<LabelDefinitionRecord>(uri).then(({ value }) => value, (error: unknown) => {
        if (error instanceof NotFoundError) {
          return undefined
        }
        definitions.delete(uri)
        throw error
      })
      definitions.set(uri, found)
    }
    return abortable(found, signal)
  }

  /**
   * The labels a thread's label ops leave: ops from accounts with push access,
   * in `performedAt` order, deletions before additions within a record. The
   * values of an `assignee` label with DID values are the assignees instead.
   */
  async function labelsOf(target: string, repo: RepoRef, warn: (warning: ForgeWarning) => void, signal?: AbortSignal): Promise<{ labels: Label[], assignees: string[], state: Map<string, Set<string>>, definitions: Map<string, LabelDefinitionRecord | undefined> }> {
    const allowed = await stateAuthors(repo.owner, repo, warn, signal)
    const ops: Array<{ at: number, did: string, rkey: string, add: boolean, key: string, value: string }> = []
    for await (const link of atproto.backlinks(target, COLLECTIONS.labelOp, '.subject', signal)) {
      if (!allowed.has(link.did)) {
        continue
      }
      const record = await readLinked<LabelOpRecord>(atUri(link.did, link.collection, link.rkey), warn, signal)
      const at = toDate(record?.performedAt)?.getTime() ?? 0
      for (const [add, operands] of [[false, record?.delete], [true, record?.add]] as const) {
        for (const { key, value } of operands ?? []) {
          ops.push({ at, did: link.did, rkey: link.rkey, add: add && value !== '', key, value })
        }
      }
    }
    ops.sort((a, b) => a.at - b.at || a.did.localeCompare(b.did) || a.rkey.localeCompare(b.rkey) || Number(a.add) - Number(b.add) || a.key.localeCompare(b.key) || a.value.localeCompare(b.value))
    const defs = new Map(await Promise.all([...new Set(ops.map(op => op.key))].map(async key => [key, await reachableDefinition(key, warn, signal)] as const)))
    const collection = parseAtUri(target)?.collection ?? ''
    const state = new Map<string, Set<string>>()
    for (const op of ops) {
      const def = defs.get(op.key)
      if (!def || (def.scope?.length && !def.scope.includes(collection))) {
        continue
      }
      applyLabelOp(state, def, op)
    }
    return { ...labelsIn(state, defs), state, definitions: defs }
  }

  function reachableDefinition(uri: string, warn: (warning: ForgeWarning) => void, signal?: AbortSignal): Promise<LabelDefinitionRecord | undefined> {
    return definitionOf(uri, signal).catch((error: unknown) => {
      if (!degradesToWarning(error)) {
        throw error
      }
      warn(toWarning('record_unreachable', error, uri))
      return undefined
    })
  }

  /** The label definitions the repo record lists, in its order. */
  async function repoLabels(repo: RepoRef, warn: (warning: ForgeWarning) => void, signal?: AbortSignal): Promise<Array<{ uri: string, definition: LabelDefinitionRecord }>> {
    const { record } = await canonicalRepo(repo, signal)
    const uris = record.value.labels ?? []
    const definitions = await Promise.all(uris.map(uri => reachableDefinition(uri, warn, signal)))
    return uris.flatMap((uri, index) => definitions[index] ? [{ uri, definition: definitions[index] }] : [])
  }

  async function countComments(target: string, kind: 'issue' | 'pull_request', signal?: AbortSignal): Promise<number> {
    let count = 0
    for (const source of COMMENT_SOURCES[kind]) {
      for await (const _ of atproto.backlinks(target, source.collection, source.path, signal)) {
        count++
      }
    }
    return count
  }

  /** A repository's star and fork counts from the index, each left out when the index cannot return it. */
  async function repoCounts(record: RecordResponse<RepoRecord>, signal?: AbortSignal): Promise<Pick<Repo, 'stars' | 'forks'>> {
    const subject = record.value.repoDid
    if (!subject) {
      return {}
    }
    const count = (nsid: string) => api.json<{ count: number }>(`/xrpc/${nsid}`, { query: { subject }, signal }).then(({ data }) => data.count, (error: unknown) => {
      if (signal?.aborted || !degradesToWarning(error)) {
        throw error
      }
      return undefined
    })
    const [stars, forks] = await Promise.all([count('sh.tangled.feed.countStars'), count('sh.tangled.repo.countForks')])
    return { stars, forks }
  }

  /** The event for one record, with the thread it is about where that thread can be read. */
  async function recordEvent(activity: ActivityRecord, source: SourceKind, fallbackTime: Date, threads = new Map<string, Promise<ThreadRead | undefined>>(), signal?: AbortSignal): Promise<ForgeEventInput> {
    const subject = activity.record ? subjectOf(activity.collection, activity.record, activity.uri) : undefined
    if (subject && !threads.has(subject)) {
      threads.set(subject, threadFor(subject, signal).catch(() => undefined))
    }
    const thread = subject ? await threads.get(subject) : undefined
    return toActivityEvent(instance, activity, await actorFor(parseAtUri(activity.uri)!.did, signal), thread?.ref, source, fallbackTime, thread?.record)
  }

  function toStreamEvent(message: JetstreamCommitEvent): Promise<ForgeEventInput | undefined> {
    const { commit } = message
    const uri = atUri(message.did, commit.collection, commit.rkey)
    return recordEvent({ uri, collection: commit.collection, record: commit.record, operation: commit.operation, rev: commit.rev }, 'subscribe', new Date(message.time_us / 1000))
  }

  const canonical = new Map<string, Promise<{ ref: RepoRef, record: RecordResponse<RepoRecord> }>>()

  /** The repo record `repo` names, where `owner` may be a handle and `name` the record's name rather than its key. */
  function canonicalRepo(repo: RepoRef, signal?: AbortSignal): Promise<{ ref: RepoRef, record: RecordResponse<RepoRecord> }> {
    const key = `${repo.owner}/${repo.name}`
    let found = canonical.get(key)
    if (!found) {
      found = (async () => {
        const did = repo.owner.startsWith('did:') ? repo.owner : await atproto.resolveHandle(repo.owner.replace(/^@/, ''))
        const record = await atproto.getRecord<RepoRecord>(atUri(did, COLLECTIONS.repo, repo.name)).catch((error: unknown) => {
          if (error instanceof NotFoundError) {
            return undefined
          }
          throw error
        })
        if (record) {
          return { ref: { ...repo, owner: did }, record }
        }
        for await (const candidate of atproto.listRecords<RepoRecord>(did, COLLECTIONS.repo)) {
          if (candidate.value.name === repo.name) {
            return { ref: { ...repo, owner: did, name: parseAtUri(candidate.uri)!.rkey }, record: candidate }
          }
        }
        throw new NotFoundError(`No Tangled repo named ${repo.name} for ${repo.owner}`, 404, '', context)
      })()
      found.catch(() => canonical.delete(key))
      canonical.set(key, found)
    }
    return abortable(found, signal)
  }

  /** `repo` with a DID owner and the record key as `name`; refs this provider returned already are. */
  async function canonicalRef(repo: RepoRef, signal?: AbortSignal): Promise<RepoRef> {
    return repo.externalId && repo.owner.startsWith('did:') ? repo : (await canonicalRepo(repo, signal)).ref
  }

  async function repoDidOf(repo: RepoRef, signal?: AbortSignal): Promise<string> {
    if (repo.externalId) {
      return repo.externalId
    }
    const { record: { value } } = await canonicalRepo(repo, signal)
    if (!value.repoDid) {
      throw new UnresolvedThreadError(`${repo.owner}/${repo.name} has no repo DID`, context)
    }
    return value.repoDid
  }

  function sshHost(knot: string): string {
    return options.sshHosts?.[knot] ?? DEFAULT_SSH_HOSTS[knot] ?? knot
  }

  function toRepo(ref: RepoRef, record: RepoRecord, raw: unknown, counts: Pick<Repo, 'stars' | 'forks'> = {}): Repo {
    const parent = record.source ? parseAtUri(record.source) : undefined
    const path = `${ref.owner}/${ref.name}`
    return {
      ref: record.repoDid ? { ...ref, externalId: record.repoDid } : ref,
      displayName: record.name && record.name !== ref.name ? record.name : undefined,
      description: record.description,
      visibility: 'public',
      isFork: Boolean(record.source),
      isArchived: false,
      parent: parent ? { forge: FORGE, instance, owner: parent.did, name: parent.rkey } : undefined,
      topics: record.topics ?? [],
      url: `${webUrl}/${path}`,
      cloneUrls: { https: `${webUrl}/${path}`, ssh: `ssh://git@${sshHost(record.knot)}/${path}` },
      createdAt: toDate(record.createdAt),
      homepage: record.website || undefined,
      mergeMethods: ['rebase'],
      defaultMergeMethod: 'rebase',
      ...counts,
      raw,
    }
  }

  async function readThread(thread: ThreadRef, options?: BaseOptions): Promise<Thread> {
    const { uri, kind } = subjectUri(thread)
    const target = atUri(uri.did, uri.collection, uri.rkey)
    const { ref, record } = await threadFor(target, options?.signal)
    const warnings: ForgeWarning[] = []
    const warn = (warning: ForgeWarning) => warnings.push(warning)
    const [author, state, comments, { labels, assignees }] = await Promise.all([
      actorFor(uri.did, options?.signal),
      stateAuthors(uri.did, ref.repo, warn, options?.signal).then(allowed => stateOf(target, kind, allowed, warn, options?.signal)),
      countComments(target, kind, options?.signal),
      labelsOf(target, ref.repo, warn, options?.signal),
    ])
    return {
      ...toThread(ref, record, author, state, comments, warnings),
      labels,
      assignees: await Promise.all(assignees.map(did => actorFor(did, options?.signal))),
    }
  }

  async function listFromIndex(repo: RepoRef, query: ThreadQuery): Promise<Page<Thread>> {
    const warnings: ForgeWarning[] = []
    if (isFirstPage(query.cursor)) {
      warnings.push({ code: 'index_possibly_stale', message: 'Listed from the Bobbin index; states may lag behind the records' })
      if (query.sort && query.sort !== 'created') {
        warnings.push({ code: 'sort_unsupported', message: 'The index sorts by creation time only' })
      }
      if (query.labels?.length || query.assignee) {
        warnings.push({ code: 'filter_unsupported', message: 'The index has no labels or assignees; those filters were ignored' })
      }
    }
    const repoDid = await repoDidOf(repo, query.signal)
    const state = query.state ?? 'open'
    const kinds = query.kind ? [query.kind] : ['issue', 'pull_request'] as const
    const page = await phased(kinds.map(kind => async (cursor?: Cursor): Promise<Page<Thread>> => {
      const pulls = kind === 'pull_request'
      const { data }: { data: { items: Array<{ uri: string, value: IssueRecord | PullRecord, state: string, stateUpdatedAt?: string, commentCount: number }>, cursor?: string } } = await api.json(
        `/xrpc/sh.tangled.repo.${pulls ? 'listPulls' : 'listIssues'}`,
        {
          query: {
            subject: repoDid,
            [pulls ? 'status' : 'state']: state === 'all' || (pulls && state === 'closed') ? undefined : state,
            author: query.author?.startsWith('did:') ? query.author : undefined,
            order: query.direction ?? 'desc',
            limit: query.perPage ?? 50,
            cursor: cursor?.token,
          },
          signal: query.signal,
        },
      )
      const items: Thread[] = []
      for (const item of data.items) {
        const uri = parseAtUri(item.uri)
        if (!uri || (state === 'closed' && item.state === 'open')) {
          continue
        }
        const author = await actorFor(uri.did, query.signal)
        if (query.author && author.login !== query.author && author.id !== query.author) {
          continue
        }
        const thread = toThread(toThreadRef(instance, { ...repo, externalId: repoDid }, uri), item.value, author, { token: item.state, at: item.stateUpdatedAt }, item.commentCount)
        if ((query.since && (thread.lastActivityAt?.getTime() ?? 0) < query.since.getTime()) || (query.createdAfter && (thread.createdAt?.getTime() ?? 0) < query.createdAfter.getTime())) {
          continue
        }
        items.push(thread)
      }
      return { items, cursor: data.items.length && data.cursor ? { token: data.cursor } : undefined }
    }), query.cursor)
    return warnings.length ? { ...page, warnings: [...warnings, ...page.warnings ?? []] } : page
  }

  /** Record-based listings read every record to apply the appview's rules, so they return one complete page. */
  async function wholePage<T>(iterable: ForgeIterable<T>): Promise<Page<T>> {
    const items = await Array.fromAsync(iterable)
    return iterable.warnings.length ? { items, warnings: iterable.warnings } : { items }
  }

  function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    return options.listSource === 'index' && query.kind !== 'discussion'
      ? listFromIndex(repo, query)
      : wholePage(listThreads(repo, query))
  }

  function listThreads(repo: RepoRef, query: ThreadQuery = {}): ForgeIterable<Thread> {
    return forgeIterable(async function* (warn) {
      if (query.kind === 'discussion') {
        warn({ code: 'kind_unsupported', message: 'Tangled has no discussions' })
        return
      }
      const address = await canonicalRef(repo, query.signal)
      const repoDid = await repoDidOf(repo, query.signal)
      const targets = [repoDid, atUri(address.owner, COLLECTIONS.repo, address.name)]
      const uris: string[] = []
      for (const kind of query.kind ? [query.kind] : ['issue', 'pull_request'] as const) {
        const collection = kind === 'issue' ? COLLECTIONS.issue : COLLECTIONS.pull
        for (const target of targets) {
          for await (const link of atproto.backlinks(target, collection, kind === 'issue' ? '.repo' : '.target.repo', query.signal)) {
            uris.push(atUri(link.did, link.collection, link.rkey))
          }
        }
      }
      const threadsRead = await mapConcurrent([...new Set(uris)], 4, async (uri) => {
        const parsed = parseAtUri(uri)!
        try {
          const thread = await readThread({ forge: FORGE, instance, repo, kind: threadKindOf(parsed.collection)!, number: uri }, query)
          thread.warnings?.forEach(warn)
          return thread
        }
        catch (error) {
          if (!degradesToWarning(error)) {
            throw error
          }
          warn(toWarning('thread_unreadable', error, uri))
          return undefined
        }
      })
      const state = query.state ?? 'open'
      const sortKey = (thread: Thread) => query.sort === 'comments'
        ? thread.commentCount ?? 0
        : (query.sort === 'updated' ? thread.lastActivityAt : thread.createdAt)?.getTime() ?? 0
      const direction = (query.direction ?? 'desc') === 'desc' ? -1 : 1
      yield* threadsRead
        .filter((thread): thread is Thread => Boolean(thread))
        .filter(thread => state === 'all' || (state === 'open' ? thread.state === 'open' : state === 'merged' ? thread.state === 'merged' : thread.state !== 'open'))
        .filter(thread => !query.author || thread.author?.login === query.author || thread.author?.id === query.author)
        .filter(thread => !query.assignee || thread.assignees.some(assignee => assignee.login === query.assignee || assignee.id === query.assignee))
        .filter(thread => !query.labels?.length || query.labels.every(name => thread.labels.some(label => label.name === name)))
        .filter(thread => !query.since || (thread.lastActivityAt?.getTime() ?? 0) >= query.since.getTime())
        .filter(thread => !query.createdAfter || (thread.createdAt?.getTime() ?? 0) >= query.createdAfter.getTime())
        .sort((a, b) => (sortKey(a) - sortKey(b)) * direction)
    })
  }

  function listComments(thread: ThreadRef, options: BaseOptions = {}): ForgeIterable<Comment> {
    const { ref, uri, kind } = subjectUri(thread)
    const target = atUri(uri.did, uri.collection, uri.rkey)
    return forgeIterable(async function* (warn) {
      const comments: Comment[] = []
      for await (const item of activity(target, kind, new Set(), warn, { sources: COMMENT_SOURCES[kind], signal: options.signal })) {
        comments.push(toRecordComment(ref, item.uri, item.record as FeedCommentRecord, await actorFor(parseAtUri(item.uri)!.did, options.signal)))
      }
      yield* comments.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    })
  }

  async function findSubscription(thread: ThreadRef, signal?: AbortSignal): Promise<string | undefined> {
    const { uri } = subjectUri(thread)
    const target = atUri(uri.did, uri.collection, uri.rkey)
    for await (const record of ownRecords<SubscriptionRecord>(COLLECTIONS.subscription, signal)) {
      if (record.value.subject.uri === target) {
        return record.uri
      }
    }
    return undefined
  }

  /** Drops cached repo records, after a write changes one. */
  function forgetRepos(): void {
    canonical.clear()
  }

  /** Drops cached collaborator lists, after a write changes one. */
  function forgetCollaborators(): void {
    collaborators.clear()
  }

  return { forgetRepos, forgetCollaborators, labelsOf, repoLabels, threadUri, reactionsPage, collaboratorsPage, permissionFor, stateAuthors, actorFor, resolveRepo, threadFor, subjectUri, activity, recordEvent, toStreamEvent, canonicalRepo, canonicalRef, repoDidOf, toRepo, repoCounts, readThread, wholePage, listPage, listComments, findSubscription }
}
