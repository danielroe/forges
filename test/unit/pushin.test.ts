import { describe, expect, it } from 'vitest'
import { UnsupportedOperationError } from '../../src/errors.ts'
import { pushin } from '../../src/pushin/index.ts'
import { toComment, toLabel, toNotification, toRepo, toThread } from '../../src/pushin/normalise.ts'
import { fixtureFetch } from '../../src/testing/index.ts'

const origin = { forge: 'pushin', instance: 'pushin.eu' } as const
const repo = { ...origin, owner: 'acme', name: 'widgets' }
const issue = { ...origin, repo, kind: 'issue', number: '31' } as const
const pull = { ...issue, kind: 'pull_request' } as const
const base = 'https://pushin.eu/api/v1'
const raw = { id: 'iss_31', number: 31, title: 'A thread', state: 'open', labels: [] }

function provider(overrides: Parameters<typeof fixtureFetch>[1]) {
  const fixtures = fixtureFetch([], overrides)
  return { ...fixtures, forge: pushin({ auth: { type: 'token', token: 't' }, fetch: fixtures.fetch }).create() }
}

describe('pushin', () => {
  it('reads issues and pull requests through their own endpoints', async () => {
    const { forge } = provider({
      [`GET ${base}/repos/acme/widgets/issues/31`]: { status: 200, body: raw },
      [`GET ${base}/repos/acme/widgets/pulls/31`]: { status: 200, body: { ...raw, merged: true, head: { ref: null, sha: null }, base: { ref: null } } },
    })
    expect(await forge.threads.get(issue)).toMatchObject({ kind: 'issue', ref: { externalId: 'iss_31' }, state: 'open' })
    expect(await forge.threads.get(pull)).toMatchObject({ kind: 'pull_request', state: 'merged', stateRaw: 'merged', branches: { head: { ref: '' }, base: { ref: '' } } })
    await expect(forge.threads.get({ ...issue, kind: 'discussion' })).rejects.toThrow(UnsupportedOperationError)
  })

  it('lists mixed threads and filters explicit issue listings while preserving pagination and rate limits', async () => {
    const next = `${base}/repos/acme/widgets/issues?page=2&per_page=2&state=all`
    const { forge, calls } = provider({
      [`GET ${base}/repos/acme/widgets/issues?state=all&per_page=2`]: {
        status: 200,
        headers: { 'link': `<${next}>; rel="next"`, 'x-ratelimit-limit': '90', 'x-ratelimit-remaining': '89' },
        body: [raw, { ...raw, id: 'pr_32', number: 32, pull_request: { url: `${base}/repos/acme/widgets/pulls/32` } }],
      },
      [`GET ${next}`]: { status: 200, body: [{ ...raw, number: 33 }] },
    })
    const page = await forge.threads.listPage(repo, { state: 'all', perPage: 2 })
    expect(page.items.map(thread => thread.kind)).toEqual(['issue', 'pull_request'])
    expect(page.rateLimit).toMatchObject({ limit: 90, remaining: 89 })
    expect(page.cursor?.nextUrl).toBe(next)
    expect((await forge.threads.listPage(repo, { kind: 'issue', state: 'all', perPage: 2 })).items.map(thread => [thread.kind, thread.ref.number])).toEqual([['issue', '31']])
    expect((await forge.threads.listPage(repo, { cursor: page.cursor })).items[0]?.ref.number).toBe('33')
    expect(calls.at(-1)?.url).toBe(next)
  })

  it('passes all states to the pull listing', async () => {
    const { forge } = provider({
      [`GET ${base}/repos/acme/widgets/pulls?state=all&per_page=1`]: { status: 200, body: [raw] },
    })
    expect((await forge.threads.listPage(repo, { kind: 'pull_request', state: 'all', perPage: 1 })).items[0]?.kind).toBe('pull_request')
  })

  it('normalises merged pull requests returned by the issues API', () => {
    expect(toThread(issue, { ...raw, state: 'closed', pull_request: { url: `${base}/repos/acme/widgets/pulls/31`, merged_at: '2026-09-10T12:00:00Z' } })).toMatchObject({
      kind: 'pull_request',
      ref: { kind: 'pull_request' },
      state: 'merged',
      stateRaw: 'merged',
    })
  })

  it('normalises integer ids to strings and prefers node_id as the external id', () => {
    const user = { id: 7, login: 'octo' }
    expect(toThread(issue, { ...raw, id: 31, user })).toMatchObject({ ref: { externalId: '31' }, author: { id: '7' } })
    expect(toThread(issue, { ...raw, id: 31, node_id: 'iss_31' }).ref.externalId).toBe('iss_31')
    expect(toComment(issue, { id: 9, body: '', user }).ref.id).toBe('9')
    expect(toRepo(origin, { id: 5, node_id: 'repo_5', name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } }).ref.externalId).toBe('repo_5')
    expect(toNotification(origin, { id: 3, repository: { id: 5, name: 'widgets', full_name: 'acme/widgets' }, subject: { title: '', type: 'Issue', url: '' }, reason: 'mention', unread: true, updated_at: '' })).toMatchObject({ ref: { id: '3' }, subject: { repo: { externalId: '5' } } })
  })

  it('preserves hex label colours and omits colour names', () => {
    expect(toLabel({ id: 'l', name: 'Future', color: 'aAbB00' }).colour).toBe('aAbB00')
    expect(toLabel({ id: 'l', name: 'Future', color: 'purple' }).colour).toBeUndefined()
  })

  it('lists notifications with filters and maps thread subjects and reasons', async () => {
    const since = new Date('2026-09-10T12:00:00Z')
    const notification = {
      id: 'n_1',
      repository: { id: 'r_1', name: 'widgets', full_name: 'acme/widgets' },
      subject: { title: 'A thread', type: 'Issue', url: `${base}/repos/acme/widgets/issues/31` },
      reason: 'assign',
      unread: true,
      updated_at: since.toISOString(),
      last_read_at: null,
      html_url: 'https://pushin.eu/acme/widgets/issues/31',
    }
    const { forge } = provider({
      [`GET ${base}/notifications?all=true&since=2026-09-10T12%3A00%3A00.000Z&per_page=1`]: { status: 200, body: [notification] },
    })
    const page = await forge.notifications.listPage({ all: true, since, perPage: 1 })
    expect(page.items[0]).toMatchObject({ ref: { ...origin, id: 'n_1' }, reason: 'assigned', subject: { type: 'thread', thread: { ...issue, repo: { externalId: 'r_1' } } }, url: notification.html_url })
    expect(page.items[0]?.updatedAt).toEqual(since)
    expect(page.items[0]?.lastReadAt).toBeUndefined()
    expect(toNotification(origin, { ...notification, subject: { ...notification.subject, type: 'PullRequest', url: `${base}/repos/acme/widgets/pulls/31` } }).subject).toMatchObject({ type: 'thread', thread: { kind: 'pull_request', number: '31' } })
    expect(toNotification(origin, { ...notification, reason: 'future_reason' }).reason).toBe('unknown')
    expect(toNotification(origin, { ...notification, subject: { ...notification.subject, url: `${base}/repos/acme/widgets/issues/not-a-number` } }).subject).toMatchObject({ type: 'other', url: `${base}/repos/acme/widgets/issues/not-a-number` })
  })
})
