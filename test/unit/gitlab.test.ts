import type { ResolvedThreadRef } from '../../src/model.ts'
import type { FixtureFetch } from '../utils/fixtures.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  InsufficientScopeError,
  MergeMethodRequiredError,
  RateLimitedError,
  TokenRevokedError,
  UnresolvedThreadError,
  UnsupportedOperationError,
} from '../../src/errors.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { toNoteKind, toReason, toRepoRef } from '../../src/gitlab/normalise.ts'
import { verifyGitLabToken } from '../../src/gitlab/webhooks.ts'
import { notificationThread, repoKey, threadKey } from '../../src/model.ts'
import { fixtureDirectory, fixtureFetch, stubFetch } from '../utils/fixtures.ts'

const P = 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets'
const repo = { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform', name: 'widgets' } as const
const mr: ResolvedThreadRef = { forge: 'gitlab', instance: 'gitlab.com', repo, kind: 'pull_request', number: '23' }

function provider(overrides = {}) {
  const { fetch, calls } = fixtureFetch('gitlab', overrides)
  return { instance: gitlab({ auth: { type: 'token', token: 't' }, fetch }).create(), calls }
}

describe('gitlab provider', () => {
  it('gives a merge request comment the discussion that resolves it', async () => {
    const { instance } = provider()
    const { items } = await instance.threads.commentsPage(mr)

    expect(items.map(comment => comment.thread)).toEqual([{ id: '6a9c1750b37d513a43987b574953fceb50b03ce7', resolved: false }])
  })

  it('opens a resolvable discussion for a comment review', async () => {
    const discussion = { id: 'd1', individual_note: false, notes: [{ id: 7, body: 'Looks off', system: false, created_at: '2025-09-16T09:00:00.000Z', resolvable: true, resolved: false }] }
    const { instance, calls } = provider({ 'POST https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/23/discussions': { status: 201, body: discussion } })
    const review = await instance.threads.createReview(mr, { event: 'comment', body: 'Looks off' })

    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ body: 'Looks off' })
    expect(review.state).toBe('commented')
    expect(review.comments && review.comments[0]!.thread).toEqual({ id: 'd1', resolved: false })
  })

  it('falls back to the user search when the profile needs credentials', async () => {
    const { fetch } = fixtureFetch('gitlab/recorded/gitlab.com', {
      'GET https://gitlab.com/api/v4/users/8420142': { status: 403, headers: {}, body: { message: '403 Forbidden - Not authorized!' } },
    })
    const user = await gitlab({ fetch }).create().users.get('gitlab-dependency-update-bot')

    expect(user).toMatchObject({ login: 'gitlab-dependency-update-bot', id: '8420142', name: 'GitLab Dependency Bot', url: 'https://gitlab.com/gitlab-dependency-update-bot' })
  })

  it('appends the api prefix and reports the instance host', () => {
    const selfManaged = gitlab({ baseUrl: 'https://git.example.org', auth: { type: 'token', token: 't' } }).create()

    expect(selfManaged.baseUrl).toBe('https://git.example.org/api/v4')
    expect(selfManaged.instance).toBe('git.example.org')
  })

  it('keeps the full namespace in owner so nested groups never collide', () => {
    const nested = toRepoRef('gitlab.com', 'acme/platform/widgets')
    const flat = toRepoRef('gitlab.com', 'acme/platform-widgets')

    expect(nested).toMatchObject({ owner: 'acme/platform', name: 'widgets' })
    expect(repoKey(nested)).toBe('gitlab:gitlab.com/acme/platform/widgets')
    expect(repoKey(nested)).not.toBe(repoKey(flat))
  })

  it('maps a group-level epic to other on a namespace ref', async () => {
    const { instance } = provider()
    const page = await instance.notifications!.listPage({ cursor: { nextUrl: 'https://gitlab.com/api/v4/todos?page=2&per_page=20&state=pending' } })
    const epic = page.items[0]!

    expect(notificationThread(epic)!).toMatchObject({ kind: 'other', typeRaw: 'Epic', number: '4' })
    expect(notificationThread(epic)!.repo).toMatchObject({ kind: 'namespace', owner: 'acme/platform', name: '' })
    expect(threadKey(notificationThread(epic)! as ResolvedThreadRef)).toBe('gitlab:gitlab.com/@namespace:7781#other:Epic/4')
    expect(epic.reason).toBe('assigned')
  })

  it('normalises todo actions and keeps the native string', async () => {
    const { instance } = provider()
    const page = await instance.notifications!.listPage()

    expect(page.items.map(item => [item.reason, item.reasonRaw])).toEqual([
      ['review_requested', 'review_requested'],
      ['mention', 'directly_addressed'],
    ])
    expect(toReason('unmergeable')).toBe('merge_blocked')
    expect(toReason('review_submitted')).toBe('review_submitted')
    expect(toReason('ssh_key_expired')).toBe('unknown')
  })

  it('filters todos by since on the client, since the API has no such parameter', async () => {
    const { instance } = provider()
    const page = await instance.notifications!.listPage({ since: new Date('2025-09-18T00:00:00Z') })

    expect(page.items.map(item => item.ref.id)).toEqual(['102938401'])
  })

  it('needs the thread to unsubscribe, because to-dos cannot be looked up by id', async () => {
    const { instance } = provider()
    await expect(instance.notifications!.unsubscribe!({ forge: 'gitlab', instance: 'gitlab.com', id: '102938401' }))
      .rejects
      .toThrow(UnresolvedThreadError)
  })

  it('classifies system notes from their text', () => {
    const note = (body: string, system = true) => toNoteKind({ id: 1, body, system, created_at: '' })

    expect(note('added ~12 ~13 labels')).toBe('label')
    expect(note('closed')).toBe('state_change')
    expect(note('assigned to @ada')).toBe('assignment')
    expect(note('mentioned in merge request !9')).toBe('referenced')
    expect(note('added 2 commits\n\n* abc')).toBe('commit')
    expect(note('approved this merge request')).toBe('review')
    expect(note('changed the description')).toBe('other')
    expect(toNoteKind({ id: 2, body: 'nit', system: false, type: 'DiffNote', created_at: '' })).toBe('review_comment')
  })

  it('classifies the legacy capitalised wording found in recorded notes', () => {
    const note = (body: string) => toNoteKind({ id: 1, body, system: true, created_at: '' })

    expect(note('Reassigned to @marin')).toBe('assignment')
    expect(note('Added 20 commits:\n\n* 0089698f...9bfc23c3 - 17 commits from branch')).toBe('commit')
    expect(note('Status changed to merged')).toBe('state_change')
    expect(note('Mentioned in commit c0c5081dc665d64b56fcee63df5429b013bb69b6')).toBe('referenced')
  })

  it('approves a merge request natively and refuses an approval body', async () => {
    const { instance, calls } = provider()

    expect(instance.capabilities.reviews.approve).toBe(true)
    await instance.threads.approve(mr)
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([`POST ${P}/merge_requests/23/approve`])
    await expect(instance.threads.approve(mr, 'Looks good')).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toHaveLength(1)
  })

  it('maps a 401 from approve to InsufficientScopeError, not a revoked token', async () => {
    const { instance } = provider({
      [`POST ${P}/merge_requests/23/approve`]: { status: 401, body: { message: '401 Unauthorized' } },
    })

    const error = await instance.threads.approveAndMerge!(mr, { method: 'squash' }).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(InsufficientScopeError)
    expect((error as Error).cause).toBeInstanceOf(TokenRevokedError)
  })

  it('lists pending then done to-dos when all is set', async () => {
    const done = JSON.parse(readFileSync(`${fixtureDirectory('gitlab')}todos-page-2.json`, 'utf8')).response.body.map((todo: { id: number }) => ({ ...todo, id: 102938499, state: 'done' }))
    const { instance, calls } = provider({
      'GET https://gitlab.com/api/v4/todos?state=done': { status: 200, body: done },
    })
    const items = []
    for await (const item of instance.notifications!.list({ all: true })) {
      items.push(item)
    }

    expect(items.map(item => [item.ref.id, item.unread])).toEqual([
      ['102938401', true],
      ['102938402', true],
      ['102938403', true],
      ['102938499', false],
    ])
    expect(calls.at(-1)!.url).toBe('https://gitlab.com/api/v4/todos?state=done')
  })

  it('flags project and group bot users', async () => {
    const { instance } = provider()
    const actors = []
    for await (const event of instance.threads.events(mr)) {
      actors.push([event.actor?.login, event.actor?.isBotHint])
    }

    expect(actors.at(-1)).toEqual(['project_278964_bot_ab12cd', true])
  })

  it('reads RateLimit-* headers without the x- prefix', async () => {
    const instance = gitlab({
      auth: { type: 'token', token: 't' },
      fetch: stubFetch(429, { 'ratelimit-remaining': '0', 'ratelimit-reset': '1800000000' }),
    }).create()

    const error = await instance.notifications!.listPage().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RateLimitedError)
    expect((error as RateLimitedError).resetAt).toEqual(new Date(1_800_000_000_000))
  })

  it('finds a milestone title among ancestor group milestones', async () => {
    const { instance, calls } = provider({
      [`GET ${P}/milestones?include_ancestors=true`]: { status: 200, body: [{ id: 41, iid: 2, group_id: 9, title: 'Group milestone', state: 'active' }] },
      [`PUT ${P}/merge_requests/23`]: { status: 200, body: {} },
    })

    await instance.threads.setMilestone!(mr, 'Group milestone')

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${P}/milestones?include_ancestors=true`,
      `PUT ${P}/merge_requests/23`,
    ])
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ milestone_id: 41 })
  })
})

describe('gitlab merge methods', () => {
  it('rejects a method the project is not configured for', async () => {
    const { instance, calls } = provider()

    await expect(instance.threads.approveAndMerge!(mr, { method: 'rebase_merge' })).rejects.toThrow(UnsupportedOperationError)
    expect(calls.map(call => call.method)).toEqual(['GET'])
  })

  it('uses squash alone when the project always squashes', async () => {
    const { instance, calls } = provider({
      [`GET ${P}`]: { status: 200, body: { merge_method: 'ff', squash_option: 'always' } },
    })
    await instance.threads.merge!(mr)

    expect(calls.at(-1)!.body).toContain('"squash":true')
  })

  it('lists both allowed methods when squash is optional', async () => {
    const { instance } = provider({
      [`GET ${P}`]: { status: 200, body: { merge_method: 'rebase_merge', squash_option: 'default_on' } },
    })
    const error = await instance.threads.approveAndMerge!(mr).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(MergeMethodRequiredError)
    expect((error as MergeMethodRequiredError).allowed).toEqual(['rebase_merge', 'squash'])
  })

  it('reads the jobs of a fork pipeline from the fork', async () => {
    const thread = JSON.parse(readFileSync(`${fixtureDirectory('gitlab')}thread-mr-23.json`, 'utf8')).response.body
    const jobs = JSON.parse(readFileSync(`${fixtureDirectory('gitlab')}pipeline-jobs-610001.json`, 'utf8')).response.body
    const { instance, calls } = provider({
      [`GET ${P}/merge_requests/23`]: { status: 200, body: { ...thread, source_project_id: 999, head_pipeline: { ...thread.head_pipeline, project_id: 999 } } },
      'GET https://gitlab.com/api/v4/projects/999/pipelines/610001/jobs?per_page=100': { status: 200, body: jobs },
    })

    const checks = await instance.threads.checks!(mr)

    expect(checks.items).toHaveLength(jobs.length)
    expect(calls.at(-1)!.url).toBe('https://gitlab.com/api/v4/projects/999/pipelines/610001/jobs?per_page=100')
  })

  it('can queue the merge until the pipeline succeeds', async () => {
    const { instance, calls } = provider()
    await instance.threads.merge!(mr, { method: 'squash', whenChecksPass: true })

    expect(calls[0]!.body).toBe('{"squash":true,"merge_when_pipeline_succeeds":true}')
  })

  it.each([
    ['squash', { title: 'Release widgets (!23)', message: 'Ships the widgets' }, { squash_commit_message: 'Release widgets (!23)\n\nShips the widgets' }],
    ['merge', { title: 'Release widgets (!23)' }, { merge_commit_message: 'Release widgets (!23)' }],
    ['merge', { message: 'Ships the widgets' }, { merge_commit_message: 'Ships the widgets' }],
  ] as const)('puts the merge commit title before the message for a %s with %j', async (method, text, expected) => {
    const { instance, calls } = provider()
    await instance.threads.merge!(mr, { method, ...text })

    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ ...expected, squash: method === 'squash', merge_when_pipeline_succeeds: false })
  })
})

describe('gitlab webhooks', () => {
  it('compares X-Gitlab-Token to the secret rather than computing a signature', async () => {
    expect(await verifyGitLabToken({ headers: { 'X-Gitlab-Token': 's3cret' }, body: '{}' }, 's3cret')).toBe(true)
    expect(await verifyGitLabToken({ headers: { 'X-Gitlab-Token': 's3cret-but-longer' }, body: '{}' }, 's3cret')).toBe(false)
    expect(await verifyGitLabToken({ headers: {}, body: '{}' }, 's3cret')).toBe(false)
  })

  it('maps a merge request approval hook to a review event', async () => {
    const instance = gitlab({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const [event] = await instance.webhooks.ingest({
      headers: { 'x-gitlab-token': 's', 'x-gitlab-event': 'Merge Request Hook' },
      body: JSON.stringify({
        object_kind: 'merge_request',
        user: { id: 4101, username: 'ada' },
        project: { id: 278964, path_with_namespace: 'acme/platform/widgets' },
        object_attributes: { iid: 23, action: 'approved', updated_at: '2025-09-18 10:00:00 UTC' },
      }),
    })

    expect(event).toMatchObject({ kind: 'review', kindRaw: 'merge_request.approved' })
    expect(event!.thread).toMatchObject({ kind: 'pull_request', number: '23', repo: { owner: 'acme/platform', name: 'widgets' } })
    expect(event!.occurredAt.toISOString()).toBe('2025-09-18T10:00:00.000Z')
  })
})

describe('gitlab update webhooks', () => {
  it('splits label, assignee and reviewer changes into one event each', async () => {
    const instance = gitlab({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const events = await instance.webhooks.ingest({
      headers: { 'x-gitlab-token': 's', 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'd1' },
      body: JSON.stringify({
        object_kind: 'merge_request',
        user: { id: 4101, username: 'ada' },
        project: { id: 278964, path_with_namespace: 'acme/platform/widgets' },
        object_attributes: { iid: 23, action: 'update', updated_at: '2025-09-18 10:00:00 UTC' },
        changes: {
          labels: { previous: [{ title: 'bug' }, { title: 'ui' }], current: [{ title: 'bug' }, { title: 'docs' }] },
          assignees: { previous: [{ id: 1, username: 'grace' }], current: [{ id: 2, username: 'linus' }] },
          reviewers: { previous: [], current: [{ id: 3, username: 'ken' }] },
        },
      }),
    })

    expect(events.map(event => [event.id, event.kind, event.action, event.detail])).toEqual([
      ['d1:0', 'label', 'labelled', { type: 'label', label: 'docs' }],
      ['d1:1', 'label', 'unlabelled', { type: 'label', label: 'ui' }],
      ['d1:2', 'assignment', 'assigned', { type: 'assignment', assignee: expect.objectContaining({ login: 'linus' }) }],
      ['d1:3', 'assignment', 'unassigned', { type: 'assignment', assignee: expect.objectContaining({ login: 'grace' }) }],
      ['d1:4', 'assignment', 'review_requested', { type: 'assignment', assignee: expect.objectContaining({ login: 'ken' }) }],
    ])
    expect(events.every(event => event.thread?.number === '23')).toBe(true)
    for (const event of events) {
      expect(instance.webhooks.events).toContainEqual({ kind: event.kind, action: event.action })
    }
  })

  it('keeps the delivery id for a single change', async () => {
    const instance = gitlab({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const events = await instance.webhooks.ingest({
      headers: { 'x-gitlab-token': 's', 'x-gitlab-event': 'Issue Hook', 'x-gitlab-event-uuid': 'd2' },
      body: JSON.stringify({
        object_kind: 'issue',
        user: { id: 4101, username: 'ada' },
        project: { id: 278964, path_with_namespace: 'acme/platform/widgets' },
        object_attributes: { iid: 5, action: 'update' },
        changes: { labels: { previous: [], current: [{ title: 'bug' }] } },
      }),
    })

    expect(events).toMatchObject([{ id: 'd2', kind: 'label', action: 'labelled', summary: 'ada added label bug' }])
  })
})

describe('gitlab release webhooks', () => {
  it('keys GitLab releases by tag so the ref can be fetched', async () => {
    const provider = gitlab({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const body = JSON.stringify({ object_kind: 'release', action: 'create', id: 7, tag: 'v2.0.0', name: 'Two', project: { id: 1, path_with_namespace: 'acme/platform/widgets' } })
    const [event] = await provider.webhooks.ingest({ headers: { 'x-gitlab-event': 'Release Hook', 'x-gitlab-token': 's' }, body })

    expect(event).toMatchObject({ kind: 'release', action: 'published', detail: { type: 'release', release: { id: 'v2.0.0', tag: 'v2.0.0' }, name: 'Two' } })
  })
})

describe('gitlab release writes', () => {
  it('rejects what a GitLab release cannot be, without sending a request', async () => {
    const { instance, calls } = provider()
    const ref = { forge: 'gitlab', instance: 'gitlab.com', repo, id: 'v2.0.0', tag: 'v2.0.0' } as const

    await expect(instance.releases.create(repo, { tag: 'v2.2.0', draft: true })).rejects.toThrow(UnsupportedOperationError)
    await expect(instance.releases.create(repo, { tag: 'v2.2.0', prerelease: true })).rejects.toThrow('GitLab has no prereleases')
    await expect(instance.releases.update(ref, { draft: true })).rejects.toThrow('GitLab has no draft releases')
    await expect(instance.releases.update(ref, { tag: 'v2.0.1' })).rejects.toThrow('GitLab keys a release by its tag, so the tag cannot change')
    await expect(instance.releases.update(ref, { target: 'main' })).rejects.toThrow('GitLab cannot change the commit a release points to')
    expect(calls).toEqual([])
  })
})

describe('gitlab code search', () => {
  const cli = { forge: 'gitlab', instance: 'gitlab.com', owner: 'gitlab-org', name: 'cli' } as const
  const project = 'gid://gitlab/Project/80045070'

  function recordedSearch(graphql?: (init: Parameters<FixtureFetch['fetch']>[1]) => Response) {
    const recorded = fixtureFetch('gitlab/recorded/gitlab.com')
    const instance = gitlab({
      auth: { type: 'token', token: 't' },
      fetch: async (input, init) => graphql && String(input).endsWith('/graphql') ? graphql(init) : recorded.fetch(input, init),
    }).create()
    return { instance, calls: recorded.calls }
  }

  it('merges the excerpts of a file into one match, linked to the line of the first', async () => {
    const { instance } = recordedSearch()

    const { items } = await instance.search.codePage({ text: 'import', repo: cli, perPage: 3 })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ repo: cli, path: 'internal/commands/variable/import/import.go', ref: 'main', url: 'https://gitlab.com/gitlab-org/cli/-/blob/main/internal/commands/variable/import/import.go#L27' })
    expect(items[0]!.fragments.map(fragment => fragment.line)).toEqual([27, 1, 2])
    expect(items[0]!.raw).toHaveLength(3)
  })

  it('merges a file that basic search lists once for its name and again for its contents', async () => {
    const { instance } = recordedSearch()
    const scratch = { forge: 'gitlab', instance: 'gitlab.com', owner: 'forges-fixtures', name: 'forges-fixtures' } as const

    const { items } = await instance.search.codePage({ text: 'forges-fixtures', repo: scratch, perPage: 20 })

    expect(items).toHaveLength(10)
    expect(new Set(items.map(item => item.path)).size).toBe(10)
    expect(items.every(item => item.fragments.length === 1)).toBe(true)
  })

  it('names the projects of a group search in one request, and remembers them', async () => {
    const { instance, calls } = recordedSearch()

    const { items } = await instance.search.codePage({ text: 'import', owner: 'gitlab-org', perPage: 3 })
    await instance.search.codePage({ text: 'import', owner: 'gitlab-org', perPage: 3 })

    expect(items.map(item => item.repo)).toEqual([expect.objectContaining({ owner: 'gitlab-org/ai-engineering/agent-foundations', name: 'agentic-productivity', externalId: '80045070' })])
    expect(calls.filter(call => call.operationName === 'CodeSearchProjects').map(call => call.variables)).toEqual([{ ids: [project] }])
  })

  it('asks only for a read scope to search code', () => {
    const { instance } = provider()

    expect(instance.scopesFor('search.code')).toEqual({ token: ['read_api'] })
    expect(instance.scopesFor('search.codePage')).toEqual({ token: ['read_api'] })
  })

  it('searches a project, a group or the whole instance', async () => {
    const paths: string[] = []
    const instance = gitlab({
      auth: { type: 'token', token: 't' },
      fetch: async (url) => {
        paths.push(new URL(url).pathname)
        return Response.json([])
      },
    }).create()

    await instance.search.codePage({ text: 'useFetch', repo })
    await instance.search.codePage({ text: 'useFetch', owner: 'acme/platform' })
    await instance.search.codePage({ text: 'useFetch' })

    expect(paths).toEqual(['/api/v4/projects/acme%2Fplatform%2Fwidgets/search', '/api/v4/groups/acme%2Fplatform/search', '/api/v4/search'])
  })

  it('leaves out the results of a project the token cannot read, with a warning', async () => {
    const { instance } = recordedSearch(() => Response.json({ data: { projects: { nodes: [] } } }))

    const page = await instance.search.codePage({ text: 'import', owner: 'gitlab-org', perPage: 3 })

    expect(page.items).toEqual([])
    expect(page.warnings).toEqual([expect.objectContaining({ code: 'record_unreachable', subject: 'project 80045070' })])
  })

  it('stops a group search when reading its projects is rate limited', async () => {
    const { instance } = recordedSearch(() => Response.json({ message: 'Retry later' }, { status: 429, headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': '1800000000' } }))

    await expect(instance.search.codePage({ text: 'import', owner: 'gitlab-org', perPage: 3 })).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('lets the caller abort a group search while it reads the projects', async () => {
    const controller = new AbortController()
    const { instance } = recordedSearch((init) => {
      controller.abort()
      throw init!.signal!.reason
    })

    await expect(instance.search.codePage({ text: 'import', owner: 'gitlab-org', perPage: 3, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('gitlab path safety', () => {
  it('refuses a comment id that would climb out of the thread, before any request', async () => {
    const urls: string[] = []
    const provider = gitlab({ auth: { type: 'token', token: 't' }, fetch: async (url) => {
      urls.push(url)
      return new Response(null, { status: 204 })
    } }).create()
    const repo = { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: 'widgets' }
    const thread = { forge: 'gitlab', instance: 'gitlab.com', repo, kind: 'issue', number: '1' } as const

    await expect(provider.threads.deleteComment({ forge: 'gitlab', instance: 'gitlab.com', thread, id: '../../../../../user' })).rejects.toThrow(TypeError)
    expect(urls).toEqual([])
  })
})
