import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher } from '../fetch.ts'
import type {
  Comment,
  Cursor,
  ForgeEventInput,
  ForgeWarning,
  Page,
  Repo,
  RepoRef,
  ResolvedThreadRef,
  Thread,
  ThreadQuery,
  ThreadRef,
} from '../model.ts'
import type { ForgeIterable } from '../provider.ts'
import type { AtprotoClient, AtUri } from './atproto.ts'
import type { TangledOptions } from './index.ts'
import type { TangledSession } from './session.ts'
import type { FeedCommentRecord, IssueRecord, JetstreamCommitEvent, PullRecord, RecordResponse, RepoRecord, StateRecord, SubscriptionRecord, TangledRecord } from './types.ts'
import { ForgeApiError, ForgeError, NotFoundError, RateLimitedError, TokenRevokedError, UnresolvedThreadError } from '../errors.ts'
import { forgeIterable, mapConcurrent, phased, requireThread, toDate, toWarning } from '../utils.ts'
import { atUri, parseAtUri } from './atproto.ts'
import {
  COLLECTIONS,
  FORGE,
  stateToken,
  subjectOf,
  threadKindOf,
  toActivityEvent,
  toActor,
  toRecordComment,
  toThread,
  toThreadRef,
} from './normalise.ts'

const TANGLED_DID = 'did:plc:wshs7t2adsemcrrd4snkeqli'

/** Knots that accept git over SSH on a different host. */
const DEFAULT_SSH_HOSTS: Record<string, string> = {
  'knot1.tangled.sh': 'tangled.org',
}

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
  function collaboratorsOf(repo: RepoRef): Promise<{ dids: Set<string>, warning?: ForgeWarning }> {
    const repoDid = repo.externalId
    if (!repoDid) {
      return Promise.resolve({ dids: new Set<string>() })
    }
    let found = collaborators.get(repoDid)
    if (!found) {
      found = (async () => {
        const { pds: knot } = await atproto.resolveDid(repoDid)
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
    return found
  }

  /**
   * Accounts whose state records the appview accepts: the thread author, the
   * repo owner, collaborators with push access, and Tangled's own account.
   */
  async function stateAuthors(authorDid: string, repo: RepoRef, warn?: (warning: ForgeWarning) => void): Promise<Set<string>> {
    const { dids, warning } = await collaboratorsOf(repo)
    if (warning) {
      warn?.(warning)
    }
    return new Set([authorDid, repo.owner, TANGLED_DID, ...dids])
  }

  async function actorFor(did: string) {
    const identity = await atproto.resolveDid(did).catch(() => ({ did }))
    return toActor(instance, identity, webUrl)
  }

  /** Resolves a record's `repo` field, a repo DID or, in older records, an `sh.tangled.repo` AT-URI. */
  function resolveRepo(field: string): Promise<RepoRef> {
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
    return repo
  }

  async function threadFor(subject: string): Promise<{ ref: ResolvedThreadRef, record: IssueRecord | PullRecord, cid?: string }> {
    const uri = parseAtUri(subject)
    if (!uri || !threadKindOf(uri.collection)) {
      throw new UnresolvedThreadError(`${subject} is not an issue or pull request`, context)
    }
    const { value, cid } = await atproto.getRecord<IssueRecord | PullRecord>(subject)
    const repoField = 'target' in value ? value.target.repo : value.repo
    return { ref: toThreadRef(instance, await resolveRepo(repoField), uri), record: value, cid }
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
  async function readLinked<T extends TangledRecord>(uri: string, warn: (warning: ForgeWarning) => void): Promise<T | undefined> {
    try {
      return (await atproto.getRecord<T>(uri)).value
    }
    catch (error) {
      if (error instanceof NotFoundError) {
        return undefined
      }
      if (error instanceof RateLimitedError || error instanceof TokenRevokedError || !(error instanceof ForgeError)) {
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
    sources = ACTIVITY_SOURCES(kind),
  ): AsyncGenerator<{ uri: string, collection: string, record: TangledRecord }> {
    for (const source of sources) {
      for await (const link of atproto.backlinks(target, source.collection, source.path)) {
        if (source === STATE_COLLECTION[kind] && !allowedState.has(link.did)) {
          continue
        }
        const uri = atUri(link.did, link.collection, link.rkey)
        const record = await readLinked(uri, warn)
        if (record) {
          yield { uri, collection: link.collection, record }
        }
      }
    }
  }

  async function stateOf(target: string, kind: 'issue' | 'pull_request', allowed: Set<string>, warn: (warning: ForgeWarning) => void): Promise<{ token?: string, at?: string }> {
    let latest: { token?: string, at?: string } = {}
    const source = STATE_COLLECTION[kind]
    for await (const link of atproto.backlinks(target, source.collection, source.path)) {
      if (!allowed.has(link.did)) {
        continue
      }
      const value = await readLinked<StateRecord>(atUri(link.did, link.collection, link.rkey), (warning) => {
        warn({ ...warning, code: 'state_record_unreachable', message: `State may be stale: ${warning.message}` })
      })
      if (!value) {
        continue
      }
      if (!latest.at || (toDate(value.createdAt)?.getTime() ?? 0) > (toDate(latest.at)?.getTime() ?? 0)) {
        latest = { token: stateToken(value), at: value.createdAt }
      }
    }
    return latest
  }

  async function countComments(target: string, kind: 'issue' | 'pull_request'): Promise<number> {
    let count = 0
    for (const source of COMMENT_SOURCES[kind]) {
      for await (const _ of atproto.backlinks(target, source.collection, source.path)) {
        count++
      }
    }
    return count
  }

  async function toStreamEvent(message: JetstreamCommitEvent): Promise<ForgeEventInput | undefined> {
    const { commit } = message
    const uri = atUri(message.did, commit.collection, commit.rkey)
    const subject = commit.record ? subjectOf(commit.collection, commit.record, uri) : undefined
    const thread = subject
      ? await threadFor(subject).then(({ ref }) => ref, () => undefined)
      : undefined
    return toActivityEvent(
      instance,
      { uri, collection: commit.collection, record: commit.record, operation: commit.operation, rev: commit.rev },
      await actorFor(message.did),
      thread,
      'subscribe',
      new Date(message.time_us / 1000),
    )
  }

  const canonical = new Map<string, Promise<{ ref: RepoRef, record: RecordResponse<RepoRecord> }>>()

  /** The repo record `repo` names, where `owner` may be a handle and `name` the record's name rather than its key. */
  function canonicalRepo(repo: RepoRef): Promise<{ ref: RepoRef, record: RecordResponse<RepoRecord> }> {
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
    return found
  }

  /** `repo` with a DID owner and the record key as `name`; refs this provider returned already are. */
  async function canonicalRef(repo: RepoRef): Promise<RepoRef> {
    return repo.externalId && repo.owner.startsWith('did:') ? repo : (await canonicalRepo(repo)).ref
  }

  async function repoDidOf(repo: RepoRef): Promise<string> {
    if (repo.externalId) {
      return repo.externalId
    }
    const { record: { value } } = await canonicalRepo(repo)
    if (!value.repoDid) {
      throw new UnresolvedThreadError(`${repo.owner}/${repo.name} has no repo DID`, context)
    }
    return value.repoDid
  }

  function sshHost(knot: string): string {
    return options.sshHosts?.[knot] ?? DEFAULT_SSH_HOSTS[knot] ?? knot
  }

  function toRepo(ref: RepoRef, record: RepoRecord, raw: unknown): Repo {
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
      raw,
    }
  }

  async function readThread(thread: ThreadRef): Promise<Thread> {
    const { uri, kind } = subjectUri(thread)
    const target = atUri(uri.did, uri.collection, uri.rkey)
    const { ref, record } = await threadFor(target)
    const warnings: ForgeWarning[] = []
    const warn = (warning: ForgeWarning) => warnings.push(warning)
    const [author, state, comments] = await Promise.all([
      actorFor(uri.did),
      stateAuthors(uri.did, ref.repo, warn).then(allowed => stateOf(target, kind, allowed, warn)),
      countComments(target, kind),
    ])
    return toThread(ref, record, author, state, comments, warnings)
  }

  async function listFromIndex(repo: RepoRef, query: ThreadQuery): Promise<Page<Thread>> {
    const warnings: ForgeWarning[] = []
    if (!query.cursor) {
      warnings.push({ code: 'index_possibly_stale', message: 'Listed from the Bobbin index; states may lag behind the records' })
      if (query.sort && query.sort !== 'created') {
        warnings.push({ code: 'sort_unsupported', message: 'The index sorts by creation time only' })
      }
    }
    const repoDid = await repoDidOf(repo)
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
        const author = await actorFor(uri.did)
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
      if (query.labels?.length || query.assignee) {
        warn({ code: 'filter_unsupported', message: 'Tangled labels and assignees are not read yet; those filters were ignored' })
      }
      const address = await canonicalRef(repo)
      const repoDid = await repoDidOf(repo)
      const targets = [repoDid, atUri(address.owner, COLLECTIONS.repo, address.name)]
      const uris: string[] = []
      for (const kind of query.kind ? [query.kind] : ['issue', 'pull_request'] as const) {
        const collection = kind === 'issue' ? COLLECTIONS.issue : COLLECTIONS.pull
        for (const target of targets) {
          for await (const link of atproto.backlinks(target, collection, kind === 'issue' ? '.repo' : '.target.repo')) {
            uris.push(atUri(link.did, link.collection, link.rkey))
          }
        }
      }
      const threadsRead = await mapConcurrent([...new Set(uris)], 4, async (uri) => {
        const parsed = parseAtUri(uri)!
        try {
          const thread = await readThread({ forge: FORGE, instance, repo, kind: threadKindOf(parsed.collection)!, number: uri })
          thread.warnings?.forEach(warn)
          return thread
        }
        catch (error) {
          if (error instanceof RateLimitedError || error instanceof TokenRevokedError || !(error instanceof ForgeError)) {
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
        .filter(thread => !query.since || (thread.lastActivityAt?.getTime() ?? 0) >= query.since.getTime())
        .filter(thread => !query.createdAfter || (thread.createdAt?.getTime() ?? 0) >= query.createdAfter.getTime())
        .sort((a, b) => (sortKey(a) - sortKey(b)) * direction)
    })
  }

  function listComments(thread: ThreadRef): ForgeIterable<Comment> {
    const { ref, uri, kind } = subjectUri(thread)
    const target = atUri(uri.did, uri.collection, uri.rkey)
    return forgeIterable(async function* (warn) {
      const comments: Comment[] = []
      for await (const item of activity(target, kind, new Set(), warn, COMMENT_SOURCES[kind])) {
        comments.push(toRecordComment(ref, item.uri, item.record as FeedCommentRecord, await actorFor(parseAtUri(item.uri)!.did)))
      }
      yield* comments.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    })
  }

  async function findSubscription(thread: ThreadRef): Promise<string | undefined> {
    const { uri } = subjectUri(thread)
    const target = atUri(uri.did, uri.collection, uri.rkey)
    for await (const record of ownRecords<SubscriptionRecord>(COLLECTIONS.subscription)) {
      if (record.value.subject.uri === target) {
        return record.uri
      }
    }
    return undefined
  }

  return { stateAuthors, actorFor, resolveRepo, threadFor, subjectUri, activity, toStreamEvent, canonicalRepo, canonicalRef, repoDidOf, toRepo, readThread, wholePage, listPage, listComments, findSubscription }
}
