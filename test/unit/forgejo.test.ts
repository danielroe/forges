import { describe, expect, it } from 'vitest'
import { forgejo } from '../../src/forgejo/index.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

function provider() {
  const { fetch, calls } = fixtureFetch('forgejo')
  return { instance: forgejo({ auth: { type: 'token', token: 't' }, fetch }).create(), calls }
}

describe('forgejo provider', () => {
  it('appends the api prefix to an instance root', () => {
    const codeberg = forgejo({ auth: { type: 'token', token: 't' } }).create()
    const selfHosted = forgejo({ baseUrl: 'https://git.example.org/', auth: { type: 'token', token: 't' } }).create()

    expect(codeberg.baseUrl).toBe('https://codeberg.org/api/v1')
    expect(codeberg.instance).toBe('codeberg.org')
    expect(selfHosted.baseUrl).toBe('https://git.example.org/api/v1')
  })

  it('emulates done as read plus unsubscribe', async () => {
    const { instance, calls } = provider()

    await instance.notifications!.markDone!({ forge: 'forgejo', instance: 'codeberg.org', id: '5512' })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'PATCH https://codeberg.org/api/v1/notifications/threads/5512?to-status=read',
      'GET https://codeberg.org/api/v1/notifications/threads/5512',
      'GET https://codeberg.org/api/v1/user',
      'DELETE https://codeberg.org/api/v1/repos/acme/widgets/issues/7/subscriptions/testuser',
    ])
  })

  it('skips the thread and lookups it can when the caller passes the thread', async () => {
    const { instance, calls } = provider()
    const thread = {
      forge: 'forgejo',
      instance: 'codeberg.org',
      repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' },
      kind: 'pull_request',
      number: '7',
    } as const

    await instance.notifications!.markDone!({ forge: 'forgejo', instance: 'codeberg.org', id: '5512' }, { thread })
    await instance.notifications!.unsubscribe!({ forge: 'forgejo', instance: 'codeberg.org', id: '5512' }, { thread })

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'PATCH https://codeberg.org/api/v1/notifications/threads/5512?to-status=read',
      'GET https://codeberg.org/api/v1/user',
      'DELETE https://codeberg.org/api/v1/repos/acme/widgets/issues/7/subscriptions/testuser',
      'DELETE https://codeberg.org/api/v1/repos/acme/widgets/issues/7/subscriptions/testuser',
    ])
  })

  it('refuses to comment on a commit', async () => {
    const { instance } = provider()
    await expect(instance.threads.comment!({
      forge: 'forgejo',
      instance: 'codeberg.org',
      repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' },
      kind: 'commit',
      number: 'adbc9741',
    }, 'hi')).rejects.toThrow('forgejo does not support threads.comment for a commit')
    expect(instance.capabilities.writes.comment.commit).toBe(false)
  })
})

describe('forgejo release webhooks', () => {
  it('maps Forgejo release deliveries', async () => {
    const { hmacSha256Hex } = await import('../../src/crypto.ts')
    const provider = forgejo({ auth: { type: 'token', token: 't' }, webhookSecret: 's' }).create()
    const body = JSON.stringify({
      action: 'published',
      release: { id: 31001, tag_name: 'v0.4.0', name: 'Four' },
      repository: { id: 64021, name: 'widgets', full_name: 'acme/widgets', owner: { id: 4001, login: 'acme' } },
      sender: { id: 4002, login: 'ada' },
    })
    const [event] = await provider.webhooks.ingest({ headers: { 'x-forgejo-event': 'release', 'x-forgejo-signature': await hmacSha256Hex('s', body) }, body })

    expect(event).toMatchObject({ kind: 'release_published', detail: { release: { id: '31001', tag: 'v0.4.0' }, name: 'Four' } })
  })
})

describe('forgejo path safety', () => {
  it('encodes owner, name and number in thread paths', async () => {
    const urls: string[] = []
    const provider = forgejo({ baseUrl: 'https://codeberg.org', auth: { type: 'token', token: 't' }, fetch: async (url) => {
      urls.push(url)
      return new Response('{"id":1,"body":"hi","user":{"id":1,"login":"a"}}', { status: 201 })
    } }).create()
    const repo = { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme/x', name: 'widgets' }

    await provider.threads.comment({ forge: 'forgejo', instance: 'codeberg.org', repo, kind: 'pull_request', number: '1?x=' }, 'hi')

    expect(urls).toEqual(['https://codeberg.org/api/v1/repos/acme%2Fx/widgets/issues/1%3Fx%3D/comments'])
  })
})
