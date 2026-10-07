import type { FixtureResponse } from '@forges-examples/fixture-fetch'
import { fixtureFetch } from '@forges-examples/fixture-fetch'
import { createForges, github } from 'forges'
import { signDelivery } from 'forges/testing'
import { describe, expect, it } from 'vitest'
import { createHandler } from '../src/handler.ts'

const SECRET = 'webhook-secret'
const REPO = {
  id: 31337,
  node_id: 'R_kgDOAAB5aQ',
  name: 'widgets',
  full_name: 'acme/widgets',
  owner: { login: 'acme', id: 5150, type: 'Organization' },
}

function setup(extra: Record<string, FixtureResponse> = {}) {
  const { fetch, calls } = fixtureFetch(['github'], extra)
  const handler = createHandler({
    forges: createForges([github({ auth: { type: 'token', token: 'ghp_test' }, webhookSecret: SECRET, fetch })]),
    titlePattern: /retry/i,
    label: 'triage',
    comment: 'Thanks! Queued for triage.',
  })
  return { handler, calls }
}

async function deliver(
  handler: (request: Request) => Promise<Response>,
  event: string,
  payload: unknown,
  signature?: string,
): Promise<Response> {
  const body = JSON.stringify(payload)
  return handler(new Request('http://localhost/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...await signDelivery('github', body, SECRET, { 'x-github-event': event, 'x-github-delivery': 'delivery-1' }),
      ...signature ? { 'x-hub-signature-256': signature } : {},
    },
    body,
  }))
}

const opened = {
  action: 'opened',
  pull_request: { number: 42, node_id: 'PR_42', title: 'Add retry handling to the uploader', user: { login: 'octocat', id: 583231, type: 'User' } },
  repository: REPO,
  sender: { login: 'octocat', id: 583231, type: 'User' },
}

const commented = {
  action: 'created',
  issue: { number: 42, node_id: 'I_42', title: 'Add retry handling to the uploader' },
  comment: { id: 770002, body: '/close', created_at: '2025-09-19T09:00:00Z', user: { login: 'grace', id: 4102, type: 'User' } },
  repository: REPO,
  sender: { login: 'grace', id: 4102, type: 'User' },
}

const closeComments: FixtureResponse = {
  status: 200,
  body: [
    { id: 770001, body: 'Could you add a test for the 503 path?', user: { login: 'octocat', id: 583231, type: 'User' }, created_at: '2025-09-16T09:00:00Z' },
    { id: 770002, body: '/close', user: { login: 'grace', id: 4102, type: 'User' }, created_at: '2025-09-19T09:00:00Z' },
  ],
}

function permission(value: string): Record<string, FixtureResponse> {
  return {
    'GET https://api.github.com/repos/acme/widgets/collaborators/grace/permission': { status: 200, body: { permission: value } },
  }
}

describe('label bot', () => {
  it('should refuse a delivery whose signature does not verify', async () => {
    const { handler, calls } = setup()

    const response = await deliver(handler, 'pull_request', opened, 'sha256=deadbeef')

    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('should label and comment on an opened thread whose title matches', async () => {
    const { handler, calls } = setup()

    const response = await deliver(handler, 'pull_request', opened)

    expect(await response.json()).toEqual({
      forge: 'github',
      actions: [
        { kind: 'labelled', reason: 'triage', thread: 'acme/widgets#42' },
        { kind: 'commented', reason: 'matched title', thread: 'acme/widgets#42' },
      ],
    })
    const labels = calls.find(call => call.method === 'POST' && call.url.endsWith('/issues/42/labels'))
    expect(labels?.body).toBe(JSON.stringify({ labels: ['triage'] }))
    expect(calls.some(call => call.method === 'POST' && call.url.endsWith('/issues/42/comments'))).toBe(true)
  })

  it('should leave an opened thread alone when the title does not match', async () => {
    const { fetch, calls } = fixtureFetch(['github'])
    const handler = createHandler({
      forges: createForges([github({ auth: { type: 'token', token: 'ghp_test' }, webhookSecret: SECRET, fetch })]),
      titlePattern: /^chore/,
      label: 'triage',
      comment: 'Thanks!',
    })

    const response = await deliver(handler, 'pull_request', opened)

    expect(await response.json()).toMatchObject({ actions: [{ kind: 'ignored', reason: 'title does not match' }] })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('should close a thread when a collaborator comments the command', async () => {
    const { handler, calls } = setup({
      'GET https://api.github.com/repos/acme/widgets/issues/42/comments': closeComments,
      ...permission('write'),
    })

    const response = await deliver(handler, 'issue_comment', commented)

    expect(await response.json()).toMatchObject({ actions: [{ kind: 'closed', reason: 'requested by grace' }] })
    const close = calls.find(call => call.method === 'PATCH' && call.url.endsWith('/issues/42'))
    expect(close?.body).toBe(JSON.stringify({ state: 'closed' }))
  })

  it('should refuse the command from someone who cannot write to the repository', async () => {
    const { handler, calls } = setup({
      'GET https://api.github.com/repos/acme/widgets/issues/42/comments': closeComments,
      ...permission('read'),
    })

    const response = await deliver(handler, 'issue_comment', commented)

    expect(await response.json()).toMatchObject({
      actions: [{ kind: 'refused', reason: 'grace cannot write to the repository' }],
    })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('should ignore a comment without the command', async () => {
    const { handler } = setup(permission('write'))

    const response = await deliver(handler, 'issue_comment', {
      ...commented,
      comment: { ...commented.comment, body: 'looks good to me' },
    })

    expect(await response.json()).toMatchObject({
      actions: [{ kind: 'ignored', reason: 'no command in the latest comment' }],
    })
  })
})
