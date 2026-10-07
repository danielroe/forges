import type { WebhookDelivery } from '../../src/index.ts'
import { describe, expect, it } from 'vitest'
import { completeEvent, eventAction } from '../../src/events.ts'
import { toEvent as toGitHubEvent } from '../../src/github/normalise.ts'
import { translateGitHubWebhook } from '../../src/github/webhooks.ts'
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
