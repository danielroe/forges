import type { WebhookEventType } from '../model.ts'
import type { NativeEventMap } from '../webhooks.ts'

/** Native GitHub event names per normalised kind, for hook subscriptions. */
export const GITHUB_NATIVE_EVENTS: NativeEventMap = {
  comment: ['issue_comment', 'commit_comment', 'discussion_comment'],
  review: ['pull_request_review'],
  review_comment: ['pull_request_review_comment'],
  state_change: ['issues', 'pull_request', 'discussion'],
  label: ['issues', 'pull_request', 'label'],
  assignment: ['issues', 'pull_request'],
  push: ['push'],
  ref: ['create', 'delete'],
  repo: ['repository'],
  installation: ['installation', 'installation_repositories'],
  membership: ['member', 'membership', 'organization', 'team'],
  release: ['release'],
}

/** Normalised kinds and actions GitHub deliveries translate into. */
export const GITHUB_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'comment', action: 'edited' },
  { kind: 'comment', action: 'deleted' },
  { kind: 'review', action: 'submitted' },
  { kind: 'review_comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'reopened' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'state_change', action: 'ready_for_review' },
  { kind: 'state_change', action: 'converted_to_draft' },
  { kind: 'label', action: 'labelled' },
  { kind: 'label', action: 'unlabelled' },
  { kind: 'assignment', action: 'assigned' },
  { kind: 'assignment', action: 'unassigned' },
  { kind: 'assignment', action: 'review_requested' },
  { kind: 'push' },
  { kind: 'ref', action: 'created' },
  { kind: 'ref', action: 'deleted' },
  { kind: 'repo', action: 'renamed' },
  { kind: 'repo', action: 'transferred' },
  { kind: 'repo', action: 'archived' },
  { kind: 'repo', action: 'unarchived' },
  { kind: 'installation' },
  { kind: 'membership' },
  { kind: 'release', action: 'published' },
]
