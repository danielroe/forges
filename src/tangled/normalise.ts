import type { Actor, Comment, EventAction, EventKind, ForgeEventInput, ForgeWarning, NotificationReason, RepoRef, ResolvedThreadRef, SourceKind, Thread, ThreadKind, ThreadRef, ThreadState } from '../model.ts'
import type { AtUri, Identity } from './atproto.ts'
import type {
  FeedCommentRecord,
  IssueRecord,
  LabelOpRecord,
  LegacyCommentRecord,
  PullRecord,
  ReactionRecord,
  StateRecord,
  TangledRecord,
} from './types.ts'
import { toDate } from '../utils.ts'
import { atUri } from './atproto.ts'

export const FORGE = 'tangled' as const

export const COLLECTIONS = {
  repo: 'sh.tangled.repo',
  issue: 'sh.tangled.repo.issue',
  pull: 'sh.tangled.repo.pull',
  comment: 'sh.tangled.feed.comment',
  issueComment: 'sh.tangled.repo.issue.comment',
  pullComment: 'sh.tangled.repo.pull.comment',
  issueState: 'sh.tangled.repo.issue.state',
  pullStatus: 'sh.tangled.repo.pull.status',
  reaction: 'sh.tangled.feed.reaction',
  labelOp: 'sh.tangled.label.op',
  subscription: 'sh.tangled.feed.subscription',
} as const

/** Collections that describe activity on an issue or pull request. */
export const THREAD_COLLECTIONS: readonly string[] = [
  COLLECTIONS.issue,
  COLLECTIONS.pull,
  COLLECTIONS.comment,
  COLLECTIONS.issueComment,
  COLLECTIONS.pullComment,
  COLLECTIONS.issueState,
  COLLECTIONS.pullStatus,
  COLLECTIONS.reaction,
  COLLECTIONS.labelOp,
]

export function threadKindOf(collection: string): ThreadKind | undefined {
  if (collection === COLLECTIONS.issue) {
    return 'issue'
  }
  return collection === COLLECTIONS.pull ? 'pull_request' : undefined
}

export function toActor(instance: string, identity: Identity, webUrl: string): Actor {
  const login = identity.handle ?? identity.did
  return {
    forge: FORGE,
    instance,
    login,
    id: identity.did,
    url: `${webUrl}/${login}`,
    isBotHint: false,
  }
}

export function toThreadRef(instance: string, repo: RepoRef, uri: AtUri): ResolvedThreadRef {
  const value = atUri(uri.did, uri.collection, uri.rkey)
  return {
    forge: FORGE,
    instance,
    repo,
    kind: threadKindOf(uri.collection) ?? 'other',
    typeRaw: uri.collection,
    number: value,
    externalId: value,
  }
}

/** The thread an activity record points at, as an AT-URI. */
export function subjectOf(collection: string, record: TangledRecord, uri: string): string | undefined {
  switch (collection) {
    case COLLECTIONS.issue:
    case COLLECTIONS.pull:
      return uri
    case COLLECTIONS.comment:
      return (record as FeedCommentRecord).subject?.uri
    case COLLECTIONS.issueComment:
    case COLLECTIONS.pullComment:
      return (record as LegacyCommentRecord).issue ?? (record as LegacyCommentRecord).pull
    case COLLECTIONS.issueState:
    case COLLECTIONS.pullStatus:
      return (record as StateRecord).issue ?? (record as StateRecord).pull
    case COLLECTIONS.reaction:
    case COLLECTIONS.labelOp:
      return (record as ReactionRecord | LabelOpRecord).subject
    default:
      return undefined
  }
}

/** Last segment of a `sh.tangled.repo.issue.state.closed`-style token. */
export function stateToken(record: StateRecord): string | undefined {
  return (record.state ?? record.status)?.split('.').at(-1)
}

export function toThreadState(token: string | undefined): ThreadState {
  switch (token) {
    case 'open':
    case 'closed':
    case 'merged':
      return token
    default:
      return 'open'
  }
}

export interface ActivityRecord {
  uri: string
  collection: string
  record?: TangledRecord
  operation: 'create' | 'update' | 'delete'
  rev?: string
}

export function toEventKind(collection: string, operation: ActivityRecord['operation']): EventKind {
  if (operation === 'delete') {
    return 'other'
  }
  switch (collection) {
    case COLLECTIONS.comment:
    case COLLECTIONS.issueComment:
    case COLLECTIONS.pullComment:
      return operation === 'create' ? 'comment' : 'other'
    case COLLECTIONS.issueState:
    case COLLECTIONS.pullStatus:
      return 'state_change'
    case COLLECTIONS.issue:
      return operation === 'create' ? 'state_change' : 'other'
    case COLLECTIONS.pull:
      return operation === 'create' ? 'state_change' : 'commit'
    case COLLECTIONS.reaction:
      return 'reaction'
    case COLLECTIONS.labelOp:
      return 'label'
    default:
      return 'other'
  }
}

const STATE_ACTIONS: Record<string, EventAction> = { open: 'reopened', closed: 'closed', merged: 'merged' }

function toEventAction(activity: ActivityRecord): EventAction {
  const { collection, operation } = activity
  if (operation === 'delete') {
    return 'deleted'
  }
  switch (collection) {
    case COLLECTIONS.issue:
      return operation === 'create' ? 'opened' : 'edited'
    case COLLECTIONS.pull:
      return operation === 'create' ? 'opened' : 'synchronised'
    case COLLECTIONS.issueState:
    case COLLECTIONS.pullStatus:
      return STATE_ACTIONS[stateToken(activity.record as StateRecord) ?? ''] ?? 'other'
    default:
      return operation === 'create' ? 'created' : 'edited'
  }
}

function summarise(activity: ActivityRecord, kind: EventKind, who: string): string {
  const { collection, record, operation } = activity
  if (operation === 'delete') {
    return `${who} deleted a ${collection.split('.').at(-1)}`
  }
  switch (kind) {
    case 'comment':
      return `${who} commented`
    case 'state_change':
      if (collection === COLLECTIONS.issue) {
        return `${who} opened an issue`
      }
      if (collection === COLLECTIONS.pull) {
        return `${who} opened a pull request`
      }
      return `${who} marked it ${stateToken(record as StateRecord) ?? 'changed'}`
    case 'commit':
      return `${who} pushed a new round`
    case 'reaction':
      return `${who} reacted ${(record as ReactionRecord).reaction}`
    case 'label':
      return `${who} changed labels`
    default:
      return `${who} edited a ${collection.split('.').at(-1)}`
  }
}

function occurredAt(record: TangledRecord | undefined): Date | undefined {
  if (!record) {
    return undefined
  }
  return toDate('performedAt' in record ? record.performedAt : (record as { createdAt?: string }).createdAt)
}

export function toActivityEvent(
  instance: string,
  activity: ActivityRecord,
  actor: Actor,
  thread: ResolvedThreadRef | undefined,
  source: SourceKind,
  fallbackTime: Date,
): ForgeEventInput {
  const kind = toEventKind(activity.collection, activity.operation)
  return {
    forge: FORGE,
    instance,
    id: activity.operation === 'create' || !activity.rev ? activity.uri : `${activity.uri}#${activity.rev}`,
    kind,
    kindRaw: activity.operation === 'create' ? activity.collection : `${activity.collection}:${activity.operation}`,
    action: toEventAction(activity),
    actionRaw: activity.operation,
    detail: kind === 'state_change' && (activity.collection === COLLECTIONS.issueState || activity.collection === COLLECTIONS.pullStatus)
      ? { type: 'state_change', state: toThreadState(stateToken(activity.record as StateRecord)) }
      : undefined,
    summary: summarise(activity, kind, actor.login),
    occurredAt: occurredAt(activity.record) ?? fallbackTime,
    actor,
    repo: thread?.repo,
    thread,
    source,
    payload: activity.record ? { uri: activity.uri, ...activity.record } : { uri: activity.uri },
  }
}

export function toThread(
  ref: ResolvedThreadRef,
  record: IssueRecord | PullRecord,
  author: Actor,
  state: { token?: string, at?: string },
  commentCount: number,
  warnings: ForgeWarning[] = [],
): Thread {
  const value = toThreadState(state.token)
  const pull = 'target' in record ? record : undefined
  const updatedAt = toDate(state.at) ?? toDate(pull?.rounds?.at(-1)?.createdAt) ?? toDate(record.createdAt)
  return {
    ref,
    kind: ref.kind,
    title: record.title,
    body: record.body,
    state: value,
    stateRaw: state.token ?? 'open',
    isDraft: false,
    author,
    assignees: [],
    reviewers: [],
    createdAt: toDate(record.createdAt),
    updatedAt,
    closedAt: value === 'open' ? undefined : toDate(state.at),
    lastActivityAt: updatedAt,
    labels: [],
    commentCount,
    branches: pull ? { head: { ref: pull.source?.branch ?? '' }, base: { ref: pull.target.branch } } : undefined,
    ...warnings.length ? { warnings } : {},
    raw: record,
  }
}

export function toRecordComment(thread: ThreadRef, uri: string, record: FeedCommentRecord | LegacyCommentRecord, author: Actor): Comment {
  const body = typeof record.body === 'string' ? record.body : record.body.original ?? record.body.text ?? ''
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: uri },
    body,
    author,
    createdAt: toDate(record.createdAt),
    raw: { uri, ...record },
  }
}

const NOTIFICATION_REASONS: Record<string, NotificationReason> = {
  issue_created: 'subscribed',
  pull_created: 'subscribed',
  issue_commented: 'comment',
  pull_commented: 'comment',
  issue_closed: 'state_change',
  issue_reopen: 'state_change',
  pull_closed: 'state_change',
  pull_reopen: 'state_change',
  pull_merged: 'state_change',
  issue_assigned: 'assigned',
  pull_assigned: 'assigned',
  user_mentioned: 'mention',
  repo_starred: 'starred',
  followed: 'followed',
}

export function toNotificationReason(type: string): NotificationReason {
  return NOTIFICATION_REASONS[type] ?? 'unknown'
}
