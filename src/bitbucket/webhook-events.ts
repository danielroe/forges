import type { WebhookEventType } from '../model.ts'
import type { NativeEventMap } from '../webhooks.ts'

/** Native Bitbucket event names per normalised kind, for hook subscriptions. */
export const BITBUCKET_NATIVE_EVENTS: NativeEventMap = {
  comment: ['issue:comment_created', 'pullrequest:comment_created', 'pullrequest:comment_updated', 'pullrequest:comment_deleted'],
  review: ['pullrequest:approved', 'pullrequest:unapproved', 'pullrequest:changes_request_created'],
  state_change: ['issue:created', 'issue:updated', 'pullrequest:created', 'pullrequest:updated', 'pullrequest:fulfilled', 'pullrequest:rejected'],
  push: ['repo:push'],
  ref: ['repo:push'],
  repo: ['repo:updated', 'repo:transfer'],
}

/** Normalised kinds and actions Bitbucket deliveries translate into. */
export const BITBUCKET_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'comment', action: 'edited' },
  { kind: 'comment', action: 'deleted' },
  { kind: 'review', action: 'submitted' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'push' },
  { kind: 'ref', action: 'created' },
  { kind: 'ref', action: 'deleted' },
  { kind: 'repo', action: 'renamed' },
  { kind: 'repo', action: 'transferred' },
]
