import { describe, expect, it } from 'vitest'
import { hmacSha256Hex } from '../../src/crypto.ts'
import { MergeConflictError, UnsupportedOperationError } from '../../src/errors.ts'
import { gitcafe } from '../../src/gitcafe/index.ts'
import { verifyGitCafeSignature } from '../../src/gitcafe/webhooks.ts'
import { fixtureFetch } from '../../src/testing/index.ts'
import { payloadFixture } from '../utils/fixtures.ts'

const origin = { forge: 'gitcafe', instance: 'git.cafe' } as const
const repo = { ...origin, owner: 'acme', name: 'widgets' }
const issue = {
  ...origin,
  repo,
  kind: 'issue',
  number: '4',
} as const
const pull = { ...issue, kind: 'pull_request', number: '2' } as const
const base = 'https://git.cafe/api/repos/acme/widgets'
const SECRET = 'forges-fixture-secret'
const author = {
  kind: 'local',
  actorId: 'act_1',
  handle: 'ada',
  displayName: 'Ada',
  avatarUrl: null,
}
const rawIssue = {
  id: 'issue_4',
  number: 4,
  title: 'A thread',
  description: null,
  version: 3,
  stateType: 'started',
  author,
  closedAt: null,
  closedReason: null,
  lockedAt: null,
  createdAt: '2026-11-12T12:00:00.000Z',
  updatedAt: '2026-11-12T12:00:00.000Z',
  labels: [],
  assignees: [],
  milestone: null,
}
const rawPull = {
  id: 'pr_2',
  number: 2,
  title: 'A pull request',
  version: 5,
  state: 'open',
  draft: false,
  author,
  sourceBranch: 'feature',
  targetBranch: 'main',
  headOid: 'a'.repeat(40),
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  createdAt: '2026-11-12T12:00:00.000Z',
  updatedAt: '2026-11-12T12:00:00.000Z',
}
const empty = {
  status: 200,
  body: { items: [], next: null },
}

function provider(overrides: Parameters<typeof fixtureFetch>[1]) {
  const fixtures = fixtureFetch([], overrides)
  return {
    ...fixtures,
    forge: gitcafe({
      auth: { type: 'token', token: 't' },
      webhookSecret: SECRET,
      fetch: fixtures.fetch,
    }),
  }
}

async function signed(body: string, at: number = Date.now()) {
  const timestamp = String(Math.floor(at / 1000))
  return {
    headers: {
      'x-gitcafe-timestamp': timestamp,
      'x-gitcafe-signature': `sha256=${await hmacSha256Hex(SECRET, `${timestamp}.${body}`)}`,
    },
    body,
  }
}

describe('gitcafe webhooks', () => {
  it('verifies the signature over the timestamp and the body', async () => {
    const delivery = await signed('{"type":"webhook.ping"}')

    expect(await verifyGitCafeSignature(delivery, SECRET)).toBe(true)
    expect(await verifyGitCafeSignature({
      ...delivery,
      body: new TextEncoder().encode(delivery.body),
    }, SECRET)).toBe(true)
    expect(await verifyGitCafeSignature(delivery, 'another-secret')).toBe(false)
    expect(await verifyGitCafeSignature({ ...delivery, body: '{"type":"issue.created"}' }, SECRET)).toBe(false)
    expect(await verifyGitCafeSignature({
      ...delivery,
      headers: { ...delivery.headers, 'x-gitcafe-timestamp': '1' },
    }, SECRET)).toBe(false)
    expect(await verifyGitCafeSignature({ headers: {}, body: delivery.body }, SECRET)).toBe(false)
  })

  it('refuses a delivery signed more than five minutes ago', async () => {
    const stale = await signed('{}', Date.now() - 360_000)

    expect(await verifyGitCafeSignature(stale, SECRET)).toBe(false)
  })

  it('refuses a delivery dated in the future', async () => {
    const early = await signed('{}', Date.now() + 360_000)

    expect(await verifyGitCafeSignature(early, SECRET)).toBe(false)
  })

  it('refuses a delivery whose timestamp is not whole seconds', async () => {
    const delivery = await signed('{}')

    expect(await verifyGitCafeSignature({
      ...delivery,
      headers: { ...delivery.headers, 'x-gitcafe-timestamp': `${delivery.headers['x-gitcafe-timestamp']}.5` },
    }, SECRET)).toBe(false)
  })

  it('refuses a delivery that carries a timestamp but no signature', async () => {
    const { headers, body } = await signed('{}')

    expect(await verifyGitCafeSignature({
      headers: { 'x-gitcafe-timestamp': headers['x-gitcafe-timestamp'] },
      body,
    }, SECRET)).toBe(false)
  })

  it('refuses a signature that is not a sha256 digest', async () => {
    const { headers, body } = await signed('{}')

    expect(await verifyGitCafeSignature({
      headers: {
        ...headers,
        'x-gitcafe-signature': headers['x-gitcafe-signature'].replace('sha256=', ''),
      },
      body,
    }, SECRET)).toBe(false)
  })

  it('translates a comment that git.cafe delivered', async () => {
    const { forge } = provider({})
    const [event, ...rest] = await forge.webhooks.ingest(await signed(payloadFixture('gitcafe', 'webhooks/issue-comment-created')))

    expect(rest).toEqual([])
    expect(event).toMatchObject({
      id: 'evt_01m77vek38eh6by4jp7gcgzxrs',
      kind: 'comment',
      action: 'created',
      kindRaw: 'issue.comment_created',
      occurredAt: new Date('2026-11-12T12:24:18.792Z'),
      repo: { owner: 'oritwoen', name: 'forges-fixtures', externalId: 'repo_01m77v6ctsf7hr9pbfma3k2m0j' },
      thread: { kind: 'issue', number: '1' },
      threadSnapshot: {
        title: 'forges probe issue, edited',
        state: 'closed',
        stateRaw: 'completed',
        url: 'https://git.cafe/oritwoen/forges-fixtures/issues/1',
      },
      detail: {
        type: 'comment',
        comment: { id: 'icomment_01m77vek2tera8hsz6hgszk9qz' },
        body: 'A second comment, to make the webhook deliver something.',
      },
      source: 'webhook',
    })
    expect(event?.actor).toBeUndefined()
  })

  it('translates a push into one event for each ref', async () => {
    const { forge } = provider({})
    const events = await forge.webhooks.ingest(await signed(payloadFixture('gitcafe', 'webhooks/git-push')))

    expect(events.map(({ id, kind, action, detail }) => ({ id, kind, action, detail }))).toEqual([
      {
        id: 'evt_01m77vf0push0000000000000a:0',
        kind: 'push',
        action: 'other',
        detail: {
          type: 'push',
          ref: 'refs/heads/main',
          before: 'ee27a73933a3461c76a163e552677fff74df20b0',
          after: '4efff95668743e5b77cc09a8b26cad2abdedee5f',
          commitCount: undefined,
          forced: false,
          commits: [],
        },
      },
      {
        id: 'evt_01m77vf0push0000000000000a:1',
        kind: 'ref',
        action: 'created',
        detail: { type: 'ref', ref: 'refs/tags/v0.1.0', refType: 'tag' },
      },
    ])
  })

  it('translates a merge into a state change', async () => {
    const { forge } = provider({})
    const [event] = await forge.webhooks.ingest(await signed(payloadFixture('gitcafe', 'webhooks/pull-merged')))

    expect(event).toMatchObject({
      kind: 'state_change',
      action: 'merged',
      thread: { kind: 'pull_request', number: '2' },
      detail: { type: 'state_change', state: 'merged', draft: false },
      threadSnapshot: {
        state: 'merged',
        branches: {
          head: { ref: 'feature/shout' },
          base: { ref: 'main' },
        },
      },
    })
  })

  it('answers a ping with no events', async () => {
    const { forge } = provider({})

    expect(await forge.webhooks.ingest(await signed('{"id":"evt_1","type":"webhook.ping"}'))).toEqual([])
  })

  it('subscribes to the native events of each kind', async () => {
    const { forge, calls } = provider({
      [`POST ${base}/webhooks/`]: {
        status: 201,
        body: {
          endpoint: {
            id: 'whep_1',
            url: 'https://example.com/hook',
            events: ['git.push', 'label.created'],
            active: true,
            version: 1,
          },
          secret: 's',
        },
      },
    })
    const hook = await forge.webhooks.create(repo, {
      url: 'https://example.com/hook',
      events: ['push'],
      nativeEvents: ['label.created'],
      secret: SECRET,
    })

    expect(JSON.parse(calls[0]!.body!)).toEqual({
      url: 'https://example.com/hook',
      events: ['label.created', 'git.push'],
      secret: SECRET,
    })
    expect(hook).toMatchObject({
      ref: { id: 'whep_1', target: repo },
      events: ['push'],
      nativeEvents: ['git.push', 'label.created'],
    })
  })
})

describe('gitcafe writes', () => {
  it('sends the version of the thread and the ids of the labels', async () => {
    const { forge, calls } = provider({
      [`GET ${base}/labels?limit=50`]: {
        status: 200,
        body: {
          items: [
            { id: 'label_1', name: 'bug', color: '#d73a4a' },
            { id: 'label_2', name: 'later', color: 'purple' },
          ],
          next: null,
        },
      },
      [`GET ${base}/issues/4`]: { status: 200, body: rawIssue },
      [`PUT ${base}/issues/4/labels`]: {
        status: 200,
        body: {
          version: 4,
          items: [
            { id: 'label_2', name: 'later', color: 'purple' },
          ],
        },
      },
    })

    expect(await forge.threads.setLabels(issue, ['later'])).toEqual([
      { name: 'later', colour: undefined, description: undefined },
    ])
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({
      expectedVersion: 3,
      labelIds: ['label_2'],
    })
    await expect(forge.threads.setLabels(issue, ['missing'])).rejects.toThrow(UnsupportedOperationError)
  })

  it('closes an issue as canceled when it was not planned', async () => {
    const { forge, calls } = provider({
      [`GET ${base}/issues/4`]: { status: 200, body: rawIssue },
      [`POST ${base}/issues/4/close`]: {
        status: 200,
        body: { ...rawIssue, stateType: 'canceled' },
      },
    })
    await forge.threads.close(issue, { reason: 'not_planned' })

    expect(JSON.parse(calls.find(call => call.method === 'POST')!.body!)).toEqual({ expectedVersion: 3, state: 'canceled' })
  })

  it('opens a pull request from the id of the repository that holds the branch', async () => {
    const { forge, calls } = provider({
      [`GET https://git.cafe/api/repos/fork/widgets/`]: {
        status: 200,
        body: {
          id: 'repo_fork',
          owner: 'fork',
          name: 'widgets',
          topics: [],
          visibility: 'public',
          defaultBranch: 'main',
          archivedAt: null,
          updatedAt: '2026-11-12T12:00:00.000Z',
          description: null,
          homepage: null,
        },
      },
      [`POST ${base}/pulls/`]: { status: 201, body: rawPull },
      [`GET ${base}/pulls/2`]: { status: 200, body: rawPull },
      [`GET ${base}/pulls/2/labels?limit=50`]: empty,
      [`GET ${base}/pulls/2/assignees?limit=50`]: empty,
      [`GET ${base}/pulls/2/reviewers?limit=50`]: empty,
    })
    const thread = await forge.threads.create(repo, {
      kind: 'pull_request',
      title: 'A pull request',
      head: 'fork:feature',
      base: 'main',
    })

    expect(JSON.parse(calls.find(call => call.method === 'POST')!.body!)).toEqual({
      repo: 'repo_fork',
      source: 'feature',
      target: 'main',
      title: 'A pull request',
    })
    expect(thread).toMatchObject({
      kind: 'pull_request',
      state: 'open',
      url: 'https://git.cafe/acme/widgets/pull/2',
      branches: {
        head: {
          ref: 'feature',
          sha: 'a'.repeat(40),
        },
        base: { ref: 'main' },
      },
    })
    await expect(forge.threads.create(repo, {
      kind: 'pull_request',
      title: 'A draft',
      head: 'feature',
      base: 'main',
      draft: true,
    })).rejects.toThrow(UnsupportedOperationError)
  })

  it('merges with the head, the base and the version that the status reports', async () => {
    const status = {
      version: 5,
      headOid: 'a'.repeat(40),
      baseOid: 'b'.repeat(40),
      merge: {
        strategies: ['merge', 'squash'],
      },
    }
    const { forge, calls } = provider({
      [`GET ${base}/pulls/2/status`]: { status: 200, body: status },
      [`POST ${base}/pulls/2/merge`]: {
        status: 202,
        body: { id: 'op_1', state: 'accepted' },
      },
    })

    expect(await forge.threads.merge(pull, { method: 'squash' })).toMatchObject({ status: 'queued', sha: undefined })
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({
      expectedVersion: 5,
      headOid: 'a'.repeat(40),
      baseOid: 'b'.repeat(40),
      strategy: 'squash',
    })
    await expect(forge.threads.merge(pull)).rejects.toThrow('Pass a merge method')
    await expect(forge.threads.merge(pull, {
      method: 'squash',
      sha: 'c'.repeat(40),
    })).rejects.toThrow('not cccc')
  })

  it('rejects a merge that the forge reports as a conflict', async () => {
    const { forge } = provider({
      [`GET ${base}/pulls/2/status`]: {
        status: 200,
        body: {
          version: 5,
          headOid: 'a'.repeat(40),
          baseOid: 'b'.repeat(40),
          merge: {
            strategies: ['merge'],
          },
        },
      },
      [`POST ${base}/pulls/2/merge`]: {
        status: 200,
        body: { id: 'op_1', state: 'failed', failure: 'conflict' },
      },
    })

    await expect(forge.threads.merge(pull)).rejects.toThrow(MergeConflictError)
  })

  it('removes the reaction that the account left', async () => {
    const group = (value: string, viewerReactionId: string | null) => ({
      subject: { kind: 'issue', id: 'issue_4' },
      emoji: { kind: 'unicode', value },
      count: 1,
      viewerReactionId,
      reactors: [author],
    })
    const { forge, calls } = provider({
      [`GET ${base}/issues/4`]: { status: 200, body: rawIssue },
      [`GET ${base}/issues/4/reactions/?limit=50`]: {
        status: 200,
        body: {
          items: [
            group('🚀', null),
            group('❤', 'reaction_9'),
            {
              ...group('👍', 'reaction_7'),
              subject: { kind: 'issue_comment', id: 'icomment_1' },
            },
          ],
          next: null,
        },
      },
      [`DELETE ${base}/issues/4/reactions/reaction_9`]: { status: 204, body: undefined },
    })
    await forge.threads.unreact(issue, 'heart')
    await forge.threads.unreact(issue, 'rocket')

    expect(calls.filter(call => call.method === 'DELETE').map(call => call.url)).toEqual([`${base}/issues/4/reactions/reaction_9`])
    expect((await forge.threads.reactions(issue).page()).items.map(({ content, contentRaw, actor }) => [content, contentRaw, actor.login])).toEqual([
      ['rocket', '🚀', 'ada'],
      ['heart', '❤', 'ada'],
    ])
  })
})

describe('gitcafe webhook management', () => {
  it('refuses to rotate the secret of a webhook', async () => {
    const { forge, calls } = provider({})

    await expect(forge.webhooks.update({ ...origin, target: repo, id: 'hook_1' }, { secret: 'rotated' })).rejects.toBeInstanceOf(UnsupportedOperationError)
    expect(calls).toEqual([])
  })
})

describe('gitcafe reads', () => {
  it('lists merged pull requests after the closed ones', async () => {
    const page = (number: number, state: string) => ({
      status: 200,
      body: {
        items: [
          {
            ...rawPull,
            number,
            state,
            labels: [],
            assignees: [],
            reviewers: [],
          },
        ],
        next: null,
      },
    })
    const { forge, calls } = provider({
      [`GET ${base}/pulls/?state=closed&sort=newest`]: page(3, 'closed'),
      [`GET ${base}/pulls/?state=merged&sort=newest`]: page(2, 'merged'),
    })
    const threads = []
    for await (const thread of forge.threads.list(repo, { kind: 'pull_request', state: 'closed' })) {
      threads.push([thread.ref.number, thread.state])
    }

    expect(threads).toEqual([
      ['3', 'closed'],
      ['2', 'merged'],
    ])
    expect(calls).toHaveLength(2)
  })

  it('warns that pull requests cannot be sorted by their last update', async () => {
    const { forge, calls } = provider({
      [`GET ${base}/pulls/?state=open&sort=newest`]: empty,
    })
    const page = await forge.threads.list(repo, { kind: 'pull_request', sort: 'updated' }).page()

    expect(page.warnings?.map(warning => warning.code)).toEqual(['sort_unsupported'])
    expect(calls.map(call => new URL(call.url).search)).toEqual(['?state=open&sort=newest'])
  })

  it('matches labels on the page and leaves the forge\'s total out', async () => {
    const labelled = {
      ...rawIssue,
      number: 5,
      labels: [
        { id: 'label_1', name: 'bug', color: '#d73a4a' },
      ],
    }
    const { forge } = provider({
      [`GET ${base}/issues/?statuses=open&sort=created&direction=desc`]: {
        status: 200,
        body: {
          items: [rawIssue, labelled],
          next: null,
          total: 2,
        },
      },
    })
    const all = await forge.threads.list(repo, { kind: 'issue' }).page()
    const bugs = await forge.threads.list(repo, {
      kind: 'issue',
      labels: ['bug'],
    }).page()

    expect([all.items.length, all.total]).toEqual([2, 2])
    expect([
      bugs.items.map(thread => thread.ref.number),
      bugs.total,
    ]).toEqual([
      ['5'],
      undefined,
    ])
    expect(bugs.items[0]).toMatchObject({
      state: 'open',
      stateRaw: 'started',
      labels: [
        { name: 'bug', colour: 'd73a4a' },
      ],
    })
  })

  it('matches the outcome of a run on the page, since the forge filters only by completion', async () => {
    const run = (id: string, status: string, conclusion: string | null) => ({
      id,
      runNumber: 1,
      workflowName: 'ci',
      event: 'push',
      ref: 'refs/heads/main',
      headOid: 'a'.repeat(40),
      status,
      conclusion,
      actor: null,
      createdAt: '2026-11-12T12:00:00.000Z',
      startedAt: null,
      completedAt: null,
    })
    const { forge, calls } = provider({
      [`GET ${base}/actions/runs?status=completed`]: {
        status: 200,
        body: {
          items: [
            run('run_1', 'completed', 'success'),
            run('run_2', 'completed', 'failure'),
          ],
          next: null,
        },
      },
      [`GET ${base}/actions/runs`]: {
        status: 200,
        body: {
          items: [
            run('run_3', 'running', null),
            run('run_1', 'completed', 'success'),
          ],
          next: null,
        },
      },
    })
    const failed = await forge.ci.runs(repo, { state: 'failure' }).page()
    const pending = await forge.ci.runs(repo, { state: 'pending' }).page()

    expect(failed.items.map(item => [item.ref.id, item.state, item.branch])).toEqual([
      ['run_2', 'failure', 'main'],
    ])
    expect(pending.items.map(item => item.ref.id)).toEqual(['run_3'])
    expect(calls.map(call => new URL(call.url).search)).toEqual(['?status=completed', ''])
  })

  it('reports a commit status with the link in `target_url`', async () => {
    const { forge, calls } = provider({
      [`POST ${base}/statuses/${'a'.repeat(40)}`]: {
        status: 201,
        body: {
          id: 'cstatus_1',
          context: 'ci/test',
          state: 'success',
          description: null,
          targetUrl: 'https://example.com/run',
          createdAt: '2026-11-12T12:00:00.000Z',
          updatedAt: '2026-11-12T12:00:00.000Z',
        },
      },
    })
    const check = await forge.checks.report(repo, 'a'.repeat(40), { name: 'ci/test', state: 'success', url: 'https://example.com/run' })

    expect(JSON.parse(calls[0]!.body!)).toEqual({ context: 'ci/test', state: 'success', target_url: 'https://example.com/run' })
    expect(check).toMatchObject({
      name: 'ci/test',
      state: 'success',
      url: 'https://example.com/run',
      ref: { type: 'status' },
    })
  })

  it('tries a bare revision as a branch first and as a tag second', async () => {
    const missing = {
      status: 404,
      body: {
        type: 'about:blank',
        title: 'Git source request failed',
        status: 404,
        code: 'not-found',
      },
    }
    const { forge, calls } = provider({
      [`GET ${base}/commit?ref=refs%2Fheads%2Fv1.0.0`]: missing,
      [`GET ${base}/commit?ref=refs%2Ftags%2Fv1.0.0`]: {
        status: 200,
        body: {
          oid: 'd'.repeat(40),
        },
      },
      [`GET ${base}/commit?oid=${'e'.repeat(40)}`]: {
        status: 200,
        body: {
          oid: 'e'.repeat(40),
        },
      },
    })

    expect(await forge.contents.resolveRef(repo, 'v1.0.0')).toBe('d'.repeat(40))
    expect(calls).toHaveLength(2)
  })
})
