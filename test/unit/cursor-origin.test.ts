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

describe('cursor origin comments', () => {
  it('encodes the comment id when reading, editing and deleting a comment', async () => {
    const urls: string[] = []
    const instance = cursorOrigin({ auth: { type: 'token', token: 't' }, fetch: async (url, init) => {
      urls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)
      return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: 'c/1', body: 'Looks good' })
    } }).create()
    const ref = { forge: 'cursor-origin', instance: 'origin.cursor.com', thread: pull, id: 'c/1' }

    await instance.threads.getComment(ref)
    await instance.threads.editComment(ref, 'Edited')
    await instance.threads.deleteComment(ref)

    expect(urls.map(url => url.replace(/^(\w+) .*\/pulls\/comments\//, '$1 '))).toEqual(['GET c%2F1', 'PATCH c%2F1', 'DELETE c%2F1'])
  })
})

describe('cursor origin merge', () => {
  it('rejects a merge commit message before sending anything', async () => {
    const { fetch, calls } = fixtureFetch('cursor-origin')
    const instance = cursorOrigin({ auth: { type: 'token', token: 't' }, fetch }).create()

    await expect(instance.threads.approveAndMerge(pull, { method: 'squash', message: 'Ship it' })).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it('rejects a merge commit title before sending anything', async () => {
    const { fetch, calls } = fixtureFetch('cursor-origin')
    const instance = cursorOrigin({ auth: { type: 'token', token: 't' }, fetch }).create()

    await expect(instance.threads.merge(pull, { method: 'squash', title: 'Release widgets' })).rejects.toThrow('Cursor Origin does not take a merge commit title')
    expect(calls).toEqual([])
  })
})

describe('cursor origin thread updates', () => {
  function serve() {
    const calls: Array<{ method: string, path: string, body?: unknown }> = []
    const instance = cursorOrigin({ auth: { type: 'token', token: 't' }, fetch: async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return Response.json({ number: 12, state: 'closed', title: 'Retry uploads' })
    } }).create()
    return { instance, calls }
  }

  it('puts the labels before the edit that closes the pull request', async () => {
    const { instance, calls } = serve()
    await instance.threads.update(pull, { title: 'Retry uploads', state: 'closed', labels: ['bug'] })

    expect(calls.map(call => `${call.method} ${call.path.replace(/^.*\/pulls\//, '')}`)).toEqual(['PUT 12/labels', 'PATCH 12'])
    expect(calls.map(call => call.body)).toEqual([{ labels: ['bug'] }, { title: 'Retry uploads', state: 'closed' }])
  })

  it('reads the pull request back instead of patching it when only its labels change', async () => {
    const { instance, calls } = serve()
    await instance.threads.update(pull, { labels: ['bug'] })

    expect(calls.map(call => `${call.method} ${call.path.replace(/^.*\/pulls\//, '')}`)).toEqual(['PUT 12/labels', 'GET 12'])
  })

  it('refuses assignees before it writes anything', async () => {
    const { instance, calls } = serve()

    await expect(instance.threads.update(pull, { labels: ['bug'], assignees: ['jane'] })).rejects.toThrow(UnsupportedOperationError)
    expect(calls).toEqual([])
  })
})
