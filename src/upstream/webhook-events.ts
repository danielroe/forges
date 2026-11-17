import type { WebhookEventType } from '../model.ts'
import type { NativeEventMap } from '../webhooks.ts'

/** The events Upstream sends, per kind, under GitHub's names. */
export const UPSTREAM_NATIVE_EVENTS: NativeEventMap = {
  comment: ['issue_comment'],
  review: ['pull_request_review'],
  review_comment: ['pull_request_review_comment'],
  state_change: ['issues', 'pull_request'],
  label: ['issues', 'pull_request'],
  assignment: ['issues', 'pull_request'],
  push: ['push'],
  ref: ['create', 'delete'],
  repo: ['repository'],
  membership: ['member'],
  release: ['release'],
  fork: ['fork'],
}

/** Normalised kinds and actions Upstream deliveries translate into. */
export const UPSTREAM_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'comment', action: 'edited' },
  { kind: 'comment', action: 'deleted' },
  { kind: 'review', action: 'submitted' },
  { kind: 'review_comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'reopened' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'label', action: 'labelled' },
  { kind: 'label', action: 'unlabelled' },
  { kind: 'assignment', action: 'assigned' },
  { kind: 'assignment', action: 'unassigned' },
  { kind: 'push' },
  { kind: 'ref', action: 'created' },
  { kind: 'ref', action: 'deleted' },
  { kind: 'repo', action: 'edited' },
  { kind: 'membership' },
  { kind: 'release', action: 'created' },
  { kind: 'release', action: 'published' },
  { kind: 'release', action: 'edited' },
  { kind: 'release', action: 'deleted' },
  { kind: 'fork', action: 'created' },
]
