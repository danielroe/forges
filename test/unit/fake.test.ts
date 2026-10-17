import { describe, expect, it } from 'vitest'
import { BranchMovedError, ContentNotTextError, NotFoundError, UnresolvedThreadError, UnsupportedOperationError } from '../../src/errors.ts'
import { fake } from '../../src/fake/index.ts'
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

  it('reports the seeded author association of a thread and its comments', async () => {
    const forge = fake({
      seed: { threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Hi', author: 'ada', authorAssociation: 'first_time_contributor', comments: [{ body: 'Thanks', authorAssociation: 'owner' }] }] },
    }).create()
    const ref = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, kind: 'issue', number: '1' } as const

    expect((await forge.threads.get(ref)).authorAssociation).toBe('first_time_contributor')
    expect((await forge.threads.commentsPage(ref)).items.map(comment => comment.authorAssociation)).toEqual(['owner'])
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

    await forge.threads.merge(pull)

    expect(created.ref.number).toBe('3')
    expect((await forge.threads.get(pull)).state).toBe('merged')
    expect((await forge.threads.get(pull)).checks).toMatchObject({ state: 'failure', total: 2, failed: 1 })
    expect((await forge.threads.checks(pull)).items.map(check => check.name)).toEqual(['test', 'lint'])
  })

  it('numbers a new thread after the highest number in its repository', async () => {
    const factory = fake({ seed: { threads: [{ repo: 'acme/widgets', kind: 'issue', number: 2, title: 'Second' }, { repo: 'acme/widgets', kind: 'issue', title: 'Unnumbered' }] } })
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

    await factory.create().threads.create(repo, { kind: 'issue', title: 'New' })

    expect([...factory.store.repos.get('acme/widgets')!.threads.values()].map(({ thread }) => [thread.ref.number, thread.title])).toEqual([['2', 'Second'], ['3', 'Unnumbered'], ['4', 'New']])
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

  it('distinguishes `not_applicable` from `false`, in the report and the message', async () => {
    const forge = fake({ seed, support: { 'notifications.markDone': 'not_applicable', 'notifications.markRead': false, 'contents.commitFiles': 'not_applicable', 'sources.subscribe': 'not_applicable' } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const notification = { forge: 'fake', instance: 'fake.test', id: '1' }

    expect(forge.support('notifications.markDone')).toBe('not_applicable')
    expect(forge.support('notifications.markRead')).toBe(false)
    expect(forge.can('notifications.markDone')).toBe(false)
    expect(forge.can('notifications.markRead')).toBe(false)
    await expect(forge.notifications.markDone(notification)).rejects.toThrow('fake has no notifications.markDone')
    await expect(forge.notifications.markRead(notification)).rejects.toThrow('fake does not support notifications.markRead')
    await expect(forge.contents.commitFiles(repo, { branch: 'main', message: 'm', changes: [{ path: 'a', content: 'b' }] })).rejects.toThrow('fake has no contents.commitFiles')
    await expect(Array.fromAsync(forge.sources.subscribe())).rejects.toThrow('fake has no sources.subscribe')
  })

  it('carries `not_applicable` through per-kind support and composed verbs', async () => {
    const forge = fake({ seed, support: { 'threads.close': { issue: 'not_applicable', pull_request: true }, 'threads.comments': { issue: 'not_applicable', pull_request: true, discussion: true, commit: true } } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    const issue = { forge: 'fake', instance: 'fake.test', repo, kind: 'issue' as const, number: '1' }

    expect(forge.support('threads.close', 'issue')).toBe('not_applicable')
    expect(forge.support('threads.close', 'pull_request')).toBe(true)
    expect(forge.can('threads.close', 'issue')).toBe(false)
    await expect(forge.threads.close(issue)).rejects.toThrow('fake has no threads.close for a issue')

    // `getComment` is emulated from the comment listing, so a listing the forge lacks makes it not applicable.
    expect(forge.support('threads.getComment', 'issue')).toBe('not_applicable')
    expect(forge.support('threads.getComment', 'pull_request')).toBe('emulated')
  })

  it('rejects reads of missing records with NotFoundError', async () => {
    const forge = fake({ seed }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'missing' }

    await expect(forge.repos.get(repo)).rejects.toThrow(NotFoundError)
    await expect(forge.threads.get({ forge: 'fake', instance: 'fake.test', repo: { ...repo, name: 'widgets' }, kind: 'issue', number: '99' })).rejects.toThrow(NotFoundError)
  })

  it('rejects a thread ref without a number with UnresolvedThreadError', async () => {
    const forge = fake({ seed }).create()
    const thread = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, kind: 'issue' as const }

    await expect(forge.threads.get(thread)).rejects.toThrow(UnresolvedThreadError)
    await expect(forge.threads.comment(thread, 'Thanks!')).rejects.toThrow(UnresolvedThreadError)
    await expect(forge.threads.editComment({ forge: 'fake', instance: 'fake.test', thread, id: '1-1' }, 'Edited')).rejects.toThrow(UnresolvedThreadError)
  })

  it('streams writes to subscribers as they happen', async () => {
    const forge = fake({ seed }).create()
    const controller = new AbortController()
    const issue = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, kind: 'issue' as const, number: '1' }
    const iterator = forge.sources.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    const received = iterator.next().then(result => result.value?.event)
    await forge.threads.close(issue)

    expect(await received).toMatchObject({ kind: 'state_change', action: 'closed' })
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
  it('never reuses the id of a deleted comment, so an edit reaches the comment it names', async () => {
    const forge = fake({ seed }).create()
    const issue = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, kind: 'issue' as const, number: '1' }

    const first = await forge.threads.comment(issue, 'First')
    const second = await forge.threads.comment(issue, 'Second')
    await forge.threads.deleteComment(first.ref)
    const third = await forge.threads.comment(issue, 'Third')
    await forge.threads.editComment(third.ref, 'Third, edited')

    expect([first, second, third].map(comment => comment.ref.id)).toEqual(['1-1', '1-2', '1-3'])
    expect((await forge.threads.commentsPage(issue)).items.map(comment => comment.body)).toEqual(['Second', 'Third, edited'])
  })

  describe('listing comments since a time', () => {
    const firstAttemptAt = new Date('2026-03-01T12:00:00Z')

    function seeded() {
      const factory = fake({ seed })
      const forge = factory.create()
      const state = factory.store.repos.get('acme/widgets')!.threads.get('1')!
      const ref = state.thread.ref
      const comment = (id: string, body: string, createdAt: Date) => ({ ref: { forge: 'fake', instance: 'fake.test', thread: ref, id }, body, createdAt, raw: {} })
      return { factory, forge, state, ref, comment }
    }

    it('lists only the comments updated since a time', async () => {
      const { forge, state, ref, comment } = seeded()
      state.comments.push(
        comment('1-1', 'Old', new Date('2026-02-01T00:00:00Z')),
        { ...comment('1-2', 'Edited', new Date('2026-02-01T00:00:00Z')), updatedAt: new Date('2026-03-01T12:00:01Z') },
        comment('1-3', 'New', new Date('2026-03-01T12:00:02Z')),
      )

      const comments = await Array.fromAsync(forge.threads.comments(ref, { since: firstAttemptAt }))

      expect(comments.map(item => item.body)).toEqual(['Edited', 'New'])
    })
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

  it('limits the commits and leaves out the files of a comparison', async () => {
    const commits = ['a', 'b', 'c', 'd'].map(char => ({ repo: 'acme/widgets', sha: char.repeat(40), message: `commit ${char}`, files: [{ path: `${char}.ts` }] }))
    const forge = fake({ seed: { commits } }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

    const full = await forge.contents.compare(repo, 'a'.repeat(40), 'd'.repeat(40))
    const limited = await forge.contents.compare(repo, 'a'.repeat(40), 'd'.repeat(40), { commitLimit: 2, files: false })

    expect(full).toMatchObject({ aheadBy: 3, commits: [{ files: [{ path: 'd.ts' }] }, {}, {}], files: [{}, {}, {}] })
    expect(limited).toMatchObject({ aheadBy: 3, commits: [{ sha: 'd'.repeat(40) }, { sha: 'c'.repeat(40) }], files: [] })
    expect(limited.commits.map(commit => commit.files)).toEqual([undefined, undefined])
  })
})

describe('fake listing filters', () => {
  const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' } as const

  function clocked() {
    let at = Date.parse('2026-01-01T00:00:00Z')
    const factory = fake({
      now: () => new Date(at),
      seed: {
        threads: [
          { repo: 'acme/widgets', kind: 'issue', title: 'Old', author: 'ada', milestone: 'v1' },
          { repo: 'acme/widgets', kind: 'issue', title: 'Mentions bob', body: 'cc @bob', comments: [{ body: 'one', author: 'cy' }, { body: 'two' }] },
          { repo: 'acme/other', kind: 'issue', title: 'Elsewhere' },
        ],
        notifications: [{ repo: 'acme/widgets', number: 1 }, { repo: 'acme/widgets', number: 2 }, { repo: 'acme/other', number: 1 }],
      },
    })
    return { factory, forge: factory.create(), tick: (ms: number) => (at += ms) }
  }

  it('filters threads by mention, involvement, milestone, update and creation time, and sorts them', async () => {
    const { forge, tick } = clocked()
    tick(60_000)
    await forge.threads.comment({ forge: 'fake', instance: 'fake.test', repo, kind: 'issue', number: '1' }, 'bump')
    const titles = async (query: Parameters<typeof forge.threads.listPage>[1]) => (await forge.threads.listPage(repo, query)).items.map(thread => thread.title)

    expect(await titles({ mentions: 'bob' })).toEqual(['Mentions bob'])
    expect(await titles({ involves: 'cy' })).toEqual(['Mentions bob'])
    expect(await titles({ involves: 'ada' })).toEqual(['Old'])
    expect(await titles({ milestone: 'v1' })).toEqual(['Old'])
    expect(await titles({ milestone: 'none' })).toEqual(['Mentions bob'])
    expect(await titles({ since: new Date('2026-01-01T00:00:30Z') })).toEqual(['Old'])
    expect(await titles({ createdAfter: new Date('2026-01-01T00:00:30Z') })).toEqual([])
    expect(await titles({ sort: 'updated' })).toEqual(['Old', 'Mentions bob'])
    expect(await titles({ sort: 'comments', direction: 'asc' })).toEqual(['Old', 'Mentions bob'])
    expect((await forge.threads.listPage(repo, { mentions: 'bob' })).warnings).toBeUndefined()
  })

  it('lists notifications updated since a time, and marks only those of a repository or before a time', async () => {
    const { factory, forge, tick } = clocked()
    factory.store.notifications[1]!.updatedAt = new Date(tick(60_000))
    const unread = async () => (await forge.notifications.listPage()).items.map(item => item.ref.id)

    expect((await forge.notifications.listPage({ since: new Date('2026-01-01T00:00:30Z') })).items.map(item => item.ref.id)).toEqual(['2'])
    await forge.notifications.markAllRead({ before: new Date('2026-01-01T00:00:30Z'), repo })
    expect(await unread()).toEqual(['2', '3'])
    await forge.notifications.markAllDone({ repo })
    expect((await forge.notifications.listPage({ all: true })).items.map(item => item.ref.id)).toEqual(['3'])
  })
})

describe('fake event sources', () => {
  it('reads polled events with source poll and an id of the listing\'s own', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const issue = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, kind: 'issue', number: '1' } as const
    await forge.threads.comment(issue, 'Hello')

    const [timeline] = (await forge.threads.eventsPage(issue)).items
    const [feed] = (await forge.repos.eventsPage(issue.repo)).items
    const [pushed] = factory.store.events

    expect([pushed!.source, timeline!.source, feed!.source]).toEqual(['subscribe', 'poll', 'poll'])
    expect(new Set([pushed!.id, timeline!.id, feed!.id]).size).toBe(3)
    expect(timeline!.detail).toEqual(pushed!.detail)
  })

  it('marks a notification read and keeps it on done where done is emulated', async () => {
    const forge = fake({ seed, support: { 'notifications.markDone': 'emulated' } }).create()
    const [notification] = (await forge.notifications.listPage()).items

    await forge.notifications.markDone(notification!.ref)

    expect((await forge.notifications.listPage()).items).toEqual([])
    expect((await forge.notifications.listPage({ all: true })).items).toMatchObject([{ ref: notification!.ref, unread: false }])
  })
})

describe('fake writes by someone else', () => {
  const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' } as const
  const issue = (number: string) => ({ forge: 'fake', instance: 'fake.test', repo, kind: 'issue', number }) as const

  function forge() {
    const factory = fake({
      seed: {
        threads: [
          { repo: 'acme/widgets', kind: 'issue', title: 'Mine' },
          { repo: 'acme/widgets', kind: 'issue', title: 'Theirs', author: 'ada' },
          { repo: 'acme/widgets', kind: 'pull_request', title: 'Fix', author: 'ada' },
        ],
        notifications: [{ repo: 'acme/widgets', number: 1, unread: false }],
      },
    })
    factory.store.repos.get('acme/widgets')!.threads.get('2')!.subscription = 'none'
    return { factory, viewer: factory.create(), octocat: factory.as('octocat') }
  }

  it('records the write as theirs and marks the viewer\'s notification for the thread unread again', async () => {
    const { factory, viewer, octocat } = forge()

    const comment = await octocat.threads.comment(issue('1'), 'Any news?')

    expect(comment.author?.login).toBe('octocat')
    expect(factory.store.events.at(-1)).toMatchObject({ actor: { login: 'octocat' }, summary: 'octocat commented' })
    const [notification] = (await viewer.notifications.listPage()).items
    expect(notification).toMatchObject({ ref: { id: '1' }, reason: 'author', unread: true, latestComment: { id: comment.ref.id } })
    expect((await viewer.threads.getComment(notification!.latestComment!)).body).toBe('Any news?')
    expect((await octocat.users.me()).login).toBe('octocat')
  })

  it('notifies the viewer of a mention or a review request on a thread the viewer is not subscribed to', async () => {
    const { viewer, octocat } = forge()

    await octocat.threads.comment(issue('2'), 'Nothing to see')
    await octocat.threads.comment(issue('2'), 'cc @fake-user')
    await octocat.threads.requestReview({ ...issue('3'), kind: 'pull_request' }, ['fake-user'])
    await viewer.threads.comment(issue('1'), 'Own comment')

    expect((await viewer.notifications.listPage()).items.map(item => [item.subject.type === 'thread' && item.subject.thread.number, item.reason])).toEqual([['2', 'mention'], ['3', 'review_requested']])
  })

  it('has no notifications or subscriptions of the viewer', async () => {
    const { octocat } = forge()

    expect(octocat.can('notifications.list')).toBe(false)
    expect(octocat.can('threads.subscription', 'issue')).toBe(false)
  })
})

describe('fake security alerts', () => {
  const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' } as const
  const forge = fake({
    seed: {
      securityAlerts: [
        { repo: 'acme/widgets', kind: 'dependency', title: 'Prototype pollution', severity: 'high', package: { ecosystem: 'npm', name: 'lodash', fixedIn: '4.17.21' } },
        { repo: 'acme/widgets', kind: 'secret', title: 'Token in config' },
        { repo: 'acme/widgets', kind: 'dependency', title: 'ReDoS', state: 'fixed' },
        { repo: 'acme/widgets', kind: 'advisory', title: 'Path traversal', severity: 'critical' },
      ],
    },
  }).create()

  it('lists seeded alerts by kind and state, numbering each kind separately', async () => {
    const open = await forge.securityAlerts.listPage(repo)
    const closed = await forge.securityAlerts.listPage(repo, { kind: 'dependency', state: 'closed' })

    expect(open.items.map(alert => [alert.kind, alert.ref.id, alert.severity])).toEqual([['advisory', '1', 'critical'], ['secret', '1', 'medium'], ['dependency', '1', 'high']])
    expect(closed.items).toMatchObject([{ ref: { id: '2', kind: 'dependency' }, title: 'ReDoS', state: 'fixed' }])
    expect(forge.capabilities.securityAlerts).toMatchObject({ dependency: true, code_scanning: true, secret: true, advisory: true })
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
    expect(JSON.stringify([hook, listed])).not.toContain('s3cret')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.active).toBe(false)
    expect(factory.store.webhooks).toEqual([])
  })

  it('allocates a distinct id when a hook is seeded directly into the store', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
    factory.store.webhooks.push({
      ref: { forge: 'fake', instance: 'fake.test', target: repo, id: '1' },
      url: 'https://hooks.test/seeded',
      events: [],
      nativeEvents: [],
      active: true,
      raw: {},
    })

    const hook = await forge.webhooks.create(repo, { url: 'https://hooks.test/new' })
    await forge.webhooks.update(hook.ref, { active: false })

    expect(hook.ref.id).toBe('2')
    expect(factory.store.webhooks.map(hook => [hook.ref.id, hook.url, hook.active])).toEqual([
      ['1', 'https://hooks.test/seeded', true],
      ['2', 'https://hooks.test/new', false],
    ])
  })

  it('never reuses the id of a deleted hook', async () => {
    const forge = fake({ seed }).create()
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

    const first = await forge.webhooks.create(repo, { url: 'https://hooks.test/first' })
    const second = await forge.webhooks.create(repo, { url: 'https://hooks.test/second' })
    await forge.webhooks.delete(first.ref)
    const third = await forge.webhooks.create(repo, { url: 'https://hooks.test/third' })

    expect([first, second, third].map(hook => hook.ref.id)).toEqual(['1', '2', '3'])
  })
})

describe('fake capabilities', () => {
  it('copies support from a real provider\'s capabilities, with `support` taking precedence', () => {
    const base = fake().create().capabilities
    const source = { ...base, writes: { ...base.writes, addLabels: { issue: false, pull_request: 'emulated', discussion: false, commit: false } } } as typeof base
    const forge = fake({ capabilities: source, support: { 'threads.close': false } }).create()

    expect(forge.capabilities.writes.addLabels).toMatchObject({ issue: false, pull_request: 'emulated' })
    expect(forge.can('threads.close', 'issue')).toBe(false)
  })
})

describe('fake write results', () => {
  const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
  const issue = { forge: 'fake', instance: 'fake.test', repo, kind: 'issue' as const, number: '1' }
  const pull = { forge: 'fake', instance: 'fake.test', repo, kind: 'pull_request' as const, number: '2' }

  it('resolves merge with the merge commit that a following read reports', async () => {
    const forge = fake({ seed }).create()

    const result = await forge.threads.merge(pull)

    expect(result).toMatchObject({ status: 'merged', sha: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect((await forge.threads.get(pull)).branches?.mergeCommitSha).toBe(result.sha)
  })

  it('resolves merge with whenChecksPass as queued and leaves the pull request open', async () => {
    const forge = fake({ seed }).create()

    await expect(forge.threads.merge(pull, { method: 'squash', whenChecksPass: true })).resolves.toEqual({ status: 'queued' })

    const thread = await forge.threads.get(pull)
    expect(thread.state).toBe('open')
    expect(thread.branches?.mergeCommitSha).toBeUndefined()
  })

  it('links a pull request to the issues its body closes with a keyword', async () => {
    const forge = fake({ seed: { ...seed, threads: [...seed.threads.map(thread => thread.kind === 'pull_request' ? { ...thread, body: 'Fixes #1, refs #3' } : thread), { repo: 'acme/widgets', kind: 'issue' as const, title: 'Unrelated' }] } }).create()

    expect((await forge.threads.closingIssuesPage(pull)).items.map(thread => thread.ref.number)).toEqual(['1'])
    expect((await Array.fromAsync(forge.threads.closingPullRequests(issue))).map(thread => thread.ref.number)).toEqual(['2'])
    expect((await forge.threads.closingPullRequestsPage({ ...issue, number: '3' })).items).toEqual([])
    await expect(forge.threads.closingIssuesPage(issue)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('locks a conversation, hides a comment and blocks an account in the store', async () => {
    const factory = fake({ seed })
    const forge = factory.create()
    const org = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: '', kind: 'namespace' } as const
    const comment = await forge.threads.comment(issue, 'Buy cheap watches')

    await forge.threads.lock(issue, { reason: 'spam' })
    expect((await forge.threads.get(issue)).locked).toBe(true)
    await forge.threads.unlock(issue)
    expect((await forge.threads.get(issue)).locked).toBe(false)

    await forge.threads.hideComment(comment.ref, 'spam')
    expect(factory.store.repos.get('acme/widgets')!.threads.get('1')!.hidden.get(comment.ref.id)).toBe('spam')
    await forge.threads.unhideComment(comment.ref)
    expect(factory.store.repos.get('acme/widgets')!.threads.get('1')!.hidden.size).toBe(0)
    await expect(forge.threads.hideComment({ ...comment.ref, id: '999' }, 'spam')).rejects.toBeInstanceOf(NotFoundError)
    await forge.threads.hideComment(comment.ref, 'spam')
    await forge.threads.deleteComment(comment.ref)
    expect(factory.store.repos.get('acme/widgets')!.threads.get('1')!.hidden.size).toBe(0)

    await forge.orgs.block(org, 'spammer')
    await forge.users.block('troll')
    expect([...factory.store.blocks].map(([blocker, logins]) => [blocker, [...logins]])).toEqual([['acme', ['spammer']], ['fake-user', ['troll']]])
    await expect(forge.orgs.block(org, 'spammer')).rejects.toMatchObject({ status: 422 })
    await forge.orgs.unblock(org, 'spammer')
    await forge.users.unblock('troll')
    await expect(forge.users.unblock('troll')).rejects.toMatchObject({ status: 422 })
  })

  it('moves the head of a pull request on updateBranch, and refuses an update from a head that has moved', async () => {
    const forge = fake({ seed: { ...seed, threads: seed.threads.map(thread => thread.kind === 'pull_request' ? { ...thread, head: { sha: 'a'.repeat(40) } } : thread) } }).create()

    await expect(forge.threads.updateBranch(pull, { sha: 'a'.repeat(40) })).resolves.toEqual({ status: 'updated' })
    const head = (await forge.threads.get(pull)).branches?.head.sha
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(head).not.toBe('a'.repeat(40))
    await expect(forge.threads.updateBranch(pull, { method: 'rebase', sha: 'a'.repeat(40) })).rejects.toBeInstanceOf(BranchMovedError)
    await expect(forge.threads.updateBranch(issue)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('queues a merge with whenChecksPass while the pull request is blocked', async () => {
    const forge = fake({ seed: { ...seed, threads: seed.threads.map(thread => thread.kind === 'pull_request' ? { ...thread, mergeable: 'blocked' as const } : thread) } }).create()

    await expect(forge.threads.merge(pull, { whenChecksPass: true })).resolves.toEqual({ status: 'queued' })
  })

  it.each([
    ['setLabels', ['bug']],
    ['addLabels', ['bug']],
  ] as const)('resolves %s with the labels that a following read returns', async (verb, labels) => {
    const forge = fake({ seed }).create()

    const result = await forge.threads[verb](issue, [...labels])

    expect(result.map(label => label.name)).toContain('bug')
    expect(result).toEqual((await forge.threads.get(issue)).labels)
  })

  it('resolves removeLabels with the labels that a following read returns', async () => {
    const forge = fake({ seed }).create()
    await forge.threads.setLabels(issue, ['bug', 'triage'])

    const result = await forge.threads.removeLabels(issue, ['bug'])

    expect(result.map(label => label.name)).toEqual(['triage'])
    expect(result).toEqual((await forge.threads.get(issue)).labels)
  })

  it('resolves close and reopen with the thread that a following read returns', async () => {
    const forge = fake({ seed }).create()

    const closed = await forge.threads.close(issue, { reason: 'not_planned' })
    expect(closed).toMatchObject({ state: 'closed', stateReason: 'not_planned' })
    expect(closed).toEqual(await forge.threads.get(issue))

    const reopened = await forge.threads.reopen(issue)
    expect(reopened.state).toBe('open')
    expect(reopened).toEqual(await forge.threads.get(issue))
  })

  it('resolves setAssignees with the assignees that a following read returns', async () => {
    const forge = fake({ seed }).create()

    const result = await forge.threads.setAssignees(issue, ['octocat'])

    expect(result.map(actor => actor.login)).toEqual(['octocat'])
    expect(result).toEqual((await forge.threads.get(issue)).assignees)
  })

  it('resolves approve with the review that a following read returns', async () => {
    const forge = fake({ seed }).create()

    const review = await forge.threads.approve(pull, 'Ship it')

    expect(review).toMatchObject({ state: 'approved', body: 'Ship it' })
    expect(await forge.threads.getReview(review.ref)).toEqual(review)
  })
})
