import { describe, expect, it } from 'vitest'
import { MergeMethodRequiredError, UnsupportedOperationError } from '../../src/errors.ts'
import { gitee } from '../../src/gitee/index.ts'
import { toCommit } from '../../src/gitee/normalise.ts'
import { verifyGiteeToken } from '../../src/gitee/webhooks.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const repo = { forge: 'gitee', instance: 'gitee.com', owner: 'acme', name: 'widgets' } as const
const pull = { forge: 'gitee', instance: 'gitee.com', repo, kind: 'pull_request', number: '7' } as const
const issue = { forge: 'gitee', instance: 'gitee.com', repo, kind: 'issue', number: 'I8ABCD' } as const

async function sign(secret: string, timestamp: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${secret}`)))))
}

describe('gitee', () => {
  it('reads commit parents as a repository commit or a pull request commit lists them', () => {
    expect(toCommit(repo, { sha: 'c', parents: [{ sha: 'a' }, { sha: 'b' }] }).parents).toEqual(['a', 'b'])
    expect(toCommit(repo, { sha: 'c', parents: { sha: 'a', shas: ['a', 'b'] } }).parents).toEqual(['a', 'b'])
    expect(toCommit(repo, { sha: 'c', parents: { sha: 'a' } }).parents).toEqual(['a'])
  })

  it('sends the token in the Authorization header, never the URL', async () => {
    const { fetch, calls } = fixtureFetch('gitee')
    await gitee({ auth: { type: 'token', token: 'gitee-token' }, fetch }).create().repos.get(repo)

    expect(calls[0]!.authorization).toBe('token gitee-token')
    expect(calls[0]!.url).not.toContain('access_token')
  })

  it('verifies signed webhooks as well as passwords', async () => {
    const timestamp = String(Date.now())
    const signature = await sign('s3cret', timestamp)
    const stale = String(Date.now() - 7_200_000)

    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': signature, 'x-gitee-timestamp': timestamp }, body: '{}' }, 's3cret')).toBe(true)
    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': encodeURIComponent(signature), 'x-gitee-timestamp': timestamp }, body: '{}' }, 's3cret')).toBe(true)
    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': signature, 'x-gitee-timestamp': '1' }, body: '{}' }, 's3cret')).toBe(false)
    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': await sign('s3cret', stale), 'x-gitee-timestamp': stale }, body: '{}' }, 's3cret')).toBe(false)
    expect(await verifyGiteeToken({ headers: { 'x-gitee-token': 's3cret' }, body: '{}' }, 's3cret')).toBe(true)
  })

  it('approves through the review endpoint, then merges with the requested method', async () => {
    const { fetch, calls } = fixtureFetch('gitee')
    await gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.approveAndMerge!(pull, { method: 'squash' })

    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /api/v5/repos/acme/widgets/pulls/7/review', 'PUT /api/v5/repos/acme/widgets/pulls/7/merge'])
    expect(JSON.parse(calls[1]!.body!)).toEqual({ merge_method: 'squash' })
    await expect(gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.approveAndMerge!(pull)).rejects.toThrow(MergeMethodRequiredError)
  })

  it('merges without approving, sending `message` as the description', async () => {
    const { fetch, calls } = fixtureFetch('gitee')
    await gitee({ auth: { type: 'token', token: 't' }, fetch }).create().threads.merge!(pull, { method: 'merge', message: 'Ship it' })

    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['PUT /api/v5/repos/acme/widgets/pulls/7/merge'])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ merge_method: 'merge', description: 'Ship it' })
  })

  it('writes issues through the owner-scoped endpoint and refuses several assignees', async () => {
    const { fetch, calls } = fixtureFetch('gitee', {
      'PATCH https://gitee.com/api/v5/repos/acme/issues/I8ABCD': { status: 200, body: { id: 7001, number: 'I8ABCD', state: 'closed', title: 'x' } },
    })
    const provider = gitee({ auth: { type: 'token', token: 't' }, fetch }).create()
    await provider.threads.close!(issue)

    expect(calls[0]).toMatchObject({ method: 'PATCH', url: 'https://gitee.com/api/v5/repos/acme/issues/I8ABCD' })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ repo: 'widgets', state: 'closed' })
    await expect(provider.threads.setAssignees!(issue, ['ada', 'grace'])).rejects.toThrow(UnsupportedOperationError)
  })
})

describe('gitee label filters', () => {
  const repository = { id: 1, path: 'widgets', name: 'widgets', full_name: 'acme/widgets', namespace: { path: 'acme' }, owner: { login: 'acme' } }
  const issues = [
    { id: 1, number: 'I1', title: 'Both', state: 'open', labels: [{ name: 'bug' }, { name: 'ui' }], repository },
    { id: 2, number: 'I2', title: 'One', state: 'open', labels: [{ name: 'bug' }], repository },
  ]
  const provider = gitee({ auth: { type: 'token', token: 't' }, fetch: async () => Response.json(issues) }).create()

  it('lists only threads carrying every label', async () => {
    const page = await provider.threads.listPage(repo, { kind: 'issue', labels: ['bug', 'ui'] })

    expect(page.items.map(thread => thread.title)).toEqual(['Both'])
  })

  it('searches only threads carrying every label', async () => {
    const page = await provider.search.threadsPage({ repo, labels: ['bug', 'ui'] })

    expect(page.items.map(thread => thread.title)).toEqual(['Both'])
  })
})
