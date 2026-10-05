import type { ResolvedThreadRef } from '../../src/model.ts'
import { describe, expect, it } from 'vitest'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { toIssueState, toMergeMethod } from '../../src/bitbucket/normalise.ts'
import { MergeConflictError, UnsupportedOperationError } from '../../src/errors.ts'
import { repoKey } from '../../src/model.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const repo = { forge: 'bitbucket', instance: 'bitbucket.org', owner: 'acme', name: 'widgets' } as const
const pull: ResolvedThreadRef = { forge: 'bitbucket', instance: 'bitbucket.org', repo, kind: 'pull_request', number: '31' }

function provider(auth: Parameters<typeof bitbucket>[0]['auth'] = { type: 'token', token: 't' }) {
  const { fetch, calls } = fixtureFetch('bitbucket')
  return { instance: bitbucket({ auth, fetch }).create(), calls }
}

describe('bitbucket provider', () => {
  it('reports bitbucket.org as the instance and has no notifications', () => {
    const { instance } = provider()

    expect(instance.instance).toBe('bitbucket.org')
    expect(instance.can('notifications.list')).toBe(false)
  })

  it('sends app passwords and API tokens as basic auth', async () => {
    const { instance, calls } = provider({ type: 'basic', username: 'ada', password: 'app-password' })
    await instance.threads.get(pull)

    expect(calls[0]!.authorization).toBe(`Basic ${btoa('ada:app-password')}`)
  })

  it('keys the repo on its UUID once a thread has been read', async () => {
    const { instance } = provider()
    const thread = await instance.threads.get(pull)

    expect(repoKey(thread.ref.repo)).toBe('bitbucket:bitbucket.org/@{8b1c2d3e-0000-4000-8000-0000000000aa}')
  })

  it('follows body pagination and sorts newest-first activity oldest first', async () => {
    const { instance, calls } = provider()
    const events = []
    for await (const event of instance.threads.events(pull)) {
      events.push(event)
    }

    expect(calls.map(call => call.url.split('?')[1])).toEqual(['pagelen=50', 'pagelen=50&ctx=page2'])
    expect(events.map(event => event.occurredAt.toISOString())).toEqual([...events.map(event => event.occurredAt.toISOString())].sort())
  })

  it('maps issue tracker states and keeps the resolution as the reason', () => {
    expect(['new', 'open', 'on hold'].map(toIssueState)).toEqual(['open', 'open', 'open'])
    expect(['resolved', 'wontfix', 'duplicate'].map(toIssueState)).toEqual(['closed', 'closed', 'closed'])
    expect(toMergeMethod('squash_fast_forward')).toBeUndefined()
  })

  it('cannot reopen a declined pull request', async () => {
    const { instance } = provider()

    await expect(instance.threads.reopen!(pull)).rejects.toThrow(UnsupportedOperationError)
  })

  it('refuses to merge when the head has moved past the expected sha', async () => {
    const { instance, calls } = provider()

    await expect(instance.threads.approveAndMerge!(pull, { sha: 'ffffffffffff' })).rejects.toThrow(MergeConflictError)
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('accepts an expected sha that matches the abbreviated head', async () => {
    const { instance, calls } = provider()
    await instance.threads.merge!(pull, { sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e', method: 'squash' })

    expect(calls.at(-1)!.url).toMatch(/\/merge$/)
  })
})

describe('bitbucket webhooks', () => {
  it('subscribes `repo` to renames and transfers', async () => {
    const bodies: string[] = []
    const instance = bitbucket({ auth: { type: 'token', token: 't' }, fetch: async (_url, init) => {
      bodies.push(init?.body as string)
      return Response.json({ uuid: '{hook}', url: 'https://hooks.test/in', active: true, events: ['repo:updated', 'repo:transfer'] })
    } }).create()

    await instance.webhooks.create(repo, { url: 'https://hooks.test/in', events: ['repo'] })

    expect(JSON.parse(bodies[0]!).events).toEqual(['repo:updated', 'repo:transfer'])
    expect(instance.webhooks.events).toContainEqual({ kind: 'repo', action: 'renamed' })
  })
})

describe('bitbucket queries', () => {
  it('escapes quotes in BBQL string literals', async () => {
    const urls: string[] = []
    const forge = bitbucket({ auth: { type: 'token', token: 't' }, fetch: async (url) => {
      urls.push(url)
      return Response.json({ values: [] })
    } }).create()

    await forge.search.reposPage({ text: 'say "hi"' })

    expect(new URL(urls[0]!).searchParams.get('q')).toBe('name ~ "say \\"hi\\""')
  })
})
