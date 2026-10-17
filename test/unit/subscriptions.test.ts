import type { FetchLike } from '../../src/fetch.ts'
import type { ThreadKind, ThreadRef } from '../../src/model.ts'
import type { ForgeProvider } from '../../src/provider.ts'
import { describe, expect, it } from 'vitest'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitea } from '../../src/gitea/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'

const auth = { type: 'token', token: 't' } as const

function recorder(answer: (url: string, init?: RequestInit) => unknown): { fetch: FetchLike, calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operationName?: string, variables?: Record<string, unknown> } : undefined
      calls.push(`${init?.method ?? 'GET'} ${url}${body?.operationName ? ` ${body.operationName} ${JSON.stringify(body.variables)}` : ''}`)
      return new Response(JSON.stringify(answer(url, init) ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
}

function ref(forge: string, instance: string, kind: ThreadKind): ThreadRef {
  return { forge, instance, repo: { forge, instance, owner: 'acme', name: 'widgets' }, kind, number: '7' }
}

function graphqlAnswers(url: string, init?: RequestInit) {
  const { operationName } = JSON.parse(String(init?.body)) as { operationName: string }
  return operationName === 'SubscriptionState'
    ? { data: { repository: { issueOrPullRequest: { id: 'I_1', viewerSubscription: 'UNSUBSCRIBED' }, discussion: { id: 'D_1', viewerSubscription: 'UNSUBSCRIBED' } } } }
    : { data: { updateSubscription: { subscribable: { viewerSubscription: 'SUBSCRIBED' } } } }
}

describe('thread subscriptions', () => {
  it.each(['issue', 'pull_request', 'discussion'] as const)('github subscribes to and unsubscribes from a %s through GraphQL', async (kind) => {
    const { fetch, calls } = recorder(graphqlAnswers)
    const provider = github({ auth, fetch })
    const thread = ref('github', 'github.com', kind)

    await provider.threads.subscribe(thread)
    await provider.threads.unsubscribe(thread)

    const id = kind === 'discussion' ? 'D_1' : 'I_1'
    expect(calls.filter(call => call.includes('UpdateSubscription'))).toEqual([
      `POST https://api.github.com/graphql UpdateSubscription {"id":"${id}","state":"SUBSCRIBED"}`,
      `POST https://api.github.com/graphql UpdateSubscription {"id":"${id}","state":"UNSUBSCRIBED"}`,
    ])
  })

  it.each(['issue', 'pull_request'] as const)('gitlab posts subscribe and unsubscribe for a %s', async (kind) => {
    const { fetch, calls } = recorder(() => ({}))
    const provider = gitlab({ auth, fetch })
    const thread = ref('gitlab', 'gitlab.com', kind)

    await provider.threads.subscribe(thread)
    await provider.threads.unsubscribe(thread)

    const resource = kind === 'issue' ? 'issues' : 'merge_requests'
    expect(calls).toEqual([
      `POST https://gitlab.com/api/v4/projects/acme%2Fwidgets/${resource}/7/subscribe`,
      `POST https://gitlab.com/api/v4/projects/acme%2Fwidgets/${resource}/7/unsubscribe`,
    ])
  })

  it.each([
    ['forgejo', 'codeberg.org', (fetch: FetchLike): ForgeProvider => forgejo({ auth, fetch })],
    ['gitea', 'gitea.com', (fetch: FetchLike): ForgeProvider => gitea({ auth, fetch })],
  ])('%s puts and deletes the current user\'s subscription', async (forge, instance, create) => {
    const { fetch, calls } = recorder(url => url.endsWith('/user') ? { login: 'ada', id: 1 } : {})
    const provider = create(fetch)

    for (const kind of ['issue', 'pull_request'] as const) {
      await provider.threads.subscribe(ref(forge, instance, kind))
      await provider.threads.unsubscribe(ref(forge, instance, kind))
    }

    expect(calls.filter(call => call.includes('/subscriptions/'))).toEqual([
      `PUT https://${instance}/api/v1/repos/acme/widgets/issues/7/subscriptions/ada`,
      `DELETE https://${instance}/api/v1/repos/acme/widgets/issues/7/subscriptions/ada`,
      `PUT https://${instance}/api/v1/repos/acme/widgets/issues/7/subscriptions/ada`,
      `DELETE https://${instance}/api/v1/repos/acme/widgets/issues/7/subscriptions/ada`,
    ])
  })
})
