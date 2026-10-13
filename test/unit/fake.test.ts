import { describe, expect, it } from 'vitest'
import { BranchMovedError, ContentNotTextError, NotFoundError, UnsupportedOperationError } from '../../src/errors.ts'
import { fake } from '../../src/fake/index.ts'
import { commentMarker } from '../../src/model.ts'
import { signDelivery } from '../../src/testing/index.ts'

const seed = {
  repos: [{ repo: 'acme/widgets', labels: ['bug', 'triage'] }],
  threads: [
    { repo: 'acme/widgets', kind: 'issue' as const, title: 'Crash on start', labels: ['triage'] },
    { repo: 'acme/widgets', kind: 'pull_request' as const, title: 'Fix crash', checks: [{ name: 'test', state: 'failure' as const }, { name: 'lint', state: 'success' as const }] },
  ],
  notifications: [{ repo: 'acme/widgets', number: 1, reason: 'mention' as const }],
}

describe('fake forge', () => {
  it('holds state across a write flow and records each write as an event', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const repo = (await forge.repos.get({ forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' })).ref
    const [issue] = (await forge.threads.listPage(repo, { kind: 'issue' })).items

    await forge.threads.comment(issue!.ref, 'Looking into it')
    await forge.threads.setLabels(issue!.ref, ['bug'])
    await forge.threads.close(issue!.ref, { reason: 'completed' })
    const after = await forge.threads.get(issue!.ref)
    const events = await Array.fromAsync(forge.threads.events(issue!.ref))

    expect(after).toMatchObject({ state: 'closed', stateReason: 'completed', commentCount: 1, labels: [{ name: 'bug' }] })
    expect(events.map(event => [event.kind, event.action])).toEqual([
      ['comment', 'created'],
      ['label', 'labelled'],
      ['label', 'unlabelled'],
      ['state_change', 'closed'],
    ])
    expect(factory.store.events).toHaveLength(4)
  })

  it('closes, relabels and reassigns a thread in one update, with an event for each change', async () => {
    const forge = fake({ seed }).create()
    const repo = (await forge.repos.get({ forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' })).ref
    const [issue] = (await forge.threads.listPage(repo, { kind: 'issue' })).items

    const updated = await forge.threads.update(issue!.ref, { state: 'closed', labels: ['bug'], assignees: ['octocat'] })
    const events = await Array.fromAsync(forge.threads.events(issue!.ref))

    expect(updated).toMatchObject({ title: 'Crash on start', state: 'closed', labels: [{ name: 'bug' }], assignees: [{ login: 'octocat' }] })
    expect(events.map(event => [event.kind, event.action])).toEqual([
      ['state_change', 'closed'],
      ['label', 'labelled'],
      ['label', 'unlabelled'],
      ['assignment', 'assigned'],
    ])
  })

  it('creates threads, merges pulls and reports checks', async () => {
    const forge = fake({ seed }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const created = await forge.threads.create(repo, { kind: 'issue', title: 'New' })
    const pull = { ...repo, repo, kind: 'pull_request' as const, number: '2' }

    await forge.threads.approveAndMerge(pull)

    expect(created.ref.number).toBe('3')
    expect((await forge.threads.get(pull)).state).toBe('merged')
    expect((await forge.threads.get(pull)).checks).toMatchObject({ state: 'failure', total: 2, failed: 1 })
    expect((await forge.threads.checks(pull)).items.map(check => check.name)).toEqual(['test', 'lint'])
  })

  it('reads one comment, review and CI job by walking their listings', async () => {
    const forge = fake({ seed: { ...seed, runs: [{ repo: 'acme/widgets', name: 'ci', jobs: [{ name: 'test' }, { name: 'lint' }] }] } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const pull = { forge: 'fake', instance: 'fake.test', repo, kind: 'pull_request' as const, number: '2' }
    const comment = await forge.threads.comment(pull, 'Looks good')
    const review = await forge.threads.createReview(pull, { event: 'approve' })
    const [run] = (await forge.ci.runsPage(repo)).items
    const [, job] = (await forge.ci.jobsPage(run!.ref)).items

    expect(forge.support('threads.getComment', 'pull_request')).toBe('emulated')
    expect(forge.support('threads.getReview')).toBe('emulated')
    expect(forge.support('ci.job')).toBe('emulated')
    expect((await forge.threads.getComment(comment.ref)).body).toBe('Looks good')
    expect((await forge.threads.getReview(review.ref)).state).toBe('approved')
    expect((await forge.ci.job(job!.ref)).name).toBe('lint')
    await expect(forge.threads.getComment({ ...comment.ref, id: 'missing' })).rejects.toThrow(NotFoundError)
    await expect(forge.ci.job({ forge: 'fake', instance: 'fake.test', repo, id: job!.ref.id })).rejects.toThrow(UnsupportedOperationError)
  })

  it('rejects verbs configured as unsupported, per kind where asked', async () => {
    const forge = fake({ seed, support: { 'threads.close': { issue: true }, 'notifications.markDone': false } }).create()
    const pull = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, kind: 'pull_request' as const, number: '2' }

    expect(forge.can('threads.close', 'issue')).toBe(true)
    expect(forge.can('threads.close', 'pull_request')).toBe(false)
    expect(forge.can('notifications.markDone')).toBe(false)
    await expect(forge.threads.close(pull)).rejects.toThrow(UnsupportedOperationError)
    await expect(forge.notifications.markDone({ forge: 'fake', instance: 'fake.test', id: '1' })).rejects.toThrow(UnsupportedOperationError)
  })

  it('rejects reads of missing records with NotFoundError', async () => {
    const forge = fake({ seed }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'missing' }

    await expect(forge.repos.get(repo)).rejects.toThrow(NotFoundError)
    await expect(forge.threads.get({ forge: 'fake', instance: 'fake.test', repo: { ...repo, name: 'widgets' }, kind: 'issue', number: '99' })).rejects.toThrow(NotFoundError)
  })

  it('streams writes to subscribers as they happen', async () => {
    const forge = fake({ seed }).create()
    const controller = new AbortController()
    const issue = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, kind: 'issue' as const, number: '1' }
    const iterator = forge.sources.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    const received = iterator.next().then(result => result.value?.event)
    await forge.threads.reopen(issue)

    expect(await received).toMatchObject({ kind: 'state_change', action: 'reopened' })
    controller.abort()
  })

  it('ingests signed deliveries of normalised events', async () => {
    const forge = fake({ webhookSecret: 's3cret' }).create()
    const body = JSON.stringify({ kind: 'comment', action: 'created', summary: 'hi', occurredAt: '2026-01-01T00:00:00Z', payload: {} })
    const [event] = await forge.webhooks.ingest({ headers: await signDelivery('fake', body, 's3cret'), body })

    expect(event).toMatchObject({ forge: 'fake', kind: 'comment', action: 'created', source: 'webhook' })
    expect(event!.occurredAt).toBeInstanceOf(Date)
    await expect(forge.webhooks.ingest({ headers: await signDelivery('fake', body, 'wrong'), body })).rejects.toThrow()
  })

  it('tracks notification read and done state', async () => {
    const forge = fake({ seed }).create()
    const [notification] = (await forge.notifications.listPage()).items

    expect(await forge.notifications.unreadCount()).toBe(1)
    await forge.notifications.markRead(notification!.ref)
    expect(await forge.notifications.unreadCount()).toBe(0)
    await forge.notifications.markDone(notification!.ref)
    expect((await forge.notifications.listPage({ all: true })).items).toEqual([])
  })
  it('creates a keyed comment once and edits it on the next run', async () => {
    const forge = fake({ seed }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const [issue] = (await forge.threads.listPage(repo, { kind: 'issue' })).items

    const first = await forge.threads.upsertComment(issue!.ref, { key: 'coverage', body: 'Coverage: 81%' })
    const second = await forge.threads.upsertComment(issue!.ref, { key: 'coverage', body: 'Coverage: 84%' })
    const other = await forge.threads.upsertComment(issue!.ref, { key: 'size', body: 'Bundle: 12kb' })
    const comments = await Array.fromAsync(forge.threads.comments(issue!.ref))

    expect([first.created, second.created, other.created]).toEqual([true, false, true])
    expect(first.comment.ref.id).toBe(second.comment.ref.id)
    expect(second.comment.body).toContain('Coverage: 84%')
    expect(second.comment.body).toContain(commentMarker('coverage'))
    expect(comments).toHaveLength(2)
  })

  it('lists the reactions a write left on a thread and on a comment', async () => {
    const forge = fake({ seed, viewer: 'octocat' }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' } as const
    const [issue] = (await forge.threads.listPage(repo, { kind: 'issue' })).items
    const comment = await forge.threads.comment(issue!.ref, 'Looking into it')

    await forge.threads.react(issue!.ref, '+1')
    await forge.threads.react(issue!.ref, 'heart')
    await forge.threads.react(comment.ref, 'rocket')
    await forge.threads.unreact(issue!.ref, '+1')
    const onThread = await Array.fromAsync(forge.threads.reactions(issue!.ref))
    const onComment = await Array.fromAsync(forge.threads.reactions(comment.ref))

    expect(onThread.map(reaction => [reaction.content, reaction.actor.login])).toEqual([['heart', 'octocat']])
    expect(onComment.map(reaction => reaction.contentRaw)).toEqual(['rocket'])
  })

  it('adds and removes labels without touching the rest', async () => {
    const forge = fake({ seed }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const [issue] = (await forge.threads.listPage(repo, { kind: 'issue' })).items

    await forge.threads.addLabels(issue!.ref, ['bug'])
    await forge.threads.removeLabels(issue!.ref, ['triage'])

    expect((await forge.threads.get(issue!.ref)).labels.map(item => item.name)).toEqual(['bug'])
  })
  it('creates a pending review, submits it and resolves its conversation', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const [pull] = (await forge.threads.listPage(repo, { kind: 'pull_request' })).items

    const pending = await forge.threads.createReview(pull!.ref, { body: 'one nit', comments: [{ path: 'src/index.ts', line: 3, body: 'rename' }] })
    expect(pending.state).toBe('pending')

    const submitted = await forge.threads.submitReview(pending.ref, 'request_changes')
    const comment = (submitted.comments as Exclude<typeof submitted.comments, false>)[0]!
    await forge.threads.resolveReviewThread(pull!.ref, comment.thread!.id)
    const reviews = await Array.fromAsync(forge.threads.reviews(pull!.ref))

    expect(submitted.state).toBe('changes_requested')
    expect(reviews).toHaveLength(1)
    expect((reviews[0]!.comments as Exclude<typeof submitted.comments, false>)[0]!.thread).toEqual({ id: comment.thread!.id, resolved: true })
    expect(factory.store.events.at(-1)!.detail).toMatchObject({ type: 'review', state: 'changes_requested' })
  })
  it('replies to a review comment inside its conversation', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const [pull] = (await forge.threads.listPage(repo, { kind: 'pull_request' })).items

    const review = await forge.threads.createReview(pull!.ref, { event: 'comment', comments: [{ path: 'src/index.ts', line: 3, body: 'rename' }] })
    const comment = (review.comments as Exclude<typeof review.comments, false>)[0]!
    const reply = await forge.threads.replyToReviewComment(pull!.ref, comment, 'renamed')
    const second = await forge.threads.replyToReviewComment(pull!.ref, reply, 'and the tests')
    await forge.threads.resolveReviewThread(pull!.ref, comment.thread!.id)
    const [read] = await Array.fromAsync(forge.threads.reviews(pull!.ref))

    expect(reply).toMatchObject({ body: 'renamed', path: 'src/index.ts', line: 3, inReplyTo: comment.ref!.id, thread: comment.thread })
    expect(second.inReplyTo).toBe(comment.ref!.id)
    expect(factory.store.events.at(-1)!.detail).toMatchObject({ type: 'review_comment', comment: second.ref, body: 'and the tests', path: 'src/index.ts' })
    expect((read!.comments as Exclude<typeof review.comments, false>).map(item => item.thread?.resolved)).toEqual([true, true, true])
  })
  it('reports a commit status, lists it back and reads a job log', async () => {
    const forge = fake({ seed: { ...seed, runs: [{ repo: 'acme/widgets', name: 'ci', state: 'failure' as const, branch: 'main', jobs: [{ name: 'lint', state: 'failure' as const, log: 'lint failed\n' }] }] } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

    await forge.checks.report(repo, 'abc123', { name: 'coverage', state: 'success', description: '84%' })
    const { items: checks } = await forge.checks.list(repo, 'abc123')
    const [run] = (await forge.ci.runsPage(repo, { branch: 'main' })).items
    const jobs = await Array.fromAsync(forge.ci.jobs(run!.ref))
    const log = await new Response(await forge.ci.log(jobs[0]!.ref)).text()

    expect(checks).toMatchObject([{ name: 'coverage', state: 'success', ref: { type: 'status' } }])
    expect(run).toMatchObject({ name: 'ci', state: 'failure' })
    expect(log).toBe('lint failed\n')
  })
  it('serves seeded files, commits and pull request diffs', async () => {
    const forge = fake({
      seed: {
        repos: [{ repo: 'acme/widgets' }],
        files: [
          { repo: 'acme/widgets', path: 'README.md', content: '# widgets\n' },
          { repo: 'acme/widgets', path: 'src/index.ts', content: 'export default 1\n' },
          { repo: 'acme/widgets', path: 'assets/icon.png', content: new Uint8Array([137, 80, 78, 71]) },
        ],
        commits: [{ repo: 'acme/widgets', sha: 'a'.repeat(40), message: 'feat: add widgets', files: [{ path: 'src/index.ts', additions: 3 }] }],
        threads: [{ repo: 'acme/widgets', kind: 'pull_request' as const, number: 7, title: 'Add widgets', commits: ['a'.repeat(40)], files: [{ path: 'src/index.ts', status: 'added' as const, additions: 3, patch: '@@ -0,0 +1 @@' }] }],
      },
    }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const pull = { forge: 'fake', instance: 'fake.test', repo, kind: 'pull_request' as const, number: '7' }

    const readme = await forge.contents.file(repo, 'README.md', { as: 'text' })
    const icon = await forge.contents.file(repo, 'assets/icon.png')
    const tree = await Array.fromAsync(forge.contents.tree(repo))
    const commit = await forge.contents.commit(repo, 'a'.repeat(40))
    const files = await Array.fromAsync(forge.threads.files(pull))
    const commits = await Array.fromAsync(forge.threads.commits(pull))

    expect(readme.content).toBe('# widgets\n')
    expect(icon.encoding).toBe('binary')
    expect(tree.map(entry => entry.path)).toEqual(['README.md', 'assets', 'src'])
    expect(commit.stats).toEqual({ additions: 3, deletions: 0 })
    expect(files[0]).toMatchObject({ path: 'src/index.ts', status: 'added', patch: '@@ -0,0 +1 @@' })
    expect(commits[0]!.sha).toBe('a'.repeat(40))
  })
  it('commits files to a new branch without changing the default one', async () => {
    const forge = fake({
      seed: {
        repos: [{ repo: 'acme/widgets' }],
        files: [
          { repo: 'acme/widgets', path: 'README.md', content: '# widgets\n' },
          { repo: 'acme/widgets', path: 'OLD.md', content: 'old\n' },
        ],
        commits: [{ repo: 'acme/widgets', sha: 'a'.repeat(40), message: 'feat: add widgets' }],
      },
    }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

    const first = await forge.contents.commitFiles(repo, {
      branch: 'docs',
      createFrom: 'main',
      message: 'docs: update readme',
      changes: [{ path: '/README.md', content: '# Widgets\n' }, { path: 'OLD.md', content: null }, { path: 'icon.png', content: new Uint8Array([137, 80]) }],
    })
    const second = await forge.contents.commitFiles(repo, { branch: 'docs', expectedHead: first.sha, message: 'docs: add guide', changes: [{ path: 'GUIDE.md', content: 'guide\n' }], author: { name: 'Ada', email: 'ada@example.com' } })
    const tree = await Array.fromAsync(forge.contents.tree(repo, { ref: 'docs' }))
    const branches = await Array.fromAsync(forge.contents.branches(repo))

    expect(first).toMatchObject({ parents: ['a'.repeat(40)], files: [{ path: 'README.md', status: 'modified' }, { path: 'OLD.md', status: 'removed' }, { path: 'icon.png', status: 'added' }] })
    expect(second).toMatchObject({ parents: [first.sha], author: { name: 'Ada', email: 'ada@example.com' } })
    expect((await forge.contents.file(repo, 'README.md', { ref: 'docs', as: 'text' })).content).toBe('# Widgets\n')
    expect((await forge.contents.file(repo, 'README.md', { as: 'text' })).content).toBe('# widgets\n')
    expect(tree.map(entry => entry.path)).toEqual(['GUIDE.md', 'README.md', 'icon.png'])
    expect(branches.map(branch => [branch.name, branch.sha])).toEqual([['main', 'a'.repeat(40)], ['docs', second.sha]])
    expect(await forge.contents.resolveRef(repo, 'docs')).toBe(second.sha)
    await expect(forge.contents.commitFiles(repo, { branch: 'docs', expectedHead: first.sha, message: 'stale', changes: [{ path: 'GUIDE.md', content: '' }] })).rejects.toThrow(BranchMovedError)
    await expect(forge.contents.commitFiles(repo, { branch: 'docs', message: 'missing', changes: [{ path: 'OLD.md', content: null }] })).rejects.toThrow(NotFoundError)
    await expect(forge.contents.commitFiles(repo, { branch: 'main', message: 'twice', changes: [{ path: 'a', content: '' }, { path: '/a', content: '' }] })).rejects.toThrow(TypeError)
    await expect(forge.contents.commitFiles(repo, { branch: 'new', createFrom: 'main', expectedHead: first.sha, message: 'both', changes: [{ path: 'a', content: '' }] })).rejects.toThrow(TypeError)
    for (const path of ['docs/../README.md', './README.md', 'docs//README.md', 'docs/']) {
      await expect(forge.contents.commitFiles(repo, { branch: 'docs', message: 'path', changes: [{ path, content: '' }] })).rejects.toThrow(TypeError)
    }
    await expect(forge.contents.commitFiles(repo, { branch: 'docs', expectedHead: first.sha.slice(0, 7), message: 'short', changes: [{ path: 'a', content: '' }] })).rejects.toThrow(TypeError)
    await expect(forge.contents.commitFiles(repo, { branch: 'docs', message: ' ', changes: [{ path: 'a', content: '' }] })).rejects.toThrow(TypeError)
  })
  it('searches seeded threads and repositories', async () => {
    const forge = fake({ seed }).create()

    const threads = await Array.fromAsync(forge.search.threads({ text: 'crash', kind: 'issue' }))
    const repos = await Array.fromAsync(forge.search.repos({ text: 'widgets', owner: 'acme' }))

    expect(threads.map(thread => thread.title)).toEqual(['Crash on start'])
    expect(repos.map(repo => repo.ref.name)).toEqual(['widgets'])
  })

  it('lists the repositories of an owner, with its subgroups when asked', async () => {
    const forge = fake({ seed: { repos: [{ repo: 'acme/widgets' }, { repo: 'acme/tools/cli', visibility: 'private' }, { repo: 'other/gadgets' }] } }).create()
    const acme = { forge: 'fake', instance: forge.instance, owner: 'acme', name: '', kind: 'namespace' } as const

    const names = async (query = {}) => (await Array.fromAsync(forge.repos.byOwner(acme, query))).map(repo => `${repo.ref.owner}/${repo.ref.name}`)

    expect(await names()).toEqual(['acme/widgets'])
    expect(await names({ subgroups: true })).toEqual(['acme/widgets', 'acme/tools/cli'])
    expect(await names({ subgroups: true, visibility: 'private' })).toEqual(['acme/tools/cli'])
    expect(await names({ subgroups: true, sort: 'name' })).toEqual(['acme/tools/cli', 'acme/widgets'])
    expect(await names({ subgroups: true, sort: 'name', direction: 'desc' })).toEqual(['acme/widgets', 'acme/tools/cli'])
    expect((await forge.repos.byOwnerPage(acme, { sort: 'created' })).warnings).toContainEqual(expect.objectContaining({ code: 'sort_unsupported' }))
  })

  it('searches the lines of seeded files', async () => {
    const forge = fake({ seed: { files: [{ repo: 'acme/widgets', path: 'src/useFetch.ts', content: 'import { ofetch } from \'ofetch\'\nexport const useFetch = ofetch\n' }] } }).create()

    const matches = await Array.fromAsync(forge.search.code({ text: 'usefetch', owner: 'acme' }))

    expect(matches).toMatchObject([{ repo: { owner: 'acme', name: 'widgets' }, path: 'src/useFetch.ts', fragments: [{ text: 'export const useFetch = ofetch', line: 2 }] }])
  })

  it('serves a release by tag and streams its asset', async () => {
    const forge = fake({
      seed: {
        repos: [{ repo: 'acme/widgets' }],
        releases: [{ repo: 'acme/widgets', tag: 'v1.0.0', assets: [{ name: 'widgets.tgz', content: 'tarball', contentType: 'application/gzip' }] }],
      },
    }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

    const release = await forge.releases.getByTag(repo, 'v1.0.0')
    const asset = release.assets![0]!
    const body = await new Response(await forge.releases.downloadAsset(asset.ref!)).text()

    expect(asset).toMatchObject({ name: 'widgets.tgz', size: 7, contentType: 'application/gzip' })
    expect(body).toBe('tarball')
  })

  it('reads a whole release asset into bytes or text', async () => {
    const forge = fake({
      seed: {
        repos: [{ repo: 'acme/widgets' }],
        releases: [{ repo: 'acme/widgets', tag: 'v1.0.0', assets: [{ name: 'SHA256SUMS', content: 'abc  widgets.tgz' }, { name: 'widgets.tgz', content: new Uint8Array([0x1F, 0x8B, 0xFF]) }] }],
      },
    }).create()
    const release = await forge.releases.getByTag({ forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, 'v1.0.0')
    const [sums, tarball] = release.assets!.map(asset => asset.ref!)

    expect(await forge.releases.downloadAsset(sums!, { as: 'text' })).toBe('abc  widgets.tgz')
    expect(await forge.releases.downloadAsset(tarball!, { as: 'binary' })).toEqual(new Uint8Array([0x1F, 0x8B, 0xFF]))
    await expect(forge.releases.downloadAsset(tarball!, { as: 'text' })).rejects.toThrow(ContentNotTextError)
  })

  it('creates a draft release, publishes it and refuses a second release of its tag', async () => {
    const forge = fake({ seed: { releases: [{ repo: 'acme/widgets', tag: 'v1.0.0' }] } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

    const draft = await forge.releases.create(repo, { tag: 'v1.1.0', body: 'Notes', draft: true })

    expect(draft).toMatchObject({ ref: { id: '2', tag: 'v1.1.0' }, isDraft: true, publishedAt: undefined, author: { login: 'fake-user' } })
    expect((await forge.releases.latest(repo))?.tag).toBe('v1.0.0')
    await forge.releases.update(draft.ref, { draft: false })
    expect(await forge.releases.latest(repo)).toMatchObject({ tag: 'v1.1.0', body: 'Notes', isDraft: false, publishedAt: expect.any(Date) })
    await expect(forge.releases.create(repo, { tag: 'v1.0.0' })).rejects.toThrow('A release tagged v1.0.0 already exists')
    await expect(forge.releases.update(draft.ref, { tag: 'v1.0.0' })).rejects.toThrow('A release tagged v1.0.0 already exists')
  })

  it('refuses a tag, target or draft change on an immutable release but edits its notes', async () => {
    const forge = fake({ seed: { releases: [{ repo: 'acme/widgets', tag: 'v1.0.0', body: 'old', immutable: true }] } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const release = await forge.releases.getByTag(repo, 'v1.0.0')

    expect(release.immutable).toBe(true)
    await expect(forge.releases.update(release.ref, { tag: 'v2.0.0' })).rejects.toMatchObject({ name: 'ForbiddenError', reason: 'immutable_release' })
    await expect(forge.releases.update(release.ref, { target: 'main' })).rejects.toThrow('is immutable')
    await expect(forge.releases.update(release.ref, { draft: true })).rejects.toThrow('is immutable')
    expect((await forge.releases.update(release.ref, { body: 'new' })).body).toBe('new')
  })
})

describe('fake webhook management', () => {
  it('registers, updates and removes a hook without ever returning its secret', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

    const hook = await forge.webhooks.create(repo, { url: 'https://hooks.test/in', events: ['state_change'], secret: 's3cret' })
    await forge.webhooks.update(hook.ref, { active: false })
    const listed = await Array.fromAsync(forge.webhooks.list(repo))
    await forge.webhooks.rotateSecret(hook.ref, 'rotated')
    await forge.webhooks.delete(hook.ref)

    expect(hook).toMatchObject({ url: 'https://hooks.test/in', events: ['state_change'] })
    expect(hook.secret).toBeUndefined()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.active).toBe(false)
    expect(factory.store.webhooks).toEqual([])
  })
})

describe('fake capabilities', () => {
  it.each([false, () => false] as const)('rejects approveAndMerge when explicitly disabled with %s', async (support) => {
    const factory = fake({ seed, support: { 'threads.approveAndMerge': support } })
    const forge = factory.create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const pull = { ...repo, repo, kind: 'pull_request' as const, number: '2' }

    expect(forge.can('threads.approveAndMerge')).toBe(false)
    expect(forge.can('threads.merge')).toBe(true)
    await expect(forge.threads.approveAndMerge(pull)).rejects.toThrow(UnsupportedOperationError)
    expect((await forge.threads.get(pull)).state).toBe('open')
    expect((await forge.threads.reviewsPage(pull)).items).toEqual([])
    expect(factory.store.events).toEqual([])
  })

  it('copies disabled approveAndMerge support and allows an explicit override', async () => {
    const base = fake().create().capabilities
    const capabilities = { ...base, writes: { ...base.writes, approveAndMerge: false as const } }
    const forge = fake({ seed, capabilities }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const pull = { ...repo, repo, kind: 'pull_request' as const, number: '2' }

    expect(forge.can('threads.approveAndMerge')).toBe(false)
    await expect(forge.threads.approveAndMerge(pull)).rejects.toThrow(UnsupportedOperationError)

    const enabled = fake({ seed, capabilities, support: { 'threads.approveAndMerge': true } }).create()
    expect(enabled.can('threads.approveAndMerge')).toBe(true)
    await enabled.threads.approveAndMerge(pull)
    expect((await enabled.threads.get(pull)).state).toBe('merged')
  })

  it.each(['threads.merge', 'threads.createReview'] as const)('requires %s even when approveAndMerge is explicitly enabled', async (verb) => {
    const forge = fake({ seed, support: { [verb]: false, 'threads.approveAndMerge': true } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const pull = { ...repo, repo, kind: 'pull_request' as const, number: '2' }

    expect(forge.can('threads.approveAndMerge')).toBe(false)
    await expect(forge.threads.approveAndMerge(pull)).rejects.toThrow(UnsupportedOperationError)
  })

  it('blocks an explicit approveAndMerge override on a read-only provider', async () => {
    const forge = fake({ seed, readOnly: true, support: { 'threads.approveAndMerge': true } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const pull = { ...repo, repo, kind: 'pull_request' as const, number: '2' }

    expect(forge.can('threads.approveAndMerge')).toBe(false)
    await expect(forge.threads.approveAndMerge(pull)).rejects.toThrow(UnsupportedOperationError)
  })

  it('reports approveAndMerge unsupported when the forge cannot approve', () => {
    const forge = fake({ support: { 'threads.approve': false, 'threads.createReview': false } }).create()

    expect(forge.capabilities.writes.merge).toBe(true)
    expect(forge.capabilities.writes.approveAndMerge).toBe(false)
  })

  it('copies support from a real provider\'s capabilities, with `support` taking precedence', () => {
    const base = fake().create().capabilities
    const source = { ...base, writes: { ...base.writes, addLabels: { issue: false, pull_request: 'experimental', discussion: false, commit: false } } } as typeof base
    const forge = fake({ capabilities: source, support: { 'threads.close': false } }).create()

    expect(forge.capabilities.writes.addLabels).toMatchObject({ issue: false, pull_request: 'experimental' })
    expect(forge.can('threads.close', 'issue')).toBe(false)
  })
})
