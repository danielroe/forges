import type { WebhookEventType } from '../model.ts'
import type { NativeEventMap } from '../webhooks.ts'

/** Header names a deployment signs and labels deliveries with, first match wins. */
export interface WebhookHeaderNames {
  signature: readonly string[]
  event: readonly string[]
  delivery: readonly string[]
}

export const FORGEJO_HEADERS: WebhookHeaderNames = {
  signature: ['x-forgejo-signature', 'x-gitea-signature'],
  event: ['x-forgejo-event', 'x-gitea-event', 'x-github-event'],
  delivery: ['x-forgejo-delivery', 'x-gitea-delivery'],
}

export const GITEA_HEADERS: WebhookHeaderNames = {
  signature: ['x-gitea-signature'],
  event: ['x-gitea-event', 'x-github-event'],
  delivery: ['x-gitea-delivery'],
}

/** Native Forgejo and Gitea event names per normalised kind, for hook subscriptions. */
export const FORGEJO_NATIVE_EVENTS: NativeEventMap = {
  comment: ['issue_comment', 'pull_request_comment'],
  review: ['pull_request_review_approved', 'pull_request_review_rejected', 'pull_request_review_comment'],
  review_comment: ['pull_request_review_comment'],
  state_change: ['issues', 'pull_request', 'pull_request_sync'],
  label: ['issue_label', 'pull_request_label'],
  assignment: ['issue_assign', 'pull_request_assign'],
  push: ['push'],
  ref: ['create', 'delete'],
  release: ['release'],
}

/** Normalised kinds and actions Forgejo and Gitea deliveries translate into. */
export const FORGEJO_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'comment', action: 'edited' },
  { kind: 'comment', action: 'deleted' },
  { kind: 'review', action: 'submitted' },
  { kind: 'review_comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'reopened' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'label', action: 'edited' },
  { kind: 'label', action: 'unlabelled' },
  { kind: 'assignment', action: 'assigned' },
  { kind: 'assignment', action: 'unassigned' },
  { kind: 'push' },
  { kind: 'ref', action: 'created' },
  { kind: 'ref', action: 'deleted' },
  { kind: 'release', action: 'published' },
]
