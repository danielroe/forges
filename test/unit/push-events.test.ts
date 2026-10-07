import type { WebhookDelivery } from '../../src/index.ts'
import type { ForgeEventInput } from '../../src/kit.ts'
import { describe, expect, it } from 'vitest'
import { translateAzureWebhook } from '../../src/azure-devops/webhooks.ts'
import { translateBitbucketWebhook } from '../../src/bitbucket/webhooks.ts'
import { translateOriginWebhook } from '../../src/cursor-origin/webhooks.ts'
import { translateForgejoWebhook } from '../../src/forgejo/webhooks.ts'
import { translateGiteeWebhook } from '../../src/gitee/webhooks.ts'
import { translateGitHubWebhook } from '../../src/github/webhooks.ts'
import { translateGitLabWebhook } from '../../src/gitlab/webhooks.ts'
import { translateTangledWebhook } from '../../src/tangled/webhooks.ts'
import { CASES } from './push-cases.ts'

const TRANSLATE: Record<string, (delivery: WebhookDelivery) => ForgeEventInput[]> = {
  github: delivery => translateGitHubWebhook('github.com', delivery),
  gitlab: delivery => translateGitLabWebhook('gitlab.com', delivery),
  forgejo: delivery => translateForgejoWebhook({ forge: 'forgejo', instance: 'codeberg.org' }, delivery),
  bitbucket: delivery => translateBitbucketWebhook('bitbucket.org', delivery),
  gitee: delivery => translateGiteeWebhook('gitee.com', delivery),
  azure: delivery => translateAzureWebhook('dev.azure.com', 'acme', delivery),
  origin: delivery => translateOriginWebhook('origin.cursor.com', delivery),
  tangled: delivery => translateTangledWebhook('tangled.sh', delivery, 'https://tangled.sh'),
}

const EXPECTED: Record<string, Array<Pick<ForgeEventInput, 'kind' | 'action' | 'summary' | 'detail'>>> = {
  'github push': [
    {
      kind: 'push',
      summary: 'ada pushed 1 commit(s) to main',
      detail: {
        type: 'push',
        ref: 'refs/heads/main',
        before: 'a0a',
        after: 'b0b',
        commitCount: 1,
        forced: true,
        commits: [
          {
            sha: 'b0b',
            message: 'Fix retry',
            author: 'ada',
            url: 'https://example.test/c/b0b',
          },
        ],
      },
    },
  ],
  'github delete push': [
    {
      kind: 'ref',
      action: 'deleted',
      summary: 'ada deleted v1',
      detail: {
        type: 'ref',
        ref: 'refs/tags/v1',
        refType: 'tag',
      },
    },
  ],
  'gitlab push': [
    {
      kind: 'push',
      summary: 'ada pushed 3 commit(s) to main',
      detail: {
        type: 'push',
        ref: 'refs/heads/main',
        before: 'a0a',
        after: 'b0b',
        commitCount: 3,
        forced: false,
        commits: [
          {
            sha: 'b0b',
            message: 'Fix retry',
            author: 'Ada',
            url: 'https://example.test/c/b0b',
          },
        ],
      },
    },
  ],
  'gitlab delete': [
    {
      kind: 'ref',
      action: 'deleted',
      summary: 'ada deleted old',
      detail: {
        type: 'ref',
        ref: 'refs/heads/old',
        refType: 'branch',
      },
    },
  ],
  'gitlab tag create': [
    {
      kind: 'ref',
      action: 'created',
      summary: 'ada created v1.0.0',
      detail: {
        type: 'ref',
        ref: 'refs/tags/v1.0.0',
        refType: 'tag',
      },
    },
  ],
  'forgejo push': [
    {
      kind: 'push',
      summary: 'ada pushed 2 commit(s) to main',
      detail: {
        type: 'push',
        ref: 'refs/heads/main',
        before: 'a0a',
        after: 'b0b',
        commitCount: 2,
        forced: false,
        commits: [
          {
            sha: 'b0b',
            message: 'Fix retry',
            author: 'ada',
            url: 'https://example.test/c/b0b',
          },
        ],
      },
    },
  ],
  'forgejo delete push': [
    {
      kind: 'ref',
      action: 'deleted',
      summary: 'ada deleted old',
      detail: {
        type: 'ref',
        ref: 'refs/heads/old',
        refType: 'branch',
      },
    },
  ],
  'bitbucket push': [
    {
      kind: 'push',
      summary: 'ada pushed 1 commit(s) to main',
      detail: {
        type: 'push',
        ref: 'main',
        before: 'a0a',
        after: 'b0b',
        commitCount: 1,
        forced: true,
        commits: [
          {
            sha: 'b0b',
            message: 'Fix retry',
            author: 'Ada <ada@example.test>',
            url: 'https://example.test/c/b0b',
          },
        ],
      },
    },
    {
      kind: 'ref',
      action: 'created',
      summary: 'ada created v1',
      detail: {
        type: 'ref',
        ref: 'v1',
        refType: 'tag',
      },
    },
    {
      kind: 'ref',
      action: 'deleted',
      summary: 'ada deleted gone',
      detail: {
        type: 'ref',
        ref: 'gone',
        refType: 'branch',
      },
    },
  ],
  'gitee push': [
    {
      kind: 'push',
      summary: 'ada pushed 1 commit(s) to main',
      detail: {
        type: 'push',
        ref: 'refs/heads/main',
        before: 'a0a',
        after: 'b0b',
        commitCount: 1,
        forced: false,
        commits: [
          {
            sha: 'b0b',
            message: 'Fix retry',
            author: 'ada',
            url: 'https://example.test/c/b0b',
          },
        ],
      },
    },
  ],
  'gitee tag create': [
    {
      kind: 'ref',
      action: 'created',
      summary: 'ada created v1',
      detail: {
        type: 'ref',
        ref: 'refs/tags/v1',
        refType: 'tag',
      },
    },
  ],
  'azure push': [
    {
      kind: 'push',
      summary: 'ada@contoso.com pushed 1 commit(s) to main',
      detail: {
        type: 'push',
        ref: 'refs/heads/main',
        before: 'a0a',
        after: 'b0b',
        commitCount: 1,
        forced: false,
        commits: [
          {
            sha: 'b0b',
            message: 'Fix retry',
            author: 'Ada',
            url: 'https://example.test/c/b0b',
          },
        ],
      },
    },
    {
      kind: 'ref',
      action: 'created',
      summary: 'ada@contoso.com created new',
      detail: {
        type: 'ref',
        ref: 'refs/heads/new',
        refType: 'branch',
      },
    },
    {
      kind: 'ref',
      action: 'deleted',
      summary: 'ada@contoso.com deleted old',
      detail: {
        type: 'ref',
        ref: 'refs/tags/old',
        refType: 'tag',
      },
    },
  ],
  'origin push': [
    {
      kind: 'push',
      summary: 'ada pushed to main',
      detail: {
        type: 'push',
        ref: 'refs/heads/main',
        before: 'a0a',
        after: 'b0b',
        commitCount: 1,
        forced: true,
        commits: [
          {
            sha: 'b0b',
            message: 'Fix retry',
          },
        ],
      },
    },
    {
      kind: 'ref',
      action: 'created',
      summary: 'ada created v1',
      detail: {
        type: 'ref',
        ref: 'refs/tags/v1',
        refType: 'tag',
      },
    },
    {
      kind: 'ref',
      action: 'deleted',
      summary: 'ada deleted gone',
      detail: {
        type: 'ref',
        ref: 'refs/heads/gone',
        refType: 'branch',
      },
    },
  ],
  'tangled push': [
    {
      kind: 'push',
      summary: 'did:plc:ada pushed 1 commit(s) to main',
      detail: {
        type: 'push',
        ref: 'refs/heads/main',
        before: 'a0a',
        after: 'b0b',
        commitCount: 1,
        forced: false,
        commits: [{ sha: 'b0b', message: 'Fix retry', author: 'did:plc:ada' }],
      },
    },
  ],
  'tangled delete push': [
    {
      kind: 'ref',
      action: 'deleted',
      summary: 'did:plc:ada deleted v1',
      detail: {
        type: 'ref',
        ref: 'refs/tags/v1',
        refType: 'tag',
      },
    },
  ],
}

describe('push webhooks', () => {
  it.each(Object.keys(CASES))('%s', (name) => {
    const { forge, headers, payload } = CASES[name]!
    const events = TRANSLATE[forge]!({ headers, body: JSON.stringify(payload) })

    expect(events.map(({ kind, action, summary, detail }) => ({ kind, action, summary, detail }))).toEqual(EXPECTED[name])
  })
})
