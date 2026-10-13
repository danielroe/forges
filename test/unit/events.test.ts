import type { WebhookDelivery } from '../../src/index.ts'
import { describe, expect, it } from 'vitest'
import { toActivityEvent as toBitbucketActivityEvent } from '../../src/bitbucket/normalise.ts'
import { translateBitbucketWebhook } from '../../src/bitbucket/webhooks.ts'
import { toReview as toOriginReview, toReviewEvent as toOriginReviewEvent } from '../../src/cursor-origin/normalise.ts'
import { translateOriginWebhook } from '../../src/cursor-origin/webhooks.ts'
import { completeEvent, eventAction } from '../../src/events.ts'
import { fake } from '../../src/fake/index.ts'
import { toEvent as toForgejoEvent, toReview as toForgejoReview } from '../../src/forgejo/normalise.ts'
import { translateGitHubWebhook } from '../../src/github/events.ts'
import { toEvent as toGitHubEvent, toReview } from '../../src/github/normalise.ts'
import { toFeedEvent as toGitLabFeedEvent } from '../../src/gitlab/feed.ts'
import { toNoteEvent as toGitLabNoteEvent } from '../../src/gitlab/normalise.ts'
import { translateGitLabWebhook } from '../../src/gitlab/webhooks.ts'
import { reviewState } from '../../src/kit.ts'

const repository = { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme', id: 2 } }
const sender = { login: 'octocat', id: 3, type: 'User' }

function github(event: string, payload: Record<string, unknown>): WebhookDelivery {
  return { headers: { 'x-github-event': event, 'x-github-delivery': 'id' }, body: JSON.stringify({ repository, sender, ...payload }) }
}

describe('event actions', () => {
  it('normalises forge-native verbs', () => {
    expect(['closed', 'close', 'synchronize', 'label_added', 'Update'].map(eventAction)).toEqual(['closed', 'closed', 'synchronised', 'labelled', 'edited'])
    expect(eventAction('cross-referenced')).toBeUndefined()
  })

  it('derives the action from `kindRaw`, then the kind', () => {
    const base = { forge: 'github', instance: 'github.com', id: '1', summary: '', occurredAt: new Date(0), source: 'poll', payload: {} } as const
    expect(completeEvent({ ...base, kind: 'state_change', kindRaw: 'issues.reopened' }).action).toBe('reopened')
    expect(completeEvent({ ...base, kind: 'comment', kindRaw: 'commented' }).action).toBe('created')
    expect(completeEvent({ ...base, kind: 'review', kindRaw: 'reviewed' }).action).toBe('submitted')
    expect(completeEvent({ ...base, kind: 'other', kindRaw: 'cross-referenced' }).action).toBe('other')
  })

  it('normalises review verdicts', () => {
    expect(['APPROVED', 'request_changes', 'COMMENTED', 'weird'].map(reviewState)).toEqual(['approved', 'changes_requested', 'commented', 'unknown'])
  })
})

describe('github webhook detail', () => {
  it('marks a merged pull as `merged` rather than `closed`', () => {
    const [event] = translateGitHubWebhook('github.com', github('pull_request', { action: 'closed', pull_request: { number: 4, merged: true } }))

    expect(event).toMatchObject({ kind: 'state_change', action: 'merged', actionRaw: 'closed', detail: { type: 'state_change', state: 'merged' } })
  })

  it('types a comment on a pull as a pull request thread', () => {
    const [event] = translateGitHubWebhook('github.com', github('issue_comment', { action: 'created', issue: { number: 4, pull_request: {} }, comment: { id: 9, body: 'Thanks!' } }))

    expect(event!.thread!.kind).toBe('pull_request')
    expect(event!.detail).toMatchObject({ type: 'comment', body: 'Thanks!', comment: { id: '9', thread: { kind: 'pull_request', number: '4' } } })
  })

  it('carries the review verdict and label name', () => {
    const [review] = translateGitHubWebhook('github.com', github('pull_request_review', { action: 'submitted', pull_request: { number: 4 }, review: { state: 'changes_requested', body: 'Nearly' } }))
    const [label] = translateGitHubWebhook('github.com', github('issues', { action: 'unlabeled', issue: { number: 5 }, label: { name: 'bug' } }))

    expect(review!.detail).toEqual({ type: 'review', state: 'changes_requested', stateRaw: 'changes_requested', body: 'Nearly' })
    expect(label).toMatchObject({ kind: 'label', action: 'unlabelled', detail: { type: 'label', label: 'bug' } })
  })

  it('reports a review request as an assignment of the requested reviewer', () => {
    const reviewer = { login: 'hubot', id: 4, type: 'User' }
    const [webhook] = translateGitHubWebhook('github.com', github('pull_request', { action: 'review_requested', pull_request: { number: 4 }, requested_reviewer: reviewer }))
    const polled = toGitHubEvent('github.com', { forge: 'github', instance: 'github.com', repo: { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '4' }, { event: 'review_requested', actor: sender, requested_reviewer: reviewer })

    for (const event of [webhook!, completeEvent(polled)]) {
      expect(event).toMatchObject({ kind: 'assignment', action: 'review_requested', detail: { type: 'assignment', assignee: { login: 'hubot' } } })
    }
    expect(polled.summary).toBe('octocat requested review from hubot')
  })

  it('matches "anything that closed" across kinds', () => {
    const closed = [
      translateGitHubWebhook('github.com', github('issues', { action: 'closed', issue: { number: 5 } })),
      translateGitHubWebhook('github.com', github('discussion', { action: 'closed', discussion: { number: 6 } })),
    ].flat().map(completeEvent)

    expect(closed.map(event => [event.thread!.kind, event.action])).toEqual([['issue', 'closed'], ['discussion', 'closed']])
  })
})

describe('review identity', () => {
  const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets', externalId: '1' } as const
  const pull = { forge: 'github', instance: 'github.com', repo, kind: 'pull_request', number: '4' } as const

  it('names the same GitHub review from a webhook, the timeline and the review listing', () => {
    const [webhook] = translateGitHubWebhook('github.com', github('pull_request_review', { action: 'submitted', pull_request: { number: 4 }, review: { id: 80, node_id: 'PRR_kwDOAAABCDE', state: 'approved' } }))
    const polled = toGitHubEvent('github.com', pull, { id: 80, node_id: 'PRR_kwDOAAABCDE', event: 'reviewed', state: 'approved', submitted_at: '2026-09-20T09:00:00Z' })
    const listed = toReview(pull, { id: 80, state: 'APPROVED' }, [])

    expect(webhook!.detail).toMatchObject({ type: 'review', review: listed.ref })
    expect(polled.detail).toMatchObject({ type: 'review', review: listed.ref })
  })

  it('names the same Origin review from a webhook, the timeline and the review listing', () => {
    const thread = { forge: 'cursor-origin', instance: 'origin.cursor.com', repo: { forge: 'cursor-origin', instance: 'origin.cursor.com', owner: 'acme', name: 'widgets', externalId: 'repo_1' }, kind: 'pull_request', number: '12', externalId: 'pr_1' } as const
    const review = { id: 'rev_1', verdict: 'approve', submittedAt: '2026-09-20T09:00:00Z' } as const
    const [webhook] = translateOriginWebhook('origin.cursor.com', { headers: {}, body: JSON.stringify({ deliveryId: 'whd_1', event: { id: 'evt_1', type: 'pull_request.review.submitted', payload: { repository: { id: 'repo_1', name: 'widgets', owner: { slug: 'acme' } }, pullRequest: { id: 'pr_1', number: '12' }, review } } }) })
    const listed = toOriginReview(thread, review)

    expect(webhook!.detail).toEqual({ type: 'review', state: 'approved', stateRaw: 'approve', review: listed.ref })
    expect(toOriginReviewEvent(thread, review).detail).toEqual(webhook!.detail)
  })

  it('names the same Forgejo review from the timeline and the review listing', () => {
    const thread = { forge: 'forgejo', instance: 'codeberg.org', repo: { forge: 'forgejo', instance: 'codeberg.org', owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '7' } as const
    const polled = toForgejoEvent(thread, { id: 90, type: 'review', review_id: 31, body: 'Looks good', created_at: '2026-09-20T09:00:00Z' })
    const listed = toForgejoReview(thread, { id: 31, state: 'APPROVED' }, false)

    expect(polled.detail).toMatchObject({ type: 'review', review: listed.ref })
  })

  it('names a GitLab approval as the review listing does', () => {
    const project = { id: 1, path_with_namespace: 'acme/widgets', name: 'widgets', namespace: { full_path: 'acme' } }
    const thread = { forge: 'gitlab', instance: 'gitlab.com', repo: { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: 'widgets', externalId: '1' }, kind: 'pull_request', number: '23' } as const
    const user = { id: 5, username: 'grace' }
    const [webhook] = translateGitLabWebhook('gitlab.com', { headers: { 'x-gitlab-event': 'Merge Request Hook' }, body: JSON.stringify({ object_kind: 'merge_request', user, project, object_attributes: { iid: 23, action: 'approved' } }) })
    const note = toGitLabNoteEvent(thread, { id: 70, body: 'approved this merge request', system: true, author: user, created_at: '2026-09-20T09:00:00Z' })
    const feed = toGitLabFeedEvent('gitlab.com', { id: 71, action_name: 'approved', target_type: 'MergeRequest', target_iid: 23, author: user, created_at: '2026-09-20T09:00:00Z' }, thread.repo)

    for (const event of [webhook!, note, feed]) {
      expect(event.detail).toMatchObject({ type: 'review', review: { thread: { number: '23' }, id: 'approval:grace' } })
    }
  })

  it('names a Bitbucket approval as the review listing does', () => {
    const user = { uuid: '{grace}', nickname: 'grace' }
    const thread = { forge: 'bitbucket', instance: 'bitbucket.org', repo: { forge: 'bitbucket', instance: 'bitbucket.org', owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '31' } as const
    const [webhook] = translateBitbucketWebhook('bitbucket.org', { headers: { 'x-event-key': 'pullrequest:approved' }, body: JSON.stringify({ actor: user, repository: { full_name: 'acme/widgets', name: 'widgets' }, pullrequest: { id: 31 }, approval: { date: '2026-09-20T09:00:00Z', user } }) })
    const polled = toBitbucketActivityEvent(thread, { approval: { date: '2026-09-20T09:00:00Z', user } }, 0)

    for (const event of [webhook!, polled]) {
      expect(event.detail).toMatchObject({ type: 'review', state: 'approved', review: { thread: { number: '31' }, id: 'participant:{grace}' } })
    }
  })

  it('names the fake review that an event reports', async () => {
    const forge = fake({ seed: { repos: [{ repo: 'acme/widgets' }], threads: [{ repo: 'acme/widgets', kind: 'pull_request', title: 'Fix' }] } }).create()
    const thread = { forge: 'fake', instance: 'fake.test', repo: { forge: 'fake', instance: 'fake.test', owner: 'acme', name: 'widgets' }, kind: 'pull_request', number: '1' } as const
    const review = await forge.threads.createReview(thread, { event: 'approve' })
    const events = await Array.fromAsync(forge.threads.events(thread))

    expect(events.find(event => event.kind === 'review')?.detail).toMatchObject({ type: 'review', review: review.ref })
  })
})

describe('cross-references', () => {
  it('reads a GitHub cross-referenced entry into a referenced event', () => {
    const thread = { forge: 'github', instance: 'github.com', repo: { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }, kind: 'issue', number: '42' } as const

    const event = toGitHubEvent('github.com', thread, {
      id: 9,
      event: 'cross-referenced',
      created_at: '2025-09-20T10:00:00Z',
      actor: { login: 'ada', id: 1 },
      source: { type: 'issue', issue: { number: 7, pull_request: {}, repository: { id: 2, name: 'gadgets', full_name: 'acme/gadgets', owner: { login: 'acme', id: 3 } } } },
    })

    expect(event.kind).toBe('referenced')
    expect(event.detail).toMatchObject({
      type: 'referenced',
      from: { kind: 'pull_request', number: '7', repo: { owner: 'acme', name: 'gadgets' } },
    })
  })
})
