import { describe, expect, it, vi } from 'vitest'
import { fake } from '../../src/fake/index.ts'
import { commentMarker, hasCommentMarker, upsertComment, withCommentMarker } from '../../src/helpers.ts'

const seed = {
  repos: [{ repo: 'acme/widgets' }],
  threads: [{ repo: 'acme/widgets', kind: 'issue' as const, title: 'Crash on start' }],
}

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
    const repo = { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }
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
    const commit = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, sha: 'abc1234def' }
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
