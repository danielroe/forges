import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

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

  it('approves with a vote of 10 and sets auto-complete for whenChecksPass', async () => {
    const { instance, calls } = provider({ ...me, 'PUT https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets/pullRequests/42/reviewers/me-0000?api-version=7.1': { status: 200, body: {} } })
    await instance.threads.approveAndMerge!(pull, { method: 'squash', whenChecksPass: true })
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
})
