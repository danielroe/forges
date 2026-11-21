import type { Actor, Comment, EventAction, EventDetail, EventKind, ForgeEventInput, ForgeWarning, Label, NotificationReason, ReactionContent, RepoRef, ResolvedThreadRef, SourceKind, Thread, ThreadState } from '../model.ts'
import type { Identity } from './atproto.ts'
import type {
  CommentRecord,
  LabelDefinitionRecord,
  PatchRecord,
  ReactionRecord,
  RecordVersion,
  TangledRecord,
  TicketRecord,
} from './types.ts'
import { eventTime, threadSnapshot } from '../events.ts'
import { toDate } from '../utils.ts'
import { atUri } from './atproto.ts'
import { commentUrl } from './web.ts'

export const FORGE = 'tangled' as const

export const COLLECTIONS = {
  manifest: 'org.tangled.repo.manifest',
  ticket: 'org.tangled.track.ticket',
  patch: 'org.tangled.review.patch',
  comment: 'org.tangled.feed.comment',
  reaction: 'org.tangled.feed.reaction',
  labelDefinition: 'org.tangled.label.definition',
  collaborator: 'org.tangled.graph.collaborator',
  subscription: 'org.tangled.feed.subscription',
  profile: 'org.tangled.actor.profile',
} as const

/** Collections that describe activity on an issue or pull request. */
export const THREAD_COLLECTIONS: readonly string[] = [
  COLLECTIONS.ticket,
  COLLECTIONS.patch,
  COLLECTIONS.comment,
  COLLECTIONS.reaction,
]

export type TicketKind = 'issue' | 'pull_request'

/** A ticket with a target branch is a pull request. */
export function ticketKind(record: Pick<TicketRecord, 'targetBranch'>): TicketKind {
  return record.targetBranch === undefined
    ? 'issue'
    : 'pull_request'
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

/** The ref of the ticket with the record key `rkey`, in the repository whose DID is `repo.externalId`. */
export function toThreadRef(instance: string, repo: RepoRef, rkey: string, kind: TicketKind): ResolvedThreadRef {
  return {
    forge: FORGE,
    instance,
    repo,
    kind,
    typeRaw: COLLECTIONS.ticket,
    number: rkey,
    externalId: atUri(repo.externalId ?? repo.owner, COLLECTIONS.ticket, rkey),
  }
}

/** The emoji Tangled stores for each reaction. */
export const REACTION_EMOJI: Record<ReactionContent, string> = {
  '+1': '👍',
  '-1': '👎',
  'laugh': '😆',
  'hooray': '🎉',
  'confused': '🫤',
  'heart': '❤️',
  'rocket': '🚀',
  'eyes': '👀',
}

export function toLabel(definition: LabelDefinitionRecord): Label {
  return {
    name: definition.name,
    colour: definition.color?.replace(/^#/, ''),
  }
}

/** A completed pull request is a merged one; a completed issue is one closed as done. */
export function toThreadState(kind: TicketKind, raw: string | undefined): { state: ThreadState, stateReason?: string } {
  switch (raw) {
    case 'open':
      return { state: 'open' }
    case 'completed':
      return kind === 'pull_request'
        ? { state: 'merged' }
        : { state: 'closed', stateReason: 'completed' }
    case 'closed':
      return { state: 'closed' }
    default:
      return { state: 'unknown' }
  }
}

/** What a thread carries besides its ticket record. */
export interface ThreadParts {
  author?: Actor
  assignees?: Actor[]
  /** The repo's label definitions, by key. */
  labels?: Map<string, LabelDefinitionRecord>
  commentCount?: number
  updatedAt?: Date
  /** When the ticket last left the open state. */
  closedAt?: Date
  /** The latest round of a pull request. */
  patch?: PatchRecord
  /** The repository the latest round came from, when it is a fork. */
  headRepo?: RepoRef
  warnings?: ForgeWarning[]
  url?: string
  raw?: unknown
}

export function toThread(ref: ResolvedThreadRef, record: TicketRecord, parts: ThreadParts = {}): Thread {
  const kind = ticketKind(record)
  const { state, stateReason } = toThreadState(kind, record.state)
  const updatedAt = parts.updatedAt ?? toDate(parts.patch?.createdAt) ?? toDate(record.createdAt)
  return {
    ref,
    kind,
    title: record.title.text,
    body: record.body?.text,
    state,
    stateRaw: record.state,
    ...stateReason
      ? { stateReason }
      : {},
    isDraft: false,
    author: parts.author,
    assignees: parts.assignees ?? [],
    reviewers: [],
    createdAt: toDate(record.createdAt),
    updatedAt,
    closedAt: state === 'open'
      ? undefined
      : parts.closedAt,
    mergedAt: state === 'merged'
      ? parts.closedAt
      : undefined,
    lastActivityAt: updatedAt,
    labels: (record.tangledLabels ?? []).map(({ key }) => {
      const definition = parts.labels?.get(key)
      return definition
        ? toLabel(definition)
        : { name: key }
    }),
    commentCount: parts.commentCount,
    ...parts.url
      ? { url: parts.url }
      : {},
    branches: record.targetBranch === undefined
      ? undefined
      : {
          head: {
            ref: parts.patch?.source?.branch ?? '',
            ...parts.patch
              ? { sha: parts.patch.head.oid }
              : {},
            ...parts.headRepo
              ? { repo: parts.headRepo }
              : {},
          },
          base: {
            ref: record.targetBranch,
            ...parts.patch
              ? { sha: parts.patch.base.oid }
              : {},
          },
        },
    ...parts.warnings?.length
      ? { warnings: parts.warnings }
      : {},
    raw: parts.raw ?? record,
  }
}

export function toComment(thread: ResolvedThreadRef, rkey: string, record: Pick<CommentRecord, 'body' | 'createdAt'>, author: Actor | undefined, webUrl: string, raw: unknown = record): Comment {
  const ref = {
    forge: FORGE,
    instance: thread.instance,
    thread,
    id: rkey,
  }
  const url = commentUrl(webUrl, ref)
  return {
    ref,
    body: record.body.text,
    author,
    createdAt: toDate(record.createdAt),
    ...url
      ? { url }
      : {},
    raw,
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
      return operation === 'create'
        ? 'comment'
        : 'other'
    case COLLECTIONS.ticket:
      return operation === 'create'
        ? 'state_change'
        : 'other'
    case COLLECTIONS.patch:
      return 'commit'
    case COLLECTIONS.reaction:
      return 'reaction'
    default:
      return 'other'
  }
}

function toEventAction({ collection, operation }: ActivityRecord): EventAction {
  if (operation === 'delete') {
    return 'deleted'
  }
  switch (collection) {
    case COLLECTIONS.ticket:
      return operation === 'create'
        ? 'opened'
        : 'edited'
    case COLLECTIONS.patch:
      return 'synchronised'
    default:
      return operation === 'create'
        ? 'created'
        : 'edited'
  }
}

const NOUNS: Record<string, string> = {
  [COLLECTIONS.ticket]: 'ticket',
  [COLLECTIONS.patch]: 'round',
  [COLLECTIONS.comment]: 'comment',
  [COLLECTIONS.reaction]: 'reaction',
}

function summarise(activity: ActivityRecord, kind: EventKind, who: string): string {
  const { collection, record, operation } = activity
  const noun = NOUNS[collection] ?? collection.split('.').at(-1)
  if (operation === 'delete') {
    return `${who} deleted a ${noun}`
  }
  switch (kind) {
    case 'comment':
      return `${who} commented`
    case 'state_change':
      return ticketKind(record as TicketRecord) === 'issue'
        ? `${who} opened an issue`
        : `${who} opened a pull request`
    case 'commit':
      return `${who} pushed a new round`
    case 'reaction':
      return `${who} reacted ${(record as ReactionRecord).reaction}`
    default:
      return `${who} edited a ${noun}`
  }
}

function activityDetail(activity: ActivityRecord, kind: EventKind, thread: ResolvedThreadRef | undefined): EventDetail | undefined {
  if (kind === 'comment') {
    return {
      type: 'comment',
      comment: thread && {
        forge: FORGE,
        instance: thread.instance,
        thread,
        id: activity.uri.split('/').pop()!,
      },
      body: (activity.record as CommentRecord | undefined)?.body?.text,
    }
  }
  return kind === 'state_change'
    ? { type: 'state_change', state: 'open' }
    : undefined
}

function snapshotOf(record: TicketRecord | undefined): ForgeEventInput['threadSnapshot'] {
  if (!record) {
    return undefined
  }
  const { state, stateReason } = toThreadState(ticketKind(record), record.state)
  return threadSnapshot({
    title: record.title.text,
    body: record.body?.text,
    state,
    stateRaw: record.state,
    stateReason,
  })
}

/** The event for one record that was created, changed or deleted. */
export function toActivityEvent(
  instance: string,
  activity: ActivityRecord,
  actor: Actor | undefined,
  thread: ResolvedThreadRef | undefined,
  source: SourceKind,
  fallbackTime: Date,
  ticket?: TicketRecord,
): ForgeEventInput {
  const kind = toEventKind(activity.collection, activity.operation)
  // A ticket's `createdAt` is when it was opened, not when this version was written.
  const time = activity.operation === 'create'
    ? toDate((activity.record as { createdAt?: string } | undefined)?.createdAt)
    : undefined
  return {
    forge: FORGE,
    instance,
    id: activity.operation === 'create' || !activity.rev
      ? activity.uri
      : `${activity.uri}#${activity.rev}`,
    kind,
    kindRaw: activity.operation === 'create'
      ? activity.collection
      : `${activity.collection}:${activity.operation}`,
    action: toEventAction(activity),
    actionRaw: activity.operation,
    detail: activityDetail(activity, kind, thread),
    summary: summarise(activity, kind, actor?.login ?? 'someone'),
    ...eventTime(time, fallbackTime),
    actor,
    repo: thread?.repo,
    thread,
    threadSnapshot: snapshotOf(ticket),
    source,
    payload: activity.record
      ? { uri: activity.uri, ...activity.record }
      : { uri: activity.uri },
  }
}

/** What one version of a ticket changed, against the version before it. */
export type TicketChange
  = | { type: 'state', state: string }
    | { type: 'label', key: string, added: boolean }
    | { type: 'assignee', did: string, added: boolean }
    | { type: 'edit' }

export function ticketChanges(before: TicketRecord, after: TicketRecord): TicketChange[] {
  const changes: TicketChange[] = []
  if (before.state !== after.state) {
    changes.push({ type: 'state', state: after.state })
  }
  const labels = (record: TicketRecord) => (record.tangledLabels ?? []).map(label => label.key)
  for (const [added, from, to] of [
    [
      false,
      labels(after),
      labels(before),
    ],
    [
      true,
      labels(before),
      labels(after),
    ],
  ] as const) {
    changes.push(...to.filter(key => !from.includes(key)).map(key => ({ type: 'label' as const, key, added })))
  }
  for (const [added, from, to] of [
    [false, after.assignees ?? [], before.assignees ?? []],
    [true, before.assignees ?? [], after.assignees ?? []],
  ] as const) {
    changes.push(...to.filter(did => !from.includes(did)).map(did => ({ type: 'assignee' as const, did, added })))
  }
  if (before.title.text !== after.title.text || before.body?.text !== after.body?.text || before.targetBranch !== after.targetBranch) {
    changes.push({ type: 'edit' })
  }
  return changes
}

const STATE_ACTIONS: Partial<Record<ThreadState, EventAction>> = { open: 'reopened', closed: 'closed', merged: 'merged' }

/** The event for one change that a version of a ticket made. */
export function toChangeEvent(
  thread: ResolvedThreadRef,
  record: TicketRecord,
  version: RecordVersion,
  change: TicketChange,
  actor: Actor | undefined,
  { label, assignee }: { label?: Label, assignee?: Actor } = {},
): ForgeEventInput {
  const who = actor?.login ?? 'someone'
  const kind = ticketKind(record)
  const base = {
    forge: FORGE,
    instance: thread.instance,
    kindRaw: `${COLLECTIONS.ticket}:update`,
    actionRaw: 'update',
    ...eventTime(toDate(version.createdAt)),
    actor,
    repo: thread.repo,
    thread,
    threadSnapshot: snapshotOf(record),
    source: 'poll' as const,
    payload: { uri: thread.externalId, ...version },
  }
  const id = `${thread.externalId}#${version.cid}`
  switch (change.type) {
    case 'state': {
      const { state, stateReason } = toThreadState(kind, change.state)
      return {
        ...base,
        id: `${id}:state`,
        kind: 'state_change',
        action: STATE_ACTIONS[state] ?? 'other',
        detail: {
          type: 'state_change',
          state,
          ...stateReason
            ? { reason: stateReason }
            : {},
        },
        summary: `${who} marked it ${state === 'open'
          ? 'open'
          : state}`,
      }
    }
    case 'label':
      return {
        ...base,
        id: `${id}:label:${change.key}`,
        kind: 'label',
        action: change.added ? 'labelled' : 'unlabelled',
        detail: { type: 'label', label: label?.name ?? change.key },
        summary: `${who} ${change.added ? 'added' : 'removed'} the label ${label?.name ?? change.key}`,
      }
    case 'assignee':
      return {
        ...base,
        id: `${id}:assignee:${change.did}`,
        kind: 'assignment',
        action: change.added ? 'assigned' : 'unassigned',
        detail: { type: 'assignment', assignee },
        summary: `${who} ${change.added ? 'assigned' : 'unassigned'} ${assignee?.login ?? change.did}`,
      }
    default:
      return {
        ...base,
        id: `${id}:edit`,
        kind: 'other',
        action: 'edited',
        summary: `${who} edited the ${kind === 'issue'
          ? 'issue'
          : 'pull request'}`,
      }
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
  issue_unassigned: 'assigned',
  pull_assigned: 'assigned',
  pull_unassigned: 'assigned',
  knot_invited: 'invitation',
  collaborator_invited: 'invitation',
  user_mentioned: 'mention',
  repo_starred: 'starred',
  followed: 'followed',
}

export function toNotificationReason(type: string): NotificationReason {
  return NOTIFICATION_REASONS[type] ?? 'unknown'
}
