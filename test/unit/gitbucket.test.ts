import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it } from 'vitest'
import { MergeBlockedError, MergeConflictError, UnsupportedOperationError } from '../../src/errors.ts'
import { gitbucket } from '../../src/gitbucket/index.ts'

const baseUrl = 'https://gitbucket.example.com'
const origin = { forge: 'gitbucket', instance: 'gitbucket.example.com' } as const
const repo = { ...origin, owner: 'root', name: 'widgets' } as const
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
const head = '4ddbfdaf459b39e50b1fe3e4ddb5157b57a4aca9'

interface Call { method: string, url: URL, body?: unknown }

/** A GitBucket that answers each request with `respond`, and records the requests it was sent. */
function server(respond: (call: Call) => unknown) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const call = {
      method: init?.method ?? 'GET',
      url: new URL(url),
      ...typeof init?.body === 'string' && {
        body: JSON.parse(init.body),
      },
    }
    calls.push(call)
    const response = respond(call)
    return response instanceof Response
      ? response
      : Response.json(response)
  }
  return {
    forge: gitbucket({
      baseUrl,
      auth: { type: 'token', token: 't' },
      fetch,
    }),
    calls,
  }
}

/** A GitBucket that answers every list with `count` threads like `fields`. */
function issuesServer(count: number, fields: (index: number) => Record<string, unknown> = () => ({ state: 'open' })) {
  return server(() => Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    created_at: '2026-10-31T17:45:27Z',
    ...fields(index),
  })))
}

/** Responds to a merge as GitBucket does: HTTP `200`, with the outcome inside. */
function mergeEnvelope(status: number, body: object) {
  return {
    status,
    body: JSON.stringify(body),
    headers: {},
  }
}

describe('gitbucket', () => {
  it('appends `/api/v3` to the server root and names the instance after its host', () => {
    const forge = gitbucket({ baseUrl: 'https://git.example.com/gitbucket' })

    expect(forge.baseUrl).toBe('https://git.example.com/gitbucket/api/v3')
    expect(forge.instance).toBe('git.example.com')
    expect(forge.webOrigin).toBe('https://git.example.com')
    expect('graphql' in forge).toBe(false)
  })

  it('needs the baseUrl of a server', () => {
    expect(() => gitbucket({} as never)).toThrow('gitbucket has no public instance, so it needs the baseUrl of your server')
  })

  it('pages threads by number and filters them under the names GitBucket reads', async () => {
    const { forge, calls } = issuesServer(25)

    const first = await forge.threads.list(repo, {
      kind: 'issue',
      author: 'ada',
      assignee: 'grace',
      mentions: 'linus',
      milestone: 'v2.0',
      labels: ['bug', 'ui'],
    }).page()
    await forge.threads.list(repo, { kind: 'issue', cursor: first.cursor }).page()

    expect(first.cursor).toEqual({ token: '2' })
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      state: 'open',
      labels: 'bug,ui',
      author: 'ada',
      assigned: 'grace',
      mentioned: 'linus',
      milestone: 'v2.0',
      sort: 'created',
      direction: 'desc',
    })
    expect(calls[1]!.url.searchParams.get('page')).toBe('2')
    await expect(forge.threads.list(repo, {
      kind: 'issue',
      cursor: { token: 'next' },
    }).page()).rejects.toThrow(TypeError)
  })

  it('orders each page as asked, since GitBucket does not', async () => {
    const created = ['2026-10-02', '2026-10-03', '2026-10-01']
    const { forge } = issuesServer(3, index => ({ state: 'open', created_at: `${created[index]}T00:00:00Z`, comments: [5, 1, 3][index] }))

    expect((await forge.threads.list(repo, { kind: 'issue' }).page()).items.map(thread => thread.ref.number)).toEqual(['2', '1', '3'])
    expect((await forge.threads.list(repo, { kind: 'issue', direction: 'asc' }).page()).items.map(thread => thread.ref.number)).toEqual(['3', '1', '2'])
    expect((await forge.threads.list(repo, { kind: 'issue', sort: 'comments' }).page()).items.map(thread => thread.ref.number)).toEqual(['1', '3', '2'])
  })

  it('ends the listing on a short page, and says what it cannot list or filter', async () => {
    const { forge, calls } = issuesServer(3)

    const page = await forge.threads.list(repo, {
      since: new Date('2026-01-01'),
      involves: 'ada',
    }).page()

    expect(page.cursor).toBeUndefined()
    expect(calls[0]!.url.pathname).toBe('/api/v3/repos/root/widgets/issues')
    expect(page.warnings?.map(warning => warning.code)).toEqual(['filter_unsupported', 'kind_unsupported', 'filter_unsupported'])
  })

  it('lists merged pull requests when no kind is given, since only those merge', async () => {
    const { forge, calls } = issuesServer(2, index => ({ state: 'closed', merged: index === 0 }))

    const page = await forge.threads.list(repo, { state: 'merged' }).page()

    expect(calls[0]!.url.pathname).toBe('/api/v3/repos/root/widgets/pulls')
    expect(calls[0]!.url.searchParams.get('state')).toBe('closed')
    expect(page.items.map(thread => [thread.ref.number, thread.state])).toEqual([
      ['1', 'merged'],
    ])
    expect(page.warnings).toBeUndefined()
  })

  it('stops the commits at a full page, past which GitBucket skips some', async () => {
    const commits = (count: number) => Array.from({ length: count }, (_, index) => ({
      sha: index.toString(16).padStart(40, '0'),
      commit: { message: `Commit ${index}` },
    }))

    for (const [perPage, count] of [
      [undefined, 30],
      [250, 100],
    ] as const) {
      const page = await server(() => commits(count)).forge.commits.list(repo, { perPage }).page()

      expect(page.items).toHaveLength(count)
      expect(page.cursor).toBeUndefined()
      expect(page.warnings).toEqual([
        expect.objectContaining({ code: 'commits_truncated' }),
      ])
    }
  })

  it('adds only the labels a thread lacks and removes only those it has, then reads what is left', async () => {
    let labels = ['bug']
    const { forge, calls } = server(({ method, url, body }) => {
      if (method === 'POST') {
        labels = [
          ...labels,
          ...(body as { labels: string[] }).labels,
        ]
      }
      if (method === 'DELETE') {
        labels = labels.filter(label => label !== decodeURIComponent(url.pathname.split('/').at(-1)!))
      }
      return labels.map(name => ({ name, color: 'fc2929' }))
    })

    expect((await forge.threads.addLabels(issue, ['bug', 'ui', 'ui'])).map(label => label.name)).toEqual(['bug', 'ui'])
    expect((await forge.threads.addLabels(issue, ['bug'])).map(label => label.name)).toEqual(['bug', 'ui'])
    expect((await forge.threads.removeLabels(issue, ['ui', 'nope'])).map(label => label.name)).toEqual(['bug'])
    await forge.threads.setLabels(issue, ['ui', 'ui'])
    expect(calls.map(call => `${call.method} ${call.url.pathname.replace('/api/v3/repos/root/widgets/issues/1', '')} ${call.body
      ? JSON.stringify(call.body)
      : ''}`.trim())).toEqual([
      'GET /labels',
      'POST /labels {"labels":["ui"]}',
      'GET /labels',
      'GET /labels',
      'GET /labels',
      'DELETE /labels/ui',
      'GET /labels',
      'PUT /labels {"labels":["ui"]}',
    ])
  })

  it('merges through the synchronous endpoint, joining the title to the message', async () => {
    const { forge, calls } = server(() => mergeEnvelope(200, { sha: `MergeResult(AnyObjectId[${'a'.repeat(40)}],List(${head}))`, merged: true, message: 'Pull Request successfully merged' }))

    expect(await forge.threads.merge(pull, { method: 'squash', title: 'Handle an empty config', message: 'Closes #1.' })).toMatchObject({
      status: 'merged',
      sha: 'a'.repeat(40),
    })
    await forge.threads.merge(pull)
    expect(calls.map(call => [call.method, call.url.pathname, call.body])).toEqual([
      [
        'PUT',
        '/api/v3/repos/root/widgets/pulls/2/merge',
        { merge_method: 'squash', commit_message: 'Handle an empty config\n\nCloses #1.' },
      ],
      ['PUT', '/api/v3/repos/root/widgets/pulls/2/merge', {}],
    ])
  })

  it('throws when GitBucket reports a merge it refused inside a successful response', async () => {
    const refused = (status: number, message: string) => server(() => mergeEnvelope(status, { message, documentation_url: 'https://docs.github.com/en/rest/reference/pulls#merge-a-pull-request' })).forge

    await expect(refused(409, 'Head branch was modified. Review and try the merge again.').threads.merge(pull, { method: 'merge' })).rejects.toThrow(MergeConflictError)
    await expect(refused(405, 'Pull Request is not mergeable, Closed').threads.merge(pull, { method: 'merge' })).rejects.toThrow(MergeBlockedError)
  })

  it('rejects what GitBucket ignores or lacks without a request', async () => {
    const { forge, calls } = server(() => ({}))

    await expect(forge.threads.merge(pull, { method: 'merge', sha: head })).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.threads.merge(pull, { method: 'merge', whenChecksPass: true })).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.threads.merge(pull, { method: 'fast_forward' as never })).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.threads.create(repo, {
      kind: 'pull_request',
      title: 'Fix',
      head: 'fix',
      base: 'main',
      labels: ['bug'],
    })).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.threads.update(pull, {
      title: 'Fix',
      labels: ['bug'],
    })).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.threads.close(issue)).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.threads.files(pull).page()).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.contents.compare(repo, 'main', 'next')).rejects.toThrow('gitbucket does not support contents.compare')
    expect(calls).toEqual([])
  })

  it('reports what GitBucket lacks', () => {
    const { forge } = server(() => ({}))

    expect(forge.support('threads.react')).toBe('not_applicable')
    expect(forge.support('ci.runs')).toBe('not_applicable')
    expect(forge.support('repos.reviewerCandidates')).toBe('not_applicable')
    expect(forge.support('threads.get', 'discussion')).toBe('not_applicable')
    expect(forge.support('threads.update', 'issue')).toBe(false)
    expect(forge.support('threads.update', 'pull_request')).toBe(true)
    expect(forge.support('search.threads')).toBe(false)
  })

  it('links to GitBucket pages and reads its URLs back', () => {
    const { forge } = server(() => ({}))
    const release = {
      ...origin,
      repo,
      id: 'v1.0.0',
      tag: 'v1.0.0',
    }

    expect(forge.urlFor({ release })).toBe(`${baseUrl}/root/widgets/releases/v1.0.0`)
    expect(forge.urlFor({
      comment: { ...origin, thread: issue, id: '19' },
    })).toBe(`${baseUrl}/root/widgets/issues/1#comment-19`)
    expect(forge.urlFor({ repo, section: 'forks' })).toBe(`${baseUrl}/root/widgets/network/members`)
    expect(forge.urlFor({ repo, section: 'stargazers' })).toBeUndefined()
    expect(forge.parseUrl(`${baseUrl}/root/widgets/releases/v1.0.0`)?.release).toEqual(release)
    expect(forge.parseUrl(`${baseUrl}/root/widgets/pull/2`)?.thread).toEqual(pull)
    expect(forge.parseUrl(`${baseUrl}/git/root/widgets.git`)?.repo).toEqual(repo)
  })
})
