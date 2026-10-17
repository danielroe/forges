import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { NotFoundError } from '../../src/errors.ts'
import { fixtureFetch, hangingFetch } from '../utils/fixtures.ts'

const repo = { forge: 'azure-devops', instance: 'dev.azure.com', owner: 'acme/Widgets', name: 'widgets' } as const
const pull = { forge: 'azure-devops', instance: 'dev.azure.com', repo, kind: 'pull_request', number: '42' } as const
const me = { 'GET https://dev.azure.com/acme/_apis/connectionData?api-version=7.1-preview.1': { status: 200, body: { authenticatedUser: { id: 'me-0000' } } } }

function provider(overrides = {}) {
  const { fetch, calls } = fixtureFetch('azure-devops', overrides)
  return { instance: azureDevOps({ auth: { type: 'token', token: 'pat' }, organization: 'acme', fetch }).create(), calls }
}

describe('azure devops', () => {
  it('sends the PAT as basic auth and the API version on every request', async () => {
    const { instance, calls } = provider()
    await instance.repos.get(repo)

    expect(calls[0]!.authorization).toBe(`Basic ${btoa(':pat')}`)
    expect(new URL(calls[0]!.url).searchParams.get('api-version')).toBe('7.1')
  })

  it('reads the visibility of a repository from its project', async () => {
    const raw = (name: string, visibility?: 'public' | 'private') => ({ id: name, name, project: { id: 'p', name: 'Widgets', visibility } })
    const instance = azureDevOps({ auth: { type: 'token', token: 'pat' }, organization: 'acme', fetch: async url => new URL(url).pathname.endsWith('/repositories')
      ? Response.json({ value: [raw('site', 'public'), raw('vault', 'private'), raw('legacy')] })
      : Response.json(raw('widgets', 'public')) }).create()

    expect((await instance.repos.get(repo)).visibility).toBe('public')
    expect((await instance.repos.listPage()).items.map(item => item.visibility)).toEqual(['public', 'private', 'private'])
  })

  it('lists work items through WIQL with state from the type\'s categories, scoped to the project', async () => {
    const { instance, calls } = provider()
    const page = await instance.threads.listPage(repo, { kind: 'issue' })

    expect(JSON.parse(calls[0]!.body!).query).toContain('[System.TeamProject] = @project')
    expect(page.items.map(thread => [thread.ref.number, thread.state, thread.labels.map(label => label.name)])).toEqual([['101', 'open', ['bug', 'networking']]])
    expect(page.items[0]!.ref.repo).toMatchObject({ owner: 'acme/Widgets', name: '', kind: 'namespace' })
  })

  it('lists pull requests only, with a warning, when anonymous and no kind is given', async () => {
    const { fetch, calls } = fixtureFetch('azure-devops')
    const page = await azureDevOps({ organization: 'acme', fetch }).create().threads.listPage(repo)

    expect(calls.some(call => call.url.includes('/wiql'))).toBe(false)
    expect(page.items.every(thread => thread.ref.kind === 'pull_request')).toBe(true)
    expect(page.warnings).toContainEqual(expect.objectContaining({ code: 'kind_unsupported' }))
  })

  it('reads a pull request without its checks when anonymous', async () => {
    const { fetch, calls } = fixtureFetch('azure-devops')
    const thread = await azureDevOps({ organization: 'acme', fetch }).create().threads.get(pull)

    expect(thread.checks).toBeUndefined()
    expect(calls.some(call => call.url.includes('/statuses') || call.url.includes('/policy/'))).toBe(false)
  })

  it('closes a work item by moving it to its type\'s completed state', async () => {
    const { instance, calls } = provider({
      'GET https://dev.azure.com/acme/Widgets/_apis/wit/workitems/101?api-version=7.1': { status: 200, body: { id: 101, fields: { 'System.WorkItemType': 'Issue', 'System.State': 'To Do' } } },
      'PATCH https://dev.azure.com/acme/Widgets/_apis/wit/workitems/101?api-version=7.1': { status: 200, body: { id: 101, fields: {} } },
    })
    await instance.threads.close!({ ...pull, kind: 'issue', number: '101' })
    const patch = calls.find(call => call.method === 'PATCH')!

    expect(patch.headers.get('content-type')).toBe('application/json-patch+json')
    expect(JSON.parse(patch.body!)).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Done' }])
  })

  it('aborts closing a work item while its state is read with the caller\'s reason', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const { fetch, started } = hangingFetch()
    const instance = azureDevOps({ auth: { type: 'token', token: 'pat' }, organization: 'acme', fetch }).create()

    const pending = instance.threads.close({ ...pull, kind: 'issue', number: '101' }, { signal: controller.signal })
    await started
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('approves with a vote of 10 and sets auto-complete for whenChecksPass', async () => {
    const { instance, calls } = provider({ ...me, 'PUT https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets/pullRequests/42/reviewers/me-0000?api-version=7.1': { status: 200, body: {} } })
    await instance.threads.approve(pull)
    await instance.threads.merge!(pull, { method: 'squash', whenChecksPass: true })
    const writes = calls.filter(call => call.method !== 'GET')

    expect(writes.map(call => [call.method, JSON.parse(call.body!)])).toEqual([
      ['PUT', { vote: 10 }],
      ['PATCH', { autoCompleteSetBy: { id: 'me-0000' }, completionOptions: { mergeStrategy: 'squash' } }],
    ])
  })

  it('completes with the current source commit when merging now', async () => {
    const { instance, calls } = provider(me)
    await instance.threads.merge!(pull, { method: 'rebase_merge' })

    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ status: 'completed', lastMergeSourceCommit: { commitId: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d' }, completionOptions: { mergeStrategy: 'rebaseMerge' } })
  })

  it('resolves with the merge commit of the completed pull request in the response', async () => {
    const completed = { pullRequestId: 42, status: 'completed', mergeStatus: 'succeeded', lastMergeCommit: { commitId: 'c0ffee0000000000000000000000000000000001' } }
    const { instance, calls } = provider({ ...me, 'PATCH https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets/pullRequests/42?api-version=7.1': { status: 200, body: completed } })

    await expect(instance.threads.merge!(pull, { method: 'squash', sha: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d' })).resolves.toEqual({ status: 'merged', sha: 'c0ffee0000000000000000000000000000000001', raw: completed })
    expect(calls.map(call => call.method)).toEqual(['GET', 'PATCH'])
  })

  it('resolves queued while Azure DevOps completes the merge in the background', async () => {
    const queued = { pullRequestId: 42, status: 'active', mergeStatus: 'queued' }
    const { instance } = provider({ ...me, 'PATCH https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets/pullRequests/42?api-version=7.1': { status: 200, body: queued } })

    await expect(instance.threads.merge!(pull, { method: 'squash' })).resolves.toEqual({ status: 'queued', raw: queued })
  })

  it('puts the merge commit title before the message', async () => {
    const { instance, calls } = provider(me)
    await instance.threads.merge!(pull, { method: 'squash', title: 'Release widgets', message: 'Ships the widgets' })

    expect(JSON.parse(calls.at(-1)!.body!).completionOptions).toEqual({ mergeStrategy: 'squash', mergeCommitMessage: 'Release widgets\n\nShips the widgets' })
  })
})

describe('azure devops single-item reads', () => {
  it('does not read a system comment, which the listing leaves out', async () => {
    const instance = azureDevOps({ auth: { type: 'token', token: 'pat' }, organization: 'acme', fetch: async url => String(url).includes('/pullRequests/42/threads/7')
      ? Response.json({ id: 7, status: 'active', comments: [{ id: 1, content: 'Looks good', commentType: 'text' }, { id: 2, content: 'Policy updated', commentType: 'system' }] })
      : Response.json({ message: 'not found' }, { status: 404 }) }).create()
    const ref = (id: string) => ({ forge: 'azure-devops', instance: 'dev.azure.com', thread: pull, id })

    expect((await instance.threads.getComment(ref('7/1'))).body).toBe('Looks good')
    await expect(instance.threads.getComment(ref('7/2'))).rejects.toThrow(NotFoundError)
  })
})

describe('azure devops thread updates', () => {
  const A = 'https://dev.azure.com/acme/Widgets/_apis'

  it('changes every field of a work item in one patch', async () => {
    const { instance, calls } = provider({
      [`GET ${A}/wit/workitems/7?api-version=7.1`]: { status: 200, body: { id: 7, fields: { 'System.WorkItemType': 'Issue' } } },
      [`PATCH ${A}/wit/workitems/7?api-version=7.1`]: { status: 200, body: { id: 7, fields: { 'System.WorkItemType': 'Issue', 'System.State': 'Done' } } },
    })
    await instance.threads.update({ ...pull, kind: 'issue', number: '7' }, { title: 'Retry uploads', state: 'closed', labels: ['bug', 'ui'], assignees: ['jane@acme.dev'] })

    expect(calls.filter(call => call.method === 'PATCH').map(call => JSON.parse(call.body!))).toEqual([[
      { op: 'add', path: '/fields/System.Title', value: 'Retry uploads' },
      { op: 'add', path: '/fields/System.State', value: 'Done' },
      { op: 'add', path: '/fields/System.Tags', value: 'bug; ui' },
      { op: 'add', path: '/fields/System.AssignedTo', value: 'jane@acme.dev' },
    ]])
  })

  it('moves pull request labels before the edit that abandons it', async () => {
    const { instance, calls } = provider({
      [`GET ${A}/git/repositories/widgets/pullRequests/42/labels?api-version=7.1`]: { status: 200, body: { value: [{ id: 'l-1', name: 'stale' }] } },
      [`DELETE ${A}/git/repositories/widgets/pullRequests/42/labels/l-1?api-version=7.1`]: { status: 200, body: {} },
      [`POST ${A}/git/repositories/widgets/pullRequests/42/labels?api-version=7.1`]: { status: 200, body: { id: 'l-2', name: 'bug' } },
    })
    const thread = await instance.threads.update(pull, { state: 'closed', labels: ['bug'] })

    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname.split('/pullRequests/')[1]}`)).toEqual(['GET 42/labels', 'DELETE 42/labels/l-1', 'POST 42/labels', 'PATCH 42'])
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ status: 'abandoned' })
    expect(thread.state).toBe('closed')
  })

  it('reads a pull request back instead of patching it when only its labels change', async () => {
    const { instance, calls } = provider({
      [`GET ${A}/git/repositories/widgets/pullRequests/42/labels?api-version=7.1`]: { status: 200, body: { value: [] } },
      [`POST ${A}/git/repositories/widgets/pullRequests/42/labels?api-version=7.1`]: { status: 200, body: { id: 'l-2', name: 'bug' } },
    })
    await instance.threads.update(pull, { labels: ['bug'] })

    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname.split('/pullRequests/')[1]}`)).toEqual(['GET 42/labels', 'POST 42/labels', 'GET 42'])
  })

  it('resolves pull request labels with the kept labels and the ones it added', async () => {
    const { instance, calls } = provider({
      [`GET ${A}/git/repositories/widgets/pullRequests/42/labels?api-version=7.1`]: { status: 200, body: { value: [{ id: 'l-1', name: 'stale' }, { id: 'l-3', name: 'ui' }] } },
      [`DELETE ${A}/git/repositories/widgets/pullRequests/42/labels/l-1?api-version=7.1`]: { status: 200, body: {} },
      [`POST ${A}/git/repositories/widgets/pullRequests/42/labels?api-version=7.1`]: { status: 200, body: { id: 'l-2', name: 'bug' } },
    })

    await expect(instance.threads.setLabels(pull, ['ui', 'bug'])).resolves.toEqual([{ name: 'ui' }, { name: 'bug' }])
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname.split('/pullRequests/')[1]}`)).toEqual(['GET 42/labels', 'DELETE 42/labels/l-1', 'POST 42/labels'])
  })

  it('resolves a pull request state change with the pull request in the response', async () => {
    const { instance, calls } = provider({
      [`PATCH ${A}/git/repositories/widgets/pullRequests/42?api-version=7.1`]: { status: 200, body: { pullRequestId: 42, title: 'Add widgets', status: 'abandoned', sourceRefName: 'refs/heads/feat', targetRefName: 'refs/heads/main' } },
    })

    await expect(instance.threads.close(pull)).resolves.toMatchObject({ title: 'Add widgets', state: 'closed', branches: { head: { ref: 'feat' }, base: { ref: 'main' } } })
    expect(calls.map(call => call.method)).toEqual(['PATCH'])
  })

  it('resolves a work item state change with the work item in the patch response', async () => {
    const { instance, calls } = provider({
      [`GET ${A}/wit/workitems/7?api-version=7.1`]: { status: 200, body: { id: 7, fields: { 'System.WorkItemType': 'Issue', 'System.Title': 'Crash', 'System.State': 'Doing' } } },
      [`PATCH ${A}/wit/workitems/7?api-version=7.1`]: { status: 200, body: { id: 7, fields: { 'System.WorkItemType': 'Issue', 'System.Title': 'Crash', 'System.State': 'Done' } } },
    })

    await expect(instance.threads.close({ ...pull, kind: 'issue', number: '7' })).resolves.toMatchObject({ kind: 'issue', title: 'Crash', state: 'closed', stateRaw: 'Done' })
    expect(calls.filter(call => call.url.includes('/workitems/7')).map(call => call.method)).toEqual(['GET', 'PATCH'])
    expect(calls.filter(call => call.url.includes('/states'))).toHaveLength(1)
  })

  it('resolves work item labels with the tags in the patch response', async () => {
    const { instance, calls } = provider({
      [`PATCH ${A}/wit/workitems/7?api-version=7.1`]: { status: 200, body: { id: 7, fields: { 'System.WorkItemType': 'Issue', 'System.Tags': 'bug; ui' } } },
    })

    await expect(instance.threads.setLabels({ ...pull, kind: 'issue', number: '7' }, ['bug', 'ui'])).resolves.toEqual([{ name: 'bug' }, { name: 'ui' }])
    expect(calls.map(call => call.method)).toEqual(['PATCH'])
  })

  it('resolves setAssignees with the assignee in the patch response', async () => {
    const { instance, calls } = provider({
      [`PATCH ${A}/wit/workitems/7?api-version=7.1`]: { status: 200, body: { id: 7, fields: { 'System.WorkItemType': 'Issue', 'System.AssignedTo': { id: 'jane-0001', uniqueName: 'jane@acme.dev', displayName: 'Jane' } } } },
    })

    await expect(instance.threads.setAssignees({ ...pull, kind: 'issue', number: '7' }, ['jane@acme.dev'])).resolves.toMatchObject([{ login: 'jane@acme.dev', id: 'jane-0001' }])
    expect(calls.map(call => call.method)).toEqual(['PATCH'])
  })

  it('refuses pull request assignees before it writes anything', async () => {
    const { instance, calls } = provider()

    await expect(instance.threads.update(pull, { state: 'closed', assignees: ['jane@acme.dev'] })).rejects.toThrow('Azure DevOps pull requests have reviewers, not assignees')
    expect(calls).toEqual([])
  })

  it('refuses more than one work item assignee before it writes anything', async () => {
    const { instance, calls } = provider()

    await expect(instance.threads.update({ ...pull, kind: 'issue', number: '7' }, { assignees: ['jane@acme.dev', 'joe@acme.dev'] })).rejects.toThrow('single assignee')
    expect(calls).toEqual([])
  })
})

describe('azure devops organisation teams', () => {
  const org = { forge: 'azure-devops', instance: 'dev.azure.com', owner: 'acme/Widgets', name: '', kind: 'namespace' } as const

  it('lists a project\'s teams and their members', async () => {
    const { instance, calls } = provider()

    const teams = await Array.fromAsync(instance.orgs.teams(org))
    const members = await Array.fromAsync(instance.orgs.teamMembers(teams[0]!.ref))

    expect(teams.map(team => [team.ref.slug, team.ref.id, team.name, team.description])).toEqual([
      ['stewards', '11111111-1111-4111-8111-111111111111', 'stewards', 'Release stewards'],
      ['core', '22222222-2222-4222-8222-222222222222', 'core', undefined],
    ])
    expect(teams[0]!.ref.org).toMatchObject({ kind: 'namespace', owner: 'acme/Widgets', name: '' })
    expect(members.map(member => [member.login, member.name])).toEqual([['octocat@example.com', 'Mona Lisa'], ['hubot@example.com', 'Hubot']])
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /acme/_apis/projects/Widgets/teams',
      'GET /acme/_apis/projects/Widgets/teams/11111111-1111-4111-8111-111111111111/members',
    ])
  })

  it('reports organisation teams unsupported without a credential', () => {
    const anonymous = azureDevOps({ organization: 'acme' }).create()

    expect(anonymous.can('orgs.teams')).toBe(false)
    expect(anonymous.can('orgs.teamMembers')).toBe(false)
  })
})
