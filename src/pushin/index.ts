import type { ProviderContext, ProviderDefinition, ProviderFactoryFunction, ProviderSpec } from '../define.ts'
import type { BaseOptions, Comment, ForgeEventInput, ListOptions, Page, PageOptions, Release, ReleaseUpdate, RepoRef, RepoRole, ResolvedThreadRef, ReviewComment, Thread, ThreadQuery, ThreadRef } from '../model.ts'
import type { AnonymousAuth, ForgeOptionsBase, TokenAuth, VerbScopes } from '../provider.ts'
import type { ForgeVerb } from '../supports.ts'
import type { WebLinks } from '../web.ts'
import type { PushinCollaborator, PushinComment, PushinLabel, PushinNotification, PushinRelease, PushinRepository, PushinReview, PushinReviewComment, PushinTeam, PushinThread, PushinUser } from './types.ts'
import { defineForgeProvider, perKind, verb } from '../define.ts'
import { NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { eventTime } from '../events.ts'
import { actorLogin, createListing, getManyConcurrently, rateLimitPart, requireIssueOrPull, resolveToken, teamOrg, toPage } from '../utils.ts'
import { FORGE, toActor, toCollaborator, toComment, toLabel, toNotification, toPermissionRole, toRelease, toRepo, toReview, toReviewComment, toTeam, toThread } from './normalise.ts'
import { PUSHIN_WEB } from './web.ts'

/** A personal access token created in Settings (`pun_pat_…`), sent as `Authorization: Bearer`. */
export type PushinAuth = TokenAuth | AnonymousAuth

/** Options for `pushin()`. */
export interface PushinOptions extends ForgeOptionsBase {
  /**
   * How to authenticate. Without credentials, only public reads work.
   * @default { type: 'anonymous' }
   */
  auth?: PushinAuth
  /**
   * Instance root. `/api/v1` is appended.
   * @default https://pushin.eu
   */
  baseUrl?: string
}

const COLLABORATOR_PERMISSIONS: Partial<Record<RepoRole, string>> = { admin: 'admin', maintain: 'push', write: 'push', triage: 'pull', read: 'pull' }

function setupPushin({ options, instance, origin: context, fetcher, baseUrl }: ProviderContext<PushinOptions, undefined>): ProviderSpec & { web: WebLinks } {
  const anonymous = options.auth?.type === 'anonymous'
  const list = createListing(fetcher, 'per_page')
  const repoPath = (repo: RepoRef) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

  function threadPath(ref: ResolvedThreadRef): string {
    return `${repoPath(ref.repo)}/${ref.kind === 'pull_request' ? 'pulls' : 'issues'}/${encodeURIComponent(ref.number)}`
  }

  function requirePull(thread: ThreadRef, action: string): ResolvedThreadRef {
    const ref = requireIssueOrPull(thread, context, action)
    if (ref.kind !== 'pull_request') {
      throw new UnsupportedOperationError(`Only pull requests can be ${action}`, context)
    }
    return ref
  }

  async function reviewComments(pull: ResolvedThreadRef, id: string, signal?: AbortSignal): Promise<ReviewComment[]> {
    const { data } = await fetcher.json<PushinReviewComment[]>(`${threadPath(pull)}/reviews/${encodeURIComponent(id)}/comments`, { query: { per_page: 100 }, signal })
    return data.map(raw => toReviewComment(pull, raw))
  }

  async function setResolved(thread: ThreadRef, id: string, resolved: boolean, options?: BaseOptions): Promise<void> {
    const pull = requirePull(thread, 'reviewed')
    await fetcher.raw(`${repoPath(pull.repo)}/pulls/comments/${encodeURIComponent(id)}`, { method: 'PATCH', json: { resolved }, signal: options?.signal })
  }

  async function get(thread: ThreadRef, options?: BaseOptions): Promise<Thread> {
    const ref = requireIssueOrPull(thread, context, 'read')
    const { data } = await fetcher.json<PushinThread>(threadPath(ref), { signal: options?.signal })
    return toThread(ref, data)
  }

  async function listPage(repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> {
    if (query.kind && query.kind !== 'issue' && query.kind !== 'pull_request') {
      return { items: [], warnings: [{ code: 'kind_unsupported', message: `Pushin.eu has no listing for ${query.kind}s` }] }
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
    const result = await fetcher.page<PushinComment>(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/comments`, {
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
        ...eventTime(comment.createdAt, new Date(0)),
        actor: comment.author,
        repo: ref.repo,
        thread: ref,
        source: 'poll' as const,
        detail: { type: 'comment' as const, comment: comment.ref, body: comment.body },
        payload: comment.raw,
      })),
    }
  }

  async function releasesPage(repo: RepoRef, listOptions: PageOptions = {}): Promise<Page<Release>> {
    return list(`${repoPath(repo)}/releases`, listOptions, (raw: PushinRelease) => toRelease(repo, raw))
  }

  async function writeRelease(repo: RepoRef, path: string, method: 'POST' | 'PATCH', input: ReleaseUpdate, options?: BaseOptions): Promise<Release> {
    const { data } = await fetcher.json<PushinRelease>(path, {
      method,
      json: { tag_name: input.tag, target_commitish: input.target, name: input.name, body: input.body, draft: input.draft, prerelease: input.prerelease },
      signal: options?.signal,
    })
    return toRelease(repo, data)
  }

  return {
    traits: {
      eventKinds: 'native',
      authKinds: ['token', 'anonymous'],
    },
    notApplicable: [
      'webhooks.ingest',
      'threads.updateComment',
      'threads.deleteComment',
      'notifications.markRead',
      'notifications.markDone',
      'notifications.unsubscribe',
      'notifications.markAllRead',
      'notifications.markAllDone',
      'threads.close',
      'threads.reopen',
      'threads.update',
      'threads.setLabels',
      'threads.addLabels',
      'threads.removeLabels',
      'threads.setMilestone',
      'threads.react',
      'threads.setAssignees',
      'threads.requestReview',
      'threads.merge',
      'threads.transfer',
      'threads.markDuplicate',
      'webhooks.list',
      'webhooks.create',
      'webhooks.update',
      'webhooks.delete',
      'webhooks.rotateSecret',
      'webhooks.deliveries',
      'webhooks.redeliver',
      'users.block',
      'orgs.block',
      'repos.templates',
      'threads.hideComment',
      'threads.lock',
      'threads.updateBranch',
      'repos.issueTypes',
      'threads.setIssueType',
    ],
    users: {
      me: verb(true, async (options) => {
        const { data } = await fetcher.json<PushinUser>('/user', { signal: options?.signal })
        return { ...toActor({ forge: FORGE, instance }, data)!, company: data.company ?? undefined, raw: data }
      }),
    },
    repos: {
      get: verb(true, async (repo, options) => toRepo({ forge: FORGE, instance }, (await fetcher.json<PushinRepository>(repoPath(repo), { signal: options?.signal })).data)),
      listPage: verb(true, (listOptions = {}) => list('/user/repos', listOptions, (raw: PushinRepository) => toRepo({ forge: FORGE, instance }, raw))),
      labelsPage: verb(true, (repo, listOptions = {}) => list(`${repoPath(repo)}/labels`, listOptions, (raw: PushinLabel) => toLabel(raw))),
      createLabel: verb(true, async (repo, label, options) => toLabel((await fetcher.json<PushinLabel>(`${repoPath(repo)}/labels`, {
        method: 'POST',
        json: { name: label.name, color: label.colour, description: label.description },
        signal: options?.signal,
      })).data)),
      collaboratorsPage: verb(!anonymous, (repo, listOptions = {}) => list(`${repoPath(repo)}/collaborators`, listOptions, (raw: PushinCollaborator) => toCollaborator({ forge: FORGE, instance }, raw))),
      permissionFor: verb(!anonymous, async (repo, actor, options) => {
        const { data } = await fetcher.json<{ role_name: string }>(`${repoPath(repo)}/collaborators/${encodeURIComponent(actorLogin(actor))}/permission`, { signal: options?.signal })
        return toPermissionRole(data.role_name)
      }),
      addCollaborator: verb(true, async (repo, actor, role, options) => {
        const permission = COLLABORATOR_PERMISSIONS[role]
        if (!permission) {
          throw new UnsupportedOperationError(`Pushin.eu has no ${role} collaborator permission`, context)
        }
        await fetcher.raw(`${repoPath(repo)}/collaborators/${encodeURIComponent(actorLogin(actor))}`, {
          method: 'PUT',
          json: { permission },
          signal: options?.signal,
        })
        return { status: 'added' }
      }),
    },
    orgs: {
      teamsPage: verb(!anonymous, (org, listOptions = {}) => list(`/orgs/${encodeURIComponent(org.owner)}/teams`, listOptions, (raw: PushinTeam) => toTeam(teamOrg(org), raw))),
      teamMembersPage: verb(!anonymous, (team, listOptions = {}) => list(
        `/orgs/${encodeURIComponent(team.org.owner)}/teams/${encodeURIComponent(team.slug)}/members`,
        listOptions,
        (raw: PushinUser) => toActor({ forge: FORGE, instance }, raw)!,
      )),
    },
    threads: {
      get: perKind({ issue: true, pull_request: true }, get),
      listPage: perKind({ issue: true, pull_request: true }, listPage),
      getMany: verb(true, (refs, options) => getManyConcurrently(refs, get, options)),
      eventsPage: verb('emulated', eventsPage),
      commentsPage: perKind({ issue: true, pull_request: true }, commentsPage),
      reviewsPage: verb(true, async (thread, listOptions: PageOptions = {}) => {
        const ref = requirePull(thread, 'reviewed')
        const result = await fetcher.page<PushinReview>(`${threadPath(ref)}/reviews`, {
          query: { per_page: listOptions.perPage },
          cursor: listOptions.cursor,
          signal: listOptions.signal,
          conditional: false,
        })
        const items = await Promise.all((result.data ?? []).map(async raw => toReview(ref, raw, await reviewComments(ref, String(raw.id), listOptions.signal))))
        return { items, cursor: result.cursor, ...rateLimitPart(result.response) }
      }),
      getReview: verb(true, async (ref, options) => {
        const pull = requirePull(ref.thread, 'reviewed')
        const { data } = await fetcher.json<PushinReview>(`${threadPath(pull)}/reviews/${encodeURIComponent(ref.id)}`, { signal: options?.signal })
        return toReview(pull, data, await reviewComments(pull, ref.id, options?.signal))
      }),
      replyToReviewComment: verb(true, async (thread, comment, body, options) => {
        const pull = requirePull(thread, 'reviewed')
        const id = comment.inReplyTo ?? comment.ref?.id
        if (id === undefined) {
          throw new UnsupportedOperationError('Pushin.eu replies to a review comment by its id; pass the comment with its `ref`', context)
        }
        const { data } = await fetcher.json<PushinReviewComment>(`${threadPath(pull)}/comments/${encodeURIComponent(id)}/replies`, { method: 'POST', json: { body }, signal: options?.signal })
        return toReviewComment(pull, data)
      }),
      reviewThreads: verb(true, {
        resolveReviewThread: (ref, id, options) => setResolved(ref, id, true, options),
        unresolveReviewThread: (ref, id, options) => setResolved(ref, id, false, options),
      }),
      createComment: perKind({ issue: true, pull_request: true }, async (thread, body, options) => {
        const ref = requireIssueOrPull(thread, context, 'comment on')
        const { data } = await fetcher.json<PushinComment>(`${repoPath(ref.repo)}/issues/${encodeURIComponent(ref.number)}/comments`, { method: 'POST', json: { body }, signal: options?.signal })
        return toComment(ref, data)
      }),
      create: perKind({ issue: true, pull_request: true }, async (repo, input, options) => {
        if (input.assignees?.length) {
          throw new UnsupportedOperationError('Pushin.eu does not set assignees on new threads', context)
        }
        if (input.kind === 'issue') {
          const { data } = await fetcher.json<PushinThread>(`${repoPath(repo)}/issues`, {
            method: 'POST',
            json: { title: input.title, body: input.body, labels: input.labels },
            signal: options?.signal,
          })
          return toThread({ forge: FORGE, instance, repo, kind: 'issue', number: String(data.number) }, data)
        }
        if (input.kind !== 'pull_request' || !input.head || !input.base) {
          throw new UnsupportedOperationError('Creating a pull request needs head and base branches', context)
        }
        const { data } = await fetcher.json<PushinThread>(`${repoPath(repo)}/pulls`, {
          method: 'POST',
          json: { title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft, labels: input.labels },
          signal: options?.signal,
        })
        return toThread({ forge: FORGE, instance, repo, kind: 'pull_request', number: String(data.number) }, data)
      }),
    },
    notifications: {
      listPage: verb(true, (listOptions = {}) => list('/notifications', listOptions, (raw: PushinNotification) => toNotification({ forge: FORGE, instance }, raw), {
        query: { all: listOptions.all, since: listOptions.since?.toISOString() },
      })),
    },
    web: PUSHIN_WEB.links({ baseUrl, instance }),
    webhooks: {},
    scopes: pushinScopesFor,
    releases: {
      get: verb(true, async (ref, options) => toRelease(ref.repo, (await fetcher.json<PushinRelease>(`${repoPath(ref.repo)}/releases/${encodeURIComponent(ref.id)}`, { signal: options?.signal })).data)),
      getByTag: verb(true, async (repo, tag, options) => toRelease(repo, (await fetcher.json<PushinRelease>(`${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`, { signal: options?.signal })).data)),
      latest: verb(true, async (repo, options) => {
        try {
          return toRelease(repo, (await fetcher.json<PushinRelease>(`${repoPath(repo)}/releases/latest`, { signal: options?.signal })).data)
        }
        catch (error) {
          if (error instanceof NotFoundError) {
            return undefined
          }
          throw error
        }
      }),
      listPage: verb(true, releasesPage),
      downloadAsset: verb(true, async (ref, downloadOptions = {}) => (await fetcher.stream(`${repoPath(ref.repo)}/releases/assets/${encodeURIComponent(ref.id)}`, {
        headers: { accept: 'application/octet-stream' },
        signal: downloadOptions.signal,
      })).body),
      create: verb(true, (repo, input, options) => writeRelease(repo, `${repoPath(repo)}/releases`, 'POST', input, options)),
      update: verb(true, (ref, update, options) => writeRelease(ref.repo, `${repoPath(ref.repo)}/releases/${encodeURIComponent(ref.id)}`, 'PATCH', update, options)),
    },
  }
}

const PUSHIN: ProviderDefinition<PushinOptions, undefined, true> = {
  forge: FORGE,
  hasWeb: true,
  experimental: true,
  anonymous: true,
  baseUrl: 'https://pushin.eu',
  apiPath: '/api/v1',
  headers: { accept: 'application/vnd.github+json' },
  authHeaders: ({ options: { auth } }) => auth?.type === 'token' ? async () => ({ authorization: `Bearer ${await resolveToken(auth)}` }) : undefined,
  setup: setupPushin,
}

/** Creates a Pushin.eu provider. */
export const pushin: ProviderFactoryFunction<PushinOptions, true, 'pushin'> = /* @__PURE__ */ defineForgeProvider(PUSHIN)

/** Scope requirements for a Pushin.eu operation. */
function pushinScopesFor(_verb: ForgeVerb): VerbScopes {
  return { note: 'A personal access token created in Settings; Pushin.eu does not scope tokens per resource' }
}
