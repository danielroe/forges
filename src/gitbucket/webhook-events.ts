import type { WebhookEventType } from '../model.ts'
import type { NativeEventMap } from '../webhooks.ts'

/** The events GitBucket sends, per kind; it takes a few more names it never sends, and answers an unknown one with a 500. */
export const GITBUCKET_NATIVE_EVENTS: NativeEventMap = {
  comment: ['issue_comment'],
  review_comment: ['pull_request_review_comment'],
  state_change: ['issues', 'pull_request'],
  push: ['push'],
  ref: ['create'],
  wiki: ['gollum'],
}

/** Normalised kinds and actions GitBucket deliveries translate into. */
export const GITBUCKET_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'review_comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'reopened' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'push' },
  { kind: 'ref', action: 'created' },
  { kind: 'wiki', action: 'created' },
  { kind: 'wiki', action: 'edited' },
]
