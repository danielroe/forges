import type { ResolvedThreadRef } from '../../src/model.ts'
import { describe, expect, it } from 'vitest'
import { cursorOrigin } from '../../src/cursor-origin/index.ts'
import { UnsupportedOperationError } from '../../src/errors.ts'
import { contracts, WEBHOOK_SECRET } from '../contract/providers.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const repo = { forge: 'cursor-origin', instance: 'origin.cursor.com', owner: 'acme', name: 'widgets' } as const
const pull: ResolvedThreadRef = { forge: 'cursor-origin', instance: 'origin.cursor.com', repo, kind: 'pull_request', number: '12' }

describe('cursor origin without credentials', () => {
  it('verifies and translates webhook deliveries, and supports nothing else', async () => {
    const { webhook } = contracts.find(contract => contract.name === 'cursor-origin')!
    const { fetch, calls } = fixtureFetch('cursor-origin')
    const forge = cursorOrigin({ fetch }).create()
    const delivery = { headers: webhook.headers(await webhook.sign(webhook.body, WEBHOOK_SECRET)), body: webhook.body }

    expect(await forge.webhooks.ingest(delivery)).toHaveLength(1)
    expect(calls.map(call => call.authorization)).toEqual([undefined])
    expect(forge.can('repos.get')).toBe(false)
    await expect(forge.repos.get(repo)).rejects.toThrow(UnsupportedOperationError)
  })
})

describe('cursor origin merge', () => {
  it('rejects a merge commit message before sending anything', async () => {
    const { fetch, calls } = fixtureFetch('cursor-origin')
    const instance = cursorOrigin({ auth: { type: 'token', token: 't' }, fetch }).create()

    await expect(instance.threads.approveAndMerge(pull, { method: 'squash', message: 'Ship it' })).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })
})
