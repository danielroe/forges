import type { WebhookEventType } from '../model.ts'
import type { NativeEventMap } from '../webhooks.ts'

/**
 * GitLab subscribes per event with a boolean flag rather than an event name,
 * so the flag names are the native events.
 */
export const GITLAB_NATIVE_EVENTS: NativeEventMap = {
  comment: ['note_events', 'confidential_note_events'],
  review: ['merge_requests_events'],
  review_comment: ['note_events'],
  state_change: ['issues_events', 'confidential_issues_events', 'merge_requests_events'],
  label: ['issues_events', 'merge_requests_events'],
  assignment: ['issues_events', 'merge_requests_events'],
  push: ['push_events'],
  ref: ['tag_push_events', 'push_events'],
  release: ['releases_events'],
  membership: ['member_events'],
}

/** Normalised kinds and actions GitLab deliveries translate into. */
export const GITLAB_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
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
  { kind: 'assignment', action: 'review_requested' },
  { kind: 'push' },
  { kind: 'ref', action: 'created' },
  { kind: 'ref', action: 'deleted' },
  { kind: 'release', action: 'published' },
  { kind: 'membership' },
]
