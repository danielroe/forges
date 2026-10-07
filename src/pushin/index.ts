import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { Comment, ForgeEventInput, ListOptions, Page, RepoRef, ResolvedThreadRef, Thread, ThreadQuery, ThreadRef } from '../model.ts'
import type { AnonymousAuth, ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { PushinCollaborator, PushinComment, PushinLabel, PushinNotification, PushinRepository, PushinThread, PushinUser } from './types.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { createListing, getManyConcurrently, requireIssueOrPull, resolveToken, toPage } from '../utils.ts'
import { githubShapedWeb } from '../web.ts'
import { FORGE, toActor, toCollaborator, toComment, toLabel, toNotification, toRepo, toThread } from './normalise.ts'

/** A personal access token created in Settings (`pun_pat_…`), sent as `Authorization: Bearer`. */
export type PushinAuth = TokenAuth | AnonymousAuth

export interface PushinOptions extends ForgeOptionsBase {
  /** Defaults to `{ type: 'anonymous' }`: public repository reads only. */
  auth?: PushinAuth
  /** Instance root. Defaults to `https://pushin.eu`; `/api/v1` is appended. */
  baseUrl?: string
}

function setupPushin({ instance, origin: context, fetcher, baseUrl }: ProviderContext<PushinOptions, undefined>): ProviderSpec {
  const list = createListing(fetcher, 'per_page')
  const repoPath = (repo: RepoRef) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

  function threadPath(ref: ResolvedThreadRef): string {
    return `${repoPath(ref.repo)}/${ref.kind === 'pull_request' ? 'pulls' : 'issues'}/${encodeURIComponent(ref.number)}`
  }

  async function get(thread: ThreadRef): Promise<Thread> {
    const ref = requireIssueOrPull(thread, context, 'read')
    const { data } = await fetcher.json<PushinThread>(threadPath(ref))
    return toThread(ref, data)
  }

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    if (query.kind && query.kind !== 'issue' && query.kind !== 'pull_request') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: `pushin.eu has no listing for ${query.kind}s` }] }
    }
    const kind = query.kind === 'pull_request' ? 'pull_request' : 'issue'
    const result = await fetcher.page<PushinThread>(`${repoPath(repo)}/${kind === 'pull_request' ? 'pulls' : 'issues'}`, {
      query: { state: query.state === 'merged' ? 'closed' : query.state, per_page: query.perPage },
      cursor: query.cursor,
      signal: query.signal,
    })
    return toPage(result, (raw) => {
      const thread = toThread({ forge: FORGE, instance, repo, kind, number: String(raw.number) }, raw)
      return (query.kind === 'issue' && raw.pull_request) || (query.state === 'merged' && thread.state !== 'merged') ? undefined : thread
    })
  }

  async function commentsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<Comment>> {
    const ref = requireIssueOrPull(thread, context, 'read comments on')
    const result = await fetcher.page<PushinComment>(`${threadPath(ref)}/comments`, {
      query: { per_page: listOptions.perPage },
      cursor: listOptions.cursor,
      signal: listOptions.signal,
    })
    return toPage(result, raw => toComment(ref, raw))
  }

  async function eventsPage(thread: ThreadRef, listOptions: ListOptions = {}): Promise<Page<ForgeEventInput>> {
    const ref = requireIssueOrPull(thread, context, 'read events for')
    const page = await commentsPage(ref, listOptions)
    return {
      ...page,
      items: page.items.map(comment => ({
        forge: FORGE,
        instance,
        id: comment.ref.id,
        kind: 'comment' as const,
        kindRaw: 'comment',
        summary: `${comment.author?.login ?? 'someone'} commented`,
        occurredAt: comment.createdAt ?? new Date(0),
        actor: comment.author,
        repo: ref.repo,
        thread: ref,
        source: 'poll' as const,
        detail: { type: 'comment' as const, comment: comment.ref, body: comment.body },
        payload: comment.raw,
      })),
    }
  }

  return {
    traits: {
      poll: false,
      eventKinds: 'native',
      authKinds: ['token', 'anonymous'],
    },
    users: {
      me: verb(true, async () => {
        const { data } = await fetcher.json<PushinUser>('/user')
        return { ...toActor({ forge: FORGE, instance }, data)!, company: data.company ?? undefined, raw: data }
      }),
    },
    repos: {
      get: verb(true, async repo => toRepo({ forge: FORGE, instance }, (await fetcher.json<PushinRepository>(repoPath(repo))).data)),
      listPage: verb('experimental', (listOptions = {}) => list('/user/repos', listOptions, (raw: PushinRepository) => toRepo({ forge: FORGE, instance }, raw))),
      labelsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/labels`, listOptions, (raw: PushinLabel) => toLabel(raw))),
      collaboratorsPage: verb('experimental', (repo, listOptions = {}) => list(`${repoPath(repo)}/collaborators`, listOptions, (raw: PushinCollaborator) => toCollaborator({ forge: FORGE, instance }, raw))),
    },
    threads: {
      get: perKind({ issue: true, pull_request: 'experimental' }, get),
      listPage: perKind({ issue: true, pull_request: 'experimental' }, listPage),
      getMany: verb(true, refs => getManyConcurrently(refs, get)),
      eventsPage: verb('emulated', eventsPage),
      commentsPage: perKind({ issue: true, pull_request: 'experimental' }, commentsPage),
    },
    notifications: {
      listPage: verb('experimental', (listOptions = {}) => list('/notifications', listOptions, (raw: PushinNotification) => toNotification({ forge: FORGE, instance }, raw), {
        query: { all: listOptions.all, since: listOptions.since?.toISOString() },
      })),
    },
    web: githubShapedWeb(baseUrl.replace(/\/api\/v1$/, ''), {
      pull: 'pulls',
      commentFragment: 'comment-',
      file: at => `/blob/${encodeURIComponent(at)}`,
      lineFragment: line => `L${line}`,
    }),
    webhooks: {},
    scopes: pushinScopesFor,
  }
}

const PUSHIN: ProviderDefinition<PushinOptions> = {
  forge: FORGE,
  experimental: true,
  anonymous: true,
  baseUrl: 'https://pushin.eu',
  apiPath: '/api/v1',
  headers: { accept: 'application/vnd.github+json' },
  authHeaders: ({ options: { auth } }) => auth?.type === 'token' ? async () => ({ authorization: `Bearer ${await resolveToken(auth)}` }) : undefined,
  setup: setupPushin,
}

/** Creates a pushin.eu provider. */
export const pushin: ProviderFactoryFunction<PushinOptions> = /* @__PURE__ */ defineForgeProvider(PUSHIN)

/** Scope requirements for a pushin.eu operation. */
export function pushinScopesFor(_verb: ForgeVerb): VerbScopes {
  return { note: 'A personal access token created in Settings; pushin.eu does not scope tokens per resource' }
}

export { toActor as toPushinActor, toComment as toPushinComment, toRepo as toPushinRepo }
