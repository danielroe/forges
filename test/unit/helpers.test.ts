import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fake } from '../../src/fake/index.ts'
import { commentMarker, hasCommentMarker, upsertComment, waitForChecks, withCommentMarker } from '../../src/helpers.ts'

const seed = {
  repos: [{ repo: 'acme/widgets' }],
  threads: [{ repo: 'acme/widgets', kind: 'issue' as const, title: 'Crash on start' }],
}
const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }

describe('comment markers', () => {
  it('refuses a comment key that would end the hidden marker', () => {
    expect(() => commentMarker('a-->b')).toThrow(TypeError)
    expect(() => commentMarker('a--!>b')).toThrow(TypeError)
    expect(commentMarker('release')).toBe('<!-- forges:key=release -->')
  })

  it('adds the marker of a key to a body once', () => {
    const marked = withCommentMarker('Deployed', 'mutation-1')

    expect(marked).toBe(`Deployed\n\n${commentMarker('mutation-1')}`)
    expect(withCommentMarker(marked, 'mutation-1')).toBe(marked)
    expect(hasCommentMarker(marked, 'mutation-1')).toBe(true)
    expect(hasCommentMarker(marked, 'mutation-2')).toBe(false)
  })
})

describe('upsertComment', () => {
  it('creates a keyed comment once and edits it on the next run', async () => {
    const forge = fake({ seed })
    const [issue] = (await forge.threads.list(repo, { kind: 'issue' }).page()).items

    const first = await upsertComment(forge, issue!.ref, { key: 'coverage', body: 'Coverage: 81%' })
    const second = await upsertComment(forge, issue!.ref, { key: 'coverage', body: 'Coverage: 84%' })
    const other = await upsertComment(forge, issue!.ref, { key: 'size', body: 'Bundle: 12kb' })
    const comments = await Array.fromAsync(forge.threads.comments(issue!.ref))

    expect([first.created, second.created, other.created]).toEqual([true, false, true])
    expect(first.comment.ref.id).toBe(second.comment.ref.id)
    expect(second.comment.body).toContain('Coverage: 84%')
    expect(second.comment.body).toContain(commentMarker('coverage'))
    expect(comments).toHaveLength(2)
  })

  it('upserts a keyed comment on a commit', async () => {
    const forge = fake({ seed })
    const commit = { forge: 'fake', instance: 'fake.test', repo, sha: 'abc1234def' }
    forge.store.repos.get('acme/widgets')!.commitComments.set(commit.sha, [
      { ref: { forge: 'fake', instance: 'fake.test', commit, id: 'old' }, body: `Deploying\n\n${commentMarker('deploy')}`, createdAt: new Date('2026-02-01T00:00:00Z'), raw: {} },
    ])

    const recent = await upsertComment(forge, commit, { key: 'deploy', body: 'Deployed', since: new Date('2026-03-01T00:00:00Z') })
    const edited = await upsertComment(forge, commit, { key: 'deploy', body: 'Deployed again' })
    const comments = await Array.fromAsync(forge.commits.comments(commit))

    expect(recent.created).toBe(true)
    expect(recent.comment.ref.commit).toEqual(commit)
    expect(edited).toMatchObject({ created: false, comment: { ref: { id: recent.comment.ref.id }, body: `Deployed again\n\n${commentMarker('deploy')}` } })
    expect(comments).toHaveLength(2)
  })

  describe('retrying a keyed comment', () => {
    const firstAttemptAt = new Date('2026-03-01T12:00:00Z')

    function seeded() {
      const forge = fake({ seed })
      const state = forge.store.repos.get('acme/widgets')!.threads.get('1')!
      const ref = state.thread.ref
      const comment = (id: string, body: string, createdAt: Date) => ({ ref: { forge: 'fake', instance: 'fake.test', thread: ref, id }, body, createdAt, raw: {} })
      return { forge, state, ref, comment }
    }

    it('passes since to the listing it reads', async () => {
      const { forge, ref } = seeded()
      const comments = vi.spyOn(forge.threads, 'comments')

      await upsertComment(forge, ref, { key: 'mutation-1', body: 'Deployed', since: firstAttemptAt })

      expect(comments).toHaveBeenCalledWith(ref, expect.objectContaining({ since: firstAttemptAt }))
    })

    it('finds the comment that a first attempt left behind instead of posting another', async () => {
      const { forge, state, ref, comment } = seeded()
      state.comments.push(comment('1-1', `Deployed\r\n\r\n${commentMarker('mutation-1')}\n`, new Date('2026-03-01T12:00:03Z')))
      const updateComment = vi.spyOn(forge.threads, 'updateComment')

      const retry = await upsertComment(forge, ref, { key: 'mutation-1', body: 'Deployed', since: firstAttemptAt })

      expect(retry).toMatchObject({ created: false, comment: { ref: { id: '1-1' } } })
      expect(state.comments).toHaveLength(1)
      expect(updateComment).not.toHaveBeenCalled()
    })

    it('edits the comment that an earlier call left behind when the body changed', async () => {
      const { forge, state, ref, comment } = seeded()
      state.comments.push(comment('1-1', `Deploying\n\n${commentMarker('mutation-1')}`, new Date('2026-03-01T12:00:03Z')))

      const retry = await upsertComment(forge, ref, { key: 'mutation-1', body: 'Deployed', since: firstAttemptAt })

      expect(retry).toMatchObject({ created: false, comment: { body: `Deployed\n\n${commentMarker('mutation-1')}` } })
      expect(state.comments[0]!.body).toBe(`Deployed\n\n${commentMarker('mutation-1')}`)
    })

    it('posts a new comment when the only one with the key predates since', async () => {
      const { forge, state, ref, comment } = seeded()
      state.comments.push(comment('1-1', `Deployed\n\n${commentMarker('mutation-1')}`, new Date('2026-02-01T00:00:00Z')))

      const retry = await upsertComment(forge, ref, { key: 'mutation-1', body: 'Deployed', since: firstAttemptAt })

      expect(retry.created).toBe(true)
      expect(state.comments).toHaveLength(2)
    })
  })
})

describe('waitForChecks', () => {
  const sha = 'abc1234def'

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads again until every check has finished', async () => {
    const forge = fake({ seed })
    await forge.checks.report(repo, sha, { name: 'test', state: 'pending' })
    await forge.checks.report(repo, sha, { name: 'lint', state: 'success' })
    const list = vi.spyOn(forge.checks, 'list')

    const wait = waitForChecks(forge, { repo, sha, interval: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    await forge.checks.report(repo, sha, { name: 'test', state: 'failure' })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await wait

    expect(list).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ timedOut: false, state: 'failure', pending: [] })
    expect(result.checks.map(check => [check.name, check.state])).toEqual([['lint', 'success'], ['test', 'failure']])
  })

  it('keeps waiting while the commit has no checks yet', async () => {
    const forge = fake({ seed })

    const wait = waitForChecks(forge, { repo, sha, interval: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    await forge.checks.report(repo, sha, { name: 'build', state: 'success' })
    await vi.advanceTimersByTimeAsync(1000)

    await expect(wait).resolves.toMatchObject({ timedOut: false, state: 'success', checks: [{ name: 'build' }] })
  })

  it('resolves with the pending checks when the timeout runs out', async () => {
    const forge = fake({ seed })
    await forge.checks.report(repo, sha, { name: 'deploy', state: 'pending' })
    const list = vi.spyOn(forge.checks, 'list')

    const wait = waitForChecks(forge, { repo, sha, timeout: 2500, interval: 1000 })
    await vi.advanceTimersByTimeAsync(2500)
    const result = await wait

    expect(list).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({ timedOut: true, state: 'pending', pending: [{ name: 'deploy' }] })
  })

  it('waits past the default timeout when the timeout is infinite', async () => {
    const forge = fake({ seed })
    await forge.checks.report(repo, sha, { name: 'release', state: 'pending' })
    const list = vi.spyOn(forge.checks, 'list')

    const wait = waitForChecks(forge, { repo, sha, timeout: Infinity })
    await vi.advanceTimersByTimeAsync(1_800_000)
    await forge.checks.report(repo, sha, { name: 'release', state: 'success' })
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(wait).resolves.toMatchObject({ timedOut: false, state: 'success' })
    expect(list).toHaveBeenCalledTimes(122)
  })

  it('refuses a timeout or an interval that would poll without a pause', async () => {
    const forge = fake({ seed })
    const list = vi.spyOn(forge.checks, 'list')

    for (const timeout of [Number.NaN, -1]) {
      await expect(waitForChecks(forge, { repo, sha, timeout })).rejects.toThrow('`timeout` must be zero or more milliseconds')
    }
    for (const interval of [Number.NaN, 0, -1, 3e9, Infinity]) {
      await expect(waitForChecks(forge, { repo, sha, interval })).rejects.toThrow('`interval` must be a positive number of milliseconds')
    }
    expect(list).not.toHaveBeenCalled()
  })

  it('rejects with the reason of an aborted signal while it sleeps', async () => {
    const forge = fake({ seed })
    await forge.checks.report(repo, sha, { name: 'test', state: 'pending' })
    const controller = new AbortController()
    const reason = new Error('Cancelled')

    const wait = waitForChecks(forge, { repo, sha, signal: controller.signal })
    const settled = expect(wait).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(5000)
    controller.abort(reason)

    await settled
  })
})
