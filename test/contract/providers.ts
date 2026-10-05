import type { FetchLike } from '../../src/fetch.ts'
import type { EventKind, MergeMethod } from '../../src/model.ts'
import type { ForgeProvider, ForgeProviderFactory } from '../../src/provider.ts'
import type { WebSocketFactory } from '../../src/tangled/index.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { hmacSha256Hex, sha256Hex } from '../../src/crypto.ts'
import { cursorOrigin } from '../../src/cursor-origin/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { tangled } from '../../src/tangled/index.ts'
import { signDelivery } from '../../src/testing/index.ts'

export const WEBHOOK_SECRET = 'contract-suite-secret'

function fixture(provider: string, name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${provider}/${name}.json`, import.meta.url)), 'utf8').trim()
}

interface Call { method: string, url: string }

export interface ProviderContract {
  name: string
  fixtures: string
  instance: string
  repo: { owner: string, name: string }
  create: (fetch: FetchLike, options?: { timeout?: number, webSocket?: WebSocketFactory }) => ForgeProvider
  /** A read that exercises the fetcher, for error mapping. Defaults to the first notifications page. */
  probe?: (instance: ForgeProvider) => Promise<unknown>
  thread: { number: string, title: string, label?: string, eventKinds: EventKind[], botActor: boolean }
  /** A raw path for `request()`, relative to the provider's API base, and a field its body must have. */
  request: { path: string, field: string }
  /** Present when the forge lists notifications. */
  notifications?: {
    count: number
    first: { id: string, reason: string, reasonRaw?: string, subjectState: string }
    /** Absent when the forge has no done state. */
    markDone?: Call
    /** Absent when the forge has no read state distinct from done. */
    markRead?: Call
    /** Absent when the forge cannot unsubscribe from a notification's thread. */
    unsubscribe?: Call
  }
  writes: {
    comment: Call
    close: Call & { bodyContains: string }
    /** Absent when pull requests cannot be reopened. */
    reopen?: Call & { bodyContains: string }
    /** Requests to leave out when checking write order, such as session creation. */
    ignore?: RegExp
  }
  /** Present when the forge supports approveAndMerge. */
  merge?: {
    /** Requests that resolve the allowed merge methods, in order; the last one is overridden to allow several. */
    reads: Call[]
    multiMethodRepo: Record<string, unknown>
    review: Call & { body: string }
    merge: Call & { body: string }
    settle?: Call[]
    /** An explicit merge method that needs no repository lookup, and a fragment of the resulting body. */
    explicit: { method: MergeMethod, bodyContains: string }
  }
  webhook: {
    body: string
    headers: (signature: string) => Record<string, string>
    sign: (body: string, secret: string) => Promise<string>
    expect: { kind: string, action: string, threadKind: string, threadNumber?: string, displayNumber?: string, actor: string }
  }
  /** Present when the forge reports checks on pull requests. */
  checks?: { summary: { state: string, total?: number, failed?: number }, names: string[] }
  /** Present when the forge reports reviews, or synthesises them from approvals. */
  reviews?: { states: string[], comments: boolean }
  /** Present when the forge has releases. */
  releases?: { count: number, get: { id: string, tag: string }, latest: string }
  /** Present when the forge reports security alerts. */
  securityAlerts?: { kinds: string[], severities: string[] }
  /** Present when the forge supports `sources.subscribe`. */
  subscribe?: { messages: unknown[], kinds: EventKind[], lastCursor: string }
}

function create(factory: ForgeProviderFactory): ForgeProvider {
  return factory.create()
}

/** Test-only Ed25519 keys; the public half of `ORIGIN_KEY` is served by `test/fixtures/cursor-origin/keys.json`. */
const ORIGIN_KEY = 'MC4CAQAwBQYDK2VwBCIEIJd6H8aUQCQXSGedf4DblXE1KoGrVSAfSlGDU8R0IYxl'
const ORIGIN_OTHER_KEY = 'MC4CAQAwBQYDK2VwBCIEIJpGOqTKj+1rnwfK761s9Cc93/NCxNkNrWv0QLrUBvLx'
const ORIGIN_DELIVERY = 'whd_01k2ja2000delivery00000000a'

/** Signs an Origin delivery and returns `<timestamp>.<signature>`, since the timestamp is part of what is signed. */
async function signOrigin(body: string, secret: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const digest = await sha256Hex(`${ORIGIN_DELIVERY}.${timestamp}.${body}`)
  const der = Uint8Array.from(atob(secret === WEBHOOK_SECRET ? ORIGIN_KEY : ORIGIN_OTHER_KEY), char => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(digest)))
  return `${timestamp}.${btoa(String.fromCharCode(...signature))}`
}

const hmac = async (body: string, secret: string) => (await signDelivery('github', body, secret))['x-hub-signature-256']!

const TANGLED_PULL = 'at://did:plc:adaauthor222222222222222/sh.tangled.repo.pull/3mwqpull22222'

export const contracts: ProviderContract[] = [
  {
    name: 'github',
    checks: { summary: { state: 'failure', total: 3, failed: 1 }, names: ['test (ubuntu-latest)', 'lint', 'ci/netlify'] },
    reviews: { states: ['changes_requested', 'approved'], comments: true },
    releases: { count: 2, get: { id: '9001', tag: 'v1.2.0' }, latest: 'v1.2.0' },
    securityAlerts: { kinds: ['dependency', 'code_scanning', 'secret'], severities: ['high', 'critical', 'unknown'] },
    fixtures: 'github',
    instance: 'github.com',
    repo: { owner: 'acme', name: 'widgets' },
    create: (fetch, options) => create(github({
      auth: { type: 'token', token: 'test-token' },
      fetch,
      timeout: options?.timeout,
      webhookSecret: WEBHOOK_SECRET,
    })),
    request: { path: '/repos/acme/widgets', field: 'full_name' },
    thread: { number: '42', title: 'Add retry handling to the uploader', label: 'enhancement', eventKinds: ['comment', 'label', 'review'], botActor: true },
    notifications: {
      count: 3,
      first: { id: '901234567', reason: 'review_requested', reasonRaw: 'review_requested', subjectState: 'unknown' },
      markDone: { method: 'DELETE', url: 'https://api.github.com/notifications/threads/901234567' },
      markRead: { method: 'PATCH', url: 'https://api.github.com/notifications/threads/901234567' },
      unsubscribe: { method: 'DELETE', url: 'https://api.github.com/notifications/threads/901234567/subscription' },
    },
    writes: {
      comment: { method: 'POST', url: 'https://api.github.com/repos/acme/widgets/issues/42/comments' },
      close: { method: 'PATCH', url: 'https://api.github.com/repos/acme/widgets/pulls/42', bodyContains: '{"state":"closed"}' },
      reopen: { method: 'PATCH', url: 'https://api.github.com/repos/acme/widgets/pulls/42', bodyContains: '{"state":"open"}' },
    },
    merge: {
      reads: [{ method: 'GET', url: 'https://api.github.com/repos/acme/widgets' }],
      multiMethodRepo: { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false },
      review: { method: 'POST', url: 'https://api.github.com/repos/acme/widgets/pulls/42/reviews', body: '{"event":"APPROVE"}' },
      merge: { method: 'PUT', url: 'https://api.github.com/repos/acme/widgets/pulls/42/merge-async', body: '{"merge_method":"squash","merge_action":"direct_merge"}' },
      settle: [{ method: 'GET', url: 'https://api.github.com/repos/acme/widgets/pulls/42/merge-async/3f1c2a9e-5b7d-4e8a-9c0f-1a2b3c4d5e6f' }],
      explicit: { method: 'rebase', bodyContains: '"merge_method":"rebase"' },
    },
    webhook: {
      body: fixture('github', 'webhooks/issue-comment-on-pull-request'),
      headers: signature => ({
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'd1e2f3a4-0000-4000-8000-000000000001',
        'x-hub-signature-256': signature,
      }),
      sign: hmac,
      expect: { kind: 'comment', action: 'created', threadKind: 'pull_request', threadNumber: '17', actor: 'octocat' },
    },
  },
  {
    name: 'forgejo',
    checks: { summary: { state: 'failure', total: 2, failed: 1 }, names: ['ci/woodpecker/push/test', 'ci/woodpecker/push/lint'] },
    reviews: { states: ['approved'], comments: true },
    releases: { count: 2, get: { id: '31001', tag: 'v0.4.0' }, latest: 'v0.4.0' },
    fixtures: 'forgejo',
    instance: 'codeberg.org',
    repo: { owner: 'acme', name: 'widgets' },
    create: (fetch, options) => create(forgejo({
      auth: { type: 'token', token: 'test-token' },
      fetch,
      timeout: options?.timeout,
      webhookSecret: WEBHOOK_SECRET,
    })),
    request: { path: '/repos/acme/widgets', field: 'allow_squash_merge' },
    thread: { number: '7', title: 'Support custom cache directory', label: 'enhancement', eventKinds: ['comment', 'label', 'review'], botActor: true },
    notifications: {
      count: 2,
      first: { id: '5512', reason: 'unknown', subjectState: 'open' },
      markDone: { method: 'PATCH', url: 'https://codeberg.org/api/v1/notifications/threads/5512?to-status=read' },
      markRead: { method: 'PATCH', url: 'https://codeberg.org/api/v1/notifications/threads/5512?to-status=read' },
      unsubscribe: { method: 'DELETE', url: 'https://codeberg.org/api/v1/repos/acme/widgets/issues/7/subscriptions/testuser' },
    },
    writes: {
      comment: { method: 'POST', url: 'https://codeberg.org/api/v1/repos/acme/widgets/issues/7/comments' },
      close: { method: 'PATCH', url: 'https://codeberg.org/api/v1/repos/acme/widgets/issues/7', bodyContains: '{"state":"closed"}' },
      reopen: { method: 'PATCH', url: 'https://codeberg.org/api/v1/repos/acme/widgets/issues/7', bodyContains: '{"state":"open"}' },
    },
    merge: {
      reads: [{ method: 'GET', url: 'https://codeberg.org/api/v1/repos/acme/widgets' }],
      multiMethodRepo: { allow_merge_commits: true, allow_squash_merge: true, default_merge_style: 'squash' },
      review: { method: 'POST', url: 'https://codeberg.org/api/v1/repos/acme/widgets/pulls/7/reviews', body: '{"event":"APPROVED","body":""}' },
      merge: { method: 'POST', url: 'https://codeberg.org/api/v1/repos/acme/widgets/pulls/7/merge', body: '{"Do":"squash"}' },
      explicit: { method: 'rebase', bodyContains: '"Do":"rebase"' },
    },
    webhook: {
      body: fixture('forgejo', 'webhooks/issue-comment-on-pull-request'),
      headers: signature => ({
        'x-forgejo-event': 'issue_comment',
        'x-forgejo-delivery': 'c1d2e3f4-0000-4000-8000-000000000002',
        'x-forgejo-signature': signature,
      }),
      sign: (body, secret) => hmacSha256Hex(secret, body),
      expect: { kind: 'comment', action: 'created', threadKind: 'pull_request', threadNumber: '9', actor: 'grace' },
    },
  },
  {
    name: 'gitlab',
    checks: { summary: { state: 'failure' }, names: ['test: test', 'test: lint', 'deploy: deploy'] },
    reviews: { states: ['approved'], comments: false },
    releases: { count: 2, get: { id: 'v2.0.0', tag: 'v2.0.0' }, latest: 'v2.0.0' },
    securityAlerts: { kinds: ['dependency', 'code_scanning'], severities: ['high', 'critical'] },
    fixtures: 'gitlab',
    instance: 'gitlab.com',
    repo: { owner: 'acme/platform', name: 'widgets' },
    create: (fetch, options) => create(gitlab({
      auth: { type: 'token', token: 'test-token' },
      fetch,
      timeout: options?.timeout,
      webhookSecret: WEBHOOK_SECRET,
    })),
    request: { path: '/projects/acme%2Fplatform%2Fwidgets', field: 'merge_method' },
    thread: { number: '23', title: 'Cache compiled templates', label: 'enhancement', eventKinds: ['comment', 'label', 'review'], botActor: true },
    notifications: {
      count: 3,
      first: { id: '102938401', reason: 'review_requested', reasonRaw: 'review_requested', subjectState: 'open' },
      markDone: { method: 'POST', url: 'https://gitlab.com/api/v4/todos/102938401/mark_as_done' },
      unsubscribe: { method: 'POST', url: 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/23/unsubscribe' },
    },
    writes: {
      comment: { method: 'POST', url: 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/23/notes' },
      close: { method: 'PUT', url: 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/23', bodyContains: '{"state_event":"close"}' },
      reopen: { method: 'PUT', url: 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/23', bodyContains: '{"state_event":"reopen"}' },
    },
    merge: {
      reads: [{ method: 'GET', url: 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets' }],
      multiMethodRepo: { merge_method: 'merge', squash_option: 'default_off' },
      review: { method: 'POST', url: 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/23/approve', body: '{}' },
      merge: { method: 'PUT', url: 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/23/merge', body: '{"squash":false,"merge_when_pipeline_succeeds":false}' },
      explicit: { method: 'squash', bodyContains: '"squash":true' },
    },
    webhook: {
      body: fixture('gitlab', 'webhooks/note-on-issue'),
      headers: token => ({
        'x-gitlab-event': 'Note Hook',
        'x-gitlab-event-uuid': 'b1c2d3e4-0000-4000-8000-000000000003',
        'x-gitlab-token': token,
      }),
      sign: async (_body, secret) => secret,
      expect: { kind: 'comment', action: 'created', threadKind: 'issue', threadNumber: '11', actor: 'grace' },
    },
  },
  {
    name: 'bitbucket',
    checks: { summary: { state: 'pending', total: 2, failed: 0 }, names: ['Pipeline #120 test', 'Pipeline #120 deploy'] },
    fixtures: 'bitbucket',
    instance: 'bitbucket.org',
    repo: { owner: 'acme', name: 'widgets' },
    create: (fetch, options) => create(bitbucket({
      auth: { type: 'token', token: 'test-token' },
      fetch,
      timeout: options?.timeout,
      webhookSecret: WEBHOOK_SECRET,
    })),
    probe: instance => instance.threads.get({
      forge: 'bitbucket',
      instance: 'bitbucket.org',
      repo: { forge: 'bitbucket', instance: 'bitbucket.org', owner: 'acme', name: 'widgets' },
      kind: 'pull_request',
      number: '31',
    }),
    request: { path: '/repositories/acme/widgets', field: 'mainbranch' },
    thread: { number: '31', title: 'Cache compiled templates', eventKinds: ['other', 'comment', 'review'], botActor: true },
    writes: {
      comment: { method: 'POST', url: 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/31/comments' },
      close: { method: 'POST', url: 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/31/decline', bodyContains: '' },
    },
    merge: {
      reads: [
        { method: 'GET', url: 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/31' },
        { method: 'GET', url: 'https://api.bitbucket.org/2.0/repositories/acme/widgets/refs/branches/main' },
      ],
      multiMethodRepo: { name: 'main', merge_strategies: ['merge_commit', 'squash'] },
      review: { method: 'POST', url: 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/31/approve', body: '' },
      merge: { method: 'POST', url: 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/31/merge', body: '{"merge_strategy":"squash"}' },
      explicit: { method: 'rebase_merge', bodyContains: '"merge_strategy":"rebase_merge"' },
    },
    webhook: {
      body: fixture('bitbucket', 'webhooks/pullrequest-comment-created'),
      headers: signature => ({
        'x-event-key': 'pullrequest:comment_created',
        'x-request-uuid': 'f1a2b3c4-0000-4000-8000-000000000005',
        'x-hook-uuid': '{44444444-0000-4000-8000-000000000004}',
        'x-hub-signature': signature,
      }),
      sign: hmac,
      expect: { kind: 'comment', action: 'created', threadKind: 'pull_request', threadNumber: '31', actor: 'grace' },
    },
  },
  {
    name: 'tangled',
    fixtures: 'tangled',
    instance: 'tangled.org',
    repo: { owner: 'did:plc:acmeowner222222222222222', name: 'widgets' },
    create: (fetch, options) => create(tangled({
      auth: { type: 'app_password', identifier: 'acme.example.com', password: 'app-password', pds: 'https://pds.example.com' },
      fetch,
      timeout: options?.timeout,
      webSocket: options?.webSocket,
      webhookSecret: WEBHOOK_SECRET,
    })),
    probe: instance => instance.threads.get({
      forge: 'tangled',
      instance: 'tangled.org',
      repo: { forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:acmeowner222222222222222', name: 'widgets' },
      kind: 'pull_request',
      number: TANGLED_PULL,
    }),
    request: { path: '/xrpc/_health', field: 'version' },
    thread: { number: TANGLED_PULL, title: 'Cache compiled templates', eventKinds: ['comment', 'label', 'reaction'], botActor: false },
    writes: {
      comment: { method: 'POST', url: 'https://pds.example.com/xrpc/com.atproto.repo.createRecord' },
      close: { method: 'POST', url: 'https://pds.example.com/xrpc/com.atproto.repo.createRecord', bodyContains: 'sh.tangled.repo.pull.status.closed' },
      reopen: { method: 'POST', url: 'https://pds.example.com/xrpc/com.atproto.repo.createRecord', bodyContains: 'sh.tangled.repo.pull.status.open' },
      ignore: /createSession$/,
    },
    webhook: {
      body: fixture('tangled', 'webhooks/pull-request-created'),
      headers: signature => ({
        'x-tangled-event': 'pull_request:created',
        'x-tangled-delivery': 'e1f2a3b4-0000-4000-8000-000000000004',
        'x-tangled-hook-id': '17',
        'x-tangled-signature-256': signature,
      }),
      sign: hmac,
      expect: { kind: 'state_change', action: 'opened', threadKind: 'pull_request', displayNumber: '4', actor: 'did:plc:adaauthor222222222222222' },
    },
    subscribe: {
      messages: (JSON.parse(fixture('tangled', 'jetstream/thread-activity')) as { messages: unknown[] }).messages,
      kinds: ['comment', 'label', 'other'],
      lastCursor: '1758000000000004',
    },
  },
  {
    name: 'cursor-origin',
    checks: { summary: { state: 'failure', total: 2, failed: 1 }, names: ['test', 'lint'] },
    reviews: { states: ['approved'], comments: false },
    fixtures: 'cursor-origin',
    instance: 'origin.cursor.com',
    repo: { owner: 'acme', name: 'widgets' },
    create: (fetch, options) => create(cursorOrigin({
      auth: { type: 'token', token: 'test-token' },
      fetch,
      timeout: options?.timeout,
    })),
    probe: instance => instance.repos.get({ forge: 'cursor-origin', instance: 'origin.cursor.com', owner: 'acme', name: 'widgets' }),
    request: { path: '/repos/acme/widgets', field: 'allowSquashMerge' },
    thread: { number: '12', title: 'Add launch telemetry', label: 'enhancement', eventKinds: ['comment', 'review_comment', 'review'], botActor: true },
    writes: {
      comment: { method: 'POST', url: 'https://api.cursor.com/v1/origin/repos/acme/widgets/pulls/12/comments' },
      close: { method: 'PATCH', url: 'https://api.cursor.com/v1/origin/repos/acme/widgets/pulls/12', bodyContains: '{"state":"closed"}' },
      reopen: { method: 'PATCH', url: 'https://api.cursor.com/v1/origin/repos/acme/widgets/pulls/12', bodyContains: '{"state":"open"}' },
    },
    merge: {
      reads: [{ method: 'GET', url: 'https://api.cursor.com/v1/origin/repos/acme/widgets' }],
      multiMethodRepo: { allowMergeCommit: true, allowSquashMerge: true },
      review: { method: 'POST', url: 'https://api.cursor.com/v1/origin/repos/acme/widgets/pulls/12/reviews', body: '{"verdict":"approve","body":""}' },
      merge: { method: 'POST', url: 'https://api.cursor.com/v1/origin/repos/acme/widgets/pulls/12/merge', body: '{"mergeMethod":"squash"}' },
      explicit: { method: 'merge', bodyContains: '"mergeMethod":"merge"' },
    },
    webhook: {
      body: fixture('cursor-origin', 'webhooks/pull-request-comment-created'),
      headers: (signed) => {
        const [timestamp, signature] = signed.split('.')
        return {
          'webhook-id': ORIGIN_DELIVERY,
          'webhook-timestamp': timestamp!,
          'webhook-signature': `v1ed,${signature}`,
          'webhook-event-type': 'pull_request.comment.created',
        }
      },
      sign: signOrigin,
      expect: { kind: 'comment', action: 'created', threadKind: 'pull_request', threadNumber: '9', actor: 'grace' },
    },
  },
  {
    name: 'gitee',
    checks: { summary: { state: 'pending', total: 2, failed: 0 }, names: ['test', 'build'] },
    releases: { count: 2, get: { id: '41001', tag: 'v0.4.0' }, latest: 'v0.4.0' },
    fixtures: 'gitee',
    instance: 'gitee.com',
    repo: { owner: 'acme', name: 'widgets' },
    create: (fetch, options) => create(gitee({
      auth: { type: 'token', token: 'test-token' },
      fetch,
      timeout: options?.timeout,
      webhookSecret: WEBHOOK_SECRET,
    })),
    request: { path: '/repos/acme/widgets', field: 'full_name' },
    thread: { number: '7', title: 'Support custom cache directory', label: 'enhancement', eventKinds: ['label', 'comment', 'review_comment'], botActor: true },
    notifications: {
      count: 2,
      first: { id: '880001', reason: 'unknown', reasonRaw: 'event', subjectState: 'unknown' },
      markRead: { method: 'PATCH', url: 'https://gitee.com/api/v5/notifications/threads/880001' },
    },
    writes: {
      comment: { method: 'POST', url: 'https://gitee.com/api/v5/repos/acme/widgets/pulls/7/comments' },
      close: { method: 'PATCH', url: 'https://gitee.com/api/v5/repos/acme/widgets/pulls/7', bodyContains: '{"state":"closed"}' },
      reopen: { method: 'PATCH', url: 'https://gitee.com/api/v5/repos/acme/widgets/pulls/7', bodyContains: '{"state":"open"}' },
    },
    webhook: {
      body: fixture('gitee', 'webhooks/note-on-pull-request'),
      headers: token => ({ 'x-gitee-event': 'Note Hook', 'x-gitee-token': token }),
      sign: async (_body, secret) => secret,
      expect: { kind: 'comment', action: 'created', threadKind: 'pull_request', threadNumber: '9', actor: 'grace' },
    },
  },
  {
    name: 'azure-devops',
    checks: { summary: { state: 'failure', total: 2, failed: 1 }, names: ['netlify/deploy-preview', 'CI build'] },
    fixtures: 'azure-devops',
    instance: 'dev.azure.com',
    repo: { owner: 'acme/Widgets', name: 'widgets' },
    create: (fetch, options) => create(azureDevOps({
      auth: { type: 'token', token: 'test-pat' },
      organization: 'acme',
      fetch,
      timeout: options?.timeout,
      webhookSecret: WEBHOOK_SECRET,
    })),
    probe: instance => instance.repos.get({ forge: 'azure-devops', instance: 'dev.azure.com', owner: 'acme/Widgets', name: 'widgets' }),
    request: { path: '/acme/Widgets/_apis/git/repositories/widgets', field: 'defaultBranch' },
    thread: { number: '42', title: 'Add retry handling to the uploader', label: 'enhancement', eventKinds: ['comment', 'review_comment', 'review'], botActor: true },
    writes: {
      comment: { method: 'POST', url: 'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets/pullRequests/42/threads?api-version=7.1' },
      close: { method: 'PATCH', url: 'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets/pullRequests/42?api-version=7.1', bodyContains: '{"status":"abandoned"}' },
      reopen: { method: 'PATCH', url: 'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets/pullRequests/42?api-version=7.1', bodyContains: '{"status":"active"}' },
    },
    webhook: {
      body: fixture('azure-devops', 'webhooks/pull-request-comment'),
      headers: token => ({ authorization: `Basic ${token}` }),
      sign: async (_body, secret) => btoa(secret),
      expect: { kind: 'comment', action: 'created', threadKind: 'pull_request', threadNumber: '9', actor: 'grace@contoso.com' },
    },
  },
]
