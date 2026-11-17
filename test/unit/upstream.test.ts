import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it } from 'vitest'
import { UnsupportedOperationError } from '../../src/errors.ts'
import { upstream } from '../../src/upstream/index.ts'
import { upstream as upstreamWeb } from '../../src/web/index.ts'

const origin = { forge: 'upstream', instance: 'upstream.codes' } as const
const repo = { ...origin, owner: 'coline', name: 'onset' } as const
const issue = {
  ...origin,
  repo,
  kind: 'issue',
  number: '1',
} as const
const pull = {
  ...origin,
  repo,
  kind: 'pull_request',
  number: '2',
} as const

/** An Upstream that answers every request with `{}`, and records the requests it was sent. */
function server() {
  const calls: string[] = []
  const fetch: FetchLike = async (url) => {
    calls.push(url)
    return Response.json({})
  }
  return {
    forge: upstream({
      auth: { type: 'token', token: 't' },
      fetch,
    }),
    calls,
  }
}

describe('upstream', () => {
  it('talks to upstream.codes through `/api/v3` by default', () => {
    const forge = upstream()

    expect(forge.baseUrl).toBe('https://upstream.codes/api/v3')
    expect(forge.instance).toBe('upstream.codes')
    expect(forge.webOrigin).toBe('https://upstream.codes')
    expect('graphql' in forge).toBe(false)
  })

  it('names the API host by the instance it serves', () => {
    const forge = upstream({ baseUrl: 'https://api.upstream.codes' })

    expect(forge.baseUrl).toBe('https://api.upstream.codes/api/v3')
    expect(forge.instance).toBe('upstream.codes')
    expect(forge.urlFor({ repo })).toBe('https://upstream.codes/coline/onset')
  })

  it('rejects what Upstream lacks without a request', async () => {
    const { forge, calls } = server()

    await expect(forge.threads.createReview(pull, { body: 'Pending' })).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.notifications.markAllRead({ repo })).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.contents.commitFiles(repo, { branch: 'main', message: 'm', changes: [] })).rejects.toThrow('upstream does not support contents.commitFiles')
    expect(calls).toEqual([])
  })

  it('reports what Upstream lacks', () => {
    const { forge } = server()

    expect(forge.support('repos.milestones')).toBe('not_applicable')
    expect(forge.support('threads.get', 'discussion')).toBe(false)
    expect(forge.support('repos.collaborators')).toBe(false)
    expect(forge.support('threads.submitReview')).toBe(false)
    expect(forge.support('threads.approve')).toBe(true)
    expect(forge.support('securityAlerts.list')).toBe(false)
    expect(upstream().support('repos.assignableUsers')).toBe(false)
  })

  it('links to Upstream pages and reads its URLs back', () => {
    const web = upstreamWeb()

    expect(web.urlFor({ thread: pull })).toBe('https://upstream.codes/coline/onset/changes/2')
    expect(web.urlFor({ thread: issue })).toBe('https://upstream.codes/coline/onset/issues/1')
    expect(web.urlFor({ repo, section: 'pullRequests' })).toBe('https://upstream.codes/coline/onset/changes')
    expect(web.urlFor({ repo, section: 'watchers' })).toBeUndefined()
    expect(web.urlFor({
      release: {
        ...origin,
        repo,
        id: '1',
        tag: 'v1.0.0',
      },
    })).toBeUndefined()
    expect(web.parseUrl('https://upstream.codes/coline/onset/changes/2')?.thread).toEqual(pull)
    expect(web.parseUrl('https://upstream.codes/coline/onset/issues/1')?.thread).toEqual(issue)
    expect(web.parseUrl('https://upstream.codes/coline/onset')?.repo).toEqual(repo)
    expect(web.parseUrl('https://upstream.codes/docs/api')).toBeUndefined()
  })
})
