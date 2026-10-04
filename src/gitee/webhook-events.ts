import type { WebhookEventType } from '../model.ts'
import type { NativeEventMap } from '../webhooks.ts'

/** Gitee subscribes per event with a boolean flag, so the flag names are the native events. */
export const GITEE_NATIVE_EVENTS: NativeEventMap = {
  comment: ['note_events'],
  state_change: ['issues_events', 'merge_requests_events'],
  label: ['issues_events', 'merge_requests_events'],
  assignment: ['issues_events', 'merge_requests_events'],
  review: ['merge_requests_events'],
  push: ['push_events'],
  ref: ['tag_push_events'],
}

/** Normalised kinds and actions Gitee deliveries translate into. */
export const GITEE_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'reopened' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'push' },
  { kind: 'ref', action: 'created' },
  { kind: 'ref', action: 'deleted' },
]
