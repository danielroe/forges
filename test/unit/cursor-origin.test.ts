import type { ResolvedThreadRef } from '../../src/model.ts'
import { describe, expect, it } from 'vitest'
import { cursorOrigin } from '../../src/cursor-origin/index.ts'
import { UnsupportedOperationError } from '../../src/errors.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const repo = { forge: 'cursor-origin', instance: 'origin.cursor.com', owner: 'acme', name: 'widgets' } as const
const pull: ResolvedThreadRef = { forge: 'cursor-origin', instance: 'origin.cursor.com', repo, kind: 'pull_request', number: '12' }

describe('cursor origin merge', () => {
  it('rejects a merge commit message before sending anything', async () => {
    const { fetch, calls } = fixtureFetch('cursor-origin')
    const instance = cursorOrigin({ auth: { type: 'token', token: 't' }, fetch }).create()

    await expect(instance.threads.approveAndMerge(pull, { method: 'squash', message: 'Ship it' })).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })
})
