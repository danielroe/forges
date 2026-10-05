import type { EventAction, EventKind, ForgeEvent, ForgeEventInput, ReviewState } from './model.ts'

const ACTIONS: Record<string, EventAction> = {
  open: 'opened',
  opened: 'opened',
  close: 'closed',
  closed: 'closed',
  reopen: 'reopened',
  reopened: 'reopened',
  merge: 'merged',
  merged: 'merged',
  edit: 'edited',
  edited: 'edited',
  update: 'edited',
  updated: 'edited',
  create: 'created',
  created: 'created',
  delete: 'deleted',
  deleted: 'deleted',
  submitted: 'submitted',
  labeled: 'labelled',
  labelled: 'labelled',
  label_added: 'labelled',
  unlabeled: 'unlabelled',
  unlabelled: 'unlabelled',
  label_removed: 'unlabelled',
  label_updated: 'edited',
  label_cleared: 'unlabelled',
  assigned: 'assigned',
  unassigned: 'unassigned',
  review_requested: 'review_requested',
  synchronize: 'synchronised',
  synchronized: 'synchronised',
  synchronised: 'synchronised',
  ready_for_review: 'ready_for_review',
  converted_to_draft: 'converted_to_draft',
  convert_to_draft: 'converted_to_draft',
  publish: 'published',
  published: 'published',
  renamed: 'renamed',
  transferred: 'transferred',
  archived: 'archived',
  unarchived: 'unarchived',
  added: 'added',
  removed: 'removed',
}

/** What a comment or review event means when the forge names no verb. */
const KIND_DEFAULTS: Partial<Record<EventKind, EventAction>> = {
  comment: 'created',
  review_comment: 'created',
  review: 'submitted',
}

/** Normalises a forge-native verb (`closed`, `close`, `synchronize`, ...) into an {@link EventAction}. */
export function eventAction(raw: string | undefined): EventAction | undefined {
  return raw ? ACTIONS[raw.toLowerCase()] : undefined
}

/**
 * Fills `action` from `actionRaw`, or from the last `.`/`:` segment of
 * `kindRaw`, falling back to the kind's default verb, then `other`.
 */
export function completeEvent(event: ForgeEventInput): ForgeEvent {
  if (event.action) {
    return event as ForgeEvent
  }
  const raw = event.actionRaw ?? event.kindRaw?.split(/[.:]/).pop()
  return { ...event, action: eventAction(raw) ?? KIND_DEFAULTS[event.kind] ?? 'other' }
}

const REVIEW_STATES: Record<string, ReviewState> = {
  approved: 'approved',
  approve: 'approved',
  changes_requested: 'changes_requested',
  request_changes: 'changes_requested',
  commented: 'commented',
  comment: 'commented',
  pending: 'pending',
  dismissed: 'dismissed',
}

/** Normalises a forge-native review verdict (`APPROVED`, `changes_requested`, ...) into a {@link ReviewState}. */
export function reviewState(raw: string | undefined): ReviewState {
  return (raw && REVIEW_STATES[raw.toLowerCase()]) || 'unknown'
}
