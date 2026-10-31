import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it } from 'vitest'
import { UnsupportedOperationError } from '../../src/errors.ts'
import { gitbucket } from '../../src/gitbucket/index.ts'
import { fixtureFetch, payloadFixture } from '../utils/fixtures.ts'

const baseUrl = 'https://gitbucket.example.com'
const origin = { forge: 'gitbucket', instance: 'gitbucket.example.com' } as const
const repo = { ...origin, owner: 'root', name: 'widgets' } as const
const issue = { ...origin, repo, kind: 'issue', number: '1' } as const
const pull = { ...origin, repo, kind: 'pull_request', number: '2' } as const
const head = '4ddbfdaf459b39e50b1fe3e4ddb5157b57a4aca9'

function provider(fixtures = 'gitbucket') {
  const { fetch, calls } = fixtureFetch(fixtures)
  return { forge: gitbucket({ baseUrl, auth: { type: 'token', token: 't' }, webhookSecret: 'tops3cret', fetch }), calls }
}

/** A GitBucket that answers every list with `count` issues and records the URLs it was asked for. */
function issuesServer(count: number) {
  const urls: URL[] = []
  const fetch: FetchLike = async (url) => {
    urls.push(new URL(url))
    return Response.json(Array.from({ length: count }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}`, state: 'open', created_at: '2026-10-31T17:45:27Z' })))
  }
  return { forge: gitbucket({ baseUrl, fetch }), urls }
}

describe('gitbucket', () => {
  it('appends `/api/v3` to the server root and names the instance after its host', () => {
    const forge = gitbucket({ baseUrl: 'https://git.example.com/gitbucket' })

    expect(forge.baseUrl).toBe('https://git.example.com/gitbucket/api/v3')
    expect(forge.instance).toBe('git.example.com')
    expect(forge.webOrigin).toBe('https://git.example.com')
    expect('graphql' in forge).toBe(false)
  })

  it('reads repositories, users and their metadata through the REST API', async () => {
    const { forge } = provider()

    expect(await forge.repos.get(repo)).toMatchObject({ ref: repo, defaultBranch: 'main', description: 'Widgets for the forges tests' })
    expect(await forge.users.get('root')).toMatchObject({ ...origin, login: 'root' })
    expect(await forge.users.me()).toMatchObject({ login: 'root' })
    expect((await forge.repos.byOwner({ ...origin, owner: 'root', name: '', kind: 'namespace' }).page()).items.map(item => item.ref.name)).toContain('widgets')
    expect((await forge.repos.labels(repo).page()).items.map(label => label.name)).toContain('bug')
    expect((await forge.repos.milestones(repo).page()).items).toEqual([])
    expect(await forge.repos.templates(repo)).toEqual([])
    expect((await forge.repos.reviewerCandidates(pull).page()).items).toEqual([])
  })

  it('reads a pull request with its commit statuses, and no check runs or GraphQL', async () => {
    const { forge, calls } = provider()

    const thread = await forge.threads.get(pull)
    const [batched] = await forge.threads.getMany([pull])

    expect(thread).toMatchObject({ state: 'merged', branches: { head: { ref: 'fix-empty-config', sha: head }, base: { ref: 'main' } } })
    // GitBucket shows the statuses on the pull request itself; it has no checks page.
    expect(thread.checks).toEqual({ state: 'success', total: 2, failed: 0, url: `${baseUrl}/root/widgets/pull/2` })
    expect(thread.warnings).toBeUndefined()
    expect(batched).toMatchObject({ ok: true, thread: { state: 'merged' } })
    expect(calls.map(call => call.url).filter(url => url.includes('check-runs') || url.includes('graphql'))).toEqual([])
  })

  it('reads issues, comments, commits and statuses', async () => {
    const { forge } = provider()

    expect(await forge.threads.get(issue)).toMatchObject({ title: 'Crash on empty config', state: 'closed' })
    expect((await forge.threads.comments(issue).page()).items[0]).toMatchObject({ body: 'Reproduced on 1.2.0.' })
    expect(await forge.threads.getComment({ ...origin, thread: issue, id: '19' })).toMatchObject({ body: 'Reproduced on 1.2.0.' })
    expect((await forge.threads.commits(pull).page()).items.map(commit => commit.ref.sha)).toEqual([head])
    expect((await forge.threads.checks(pull)).items.map(check => check.name)).toEqual(['lint', 'ci/build'])
    expect((await forge.checks.list(repo, head)).items).toContainEqual(expect.objectContaining({ name: 'ci/build', state: 'success', url: 'https://ci.example.com/builds/7' }))
  })

  it('reads files, branches, tags and commits', async () => {
    const { forge } = provider()

    expect(await forge.contents.getFile(repo, 'README.md', { ref: 'main', as: 'text' })).toMatchObject({ path: 'README.md', encoding: 'utf-8', content: expect.stringContaining('widgets') })
    expect((await forge.contents.branches(repo).page()).items.map(branch => branch.name)).toContain('main')
    expect((await forge.contents.tags(repo).page()).items.map(tag => tag.name)).toEqual(['v1.0.0'])
    expect(await forge.contents.resolveRef(repo, 'main')).toMatch(/^[0-9a-f]{40}$/)
    expect(await forge.commits.get({ ...origin, repo, sha: head })).toMatchObject({ message: expect.stringContaining('Handle an empty config') })
    expect((await forge.commits.list(repo).page()).items.length).toBeGreaterThan(0)
  })

  it('addresses releases by tag, since GitBucket gives them no id', async () => {
    const { forge } = provider()

    const release = await forge.releases.getByTag(repo, 'v1.0.0')

    expect(release.ref).toMatchObject({ id: 'v1.0.0', tag: 'v1.0.0' })
    expect(await forge.releases.get(release.ref)).toMatchObject({ name: '1.0.0', body: 'The first release.' })
    expect((await forge.releases.list(repo).page()).items.map(item => item.tag)).toEqual(['v1.0.0'])
    expect(await forge.releases.latest(repo)).toMatchObject({ tag: 'v1.0.0' })
    expect((await forge.webhooks.list(repo).page()).items).toEqual([expect.objectContaining({ url: 'https://hooks.example.com/gitbucket' })])
  })

  it('reads public data without a token', async () => {
    const { fetch, calls } = fixtureFetch('gitbucket')
    const forge = gitbucket({ baseUrl, fetch })
    const release = await forge.releases.getByTag(repo, 'v1.0.0')

    await Promise.all([
      forge.repos.get(repo),
      forge.users.get('root'),
      forge.repos.byOwner({ ...origin, owner: 'root', name: '', kind: 'namespace' }).page(),
      forge.repos.labels(repo).page(),
      forge.repos.milestones(repo).page(),
      forge.repos.templates(repo),
      forge.threads.get(issue),
      forge.threads.get(pull),
      forge.threads.getMany([issue, pull]),
      forge.threads.list(repo, { kind: 'issue' }).page(),
      forge.threads.list(repo, { kind: 'pull_request', state: 'all' }).page(),
      forge.threads.comments(issue).page(),
      forge.threads.checks(pull),
      forge.threads.commits(pull).page(),
      forge.checks.list(repo, head),
      forge.contents.getFile(repo, 'README.md', { ref: 'main' }),
      forge.contents.branches(repo).page(),
      forge.contents.tags(repo).page(),
      forge.contents.resolveRef(repo, 'main'),
      forge.commits.list(repo).page(),
      forge.commits.get({ ...origin, repo, sha: head }),
      forge.releases.list(repo).page(),
      forge.releases.get(release.ref),
      forge.releases.latest(repo),
    ])

    expect(forge.authKind).toBe('anonymous')
    expect(calls.length).toBeGreaterThan(20)
  })

  it('lists issues and pull requests apart, from their own endpoints', async () => {
    const { forge } = provider()

    expect((await forge.threads.list(repo, { kind: 'issue' }).page()).items.map(thread => thread.title)).toEqual(['Widgets render twice', 'Typo in the README'])
    expect((await forge.threads.list(repo, { kind: 'pull_request', state: 'all' }).page()).items).toEqual([expect.objectContaining({ ref: pull, state: 'merged', checks: { state: 'success', total: 2, failed: 0, url: `${baseUrl}/root/widgets/pull/2` } })])
  })

  it('pages threads by number and filters them under the names GitBucket reads', async () => {
    const { forge, urls } = issuesServer(25)

    const first = await forge.threads.list(repo, { kind: 'issue', author: 'ada', assignee: 'grace', mentions: 'linus', milestone: 'v2.0', labels: ['bug', 'ui'] }).page()
    await forge.threads.list(repo, { kind: 'issue', cursor: first.cursor }).page()

    expect(first.cursor).toEqual({ token: '2' })
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ state: 'open', labels: 'bug,ui', author: 'ada', assigned: 'grace', mentioned: 'linus', milestone: 'v2.0', sort: 'created', direction: 'desc' })
    expect(urls[1]!.searchParams.get('page')).toBe('2')
    await expect(forge.threads.list(repo, { kind: 'issue', cursor: { token: 'next' } }).page()).rejects.toThrow(TypeError)
  })

  it('ends the listing on a short page, and says what it cannot list or filter', async () => {
    const { forge, urls } = issuesServer(3)

    const page = await forge.threads.list(repo, { since: new Date('2026-01-01') }).page()

    expect(page.cursor).toBeUndefined()
    expect(urls[0]!.pathname).toBe('/api/v3/repos/root/widgets/issues')
    expect(page.warnings?.map(warning => warning.code)).toEqual(['kind_unsupported', 'filter_unsupported'])
  })

  it('stops the commits at a full page, past which GitBucket skips some', async () => {
    const commits = Array.from({ length: 30 }, (_, index) => ({ sha: index.toString(16).padStart(40, '0'), commit: { message: `Commit ${index}` } }))
    const forge = gitbucket({ baseUrl, fetch: async () => Response.json(commits) })

    const page = await forge.commits.list(repo).page()

    expect(page.items).toHaveLength(30)
    expect(page.cursor).toBeUndefined()
    expect(page.warnings).toEqual([expect.objectContaining({ code: 'commits_truncated' })])
  })

  it('writes comments, issues, labels and statuses', async () => {
    const { forge } = provider('gitbucket/writes')

    expect(await forge.repos.createLabel(repo, { name: 'needs-triage', colour: 'fbca04' })).toMatchObject({ name: 'needs-triage' })
    const comment = await forge.threads.createComment(issue, 'Thanks for the report!')
    expect(await forge.threads.updateComment(comment.ref, 'Thanks for the report, a fix is up.')).toMatchObject({ body: 'Thanks for the report, a fix is up.' })
    expect(await forge.threads.create(repo, { kind: 'issue', title: 'Typo in the README', body: 'It says widgte.' })).toMatchObject({ ref: { kind: 'issue' }, title: 'Typo in the README' })
    expect((await forge.threads.setLabels(issue, ['bug'])).map(label => label.name)).toEqual(['bug'])
    expect((await forge.threads.addLabels(issue, ['needs-triage'])).map(label => label.name)).toContain('needs-triage')
    expect((await forge.threads.removeLabels(issue, ['needs-triage'])).map(label => label.name)).not.toContain('needs-triage')
    expect(await forge.checks.report(repo, head, { name: 'lint', state: 'success', description: 'No problems', url: 'https://ci.example.com/builds/8' })).toMatchObject({ name: 'lint', state: 'success' })
  })

  it('subscribes a hook only to the events GitBucket sends', async () => {
    const { forge, calls } = provider('gitbucket/writes')

    const hook = await forge.webhooks.create(repo, { url: 'https://hooks.example.com/gitbucket', events: ['comment', 'state_change'], secret: 'tops3cret', contentType: 'json' })
    await forge.webhooks.delete(hook.ref)

    expect(JSON.parse(calls.find(call => call.method === 'POST')!.body!)).toMatchObject({ events: ['issue_comment', 'issues', 'pull_request'] })
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${baseUrl}/api/v3/repos/root/widgets/hooks/2` })
  })

  it('merges through the synchronous endpoint, which reports no merge commit and checks no head', async () => {
    const { forge, calls } = provider('gitbucket/writes')

    await expect(forge.threads.merge(pull, { method: 'merge', sha: head })).rejects.toThrow(UnsupportedOperationError)
    expect(await forge.threads.merge(pull, { method: 'merge' })).toMatchObject({ status: 'merged', sha: undefined })
    expect(calls.map(call => call.url)).toEqual([`${baseUrl}/api/v3/repos/root/widgets/pulls/2/merge-async`, `${baseUrl}/api/v3/repos/root/widgets/pulls/2/merge`])
  })

  it('verifies and translates the deliveries GitBucket signs', async () => {
    const { forge } = provider()
    const comment = { headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': '75976dd4-ff3a-4d68-9609-0080d3fe330a', 'x-hub-signature-256': 'sha256=411aa9dbca10165f32e2dbb7c5b2e6be1d670ca3263d614a854128912fe145f8' }, body: payloadFixture('gitbucket', 'webhooks/issue-comment-created') }
    const opened = { headers: { 'x-github-event': 'issues', 'x-github-delivery': '4ebd5a0b-2dd4-437d-9381-45e0b350634b', 'x-hub-signature-256': 'sha256=d2f7d175335ce5796da0521179b90749649e2cec40d335afcad4372e5f9a1c76' }, body: payloadFixture('gitbucket', 'webhooks/issues-opened') }

    expect(await forge.webhooks.verify(comment)).toBe(true)
    expect(await forge.webhooks.verify({ ...comment, secret: 'wrong' })).toBe(false)
    expect(await forge.webhooks.ingest(comment)).toEqual([expect.objectContaining({ forge: 'gitbucket', kind: 'comment', action: 'created', thread: expect.objectContaining({ forge: 'gitbucket', number: '1' }) })])
    expect(await forge.webhooks.ingest(opened)).toEqual([expect.objectContaining({ kind: 'state_change', action: 'opened', thread: expect.objectContaining({ number: '4' }) })])
  })

  it('edits a pull request through its own endpoint, but not its labels', async () => {
    const urls: string[] = []
    const forge = gitbucket({ baseUrl, auth: { type: 'token', token: 't' }, fetch: async (url, init) => {
      urls.push(`${init?.method} ${url}`)
      return Response.json({ number: 2, title: 'Handle an empty config', state: 'closed', head: { sha: head, ref: 'fix-empty-config' }, base: { ref: 'main' } })
    } })

    await forge.threads.update(pull, { title: 'Handle an empty config', state: 'closed' })
    await expect(forge.threads.update(pull, { title: 'Handle an empty config', labels: ['bug'] })).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.threads.close(issue)).rejects.toThrow(UnsupportedOperationError)

    expect(urls).toEqual([`PATCH ${baseUrl}/api/v3/repos/root/widgets/pulls/2`])
  })

  it('reports what GitBucket lacks, and rejects it without a request', async () => {
    const urls: string[] = []
    const forge = gitbucket({ baseUrl, auth: { type: 'token', token: 't' }, fetch: async (url) => {
      urls.push(url)
      return Response.json({})
    } })

    expect(forge.support('threads.react')).toBe('not_applicable')
    expect(forge.support('ci.runs')).toBe('not_applicable')
    expect(forge.support('threads.get', 'discussion')).toBe('not_applicable')
    expect(forge.support('threads.files')).toBe(false)
    expect(forge.support('search.threads')).toBe(false)
    await expect(forge.threads.files(pull).page()).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.contents.compare(repo, 'main', 'next')).rejects.toThrow('gitbucket does not support contents.compare')
    expect(urls).toEqual([])
  })

  it('links to GitBucket pages and reads its URLs back', () => {
    const { forge } = provider()
    const release = { ...origin, repo, id: 'v1.0.0', tag: 'v1.0.0' }

    expect(forge.urlFor({ release })).toBe(`${baseUrl}/root/widgets/releases/v1.0.0`)
    expect(forge.urlFor({ comment: { ...origin, thread: issue, id: '19' } })).toBe(`${baseUrl}/root/widgets/issues/1#comment-19`)
    expect(forge.urlFor({ repo, section: 'forks' })).toBe(`${baseUrl}/root/widgets/network/members`)
    expect(forge.urlFor({ repo, section: 'stargazers' })).toBeUndefined()
    expect(forge.parseUrl(`${baseUrl}/root/widgets/releases/v1.0.0`)?.release).toEqual(release)
    expect(forge.parseUrl(`${baseUrl}/root/widgets/pull/2`)?.thread).toEqual(pull)
    expect(forge.parseUrl(`${baseUrl}/git/root/widgets.git`)?.repo).toEqual(repo)
  })
})
