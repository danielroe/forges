import type { WebhookDelivery } from '../../src/index.ts'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translateAzureWebhook } from '../../src/azure-devops/events.ts'
import { translateBitbucketWebhook } from '../../src/bitbucket/events.ts'
import { translateOriginWebhook } from '../../src/cursor-origin/events.ts'
import { translateForgejoWebhook } from '../../src/forgejo/events.ts'
import { GITEA_HEADERS } from '../../src/forgejo/webhook-events.ts'
import { translateGiteeWebhook } from '../../src/gitee/events.ts'
import { translateGitHubWebhook } from '../../src/github/events.ts'
import { toEvent as toGitHubEvent } from '../../src/github/normalise.ts'
import { translateGitLabWebhook } from '../../src/gitlab/events.ts'
import { translateTangledWebhook } from '../../src/tangled/events.ts'
import { fixtureDirectory, payloadFixture } from '../utils/fixtures.ts'
import { markPayload } from '../utils/provenance.ts'

const NOW = new Date('2026-12-01T00:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

function recorded(recording: string, name: string): WebhookDelivery {
  const { headers, body } = JSON.parse(readFileSync(`${fixtureDirectory(recording)}${name}.delivery.json`, 'utf8')) as { headers: Record<string, string>, body: string }
  return { headers, body: markPayload(body, 'recorded') }
}

function times(events: Array<{ occurredAt: Date, undated?: boolean }>): Array<{ occurredAt: string, undated?: boolean }> {
  return events.map(({ occurredAt, undated }) => ({ occurredAt: occurredAt.toISOString(), ...undated && { undated } }))
}

const github = {
  repository: { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme', id: 2 } },
  sender: { login: 'octocat', id: 3, type: 'User' },
}

function githubDelivery(event: string, payload: Record<string, unknown>): WebhookDelivery {
  return { headers: { 'x-github-event': event, 'x-github-delivery': 'id' }, body: JSON.stringify({ ...github, ...payload }) }
}

function delivery(headers: Record<string, string>, payload: unknown): WebhookDelivery {
  return { headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}

describe('timeline entries', () => {
  const thread = { forge: 'github', instance: 'github.com', repo: { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '4' } as const

  it('dates an entry from the forge without marking it undated', () => {
    const event = toGitHubEvent('github.com', thread, { event: 'closed', created_at: '2026-09-20T10:00:00Z' })

    expect(times([event])).toEqual([{ occurredAt: '2026-09-20T10:00:00.000Z' }])
  })

  it('marks an entry without a time as undated at the Unix epoch', () => {
    expect(times([toGitHubEvent('github.com', thread, { event: 'closed' })])).toEqual([{ occurredAt: '1970-01-01T00:00:00.000Z', undated: true }])
  })
})

describe('github webhook times', () => {
  const translate = (delivery: WebhookDelivery) => times(translateGitHubWebhook('github.com', delivery))

  it('dates recorded deliveries from their payloads', () => {
    const recording = 'github/recorded/github.com-webhooks'

    expect(translate(recorded(recording, '03-push'))).toEqual([{ occurredAt: '2026-10-18T15:36:54.000Z' }])
    expect(translate(recorded(recording, '04-issues'))).toEqual([{ occurredAt: '2026-10-18T15:36:54.000Z' }])
    expect(translate(recorded(recording, '05-issue_comment'))).toEqual([{ occurredAt: '2026-10-18T15:36:55.000Z' }])
    expect(translate(recorded(recording, '06-issues'))).toEqual([{ occurredAt: '2026-10-18T15:36:56.000Z' }])
    expect(translate(recorded(recording, '07-issues'))).toEqual([{ occurredAt: '2026-10-18T15:36:57.000Z' }])
    expect(translate(recorded(recording, '08-issues'))).toEqual([{ occurredAt: '2026-10-18T15:36:58.000Z' }])
  })

  it('dates a merge, an edit, a review and a label from the payload', () => {
    const pull = { number: 4, created_at: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T12:00:00Z', closed_at: '2026-09-20T11:00:00Z' }

    expect(translate(githubDelivery('pull_request', { action: 'closed', pull_request: { ...pull, merged: true, merged_at: '2026-09-20T10:59:59Z' } }))).toEqual([{ occurredAt: '2026-09-20T10:59:59.000Z' }])
    expect(translate(githubDelivery('issue_comment', { action: 'edited', issue: pull, comment: { id: 1, created_at: '2026-09-20T09:30:00Z', updated_at: '2026-09-20T09:45:00Z' } }))).toEqual([{ occurredAt: '2026-09-20T09:45:00.000Z' }])
    expect(translate(githubDelivery('pull_request_review', { action: 'submitted', pull_request: pull, review: { id: 80, state: 'approved', submitted_at: '2026-09-20T09:50:00Z' } }))).toEqual([{ occurredAt: '2026-09-20T09:50:00.000Z' }])
    expect(translate(githubDelivery('pull_request', { action: 'labeled', pull_request: pull, label: { name: 'bug' } }))).toEqual([{ occurredAt: '2026-09-20T12:00:00.000Z' }])
  })

  it('marks a delivery without a time as undated at its arrival', () => {
    expect(translate(recorded('github/recorded/github.com-webhooks', '01-ping'))).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
    expect(translate(githubDelivery('create', { ref: 'main', ref_type: 'branch' }))).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })

  it('marks a deletion as undated at its arrival', () => {
    const issue = { number: 4, created_at: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T12:00:00Z' }
    const comment = { id: 1, created_at: '2026-09-20T09:30:00Z', updated_at: '2026-09-20T09:45:00Z' }

    expect(translate(githubDelivery('issue_comment', { action: 'deleted', issue, comment }))).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
    expect(translate(githubDelivery('issues', { action: 'deleted', issue }))).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })
})

describe('forgejo and gitea webhook times', () => {
  const forgejo = (event: string, payload: unknown) => times(translateForgejoWebhook({ forge: 'forgejo', instance: 'codeberg.org' }, delivery({ 'x-forgejo-event': event }, payload)))
  const gitea = (body: WebhookDelivery) => times(translateForgejoWebhook({ forge: 'gitea', instance: 'gitea.com' }, body, GITEA_HEADERS))
  const repository = { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme', id: 2 } }

  it('dates recorded and documented deliveries from their payloads', () => {
    const recording = 'gitea/recorded/gitea.com-webhooks'

    expect(gitea(recorded(recording, '01-issues'))).toEqual([{ occurredAt: '2026-10-09T20:08:21.000Z' }])
    expect(gitea(recorded(recording, '02-issue_comment'))).toEqual([{ occurredAt: '2026-10-09T20:08:22.000Z' }])
    expect(gitea(recorded(recording, '03-issues'))).toEqual([{ occurredAt: '2026-10-09T20:08:23.000Z' }])
    expect(gitea(recorded(recording, '04-push'))).toEqual([{ occurredAt: '2026-10-09T20:08:23.000Z' }])
    expect(forgejo('issue_comment', payloadFixture('forgejo', 'webhooks/issue-comment-created'))).toEqual([{ occurredAt: '2025-09-18T10:05:00.000Z' }])
  })

  it('dates a push from its head commit', () => {
    const commits = [{ id: 'b0b', message: 'Newer', timestamp: '2026-09-20T10:00:00Z' }, { id: 'a0a', message: 'Older', timestamp: '2026-09-19T10:00:00Z' }]

    expect(forgejo('push', { ref: 'refs/heads/main', before: '9f9', after: 'b0b', commits, head_commit: commits[0], repository })).toEqual([{ occurredAt: '2026-09-20T10:00:00.000Z' }])
  })

  it('dates a merge and a review from the pull request', () => {
    const pull = { number: 7, created_at: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T12:00:00Z', closed_at: '2026-09-20T11:00:00Z' }

    expect(forgejo('pull_request', { action: 'closed', pull_request: { ...pull, merged: true, merged_at: '2026-09-20T10:59:59Z' }, repository })).toEqual([{ occurredAt: '2026-09-20T10:59:59.000Z' }])
    expect(forgejo('pull_request_review_approved', { action: 'reviewed', pull_request: pull, review: { type: 'pull_request_review_approved', content: 'LGTM' }, repository })).toEqual([{ occurredAt: '2026-09-20T12:00:00.000Z' }])
  })

  it('marks a delivery without a time as undated at its arrival', () => {
    expect(forgejo('create', { ref: 'main', ref_type: 'branch', repository })).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })

  it('marks a deletion as undated at its arrival', () => {
    const issue = { number: 7, created_at: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T12:00:00Z' }
    const comment = { id: 1, created_at: '2026-09-20T09:30:00Z', updated_at: '2026-09-20T09:45:00Z' }

    expect(forgejo('issue_comment', { action: 'deleted', issue, comment, repository })).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
    expect(forgejo('issues', { action: 'deleted', issue, repository })).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })
})

describe('bitbucket webhook times', () => {
  const translate = (body: WebhookDelivery) => times(translateBitbucketWebhook('bitbucket.org', body))

  it('dates recorded and documented deliveries from their payloads', () => {
    const recording = 'bitbucket/recorded/bitbucket.org-webhooks'

    expect(translate(recorded(recording, '01-pullrequest-created'))).toEqual([{ occurredAt: '2026-10-09T20:12:12.057Z' }])
    expect(translate(recorded(recording, '02-repo-push'))).toEqual([{ occurredAt: '2026-10-09T20:12:09.000Z' }])
    expect(translate(recorded(recording, '03-pullrequest-comment_created'))).toEqual([{ occurredAt: '2026-10-09T20:12:12.945Z' }])
    expect(translate(recorded(recording, '04-pullrequest-rejected'))).toEqual([{ occurredAt: '2026-10-09T20:12:13.914Z' }])
    expect(translate(delivery({ 'x-event-key': 'pullrequest:comment_created' }, payloadFixture('bitbucket', 'webhooks/pullrequest-comment-created')))).toEqual([{ occurredAt: '2025-09-18T10:00:00.000Z' }])
  })

  it('dates a request for changes from the request', () => {
    const payload = { repository: { full_name: 'acme/widgets' }, pullrequest: { id: 4, updated_on: '2026-09-20T12:00:00Z' }, changes_request: { date: '2026-09-20T11:00:00Z' } }

    expect(translate(delivery({ 'x-event-key': 'pullrequest:changes_request_created' }, payload))).toEqual([{ occurredAt: '2026-09-20T11:00:00.000Z' }])
  })

  it('marks a delivery without a time as undated at its arrival', () => {
    expect(translate(delivery({ 'x-event-key': 'repo:transfer' }, { repository: { full_name: 'acme/widgets' }, previous_workspace: { slug: 'old' } }))).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })

  it('marks a deleted comment as undated at its arrival', () => {
    const payload = { repository: { full_name: 'acme/widgets' }, pullrequest: { id: 4, updated_on: '2026-09-20T12:00:00Z' }, comment: { id: 1, created_on: '2026-09-20T09:30:00Z', updated_on: '2026-09-20T09:45:00Z' } }

    expect(translate(delivery({ 'x-event-key': 'pullrequest:comment_deleted' }, payload))).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })
})

describe('gitee webhook times', () => {
  const translate = (hook: string, payload: unknown) => times(translateGiteeWebhook('gitee.com', delivery({ 'x-gitee-event': hook }, payload)))
  const repository = { id: 1, full_name: 'acme/widgets', path: 'widgets' }

  it('dates a documented comment from the payload', () => {
    expect(translate('Note Hook', payloadFixture('gitee', 'webhooks/note-on-pull-request'))).toEqual([{ occurredAt: '2026-09-20T02:00:00.000Z' }])
  })

  it('dates a merge from the pull request, and a push from its head commit', () => {
    const pull_request = { number: 4, created_at: '2026-09-20T09:00:00+08:00', updated_at: '2026-09-20T12:00:00+08:00', merged_at: '2026-09-20T11:00:00+08:00' }

    expect(translate('Merge Request Hook', { hook_name: 'merge_request_hooks', action: 'merge', pull_request, repository })).toEqual([{ occurredAt: '2026-09-20T03:00:00.000Z' }])
    const head = { id: 'b0b', message: 'Fix', timestamp: '2026-09-20T10:00:00+08:00' }
    expect(translate('Push Hook', { hook_name: 'push_hooks', ref: 'refs/heads/main', before: 'a0a', after: 'b0b', commits: [head], head_commit: head, timestamp: '1758358800000', repository })).toEqual([{ occurredAt: '2026-09-20T02:00:00.000Z' }])
  })

  it('marks a delivery without a time as undated at its arrival', () => {
    expect(translate('Push Hook', { hook_name: 'push_hooks', ref: 'refs/heads/main', before: 'a0a', after: 'b0b', commits: [], timestamp: '1758358800000', repository })).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })
})

describe('tangled webhook times', () => {
  const translate = (event: string, payload: unknown) => times(translateTangledWebhook('tangled.org', delivery({ 'x-tangled-event': event }, payload), 'https://tangled.org'))
  const opened = payloadFixture('tangled', 'webhooks/pull-request-created')

  it('dates an opened pull request from its record', () => {
    expect(translate('pull_request:created', opened)).toEqual([{ occurredAt: '2025-09-15T08:00:00.000Z' }])
  })

  it('marks other deliveries as undated at their arrival', () => {
    expect(translate('pull_request:merged', { ...JSON.parse(opened), action: 'merged' })).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
    expect(translate('push', { ref: 'refs/heads/main', before: 'a0a', after: 'b0b', pusher: { did: 'did:plc:ada' }, repository: { name: 'widgets', owner: { did: 'did:plc:ada' }, updated_at: '2025-09-01T00:00:00Z' } })).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })
})

describe('azure devops webhook times', () => {
  const translate = (payload: unknown) => times(translateAzureWebhook('dev.azure.com', 'acme', delivery({}, payload)))

  it('dates a documented delivery from the service hook event', () => {
    expect(translate(payloadFixture('azure-devops', 'webhooks/pull-request-comment'))).toEqual([{ occurredAt: '2026-09-20T10:00:01.000Z' }])
  })

  it('marks a delivery without a time as undated at its arrival', () => {
    expect(translate({ id: 'e1', eventType: 'git.repo.created', resource: {} })).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })
})

describe('cursor origin webhook times', () => {
  const translate = (payload: unknown) => times(translateOriginWebhook('origin.cursor.com', delivery({}, payload)))
  const repository = { id: 'repo_1', name: 'widgets', owner: { slug: 'acme' } }
  const pullRequest = { id: 'pr_1', number: '12' }

  it('dates a documented delivery and a review from the event time', () => {
    expect(translate(payloadFixture('cursor-origin', 'webhooks/pull-request-comment-created'))).toEqual([{ occurredAt: '2026-09-20T09:30:00.000Z' }])
    expect(translate({ deliveryId: 'whd_1', event: { id: 'evt_1', type: 'pull_request.review.submitted', eventTime: '2026-09-20T09:40:00Z', payload: { repository, pullRequest, review: { id: 'rev_1', verdict: 'approve' } } } })).toEqual([{ occurredAt: '2026-09-20T09:40:00.000Z' }])
  })

  it('dates a review without an event time from its submission', () => {
    expect(translate({ deliveryId: 'whd_1', event: { id: 'evt_1', type: 'pull_request.review.submitted', payload: { repository, pullRequest, review: { id: 'rev_1', verdict: 'approve', submittedAt: '2026-09-20T09:40:00Z' } } } })).toEqual([{ occurredAt: '2026-09-20T09:40:00.000Z' }])
  })

  it('marks a delivery without a time as undated at its arrival', () => {
    expect(translate({ deliveryId: 'whd_1', event: { id: 'evt_1', type: 'repository.created', payload: { repository } } })).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })
})

describe('gitlab webhook times', () => {
  const translate = (body: WebhookDelivery) => times(translateGitLabWebhook('gitlab.com', body))
  const project = { id: 1, path_with_namespace: 'acme/widgets' }

  it('dates recorded and documented deliveries from their payloads', () => {
    const recording = 'gitlab/recorded/gitlab.com-webhooks'

    expect(translate(recorded(recording, '01-issue-hook'))).toEqual([{ occurredAt: '2026-10-09T19:57:40.681Z' }])
    expect(translate(recorded(recording, '02-note-hook'))).toEqual([{ occurredAt: '2026-10-09T19:57:41.398Z' }])
    expect(translate(recorded(recording, '03-issue-hook'))).toEqual([{ occurredAt: '2026-10-09T19:57:41.971Z' }])
    expect(translate(recorded(recording, '04-issue-hook'))).toEqual([{ occurredAt: '2026-10-09T19:57:42.195Z' }])
    expect(translate(delivery({ 'x-gitlab-event': 'Note Hook' }, payloadFixture('gitlab', 'webhooks/note-on-issue')))).toEqual([{ occurredAt: '2025-09-18T10:05:00.000Z' }])
  })

  it('dates a release from its creation and an edited note from its update', () => {
    expect(translate(delivery({ 'x-gitlab-event': 'Release Hook' }, { object_kind: 'release', action: 'create', tag: 'v1.1', created_at: '2026-09-20 10:00:00 UTC', released_at: '2026-09-01 00:00:00 UTC', project }))).toEqual([{ occurredAt: '2026-09-20T10:00:00.000Z' }])
    expect(translate(delivery({ 'x-gitlab-event': 'Note Hook' }, { object_kind: 'note', object_attributes: { id: 1, action: 'update', note: 'Fixed', created_at: '2026-09-20T09:00:00Z', updated_at: '2026-09-20T09:30:00Z' }, issue: { iid: 3 }, project }))).toEqual([{ occurredAt: '2026-09-20T09:30:00.000Z' }])
  })

  it('marks a delivery without a time as undated at its arrival', () => {
    expect(translate(delivery({ 'x-gitlab-event': 'Push Hook' }, { object_kind: 'push', ref: 'refs/heads/old', before: 'a0a', after: '0000000000000000000000000000000000000000', commits: [], project }))).toEqual([{ occurredAt: NOW.toISOString(), undated: true }])
  })
})
