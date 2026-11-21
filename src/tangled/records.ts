import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher } from '../fetch.ts'
import type {
  Actor,
  BaseOptions,
  Collaborator,
  Comment,
  CommentRef,
  ForgeEventInput,
  ForgeWarning,
  ListOptions,
  Page,
  PageOptions,
  Reaction,
  ReactionContent,
  Repo,
  RepoRef,
  RepoRole,
  RepoSearchQuery,
  ResolvedThreadRef,
  SourceKind,
  Thread,
  ThreadQuery,
  ThreadRef,
  ThreadSearchQuery,
} from '../model.ts'
import type { AtprotoClient } from './atproto.ts'
import type { TangledOptions } from './index.ts'
import type { ActivityRecord, ThreadParts } from './normalise.ts'
import type {
  CommentRecord,
  CommentView,
  JetstreamCommitEvent,
  LabelDefinitionRecord,
  PatchRecord,
  ReactionRecord,
  RecordResponse,
  RecordVersion,
  RepoManifest,
  RepoView,
  TicketItem,
  TicketRecord,
} from './types.ts'
import { NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { abortable } from '../fetch.ts'
import { degradesToWarning, isFirstPage, mapConcurrent, requireThread, toDate, toWarning } from '../utils.ts'
import { atUri, parseAtUri } from './atproto.ts'
import {
  COLLECTIONS,
  FORGE,
  REACTION_EMOJI,
  ticketChanges,
  ticketKind,
  toActivityEvent,
  toActor,
  toChangeEvent,
  toComment,
  toLabel,
  toThread,
  toThreadRef,
} from './normalise.ts'
import { threadUrl } from './web.ts'

const DEFAULT_SSH_HOSTS: Record<string, string> = {
  'knot1.tangled.sh': 'tangled.org',
}

const REACTIONS: Record<string, ReactionContent> = Object.fromEntries(Object.entries(REACTION_EMOJI).map(([name, emoji]) => [emoji, name as ReactionContent]))

const OWNER_PERMISSIONS = {
  admin: true,
  maintain: true,
  push: true,
  triage: true,
  pull: true,
}
const COLLABORATOR_PERMISSIONS = {
  admin: false,
  maintain: false,
  push: true,
  triage: true,
  pull: true,
}

/** How long a repository's label definitions are reused for. */
const LABELS_TTL = 60_000

/** How many versions of one ticket are read for its history. */
const MAX_VERSIONS = 1000

export type XrpcParams = Record<string, string | number | boolean | readonly string[] | undefined>

/** The path of an XRPC query, with each array parameter repeated. */
export function xrpcPath(nsid: string, params: XrpcParams = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue
    }
    for (const item of typeof value === 'object'
      ? value
      : [value]) {
      search.append(key, String(item))
    }
  }
  const query = search.toString()
  return query
    ? `/xrpc/${nsid}?${query}`
    : `/xrpc/${nsid}`
}

/** A repository, with what reading and writing its records needs. */
export interface RepoHandle {
  /** The owner's DID and the repository's name, with the repo DID as `externalId`. */
  ref: RepoRef
  /** The repo DID, whose account on the knot holds the repository's records. */
  did: string
  /** The origin of the knot that hosts the repository. */
  knot: string
  view: RepoView
}

/** A ticket the index found, with what the index adds to its record. */
interface TicketHit extends TicketItem {
  nsid?: string
}

interface Listed<T> {
  items: T[]
  cursor?: string
  total?: number
}

/** One version of a ticket, with its record where the knot still has it. */
interface TicketVersion {
  version: RecordVersion
  record?: TicketRecord
}

interface TicketView extends Omit<TicketRecord, 'x-tngl-editor'> {
  uri: string
  cid: string
  author?: { did: string, handle?: string }
}

interface RecordDeps {
  options: TangledOptions
  instance: string
  webUrl: string
  context: ForgeErrorContext
  atproto: AtprotoClient
  /** The index, which serves every read but a record's history. */
  api: Fetcher
  fetcher: Fetcher
}

export type TangledRecords = ReturnType<typeof createTangledRecords>

/** Reads repositories, tickets and what hangs off them from the index, and their histories from knots. */
export function createTangledRecords({ options, instance, webUrl, context, atproto, api, fetcher }: RecordDeps) {
  async function query<T>(nsid: string, params: XrpcParams, signal?: AbortSignal): Promise<T> {
    return (await api.json<T>(xrpcPath(nsid, params), { signal })).data
  }

  /** Calls a query of the knot at `origin`, which reports a missing record as a bad request. */
  async function knotQuery<T>(origin: string, nsid: string, params: XrpcParams, signal?: AbortSignal): Promise<T> {
    return (await fetcher.json<T>(`${origin}${xrpcPath(nsid, params)}`, {
      signal,
      mapError: error => error instanceof Error && 'status' in error && error.status === 400 && 'body' in error && /"(?:Record)?NotFound"/.test(String(error.body))
        ? new NotFoundError(error.message, 404, String(error.body), context, { cause: error })
        : error,
    })).data
  }

  async function actorFor(did: string, signal?: AbortSignal): Promise<Actor> {
    const identity = await atproto.resolveDid(did, signal).catch((error: unknown) => {
      if (signal?.aborted) {
        throw error
      }
      return { did }
    })
    return toActor(instance, identity, webUrl)
  }

  async function didOf(actor: string | Actor, signal?: AbortSignal): Promise<string> {
    const login = typeof actor === 'string'
      ? actor.replace(/^@/, '')
      : actor.id
    return login.startsWith('did:')
      ? login
      : atproto.resolveHandle(login, signal)
  }

  const reposByDid = new Map<string, Promise<RepoHandle>>()
  const reposByName = new Map<string, Promise<RepoHandle>>()

  async function toHandle(view: RepoHandle['view']): Promise<RepoHandle> {
    const did = parseAtUri(view.uri)!.did
    const { owner, name } = view.value.declaration
    if (!view.knot) {
      throw new NotFoundError(`${owner}/${name} names no knot`, 404, '', context)
    }
    const identity = await atproto.resolveDid(owner).catch(() => undefined)
    return {
      ref: {
        forge: FORGE,
        instance,
        owner,
        name,
        externalId: did,
        ...identity?.handle
          ? { ownerHandle: identity.handle }
          : {},
      },
      did,
      knot: /^https?:\/\//.test(view.knot)
        ? view.knot.replace(/\/$/, '')
        : `https://${view.knot}`,
      view,
    }
  }

  function cached(cache: Map<string, Promise<RepoHandle>>, key: string, load: () => Promise<RepoHandle>, signal?: AbortSignal): Promise<RepoHandle> {
    let found = cache.get(key)
    if (!found) {
      found = load()
      found.catch(() => cache.delete(key))
      cache.set(key, found)
    }
    return abortable(found, signal)
  }

  /** The repository whose DID is `did`. */
  function repoByDid(did: string, signal?: AbortSignal): Promise<RepoHandle> {
    return cached(reposByDid, did, async () => toHandle(await query('org.tangled.repo.getRepoByRepoDid', { repoDid: did })), signal)
  }

  /** The repository `repo` names: by its repo DID when the ref has one, else by its owner, a DID or a handle, and its name. */
  function repoFor(repo: RepoRef, signal?: AbortSignal): Promise<RepoHandle> {
    if (repo.externalId?.startsWith('did:')) {
      return repoByDid(repo.externalId, signal)
    }
    return cached(reposByName, `${repo.owner.toLowerCase()}/${repo.name}`, async () => {
      const handle = await toHandle(await query('org.tangled.repo.getRepoByName', {
        owner: await didOf(repo.owner),
        name: repo.name,
      }))
      reposByDid.set(handle.did, Promise.resolve(handle))
      return handle
    }, signal)
  }

  function sshHost(knot: string): string {
    return options.sshHosts?.[knot] ?? DEFAULT_SSH_HOSTS[knot] ?? knot
  }

  async function toRepo({ ref, did, knot, view }: RepoHandle, signal?: AbortSignal, counts: Pick<Repo, 'stars' | 'forks'> = {}): Promise<Repo> {
    const manifest = view.value
    const owner = await actorFor(ref.owner, signal)
    const path = `${owner.login}/${ref.name}`
    const parent = manifest.source?.did
      ? await repoByDid(manifest.source.did, signal).then(found => found.ref, () => undefined)
      : undefined
    return {
      ref,
      description: manifest.description || undefined,
      defaultBranch: view.defaultBranch,
      visibility: 'public',
      isFork: Boolean(manifest.source),
      isArchived: false,
      parent,
      topics: manifest.topics ?? [],
      owner,
      url: `${webUrl}/${path}`,
      cloneUrls: { https: `${webUrl}/${path}`, ssh: `ssh://git@${sshHost(new URL(knot).host)}/${path}` },
      createdAt: toDate(manifest.createdAt),
      homepage: manifest.website || undefined,
      mergeMethods: ['merge', 'rebase'],
      defaultMergeMethod: 'merge',
      ...counts,
      raw: { ...view, did },
    }
  }

  async function repoCounts(did: string, signal?: AbortSignal): Promise<Pick<Repo, 'stars' | 'forks'>> {
    const count = (nsid: string) => query<{ count: number }>(nsid, { subject: did }, signal).then(data => data.count, (error: unknown) => {
      if (!degradesToWarning(error)) {
        throw error
      }
      return undefined
    })
    const [stars, forks] = await Promise.all([
      count('org.tangled.feed.countStars'),
      count('org.tangled.repo.countForks'),
    ])
    return { stars, forks }
  }

  /** Every item of a listing the index pages by cursor. */
  async function* everyItem<T>(nsid: string, params: XrpcParams, signal?: AbortSignal): AsyncGenerator<T> {
    let cursor: string | undefined
    do {
      const data: Listed<T> = await query(nsid, { ...params, limit: 100, cursor }, signal)
      yield* data.items
      cursor = data.items.length
        ? data.cursor
        : undefined
    } while (cursor)
  }

  /** One page of a listing the index pages by cursor. */
  async function listedPage<R, T>(nsid: string, params: XrpcParams, pageOptions: PageOptions, map: (raw: R) => Promise<T | undefined>): Promise<Page<T>> {
    const data: Listed<R> = await query(nsid, {
      ...params,
      limit: Math.min(pageOptions.perPage ?? 50, 100),
      cursor: pageOptions.cursor?.token,
    }, pageOptions.signal)
    const items = await mapConcurrent(data.items, 4, map)
    return {
      items: items.filter(item => item !== undefined),
      ...data.total === undefined
        ? {}
        : { total: data.total },
      cursor: data.items.length && data.cursor
        ? { token: data.cursor }
        : undefined,
    }
  }

  const labelCache = new Map<string, { at: number, definitions: Promise<Map<string, LabelDefinitionRecord>> }>()

  /** A repository's label definitions, by the key tickets name them with. */
  function repoLabels(did: string, signal?: AbortSignal): Promise<Map<string, LabelDefinitionRecord>> {
    let entry = labelCache.get(did)
    if (!entry || Date.now() - entry.at > LABELS_TTL) {
      const definitions = (async () => {
        const found = new Map<string, LabelDefinitionRecord>()
        for await (const item of everyItem<RecordResponse<LabelDefinitionRecord>>('org.tangled.label.listDefinitions', { subject: did, order: 'asc' })) {
          found.set(parseAtUri(item.uri)!.rkey, item.value)
        }
        return found
      })()
      entry = {
        at: Date.now(),
        definitions,
      }
      definitions.catch(() => labelCache.delete(did))
      labelCache.set(did, entry)
    }
    return abortable(entry.definitions, signal)
  }

  /** Drops a repository's cached label definitions, after a write changes them. */
  function forgetLabels(did: string): void {
    labelCache.delete(did)
  }

  /** The rounds of a pull request, oldest first. */
  async function patchesOf(ticket: string, signal?: AbortSignal): Promise<Array<RecordResponse<PatchRecord>>> {
    return Array.fromAsync(everyItem<RecordResponse<PatchRecord>>('org.tangled.temp.review.listPatches', { ticket, order: 'asc' }, signal))
  }

  async function latestPatch(ticket: string, signal?: AbortSignal): Promise<PatchRecord | undefined> {
    const data: Listed<RecordResponse<PatchRecord>> = await query('org.tangled.temp.review.listPatches', { ticket, order: 'desc', limit: 1 }, signal)
    return data.items[0]?.value
  }

  /** The repository and record key a thread ref names. */
  async function ticketFor(thread: ThreadRef, signal?: AbortSignal): Promise<{ repo: RepoHandle, rkey: string, uri: string }> {
    const ref = requireThread(thread, context)
    if (ref.kind === 'discussion') {
      throw new UnsupportedOperationError('Tangled has no discussions', context)
    }
    // A ref this provider returned carries the ticket's AT-URI, whose repo DID survives a rename.
    const known = parseAtUri(ref.externalId ?? '')
    const repo = known?.collection === COLLECTIONS.ticket
      ? await repoByDid(known.did, signal)
      : await repoFor(ref.repo, signal)
    return {
      repo,
      rkey: ref.number,
      uri: atUri(repo.did, COLLECTIONS.ticket, ref.number),
    }
  }

  /** The AT-URI of the ticket or comment a reaction is on. */
  async function subjectUri(target: ThreadRef | CommentRef, signal?: AbortSignal): Promise<{ repo: RepoHandle, uri: string }> {
    if ('thread' in target) {
      const { repo } = await ticketFor(target.thread, signal)
      return {
        repo,
        uri: atUri(repo.did, COLLECTIONS.comment, target.id),
      }
    }
    return ticketFor(target, signal)
  }

  /** Runs a read whose failure costs the thread one field, and records it as a warning. */
  async function side<T>(warnings: ForgeWarning[], subject: string, read: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    try {
      return await read()
    }
    catch (error) {
      if (signal?.aborted || !degradesToWarning(error)) {
        throw error
      }
      warnings.push(toWarning('record_unreachable', error, subject))
      return undefined
    }
  }

  /** A thread from its ticket record, with the author, assignees, labels and latest round read alongside. */
  async function ticketThread(repo: RepoHandle, rkey: string, record: TicketRecord, extras: Pick<ThreadParts, 'commentCount' | 'updatedAt' | 'closedAt' | 'raw' | 'url'> & { author?: string }, signal?: AbortSignal): Promise<Thread> {
    const kind = ticketKind(record)
    const ref = toThreadRef(instance, repo.ref, rkey, kind)
    const warnings: ForgeWarning[] = []
    const [author, assignees, labels, patch, url] = await Promise.all([
      extras.author
        ? actorFor(extras.author, signal)
        : undefined,
      Promise.all((record.assignees ?? []).map(did => actorFor(did, signal))),
      record.tangledLabels?.length
        ? side(warnings, ref.externalId!, () => repoLabels(repo.did, signal), signal)
        : undefined,
      kind === 'pull_request'
        ? side(warnings, ref.externalId!, () => latestPatch(ref.externalId!, signal), signal)
        : undefined,
      extras.url
        ? Promise.resolve(extras.url)
        : Promise.resolve(threadUrl(webUrl, ref)),
    ])
    const source = patch?.source?.repo
    const headRepo = source && source !== repo.did
      ? await side(warnings, source, async () => (await repoByDid(source, signal)).ref, signal)
      : undefined
    return toThread(ref, record, {
      ...extras,
      author,
      assignees,
      labels,
      patch,
      headRepo,
      warnings,
      url,
    })
  }

  /** Every version of a ticket, oldest first, as the knot that hosts it recorded them. */
  async function historyOf(repo: RepoHandle, uri: string, signal?: AbortSignal): Promise<TicketVersion[]> {
    const versions: RecordVersion[] = []
    let cursor: string | undefined
    do {
      const data: { versions: RecordVersion[], cursor?: string } = await knotQuery(repo.knot, 'org.tangled.repo.listRecordVersions', { uri, limit: 100, cursor }, signal)
      versions.push(...data.versions)
      cursor = data.versions.length
        ? data.cursor
        : undefined
    } while (cursor && versions.length < MAX_VERSIONS)
    const cids = versions.flatMap(version => version.cid ?? [])
    const { decodeCar } = await import('./car.ts')
    const blocks = new Map<string, unknown>()
    for (let start = 0; start < cids.length; start += 50) {
      const response = await fetcher.raw(`${repo.knot}${xrpcPath('com.atproto.sync.getBlocks', {
        did: repo.did,
        cids: cids.slice(start, start + 50),
      })}`, { signal })
      for (const [cid, block] of decodeCar(new Uint8Array(await response.arrayBuffer()))) {
        blocks.set(cid, block)
      }
    }
    return versions.map(version => ({
      version,
      record: version.cid
        ? blocks.get(version.cid) as TicketRecord | undefined
        : undefined,
    }))
  }

  /** When a ticket last changed and, for one that is not open, when it last left the open state. */
  function timesIn(history: TicketVersion[]): Pick<ThreadParts, 'updatedAt' | 'closedAt'> {
    let closedAt: string | undefined
    let open = true
    for (const { version, record } of history) {
      if (!record) {
        continue
      }
      if (record.state === 'open') {
        closedAt = undefined
      }
      else if (open) {
        closedAt = version.createdAt
      }
      open = record.state === 'open'
    }
    return {
      updatedAt: toDate(history.at(-1)?.version.createdAt),
      closedAt: toDate(closedAt),
    }
  }

  async function readThread(thread: ThreadRef, readOptions?: BaseOptions): Promise<Thread> {
    const signal = readOptions?.signal
    const { repo, rkey, uri } = await ticketFor(thread, signal)
    const warnings: ForgeWarning[] = []
    const [view, comments, history] = await Promise.all([
      query<TicketView>('org.tangled.track.getTicketView', { uri }, signal),
      side(warnings, uri, () => query<{ count: number }>('org.tangled.feed.countComments', { subject: uri }, signal), signal),
      side(warnings, uri, () => historyOf(repo, uri, signal), signal),
    ])
    const record: TicketRecord = {
      title: view.title,
      body: view.body,
      state: view.state,
      tangledLabels: view.tangledLabels,
      assignees: view.assignees,
      targetBranch: view.targetBranch,
      createdAt: view.createdAt,
    }
    const found = await ticketThread(repo, rkey, record, {
      author: view.author?.did,
      commentCount: comments?.count,
      ...history
        ? timesIn(history)
        : {},
      raw: view,
    }, signal)
    return warnings.length
      ? {
          ...found,
          warnings: [
            ...warnings,
            ...found.warnings ?? [],
          ],
        }
      : found
  }

  /** The state qualifier of a ticket search: a closed thread is any that is not open. */
  function stateQualifier(state: 'open' | 'closed' | 'merged' | 'all'): string | undefined {
    switch (state) {
      case 'open':
        return 'is:open'
      case 'closed':
        return '-is:open'
      case 'merged':
        return 'is:merged'
      default:
        return undefined
    }
  }

  interface TicketSearch {
    repo?: string
    text?: string
    kind?: 'issue' | 'pull_request'
    state: 'open' | 'closed' | 'merged' | 'all'
    author?: string
    assignee?: string
    labels?: string[]
    createdAfter?: Date
    sort: 'relevance' | 'created-desc' | 'created-asc'
  }

  async function ticketsPage(search: TicketSearch, pageOptions: PageOptions, warnings: ForgeWarning[]): Promise<Page<Thread>> {
    const signal = pageOptions.signal
    const [author, assignee] = await Promise.all([
      search.author
        ? didOf(search.author, signal)
        : undefined,
      search.assignee
        ? didOf(search.assignee, signal)
        : undefined,
    ])
    const page = await listedHits({
      nsid: COLLECTIONS.ticket,
      repo: search.repo,
      q: [
        stateQualifier(search.state),
        assignee && `assignee:${assignee}`,
        search.text,
      ].filter(Boolean).join(' ') || undefined,
      kind: search.kind && (search.kind === 'issue'
        ? 'issue'
        : 'pull'),
      author,
      label: search.labels,
      since: search.createdAfter?.toISOString(),
      sort: search.sort,
    }, pageOptions, async (hit: TicketHit) => {
      const uri = parseAtUri(hit.uri)!
      const repo = await side(warnings, hit.uri, () => repoByDid(uri.did, signal), signal)
      return repo && ticketThread(repo, uri.rkey, hit.value, { author: hit.author, commentCount: hit.commentCount, raw: hit }, signal)
    })
    return warnings.length
      ? { ...page, warnings }
      : page
  }

  /** One page of what the index's search finds. */
  async function listedHits<R, T>(params: XrpcParams, pageOptions: PageOptions, map: (hit: R) => Promise<T | undefined>): Promise<Page<T>> {
    const data: { hits: R[], cursor?: string, total?: number } = await query('org.tangled.search.query', {
      ...params,
      limit: Math.min(pageOptions.perPage ?? 50, 100),
      cursor: pageOptions.cursor?.token,
    }, pageOptions.signal)
    const items = await mapConcurrent(data.hits, 4, map)
    return {
      items: items.filter(item => item !== undefined),
      ...data.total === undefined
        ? {}
        : { total: data.total },
      cursor: data.hits.length && data.cursor
        ? { token: data.cursor }
        : undefined,
    }
  }

  async function listPage(repo: RepoRef, threadQuery: ThreadQuery = {}): Promise<Page<Thread>> {
    const warnings: ForgeWarning[] = []
    if (threadQuery.kind === 'discussion') {
      return {
        items: [],
        warnings: [
          { code: 'kind_unsupported', message: 'Tangled has no discussions' },
        ],
      }
    }
    if (isFirstPage(threadQuery.cursor)) {
      if (threadQuery.sort && threadQuery.sort !== 'created') {
        warnings.push({ code: 'sort_unsupported', message: 'Tangled lists threads by when they were created' })
      }
      const ignored = ([
        'since',
        'involves',
        'mentions',
        'milestone',
      ] as const).filter(key => threadQuery[key] !== undefined)
      if (ignored.length) {
        warnings.push({ code: 'filter_unsupported', message: `Tangled does not filter threads by ${ignored.join(', ')}; those filters were ignored` })
      }
    }
    const { did } = await repoFor(repo, threadQuery.signal)
    return ticketsPage({
      repo: did,
      kind: threadQuery.kind,
      state: threadQuery.state ?? 'open',
      author: threadQuery.author,
      assignee: threadQuery.assignee,
      labels: threadQuery.labels,
      createdAfter: threadQuery.createdAfter,
      sort: threadQuery.direction === 'asc'
        ? 'created-asc'
        : 'created-desc',
    }, threadQuery, warnings)
  }

  async function searchThreadsPage(search: ThreadSearchQuery): Promise<Page<Thread>> {
    const warnings: ForgeWarning[] = []
    if (isFirstPage(search.cursor)) {
      if (search.sort && search.sort !== 'created' && search.sort !== 'relevance') {
        warnings.push({ code: 'sort_unsupported', message: 'Tangled sorts search results by relevance or by when they were created' })
      }
      const ignored = (['owner', 'involves'] as const).filter(key => search[key] !== undefined)
      if (ignored.length) {
        warnings.push({ code: 'filter_unsupported', message: `Tangled does not search threads by ${ignored.join(', ')}; those filters were ignored` })
      }
      if (search.labels?.length && !search.repo) {
        warnings.push({ code: 'filter_unsupported', message: 'Tangled searches by label within one repository; the labels were ignored' })
      }
    }
    const repo = search.repo && await repoFor(search.repo, search.signal)
    return ticketsPage({
      repo: repo
        ? repo.did
        : undefined,
      text: [search.queryRaw, search.text].filter(Boolean).join(' ') || undefined,
      kind: search.kind,
      state: search.state ?? 'all',
      author: search.author,
      assignee: search.assignee,
      labels: repo
        ? search.labels
        : undefined,
      createdAfter: search.since,
      sort: search.sort === 'created'
        ? search.direction === 'asc'
          ? 'created-asc'
          : 'created-desc'
        : 'relevance',
    }, search, warnings)
  }

  async function searchReposPage(search: RepoSearchQuery): Promise<Page<Repo>> {
    const warnings: ForgeWarning[] = []
    if (isFirstPage(search.cursor)) {
      if (search.sort && search.sort !== 'created' && search.sort !== 'relevance') {
        warnings.push({ code: 'sort_unsupported', message: 'Tangled sorts search results by relevance or by when they were created' })
      }
      if (search.language) {
        warnings.push({ code: 'filter_unsupported', message: 'Tangled does not search repositories by language; the filter was ignored' })
      }
    }
    const page = await listedHits({
      nsid: COLLECTIONS.manifest,
      q: [search.queryRaw, search.text].filter(Boolean).join(' ') || undefined,
      author: search.owner && await didOf(search.owner, search.signal),
      sort: search.sort === 'created'
        ? search.direction === 'asc'
          ? 'created-asc'
          : 'created-desc'
        : 'relevance',
    }, search, async (hit: RecordResponse<RepoManifest>) => {
      const repo = await side(warnings, hit.uri, () => repoByDid(parseAtUri(hit.uri)!.did, search.signal), search.signal)
      return repo && toRepo(repo, search.signal)
    })
    return warnings.length
      ? { ...page, warnings }
      : page
  }

  function commentOf(thread: ResolvedThreadRef, view: CommentView, author: Actor | undefined): Comment {
    return toComment(thread, parseAtUri(view.uri)!.rkey, view, author, webUrl, view)
  }

  const authors = new Map<string, Promise<string | undefined>>()

  /**
   * The account that wrote the first version of a record the knot hosts. A
   * moderator can edit someone else's comment, so the latest editor is not
   * always its author. Falls back to `editor` where the history can't be read.
   */
  function authorOf(repo: RepoHandle, uri: string, editor: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    let author = authors.get(uri)
    if (!author) {
      author = knotQuery<{ versions: RecordVersion[] }>(repo.knot, 'org.tangled.repo.listRecordVersions', { uri, limit: 1, order: 'asc' }, signal)
        .then(data => data.versions[0]?.editor ?? editor, (error: unknown) => {
          if (signal?.aborted || !degradesToWarning(error)) {
            throw error
          }
          return editor
        })
      author.catch(() => authors.delete(uri))
      authors.set(uri, author)
    }
    return author
  }

  async function actorOrNone(did: string | undefined, signal?: AbortSignal): Promise<Actor | undefined> {
    return did
      ? actorFor(did, signal)
      : undefined
  }

  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const { repo, rkey, uri } = await ticketFor(thread, listOptions.signal)
    const ref = toThreadRef(instance, repo.ref, rkey, thread.kind === 'pull_request'
      ? 'pull_request'
      : 'issue')
    const since = listOptions.since?.getTime()
    return listedPage('org.tangled.feed.listComments', { subject: uri, order: 'asc' }, listOptions, async (view: CommentView) => {
      if (since !== undefined && (toDate(view.createdAt)?.getTime() ?? 0) < since) {
        return undefined
      }
      return commentOf(ref, view, await actorOrNone(await authorOf(repo, view.uri, view.editor, listOptions.signal), listOptions.signal))
    })
  }

  /** A record the knot hosts, as the knot has it now. */
  async function knotRecord<T>(repo: RepoHandle, collection: string, rkey: string, signal?: AbortSignal): Promise<RecordResponse<T> & { cid: string }> {
    return knotQuery(repo.knot, 'com.atproto.repo.getRecord', { repo: repo.did, collection, rkey }, signal)
  }

  async function getComment(ref: CommentRef, readOptions?: BaseOptions): Promise<Comment> {
    const signal = readOptions?.signal
    const { repo } = await ticketFor(ref.thread, signal)
    const { uri, value } = await knotRecord<CommentRecord>(repo, COLLECTIONS.comment, ref.id, signal)
    const subject = parseAtUri(value.subject.uri)
    const thread = subject?.collection === COLLECTIONS.ticket
      ? toThreadRef(instance, repo.ref, subject.rkey, ref.thread.kind === 'pull_request'
          ? 'pull_request'
          : 'issue')
      : requireThread(ref.thread, context)
    return toComment(thread, ref.id, value, await actorOrNone(await authorOf(repo, uri, value['x-tngl-editor'], signal), signal), webUrl)
  }

  async function toReaction(record: ReactionRecord, signal?: AbortSignal): Promise<Reaction | undefined> {
    const editor = record['x-tngl-editor']
    return editor
      ? {
          content: REACTIONS[record.reaction] ?? 'other',
          contentRaw: record.reaction,
          actor: await actorFor(editor, signal),
          createdAt: toDate(record.createdAt),
          raw: record,
        }
      : undefined
  }

  async function reactionsPage(target: ThreadRef | CommentRef, listOptions: ListOptions = {}): Promise<Page<Reaction>> {
    const { uri } = await subjectUri(target, listOptions.signal)
    const since = listOptions.since?.getTime()
    return listedPage('org.tangled.feed.listReactions', { subject: uri, order: 'asc' }, listOptions, async ({ value }: RecordResponse<ReactionRecord>) => {
      return since !== undefined && (toDate(value.createdAt)?.getTime() ?? 0) < since
        ? undefined
        : toReaction(value, listOptions.signal)
    })
  }

  interface CollaboratorItem {
    subject: string
    addedBy?: string
    createdAt?: string
  }

  /** The repo owner, then the collaborators, who can push. */
  async function collaboratorsPage(repo: RepoRef, pageOptions: PageOptions = {}): Promise<Page<Collaborator>> {
    const { ref, did } = await repoFor(repo, pageOptions.signal)
    const page = await listedPage('org.tangled.repo.listCollaborators', { subject: did, order: 'asc' }, pageOptions, async (item: CollaboratorItem): Promise<Collaborator | undefined> => item.subject === ref.owner
      ? undefined
      : {
          actor: await actorFor(item.subject, pageOptions.signal),
          role: 'write',
          roleRaw: 'collaborator',
          permissions: COLLABORATOR_PERMISSIONS,
          raw: item,
        })
    return isFirstPage(pageOptions.cursor)
      ? {
          ...page,
          items: [
            {
              actor: await actorFor(ref.owner, pageOptions.signal),
              role: 'admin',
              roleRaw: 'owner',
              permissions: OWNER_PERMISSIONS,
              raw: { subject: ref.owner },
            },
            ...page.items,
          ],
        }
      : page
  }

  async function permissionFor(repo: RepoRef, actor: string | Actor, readOptions: BaseOptions = {}): Promise<RepoRole> {
    const [{ ref, did }, subject] = await Promise.all([
      repoFor(repo, readOptions.signal),
      didOf(actor, readOptions.signal),
    ])
    if (subject === ref.owner) {
      return 'admin'
    }
    for await (const item of everyItem<CollaboratorItem>('org.tangled.repo.listCollaborators', { subject: did }, readOptions.signal)) {
      if (item.subject === subject) {
        return 'write'
      }
    }
    return 'read'
  }

  /** What happened on a thread: its ticket's versions, its rounds, its comments and the reactions to it, oldest first. */
  async function eventsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> {
    const signal = listOptions.signal
    const { repo, rkey, uri } = await ticketFor(thread, signal)
    const warnings: ForgeWarning[] = []
    const [history, patches, comments, reactions] = await Promise.all([
      side(warnings, uri, () => historyOf(repo, uri, signal), signal),
      side(warnings, uri, () => patchesOf(uri, signal), signal),
      side(warnings, uri, () => Array.fromAsync(everyItem<CommentView>('org.tangled.feed.listComments', { subject: uri, order: 'asc' }, signal)), signal),
      side(warnings, uri, () => Array.fromAsync(everyItem<RecordResponse<ReactionRecord>>('org.tangled.feed.listReactions', { subject: uri, order: 'asc' }, signal)), signal),
    ])
    const versions = (history ?? []).filter((item): item is Required<TicketVersion> => item.record !== undefined)
    const latest = versions.at(-1)?.record
    const ref = toThreadRef(instance, repo.ref, rkey, latest
      ? ticketKind(latest)
      : thread.kind === 'pull_request'
        ? 'pull_request'
        : 'issue')
    const labels = versions.some(({ record }) => record.tangledLabels?.length)
      ? await side(warnings, uri, () => repoLabels(repo.did, signal), signal)
      : undefined
    const actorOf = (did: string | undefined) => did
      ? actorFor(did, signal)
      : undefined
    const created = (activity: Omit<ActivityRecord, 'operation'>, actor: Actor | undefined, ticket?: TicketRecord) =>
      toActivityEvent(instance, { ...activity, operation: 'create' }, actor, ref, 'poll', new Date(0), ticket)
    const events: ForgeEventInput[] = []
    for (const [index, { version, record }] of versions.entries()) {
      const actor = await actorOf(version.editor)
      const before = versions[index - 1]?.record
      if (!before) {
        events.push(created({ uri, collection: COLLECTIONS.ticket, record }, actor, record))
        continue
      }
      for (const change of ticketChanges(before, record)) {
        const definition = change.type === 'label'
          ? labels?.get(change.key)
          : undefined
        events.push(toChangeEvent(ref, record, version, change, actor, {
          label: definition && toLabel(definition),
          assignee: change.type === 'assignee'
            ? await actorFor(change.did, signal)
            : undefined,
        }))
      }
    }
    for (const patch of (patches ?? []).slice(1)) {
      events.push(created({ uri: patch.uri, collection: COLLECTIONS.patch, record: patch.value }, await actorOf(patch.value['x-tngl-editor'] ?? parseAtUri(patch.uri)!.did), latest))
    }
    for (const comment of comments ?? []) {
      events.push(created({
        uri: comment.uri,
        collection: COLLECTIONS.comment,
        record: { body: comment.body, subject: comment.subject, createdAt: comment.createdAt },
      }, await actorOf(await authorOf(repo, comment.uri, comment.editor, signal) ?? parseAtUri(comment.uri)!.did), latest))
    }
    for (const reaction of reactions ?? []) {
      events.push(created({ uri: reaction.uri, collection: COLLECTIONS.reaction, record: reaction.value }, await actorOf(reaction.value['x-tngl-editor'] ?? parseAtUri(reaction.uri)!.did), latest))
    }
    const since = listOptions.since?.getTime()
    const items = events
      .filter(event => since === undefined || event.occurredAt.getTime() >= since)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    return warnings.length
      ? { items, warnings }
      : { items }
  }

  /** The ticket a record is about: a ticket itself, the ticket a round belongs to, or the subject of a comment or reaction. */
  async function ticketOf(activity: ActivityRecord, signal?: AbortSignal): Promise<{ repo: string, rkey: string } | undefined> {
    const uri = parseAtUri(activity.uri)
    if (!uri) {
      return undefined
    }
    if (activity.collection === COLLECTIONS.ticket) {
      return { repo: uri.did, rkey: uri.rkey }
    }
    if (activity.collection === COLLECTIONS.patch) {
      const ticket = (activity.record as PatchRecord | undefined)?.ticket
      return ticket
        ? { repo: uri.did, rkey: ticket }
        : undefined
    }
    const subject = parseAtUri((activity.record as CommentRecord | ReactionRecord | undefined)?.subject?.uri ?? '')
    if (subject?.collection === COLLECTIONS.ticket) {
      return { repo: subject.did, rkey: subject.rkey }
    }
    if (subject?.collection !== COLLECTIONS.comment) {
      return undefined
    }
    // A reaction to a comment is about the ticket the comment is on.
    const comment = await knotRecord<CommentRecord>(await repoByDid(subject.did, signal), COLLECTIONS.comment, subject.rkey, signal)
    const parent = parseAtUri(comment.value.subject.uri)
    return parent?.collection === COLLECTIONS.ticket
      ? { repo: parent.did, rkey: parent.rkey }
      : undefined
  }

  /** The event for one record, with the thread it is about where that thread can be read. */
  async function recordEvent(activity: ActivityRecord, source: SourceKind, fallbackTime: Date, signal?: AbortSignal): Promise<ForgeEventInput> {
    const editor = (activity.record as { 'x-tngl-editor'?: string } | undefined)?.['x-tngl-editor']
    const [actor, read] = await Promise.all([
      editor
        ? actorFor(editor, signal)
        : undefined,
      (async () => {
        const ticket = await ticketOf(activity, signal)
        if (!ticket) {
          return undefined
        }
        const repo = await repoByDid(ticket.repo, signal)
        const record = activity.collection === COLLECTIONS.ticket && activity.record
          ? activity.record as TicketRecord
          : (await query<Listed<RecordResponse<TicketRecord>>>('org.tangled.track.getTickets', {
              uris: [
                atUri(ticket.repo, COLLECTIONS.ticket, ticket.rkey),
              ],
            }, signal)).items[0]?.value
        return record && {
          ref: toThreadRef(instance, repo.ref, ticket.rkey, ticketKind(record)),
          record,
        }
      })().catch((error: unknown) => {
        if (signal?.aborted) {
          throw error
        }
        return undefined
      }),
    ])
    return toActivityEvent(instance, activity, actor, read?.ref, source, fallbackTime, read?.record)
  }

  function toStreamEvent(message: JetstreamCommitEvent): Promise<ForgeEventInput | undefined> {
    const { commit } = message
    return recordEvent({
      uri: atUri(message.did, commit.collection, commit.rkey),
      collection: commit.collection,
      record: commit.record,
      operation: commit.operation,
      rev: commit.rev,
    }, 'stream', new Date(message.time_us / 1000))
  }

  /** Waits until the index has a record version a knot or PDS wrote, so that a read after a write finds it. */
  async function awaitIndexed(uri: string, cid: string | undefined, signal?: AbortSignal): Promise<void> {
    await query('org.tangled.bobbin.awaitRecord', { uri, cid }, signal).catch((error: unknown) => {
      if (signal?.aborted || !degradesToWarning(error)) {
        throw error
      }
    })
  }

  /** One page of the records of `collection` that `did` authored, newest first. */
  async function listActivity(did: string, collection: string, { limit, offset, signal }: { limit: number, offset: number, signal?: AbortSignal }): Promise<Array<{ uri: string, cid?: string, value?: unknown }>> {
    const page = { limit, offset: offset || undefined }
    if (collection === COLLECTIONS.ticket) {
      return (await query<{ hits: Array<{ uri: string, cid?: string, value: unknown }> }>('org.tangled.search.query', {
        author: did,
        nsid: collection,
        sort: 'created-desc',
        ...page,
      }, signal)).hits
    }
    const listings: Record<string, string> = {
      [COLLECTIONS.comment]: 'org.tangled.feed.listCommentsBy',
      [COLLECTIONS.reaction]: 'org.tangled.feed.listReactionsBy',
    }
    return (await query<Listed<RecordResponse<unknown>>>(listings[collection]!, { subject: did, order: 'desc', ...page }, signal)).items
  }

  return {
    query,
    actorFor,
    didOf,
    repoFor,
    repoByDid,
    toRepo,
    repoCounts,
    repoLabels,
    forgetLabels,
    latestPatch,
    ticketFor,
    subjectUri,
    ticketThread,
    readThread,
    listPage,
    searchThreadsPage,
    searchReposPage,
    commentsPage,
    knotRecord,
    getComment,
    reactionsPage,
    collaboratorsPage,
    permissionFor,
    eventsPage,
    recordEvent,
    toStreamEvent,
    awaitIndexed,
    listActivity,
  }
}
