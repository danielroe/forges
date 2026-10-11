import type { components } from '@octokit/openapi-webhooks-types'
import type { GitHubEventPayload } from '../../src/github/events.ts'
import { describe, expect, it } from 'vitest'

type Schemas = components['schemas']
type Accepts<T extends GitHubEventPayload> = T

export type Translated = [
  Accepts<Schemas['webhook-issue-comment-created']>,
  Accepts<Schemas['webhook-issues-closed']>,
  Accepts<Schemas['webhook-issues-labeled']>,
  Accepts<Schemas['webhook-pull-request-closed']>,
  Accepts<Schemas['webhook-pull-request-synchronize']>,
  Accepts<Schemas['webhook-pull-request-review-submitted']>,
  Accepts<Schemas['webhook-pull-request-review-comment-created']>,
  Accepts<Schemas['webhook-discussion-closed']>,
  Accepts<Schemas['webhook-push']>,
  Accepts<Schemas['webhook-create']>,
  Accepts<Schemas['webhook-delete']>,
  Accepts<Schemas['webhook-release-published']>,
  Accepts<Schemas['webhook-repository-renamed']>,
  Accepts<Schemas['webhook-installation-created']>,
  Accepts<Schemas['webhook-member-added']>,
]

describe('github webhook payload types', () => {
  it('accepts every payload GitHub documents for the events it translates (checked by tsc)', () => {
    expect(true).toBe(true)
  })
})
