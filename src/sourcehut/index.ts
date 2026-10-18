import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher } from '../fetch.ts'
import type {
  BaseOptions,
  Branch,
  Comment,
  CommitRef,
  ForgeEventInput,
  ListOptions,
  Page,
  PageOptions,
  Release,
  ReleaseAssetRef,
  ReleaseRef,
  Repo,
  RepoQuery,
  RepoRef,
  RepoRole,
  Tag,
  Thread,
  ThreadQuery,
  ThreadRef,
  TreeEntry,
  TreeOptions,
} from '../model.ts'
import type { ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { WebLinks } from '../web.ts'
import type { SourcehutGraphQL } from './client.ts'
import type { Service } from './services.ts'
import type { ShAcl, ShCommit, ShEmail, ShEvent, ShJob, ShLabel, ShPage, ShPatchset, ShReference, ShRepository, ShTicket, ShUser } from './types.ts'
import { fromBase64, toFileContent } from '../contents.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { InsufficientScopeError, NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { getManyConcurrently, isFirstPage, phased, requireThread, resolveToken, toDate } from '../utils.ts'
import { webUrlFor } from '../web.ts'
import { createSourcehutClient } from './client.ts'
import {
  branchOf,
  FORGE,
  toBranch,
  toCiJob,
  toCiRun,
  toCodeMatch,
  toCollaborator,
  toCommit,
  toEmailComment,
  toEmailEvent,
  toLabel,
  toPatchsetThread,
  toRelease,
  toRepo,
  toTag,
  toTicketComment,
  toTicketEvents,
  toTicketThread,
  toTreeEntry,
  toUser,
  usernameOf,
} from './normalise.ts'
import * as Q from './queries.ts'
import { serviceHost, SERVICES, serviceUrl } from './services.ts'
import { SOURCEHUT_WEB } from './web.ts'
import { sourcehutWebhooks } from './webhooks.ts'

/** A Sourcehut personal access token or OAuth bearer token, sent as `Authorization: Bearer`. */
export type SourcehutAuth = TokenAuth

/** Options for `sourcehut()`. */
export interface SourcehutOptions extends ForgeOptionsBase {
  /** How to authenticate. Every Sourcehut service refuses reads without a token. */
  auth: SourcehutAuth
  /**
   * Instance root; each service is a subdomain of its host (`sr.ht` gives
   * `meta.sr.ht`, `git.sr.ht`, `todo.sr.ht`, `lists.sr.ht`, `builds.sr.ht`).
   * `request()` takes an absolute URL and sends it to the service it names.
   * @default https://sr.ht
   */
  baseUrl?: string
  /**
   * Base64 ed25519 public key used to verify inbound webhook deliveries.
   * Defaults to the public key of `sr.ht`; set it for a self-hosted instance.
   */
  webhookPublicKey?: string
}

/** `TextBlob.text` is capped at 128 KiB and `BinaryBlob.base64` at 32 KiB; past that the blob is fetched from `content`. */
const TEXT_INLINE_LIMIT = 128 * 1024
const BINARY_INLINE_LIMIT = 32 * 1024

function notFound(ref: RepoRef | ThreadRef | ReleaseRef, context: ForgeErrorContext): NotFoundError {
  const slug = 'repo' in ref ? `${ref.repo.owner}/${ref.repo.name}` : `${ref.owner}/${ref.name}`
  return new NotFoundError(`Nothing found for ${slug} on Sourcehut, or the credential cannot see it`, 404, '', context)
}

/** Sourcehut ids are integers; a non-numeric ref would otherwise reach the API as `null` and fail as a GraphQL error. */
function numericId(value: string | undefined, what: string, context: ForgeErrorContext): number {
  const parsed = value ? Number(value) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new NotFoundError(`Sourcehut has no ${what} ${value || 'with that id'}`, 404, '', context)
  }
  return parsed
}

/** The host of an absolute URL, or an empty string for a relative path. */
function hostOf(path: string): string {
  try {
    return new URL(path).host
  }
  catch {
    return ''
  }
}

function pageOf<R, T>(page: ShPage<R> | null | undefined, map: (raw: R) => T, warnings?: Page<T>['warnings']): Page<T> {
  return {
    items: (page?.results ?? []).map(map),
    ...page?.cursor ? { cursor: { token: page.cursor } } : {},
    ...warnings?.length ? { warnings } : {},
  }
}

/** `ListOptions.since` is not a Sourcehut filter, so drop the events the forge returned before it. */
function filterSince(page: Page<ForgeEventInput>, since: Date | undefined): Page<ForgeEventInput> {
  return since ? { ...page, items: page.items.filter(item => item.occurredAt >= since) } : page
}

/** When a tag was made: the tag object's own time for an annotated tag, else the commit's. */
function tagTime(ref: ShReference): string {
  return ref.follow?.tagger?.time ?? ref.follow?.committer?.time ?? ref.follow?.target?.committer?.time ?? ''
}

/** Newest first by instant, not by string: Sourcehut returns timestamps with differing UTC offsets. */
function byTagTimeDesc(a: { at: string }, b: { at: string }): number {
  return (toDate(b.at)?.getTime() ?? 0) - (toDate(a.at)?.getTime() ?? 0)
}

/** `Filter.count` is the only page-size knob Sourcehut's repository resolvers accept. */
function countFilter(perPage?: number): { count: number } | undefined {
  return perPage === undefined ? undefined : { count: perPage }
}

function setupSourcehut(ctx: ProviderContext<SourcehutOptions, undefined>): ProviderSpec & { web: WebLinks } {
  const { options, instance, origin, createFetcher, fetcher } = ctx
  const authHeaders = async () => ({ authorization: `Bearer ${await resolveToken(options.auth)}` })
  const fetchers = new Map<Service, Fetcher>(SERVICES.map(service => [service, createFetcher({ baseUrl: serviceUrl(instance, service), authHeaders })]))
  const client = (service: Service): SourcehutGraphQL => {
    const url = serviceUrl(instance, service)
    return createSourcehutClient(fetchers.get(service)!, service, `${url}/query`, origin)
  }
  const meta = client('meta')
  const git = client('git')
  const todo = client('todo')
  const lists = client('lists')
  const builds = client('builds')
  const gitFetcher = fetchers.get('git')!
  const buildsFetcher = fetchers.get('builds')!
  const byHost = new Map(SERVICES.map(service => [serviceHost(instance, service), fetchers.get(service)!]))
  // `request()` takes an absolute URL, which lands on a service subdomain the
  // instance-root fetcher would send no credentials to; route it to its service.
  const requestFetcher: Fetcher = {
    ...fetcher,
    json: (path, requestOptions) => (byHost.get(hostOf(path)) ?? fetcher).json(path, requestOptions),
    stream: (path, requestOptions) => (byHost.get(hostOf(path)) ?? fetcher).stream(path, requestOptions),
  }
  const web = SOURCEHUT_WEB.links({ baseUrl: ctx.baseUrl, instance })

  const repoParts = (repo: RepoRef) => ({ owner: usernameOf(repo.owner), name: repo.name })

  async function getRepo(repo: RepoRef, options?: BaseOptions): Promise<Repo> {
    const { user } = await git.query<{ user: { repository: ShRepository | null } | null }>(Q.RepositoryByOwner, repoParts(repo), options)
    if (!user?.repository) {
      throw notFound(repo, origin)
    }
    return toRepo(origin, user.repository)
  }

  async function getTicket(ref: ThreadRef, options?: BaseOptions): Promise<ShTicket> {
    const { user } = await todo.query<{ user: { tracker: { ticket: ShTicket | null } | null } | null }>(Q.Ticket, { ...repoParts(ref.repo), id: numericId(ref.number, 'ticket', origin) }, options)
    const ticket = user?.tracker?.ticket
    if (!ticket) {
      throw notFound(ref, origin)
    }
    return ticket
  }

  /** A patchset id is global to lists.sr.ht, so confirm the patchset belongs to the list the ref names. */
  function onList(patchset: ShPatchset | null | undefined, repo: RepoRef): patchset is ShPatchset {
    const list = patchset?.list
    return !!list && list.name === repo.name && usernameOf(list.owner?.canonicalName ?? '') === usernameOf(repo.owner)
  }

  async function getPatchset(ref: ThreadRef, options?: BaseOptions): Promise<ShPatchset> {
    const { patchset } = await lists.query<{ patchset: ShPatchset | null }>(Q.Patchset, { id: numericId(ref.number, 'patchset', origin) }, options)
    if (!onList(patchset, ref.repo)) {
      throw notFound(ref, origin)
    }
    return patchset
  }

  async function getThread(ref: ThreadRef, options?: BaseOptions): Promise<Thread> {
    const thread = requireThread(ref, origin)
    if (thread.kind === 'issue') {
      return toTicketThread(origin, await getTicket(thread, options))
    }
    if (thread.kind === 'pull_request') {
      return toPatchsetThread(origin, await getPatchset(thread, options))
    }
    throw new UnsupportedOperationError(`${FORGE} does not read ${thread.kind} threads`, origin)
  }

  async function listTickets(repo: RepoRef, query: ThreadQuery, warnings?: Page<Thread>['warnings']): Promise<Page<Thread>> {
    const { user } = await todo.query<{ user: { tracker: { tickets: ShPage<ShTicket> } | null } | null }>(Q.TrackerTickets, { ...repoParts(repo), cursor: query.cursor?.token }, query)
    if (!user) {
      throw notFound(repo, origin)
    }
    const page = pageOf(user.tracker?.tickets, ticket => toTicketThread(origin, ticket))
    return { ...page, items: filterThreads(page.items, query), ...warnings?.length ? { warnings } : {} }
  }

  async function listPatches(repo: RepoRef, query: ThreadQuery, warnings?: Page<Thread>['warnings']): Promise<Page<Thread>> {
    const { user } = await lists.query<{ user: { list: { patches: ShPage<ShPatchset> } | null } | null }>(Q.ListPatches, { ...repoParts(repo), cursor: query.cursor?.token }, query)
    if (!user) {
      throw notFound(repo, origin)
    }
    const page = pageOf(user.list?.patches, patchset => toPatchsetThread(origin, patchset))
    return { ...page, items: filterThreads(page.items, query), ...warnings?.length ? { warnings } : {} }
  }

  function filterThreads(items: Thread[], query: ThreadQuery): Thread[] {
    // `ThreadQuery.state` defaults to 'open'; Sourcehut returns every state, so filter here.
    const state = query.state ?? 'open'
    return items.filter((thread) => {
      if (state === 'open') {
        return thread.state === 'open'
      }
      if (state === 'closed') {
        return thread.state === 'closed' || thread.state === 'merged'
      }
      if (state === 'merged') {
        return thread.state === 'merged'
      }
      return true
    })
  }

  /** Warnings when the caller asked for filters or an order Sourcehut's ticket and patch listings cannot apply. */
  function threadFilterWarnings(query: ThreadQuery): Page<Thread>['warnings'] {
    // `involves`, `mentions` and `milestone` are not here: core strips them for a
    // provider that does not declare them in `threads.listFilters`, and warns.
    const filtered = query.labels !== undefined || query.author !== undefined || query.assignee !== undefined || query.since !== undefined || query.createdAfter !== undefined
    const sorted = (query.sort !== undefined && query.sort !== 'created') || (query.direction !== undefined && query.direction !== 'desc')
    const warnings = [
      ...filtered ? [{ code: 'filter_unsupported' as const, message: 'Sourcehut lists threads without filtering by labels, author, assignee or date' }] : [],
      ...sorted ? [{ code: 'sort_unsupported' as const, message: 'Sourcehut lists threads in its own order' }] : [],
    ]
    return warnings.length ? warnings : undefined
  }

  /** Warnings when the caller asked for a filter or an order Sourcehut's repository listings cannot apply. */
  function repoWarnings(query: { sort?: unknown, direction?: unknown }, filtered?: string): Page<Repo>['warnings'] {
    const warnings = [
      ...filtered ? [{ code: 'filter_unsupported' as const, message: filtered }] : [],
      ...query.sort !== undefined || query.direction !== undefined ? [{ code: 'sort_unsupported' as const, message: 'Sourcehut lists repositories in its own order' }] : [],
    ]
    return warnings.length ? warnings : undefined
  }

  async function ticketEventPage(ref: ThreadRef, options?: ListOptions): Promise<ShPage<ShEvent>> {
    const { user } = await todo.query<{ user: { tracker: { ticket: { events: ShPage<ShEvent> } | null } | null } | null }>(Q.TicketEvents, { ...repoParts(ref.repo), id: numericId(ref.number, 'ticket', origin), cursor: options?.cursor?.token }, options)
    const events = user?.tracker?.ticket?.events
    if (!events) {
      throw notFound(ref, origin)
    }
    return events
  }

  async function ticketEvents(ref: ThreadRef, options?: ListOptions): Promise<Page<ForgeEventInput>> {
    const page = await ticketEventPage(ref, options)
    return {
      items: page.results.flatMap(event => toTicketEvents(ref, event)),
      ...page.cursor ? { cursor: { token: page.cursor } } : {},
    }
  }

  /** Whether an email is one of the patchset's patches rather than a reply. Sourcehut returns `patch` with null fields for a reply. */
  function isPatchEmail(email: ShEmail): boolean {
    return email.patch?.index != null || email.patch?.count != null
  }

  /** The replies on a patchset's thread. The patch emails themselves are excluded: they are the change, not the conversation. */
  async function patchsetEmails(ref: ThreadRef, options?: ListOptions): Promise<ShPage<ShEmail>> {
    const { patchset } = await lists.query<{ patchset: (ShPatchset & { thread: { descendants: ShPage<ShEmail> } }) | null }>(Q.PatchsetEmails, { id: numericId(ref.number, 'patchset', origin), cursor: options?.cursor?.token }, options)
    const descendants = onList(patchset, ref.repo) ? patchset.thread?.descendants : undefined
    if (!descendants) {
      throw notFound(ref, origin)
    }
    return { ...descendants, results: descendants.results.filter(email => !isPatchEmail(email)) }
  }

  async function comments(ref: ThreadRef, options?: ListOptions): Promise<Page<Comment>> {
    const thread = requireThread(ref, origin)
    if (thread.kind === 'issue') {
      const page = await ticketEventPage(thread, options)
      const items = page.results.flatMap(event => event.changes.filter(change => change.eventType === 'COMMENT').map(change => toTicketComment(thread, event, change)))
      return { items, ...page.cursor ? { cursor: { token: page.cursor } } : {} }
    }
    if (thread.kind === 'pull_request') {
      return pageOf(await patchsetEmails(thread, options), email => toEmailComment(thread, email))
    }
    throw new UnsupportedOperationError(`${FORGE} does not read comments on a ${thread.kind}`, origin)
  }

  async function events(ref: ThreadRef, options?: ListOptions): Promise<Page<ForgeEventInput>> {
    const thread = requireThread(ref, origin)
    if (thread.kind === 'issue') {
      return filterSince(await ticketEvents(thread, options), options?.since)
    }
    if (thread.kind === 'pull_request') {
      return filterSince(pageOf(await patchsetEmails(thread, options), email => toEmailEvent(thread, email)), options?.since)
    }
    throw new UnsupportedOperationError(`${FORGE} does not read events on a ${thread.kind}`, origin)
  }

  /** The refs of a repository, plus its default branch. Sourcehut returns `repository: null` for a missing repo. */
  async function refs(repo: RepoRef, cursor: string | undefined, options?: BaseOptions): Promise<{ references: ShPage<ShReference>, defaultBranch?: string }> {
    const { user } = await git.query<{ user: { repository: { HEAD: { name: string } | null, references: ShPage<ShReference> } | null } | null }>(Q.RepositoryRefs, { ...repoParts(repo), cursor }, options)
    if (!user?.repository) {
      throw notFound(repo, origin)
    }
    return { references: user.repository.references, defaultBranch: branchOf(user.repository.HEAD?.name) }
  }

  async function treePage(repo: RepoRef, options: TreeOptions = {}): Promise<Page<TreeEntry>> {
    const revspec = options.ref ?? 'HEAD'
    const path = (options.path ?? '').replace(/^\/+|\/+$/g, '')
    const warnings = options.recursive
      ? [{ code: 'recursive_unsupported' as const, message: 'Sourcehut lists one level of a tree; read subdirectories separately' }]
      : undefined
    if (path === '') {
      const { user } = await git.query<{ user: { repository: { revparse_single: { tree: { entries: ShPage<ShTreeEntryNode> } } | null } | null } | null }>(Q.RepositoryRootTree, { ...repoParts(repo), revspec, cursor: options.cursor?.token }, options)
      const entries = user?.repository?.revparse_single?.tree?.entries
      if (!entries) {
        throw new NotFoundError(`No revision ${revspec} in ${repo.owner}/${repo.name}`, 404, '', origin)
      }
      return { ...pageOf(entries, entry => toTreeEntry('', entry)), ...warnings ? { warnings } : {} }
    }
    const { user } = await git.query<{ user: { repository: { path: { object: { entries: ShPage<ShTreeEntryNode> } } | null } | null } | null }>(Q.RepositoryTree, { ...repoParts(repo), revspec, path, cursor: options.cursor?.token }, options)
    const entries = user?.repository?.path?.object?.entries
    if (!entries) {
      throw new NotFoundError(`No directory ${path} in ${repo.owner}/${repo.name}`, 404, '', origin)
    }
    return { ...pageOf(entries, entry => toTreeEntry(path, entry)), ...warnings ? { warnings } : {} }
  }

  /** Tags with their commit time, newest first, so `releases.latest()` means the most recent tag. */
  async function tagsOf(repo: RepoRef, options?: PageOptions): Promise<Page<{ tag: string, artifacts: ShReference['artifacts'], at: string }>> {
    const { references } = await refs(repo, options?.cursor?.token, options)
    const items = references.results
      .filter(ref => ref.name.startsWith('refs/tags/'))
      .map(ref => ({ tag: ref.name.replace(/^refs\/tags\//, ''), artifacts: ref.artifacts, at: tagTime(ref) }))
      .sort(byTagTimeDesc)
    return { items, ...references.cursor ? { cursor: { token: references.cursor } } : {} }
  }

  /**
   * Each page is newest-first, but tags share pages with branches, so across
   * pages `releases.list()` is not globally newest-first. `releases.latest()`
   * sorts the whole set instead.
   */
  async function releasesPage(repo: RepoRef, options?: PageOptions): Promise<Page<Release>> {
    const page = await tagsOf(repo, options)
    return { ...page, items: page.items.map(({ tag, artifacts, at }) => toRelease(repo, tag, artifacts?.results ?? [], at)) }
  }

  /** `latest` reads every refs page, because tags sort after branches and can fall on a later page. */
  async function latestTag(repo: RepoRef, options?: BaseOptions): Promise<Release | undefined> {
    const tags: Array<{ tag: string, artifacts: ShReference['artifacts'], at: string }> = []
    let cursor: string | undefined
    do {
      const page = await tagsOf(repo, { cursor: cursor ? { token: cursor } : undefined, signal: options?.signal })
      tags.push(...page.items)
      cursor = page.cursor?.token
    } while (cursor)
    return tags.sort(byTagTimeDesc).map(({ tag, artifacts, at }) => toRelease(repo, tag, artifacts?.results ?? [], at))[0]
  }

  return {
    traits: {
      eventKinds: 'native',
      authKinds: ['token'],
    },
    users: {
      get: verb(true, async (login, options) => {
        const { userByName } = await meta.query<{ userByName: ShUser | null }>(Q.UserByName, { username: usernameOf(login) }, options)
        if (!userByName) {
          throw new NotFoundError(`No Sourcehut account named ${login}`, 404, '', origin)
        }
        return toUser(origin, userByName)
      }),
      me: verb(true, async options => toUser(origin, (await meta.query<{ me: ShUser }>(Q.Me, {}, options)).me)),
    },
    repos: {
      get: verb(true, getRepo),
      listPage: verb(true, async (query: RepoQuery = {}) => {
        const { repositories } = await git.query<{ repositories: ShPage<ShRepository> }>(Q.MyRepositories, { cursor: query.cursor?.token, filter: countFilter(query.perPage) }, query)
        const page = pageOf(repositories, repository => toRepo(origin, repository))
        const warnings = isFirstPage(query.cursor) ? repoWarnings(query, query.affiliation !== undefined ? 'Sourcehut lists the account\'s repositories without an affiliation filter' : undefined) : undefined
        return { ...page, items: page.items.filter(repo => !query.visibility || query.visibility === 'all' || repo.visibility === query.visibility), ...warnings ? { warnings } : {} }
      }),
      byOwnerPage: verb(true, async (owner: RepoRef, query = {}) => {
        const { user } = await git.query<{ user: { repositories: ShPage<ShRepository> } | null }>(Q.OwnerRepositories, { owner: usernameOf(owner.owner), cursor: query.cursor?.token, filter: countFilter(query.perPage) }, query)
        if (!user) {
          throw new NotFoundError(`No Sourcehut account named ${owner.owner}`, 404, '', origin)
        }
        const page = pageOf(user.repositories, repository => toRepo(origin, repository))
        const warnings = isFirstPage(query.cursor) ? repoWarnings(query, query.subgroups === true ? 'Sourcehut lists an account\'s repositories without subgroup filtering' : undefined) : undefined
        return { ...page, items: page.items.filter(repo => !query.visibility || query.visibility === 'all' || repo.visibility === query.visibility), ...warnings ? { warnings } : {} }
      }),
      collaboratorsPage: verb(true, async (repo: RepoRef, options: PageOptions = {}) => {
        const { user } = await git.query<{ user: { repository: { acls: ShPage<ShAcl> } | null } | null }>(Q.RepositoryAcls, { ...repoParts(repo), cursor: options.cursor?.token }, options)
        if (!user?.repository) {
          throw notFound(repo, origin)
        }
        return pageOf(user.repository.acls, acl => toCollaborator(origin, acl))
      }),
      labelsPage: verb('emulated', async (repo: RepoRef, options: PageOptions = {}) => {
        const { user } = await todo.query<{ user: { tracker: { labels: ShPage<ShLabel> } | null } | null }>(Q.TrackerLabels, { ...repoParts(repo), cursor: options.cursor?.token }, options)
        if (!user) {
          throw notFound(repo, origin)
        }
        return pageOf(user.tracker?.labels, label => toLabel(label))
      }),
      permissionFor: verb('emulated', async (repo: RepoRef, actor, options) => {
        const login = typeof actor === 'string' ? actor : actor.login
        // The owner is never on its own access list, so its role is implicit.
        if (usernameOf(repo.owner) === usernameOf(login)) {
          return 'admin' as RepoRole
        }
        let cursor: string | undefined
        try {
          do {
            const { user } = await git.query<{ user: { repository: { acls: ShPage<ShAcl> } | null } | null }>(Q.RepositoryAcls, { ...repoParts(repo), cursor }, options)
            const page = user?.repository?.acls
            const match = page?.results.find(acl => usernameOf(acl.entity.canonicalName) === usernameOf(login))
            if (match) {
              return match.mode === 'RW' ? 'write' : 'read'
            }
            cursor = page?.cursor ?? undefined
          } while (cursor)
          return 'none' as RepoRole
        }
        catch (error) {
          // git.sr.ht serves the access list to the repository's owner and collaborators only,
          // so for anyone else fall back to what a public repository lets everyone do.
          if (!(error instanceof InsufficientScopeError)) {
            throw error
          }
          return (await getRepo(repo, options)).visibility === 'public' ? 'read' as RepoRole : 'none' as RepoRole
        }
      }),
    },
    threads: {
      get: perKind({ issue: true, pull_request: true }, getThread),
      listPage: perKind({ issue: true, pull_request: true }, (repo, query: ThreadQuery = {}) => {
        // Both listings ignore the same filters, so warn once, on the first page.
        const warnings = isFirstPage(query.cursor) ? threadFilterWarnings(query) : undefined
        if (query.kind === 'issue') {
          return listTickets(repo, query, warnings)
        }
        if (query.kind === 'pull_request') {
          return listPatches(repo, query, warnings)
        }
        // No kind: issues live on the tracker, patches on the mailing list, so read one after the other.
        return phased([
          cursor => listTickets(repo, { ...query, cursor }, warnings),
          cursor => listPatches(repo, { ...query, cursor }),
        ], query.cursor)
      }),
      getMany: verb(true, (refs: ThreadRef[], options) => getManyConcurrently(refs, getThread, options)),
      eventsPage: verb(true, events),
      commentsPage: perKind({ issue: true, pull_request: true }, comments),
      subscriptions: perKind({ issue: true }, {
        subscription: async (ref: ThreadRef, options?: BaseOptions) => {
          const ticket = await getTicket(requireThread(ref, origin), options)
          return ticket.subscription ? 'subscribed' : 'none'
        },
        subscribe: () => Promise.reject(new UnsupportedOperationError(`${FORGE} is read-only in this provider`, origin)),
        unsubscribe: () => Promise.reject(new UnsupportedOperationError(`${FORGE} is read-only in this provider`, origin)),
      }),
    },
    emulated: {
      getComment: { issue: true, pull_request: true },
      getJob: true,
    },
    contents: {
      getFile: verb(true, async (repo: RepoRef, path: string, options = {}) => {
        const revspec = options.ref ?? 'HEAD'
        const { user } = await git.query<{ user: { repository: { path: { id: string, object: ShFileObject } | null } | null } | null }>(Q.RepositoryFile, { ...repoParts(repo), revspec, path }, options)
        const object = user?.repository?.path?.object
        if (!object || object.type !== 'BLOB') {
          throw new NotFoundError(`No file ${path} in ${repo.owner}/${repo.name}`, 404, '', origin)
        }
        const size = object.size ?? undefined
        const metadata = { path, sha: object.id, size, url: webUrlFor(web, { file: { repo, path, at: revspec } }) }
        const text = object.text ?? undefined
        const base64 = object.base64 ?? undefined
        // `text` and `base64` are capped inline, so past the cap read the whole blob from `content`.
        const bytes = text !== undefined && (size === undefined || size <= TEXT_INLINE_LIMIT)
          ? new TextEncoder().encode(text)
          : base64 !== undefined && (size === undefined || size <= BINARY_INLINE_LIMIT)
            ? fromBase64(base64)
            : object.content ? new Uint8Array(await (await gitFetcher.raw(object.content, options)).arrayBuffer()) : undefined
        if (!bytes) {
          throw new NotFoundError(`No file ${path} in ${repo.owner}/${repo.name}`, 404, '', origin)
        }
        return toFileContent(bytes, metadata, options, origin)
      }),
      treePage: verb(true, treePage),
      branchesPage: verb(true, async (repo: RepoRef, options: PageOptions = {}) => {
        const { references, defaultBranch } = await refs(repo, options.cursor?.token, options)
        const items: Branch[] = references.results.filter(ref => ref.name.startsWith('refs/heads/')).map(ref => toBranch(ref, defaultBranch))
        return { items, ...references.cursor ? { cursor: { token: references.cursor } } : {} }
      }),
      tagsPage: verb(true, async (repo: RepoRef, options: PageOptions = {}) => {
        const { references } = await refs(repo, options.cursor?.token, options)
        const items: Tag[] = references.results.filter(ref => ref.name.startsWith('refs/tags/')).map(toTag)
        return { items, ...references.cursor ? { cursor: { token: references.cursor } } : {} }
      }),
      resolveRef: verb(true, async (repo: RepoRef, ref: string, options?: BaseOptions) => {
        const { user } = await git.query<{ user: { repository: { revparse_single: { id: string } | null } | null } | null }>(Q.RepositoryResolveRef, { ...repoParts(repo), revspec: ref }, options)
        const sha = user?.repository?.revparse_single?.id
        if (!sha) {
          throw new NotFoundError(`No revision ${ref} in ${repo.owner}/${repo.name}`, 404, '', origin)
        }
        return sha
      }),
    },
    commits: {
      listPage: verb(true, async (repo: RepoRef, query = {}) => {
        const { user } = await git.query<{ user: { repository: { log: ShPage<ShCommit> } | null } | null }>(Q.RepositoryLog, { ...repoParts(repo), from: query.ref, cursor: query.cursor?.token }, query)
        if (!user?.repository) {
          throw notFound(repo, origin)
        }
        const page = pageOf(user.repository.log, commit => toCommit(repo, commit))
        const warnings = isFirstPage(query.cursor) && [query.since, query.until, query.path, query.author].some(value => value !== undefined)
          ? [{ code: 'filter_unsupported' as const, message: 'Sourcehut walks the log without filtering by date, path or author' }]
          : undefined
        return { ...page, ...warnings ? { warnings } : {} }
      }),
      get: verb(true, async ({ repo, sha }: CommitRef, options?: BaseOptions) => {
        const { user } = await git.query<{ user: { repository: { revparse_single: ShCommit | null } | null } | null }>(Q.RepositoryCommit, { ...repoParts(repo), revspec: sha }, options)
        const commit = user?.repository?.revparse_single
        if (!commit) {
          throw new NotFoundError(`No commit ${sha} in ${repo.owner}/${repo.name}`, 404, '', origin)
        }
        return toCommit(repo, commit)
      }),
    },
    ci: {
      runsPage: verb('emulated', async (_repo: RepoRef, query = {}) => {
        const { jobs } = await builds.query<{ jobs: ShPage<ShJob> }>(Q.Jobs, { cursor: query.cursor?.token }, query)
        // `jobs` lists the authenticated account's builds and never names a job's repository,
        // so the ref points at the account rather than at the queried repository.
        const page = pageOf(jobs, job => toCiRun(origin, { ...origin, owner: job.owner.canonicalName, name: '', kind: 'namespace' }, job))
        const warnings = isFirstPage(query.cursor)
          ? [
              { code: 'filter_unsupported' as const, message: 'Sourcehut lists the builds of the authenticated account, not of one repository' },
              ...query.branch || query.state ? [{ code: 'filter_unsupported' as const, message: 'Sourcehut cannot filter builds by branch or state' }] : [],
            ]
          : undefined
        return { ...page, ...warnings ? { warnings } : {} }
      }),
      getRun: verb(true, async (ref, options?: BaseOptions) => {
        const { job } = await builds.query<{ job: ShJob | null }>(Q.Job, { id: numericId(ref.id, 'build', origin) }, options)
        if (!job) {
          throw new NotFoundError(`No Sourcehut build ${ref.id}`, 404, '', origin)
        }
        return toCiRun(origin, ref.repo, job)
      }),
      jobsPage: verb(true, async (ref, options: PageOptions = {}) => {
        const { job } = await builds.query<{ job: ShJob | null }>(Q.Job, { id: numericId(ref.id, 'build', origin) }, options)
        if (!job) {
          throw new NotFoundError(`No Sourcehut build ${ref.id}`, 404, '', origin)
        }
        return { items: job.tasks.map(task => toCiJob(origin, ref.repo, job, task)) }
      }),
      log: verb(true, async (ref, options?: BaseOptions) => {
        if (!ref.run) {
          throw new UnsupportedOperationError('Sourcehut reads a build log from its build, so the job ref must name one', origin)
        }
        const { job } = await builds.query<{ job: ShJob | null }>(Q.Job, { id: numericId(ref.run.id, 'build', origin) }, options)
        // A job is one of the build's tasks; the build's own log is the runner's, not this job's.
        const task = job?.tasks.find(candidate => String(candidate.id) === ref.id)
        if (!task?.log?.fullURL) {
          throw new NotFoundError(`No log for Sourcehut job ${ref.id} in build ${ref.run.id}`, 404, '', origin)
        }
        return (await buildsFetcher.stream(task.log.fullURL, options)).body
      }),
    },
    search: {
      codePage: verb('experimental', async (query) => {
        const repo = query.repo
        if (!repo) {
          throw new UnsupportedOperationError('Sourcehut searches code within one repository', origin)
        }
        const { user } = await git.query<{ user: { repository: { codeSearch: { totalFiles: number, totalMatches: number, results: ShCodeSearchResult[], cursor?: string | null } } | null } | null }>(Q.RepositoryCodeSearch, { ...repoParts(repo), query: query.text ?? query.queryRaw ?? '', cursor: query.cursor?.token }, query)
        const search = user?.repository?.codeSearch
        if (!search) {
          throw notFound(repo, origin)
        }
        return {
          items: search.results.map(match => toCodeMatch(repo, match)),
          total: search.totalMatches,
          ...search.cursor ? { cursor: { token: search.cursor } } : {},
        }
      }),
      reposPage: verb('emulated', async (query) => {
        const { repositories } = await git.query<{ repositories: ShPage<ShRepository> }>(Q.MyRepositories, { cursor: query.cursor?.token, filter: countFilter(query.perPage) }, query)
        const page = pageOf(repositories, repository => toRepo(origin, repository))
        const text = query.text?.toLowerCase()
        const warnings = isFirstPage(query.cursor) && query.owner
          ? [{ code: 'filter_unsupported' as const, message: 'Sourcehut searches the account\'s own repositories and cannot filter by owner' }]
          : undefined
        return { ...page, items: page.items.filter(repo => !text || `${repo.ref.owner}/${repo.ref.name}`.toLowerCase().includes(text)), ...warnings ? { warnings } : {} }
      }),
    },
    releases: {
      listPage: verb('emulated', releasesPage),
      get: verb('emulated', async (ref, options?: BaseOptions) => {
        const tag = ref.tag ?? ref.id
        const { user } = await git.query<{ user: { repository: { reference: ShReference | null } | null } | null }>(Q.RepositoryReference, { ...repoParts(ref.repo), refName: `refs/tags/${tag}` }, options)
        const reference = user?.repository?.reference
        if (!reference) {
          throw notFound(ref, origin)
        }
        return toRelease(ref.repo, tag, reference.artifacts?.results ?? [], tagTime(reference))
      }),
      getByTag: verb('emulated', async (repo: RepoRef, tag: string, options?: BaseOptions) => {
        const { user } = await git.query<{ user: { repository: { reference: ShReference | null } | null } | null }>(Q.RepositoryReference, { ...repoParts(repo), refName: `refs/tags/${tag}` }, options)
        const reference = user?.repository?.reference
        if (!reference) {
          throw new NotFoundError(`No tag ${tag} in ${repo.owner}/${repo.name}`, 404, '', origin)
        }
        return toRelease(repo, tag, reference.artifacts?.results ?? [], tagTime(reference))
      }),
      latest: verb('emulated', latestTag),
      downloadAsset: verb('emulated', async (ref: ReleaseAssetRef, options?: BaseOptions) => {
        const url = `${serviceUrl(instance, 'git')}/query/artifact/${ref.id}`
        return (await gitFetcher.stream(url, options)).body
      }),
    },
    webhooks: {},
    scopes: sourcehutScopesFor,
    request: requestFetcher,
    web,
  }
}

type ShTreeEntryNode = Parameters<typeof toTreeEntry>[1]
interface ShFileObject { type: string, id: string, shortId: string, text?: string | null, size?: number | null, base64?: string | null, content?: string | null }
type ShCodeSearchResult = Parameters<typeof toCodeMatch>[1]

const SOURCEHUT: ProviderDefinition<SourcehutOptions, undefined, true> = {
  forge: FORGE,
  hasWeb: true,
  baseUrl: 'https://sr.ht',
  headers: { accept: 'application/json' },
  authHeaders: ({ options }) => async () => ({ authorization: `Bearer ${await resolveToken(options.auth)}` }),
  webhooks: sourcehutWebhooks,
  setup: setupSourcehut,
}

const factory: ProviderFactoryFunction<SourcehutOptions, true, 'sourcehut'> = /* @__PURE__ */ defineForgeProvider(SOURCEHUT)

/**
 * Creates a Sourcehut provider. Sourcehut cannot write, so `readOnly` is always
 * set: it reports `subscriptions.set` unsupported, which no write is declared to
 * do, and it cannot be turned off.
 */
export const sourcehut: ProviderFactoryFunction<SourcehutOptions, true, 'sourcehut'> = options => factory({ ...options, readOnly: true })

/** The OAuth grants each Sourcehut operation needs. */
export function sourcehutScopesFor(verb: ForgeVerb): VerbScopes {
  const grant = (service: string, scope: string) => `${service}/${scope}:RO`
  // Each service enforces scopes per resolver, and a query with any out-of-scope
  // field fails as a whole, so a verb must list every grant its queries touch.
  const git = { profile: grant('git.sr.ht', 'PROFILE'), repositories: grant('git.sr.ht', 'REPOSITORIES'), objects: grant('git.sr.ht', 'OBJECTS'), acls: grant('git.sr.ht', 'ACLS') }
  const todo = { profile: grant('todo.sr.ht', 'PROFILE'), trackers: grant('todo.sr.ht', 'TRACKERS'), tickets: grant('todo.sr.ht', 'TICKETS'), events: grant('todo.sr.ht', 'EVENTS'), subscriptions: grant('todo.sr.ht', 'SUBSCRIPTIONS') }
  const lists = { profile: grant('lists.sr.ht', 'PROFILE'), lists: grant('lists.sr.ht', 'LISTS'), emails: grant('lists.sr.ht', 'EMAILS'), patches: grant('lists.sr.ht', 'PATCHES') }
  const builds = { profile: grant('builds.sr.ht', 'PROFILE'), jobs: grant('builds.sr.ht', 'JOBS'), logs: grant('builds.sr.ht', 'LOGS') }
  // Resolving a repository is REPOSITORIES, and the fragment it returns reads `HEAD`, which is OBJECTS.
  const repo = [git.repositories, git.objects, git.profile]
  const ticket = [todo.trackers, todo.tickets, todo.subscriptions, todo.profile]
  const patch = [lists.lists, lists.emails, lists.profile]
  const threadEvent = [todo.trackers, todo.tickets, todo.profile, todo.events, lists.emails, lists.profile]
  const job = [builds.jobs, builds.logs, builds.profile]
  const table: Partial<Record<ForgeVerb, string[]>> = {
    'repos.get': repo,
    'repos.list': repo,
    'repos.byOwner': repo,
    'repos.labels': [todo.trackers, todo.profile],
    'repos.collaborators': [git.acls, git.repositories, git.profile],
    'repos.permissionFor': [git.acls, git.repositories, git.profile],
    'threads.get': [...ticket, ...patch],
    'threads.getMany': [...ticket, ...patch],
    'threads.list': [...ticket, ...patch, lists.patches],
    'threads.events': threadEvent,
    'threads.comments': threadEvent,
    'threads.getComment': threadEvent,
    'threads.subscription': ticket,
    'contents.getFile': repo,
    'contents.tree': repo,
    'contents.branches': repo,
    'contents.tags': repo,
    'contents.resolveRef': repo,
    'commits.list': repo,
    'commits.get': repo,
    'ci.runs': job,
    'ci.getRun': job,
    'ci.jobs': job,
    'ci.getJob': job,
    'ci.log': job,
    'search.code': repo,
    'search.repos': repo,
    'releases.list': repo,
    'releases.get': repo,
    'releases.latest': repo,
    'releases.getByTag': repo,
    'releases.downloadAsset': [git.objects],
    'users.get': [grant('meta.sr.ht', 'PROFILE')],
    'users.me': [grant('meta.sr.ht', 'PROFILE')],
    // A delivery is verified against the instance's published ed25519 key, not a token.
    'webhooks.verify': [],
    'webhooks.ingest': [],
  }
  const scopes = table[verb]
  return scopes?.length ? { token: scopes } : {}
}
