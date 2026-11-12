import type { WebhookEventType } from '../model.ts'
import type { NativeEventMap } from '../webhooks.ts'

/** GitCafe names its events `<subject>.<verb>`, and a hook subscribes to each one by name. */
export const GITCAFE_NATIVE_EVENTS: NativeEventMap = {
  comment: [
    'issue.comment_created',
    'issue.comment_updated',
    'issue.comment_deleted',
    'pull.comment_created',
    'pull.comment_updated',
    'pull.comment_deleted',
  ],
  review_comment: ['pull.comment_created', 'pull.comment_updated', 'pull.comment_deleted'],
  review: ['pull.review_submitted', 'pull.review_dismissed'],
  state_change: [
    'issue.created',
    'issue.updated',
    'issue.closed',
    'issue.reopened',
    'pull.created',
    'pull.updated',
    'pull.closed',
    'pull.reopened',
    'pull.merged',
    'pull.drafted',
    'pull.ready',
    'pull.synchronized',
  ],
  label: ['issue.labels_updated', 'pull.labels_updated'],
  assignment: ['issue.assignees_updated', 'pull.assignees_updated', 'pull.reviewers_updated'],
  reaction: [
    'issue.reaction_added',
    'issue.reaction_removed',
    'pull.reaction_added',
    'pull.reaction_removed',
  ],
  push: ['git.push'],
  ref: ['git.ref_created', 'git.ref_deleted'],
}

/** Normalised kinds and actions GitCafe deliveries translate into. */
export const GITCAFE_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'comment', action: 'edited' },
  { kind: 'comment', action: 'deleted' },
  { kind: 'review_comment', action: 'created' },
  { kind: 'review_comment', action: 'edited' },
  { kind: 'review_comment', action: 'deleted' },
  { kind: 'review', action: 'submitted' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'edited' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'reopened' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'state_change', action: 'converted_to_draft' },
  { kind: 'state_change', action: 'ready_for_review' },
  { kind: 'state_change', action: 'synchronised' },
  { kind: 'label' },
  { kind: 'assignment' },
  { kind: 'reaction', action: 'added' },
  { kind: 'reaction', action: 'removed' },
  { kind: 'push' },
  { kind: 'ref', action: 'created' },
  { kind: 'ref', action: 'deleted' },
  { kind: 'other' },
]
