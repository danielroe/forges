import type { CommitRef, EventAction, EventDetail, EventKind, ForgeEventInput, RepoRef, ThreadRef, ThreadSnapshot } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GitLabUser } from './types.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventAction, eventTime, threadSnapshot } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { approvalId, FORGE, toActor, toLabel, toRepoRef, toState } from './normalise.ts'

export const EVENT_HEADER = 'x-gitlab-event'
export const DELIVERY_HEADER = 'x-gitlab-event-uuid'

interface GitLabWebhookPayload {
  object_kind?: string
  event_type?: string
  user?: Partial<GitLabUser> & { username?: string }
  user_username?: string
  project?: { id?: number, path_with_namespace?: string }
  object_attributes?: GitLabHookThread & {
    id?: number
    iid?: number
    action?: string
    type?: string | null
    noteable_type?: string
    position?: unknown
    created_at?: string
    updated_at?: string
    closed_at?: string | null
    note?: string
    oldrev?: string
  }
  issue?: GitLabHookThread & { iid: number }
  merge_request?: GitLabHookThread & { iid: number }
  commit?: { id?: string }
  changes?: Record<string, unknown>
  commits?: Array<{ id: string, message: string, timestamp?: string, url?: string, author?: { name?: string } }>
  ref?: string
  before?: string
  after?: string
  total_commits_count?: number
  event_name?: string
  path_with_namespace?: string
  old_path_with_namespace?: string
  action?: string
  id?: number
  tag?: string
  name?: string
  description?: string | null
  url?: string
  released_at?: string
  created_at?: string
  updated_at?: string
  user_name?: string
  user_email?: string
  user_id?: number
  project_id?: number
}

/** An issue or merge request as a hook carries it. */
interface GitLabHookThread {
  title?: string
  description?: string | null
  state?: string
  draft?: boolean | null
  url?: string
  labels?: Array<{ title: string, color?: string, description?: string | null }> | null
  source_branch?: string | null
  target_branch?: string | null
  last_commit?: { id: string } | null
  merge_commit_sha?: string | null
  source?: { path_with_namespace?: string, id?: number } | null
  target_project_id?: number
  source_project_id?: number
}

function snapshotOf(instance: string, raw: GitLabHookThread | undefined): ThreadSnapshot | undefined {
  return raw && threadSnapshot({
    title: raw.title,
    body: raw.description ?? undefined,
    state: raw.state ? toState(raw.state) : undefined,
    stateRaw: raw.state,
    isDraft: raw.draft ?? undefined,
    labels: raw.labels?.map(label => toLabel({ name: label.title, color: label.color, description: label.description })),
    url: raw.url,
    branches: raw.source_branch && raw.target_branch
      ? {
          head: { ref: raw.source_branch, sha: raw.last_commit?.id, repo: raw.source?.path_with_namespace ? toRepoRef(instance, raw.source.path_with_namespace, raw.source.id) : undefined },
          base: { ref: raw.target_branch },
          mergeCommitSha: raw.merge_commit_sha ?? undefined,
        }
      : undefined,
  })
}

const ZERO_SHA = /^0+$/

function repoLevel(instance: string, payload: GitLabWebhookPayload, who: string, repo: RepoRef | undefined): Pick<ForgeEventInput, 'kind' | 'action' | 'detail' | 'summary'> | undefined {
  switch (payload.object_kind ?? payload.event_name) {
    case 'push':
    case 'tag_push':
      return refEvent(who, {
        ref: payload.ref ?? '',
        before: payload.before,
        after: payload.after,
        created: Boolean(payload.before && ZERO_SHA.test(payload.before)),
        deleted: Boolean(payload.after && ZERO_SHA.test(payload.after)),
        commits: (payload.commits ?? []).map(commit => ({ sha: commit.id, message: commit.message, author: commit.author?.name, url: commit.url })),
        commitCount: payload.total_commits_count,
      })
    case 'release': {
      if (!repo) {
        return undefined
      }
      const action = payload.action === 'create' ? 'published' : eventAction(payload.action) ?? 'other'
      return {
        kind: 'release',
        action,
        detail: { type: 'release', release: { forge: FORGE, instance, repo, id: payload.tag ?? String(payload.id), tag: payload.tag }, tag: payload.tag, name: payload.name, body: payload.description ?? undefined, url: payload.url },
        summary: `${who} ${action} ${payload.name ?? payload.tag ?? 'a release'}`,
      }
    }
    case 'wiki_page': {
      const page = payload.object_attributes
      const action = eventAction(page?.action) ?? 'other'
      return {
        kind: 'wiki',
        action,
        detail: { type: 'wiki', title: page?.title, url: page?.url },
        summary: `${who} ${action} wiki page ${page?.title ?? ''}`.trim(),
      }
    }
    case 'project_rename':
      return {
        kind: 'repo',
        action: 'renamed',
        detail: { type: 'repo_renamed', from: payload.old_path_with_namespace ?? '', to: payload.path_with_namespace ?? '' },
        summary: `${who} renamed the project`,
      }
    case 'project_transfer':
      return {
        kind: 'repo',
        action: 'transferred',
        detail: {
          type: 'repo_transferred',
          fromOwner: payload.old_path_with_namespace?.split('/').slice(0, -1).join('/'),
          toOwner: payload.path_with_namespace?.split('/').slice(0, -1).join('/'),
        },
        summary: `${who} transferred the project`,
      }
    case 'user_add_to_team':
    case 'user_remove_from_team':
    case 'user_add_to_group':
    case 'user_remove_from_group':
    case 'user_access_request_to_project':
    case 'user_update_for_team':
    case 'user_update_for_group':
      return {
        kind: 'membership',
        action: membershipAction(payload.event_name),
        detail: {
          type: 'membership',
          actionRaw: payload.event_name ?? 'member',
          member: payload.user_name
            ? toActor(instance, { id: payload.user_id ?? 0, username: payload.user_username ?? payload.user_name, name: payload.user_name })
            : undefined,
        },
        summary: `${who} changed a membership`,
      }
    default:
      return undefined
  }
}

/** The time of the change a project-level delivery reports, else the time its subject last changed. */
function repoLevelTime(payload: GitLabWebhookPayload): string | undefined {
  if (payload.object_kind === 'release') {
    return payload.action === 'create' ? payload.created_at ?? payload.released_at : undefined
  }
  if (payload.event_name?.startsWith('user_add_')) {
    return payload.created_at
  }
  if (payload.event_name?.startsWith('user_remove_')) {
    return undefined
  }
  return payload.commits?.at(-1)?.timestamp ?? payload.updated_at
}

/** The time of the change an issue, merge request or note delivery reports, else the time its subject last changed. */
function threadTime(payload: GitLabWebhookPayload): string | null | undefined {
  const attributes = payload.object_attributes
  const action = attributes?.action
  if (payload.object_kind === 'note') {
    return action === 'update' ? attributes?.updated_at : attributes?.created_at ?? attributes?.updated_at
  }
  if (action === 'open') {
    return attributes?.created_at
  }
  return (action === 'close' ? attributes?.closed_at : undefined) ?? attributes?.updated_at
}

function membershipAction(eventName: string | undefined): EventAction {
  if (eventName?.startsWith('user_add_')) {
    return 'added'
  }
  if (eventName?.startsWith('user_remove_')) {
    return 'removed'
  }
  return eventName?.startsWith('user_update_') ? 'edited' : 'other'
}

interface ChangeEvent {
  kind: EventKind
  action: EventAction
  detail: EventDetail
  summary: string
}

interface Change<T> {
  previous?: T[]
  current?: T[]
}

function diff<T>(change: Change<T> | undefined, key: (item: T) => string | number | undefined): { added: T[], removed: T[] } {
  const previous = change?.previous ?? []
  const current = change?.current ?? []
  const before = new Set(previous.map(key))
  const after = new Set(current.map(key))
  return { added: current.filter(item => !before.has(key(item))), removed: previous.filter(item => !after.has(key(item))) }
}

/** One event per label, assignee or reviewer an `update` delivery adds or removes. */
function changeEvents(instance: string, payload: GitLabWebhookPayload, who: string): ChangeEvent[] {
  const changes = payload.changes as { labels?: Change<{ title?: string }>, assignees?: Change<GitLabUser>, reviewers?: Change<GitLabUser> } | undefined
  if (payload.object_attributes?.action !== 'update' || !changes) {
    return []
  }
  const events: ChangeEvent[] = []
  const labels = diff(changes.labels, label => label.title)
  for (const [items, action, verb] of [[labels.added, 'labelled', 'added'], [labels.removed, 'unlabelled', 'removed']] as const) {
    for (const { title = '' } of items) {
      events.push({ kind: 'label', action, detail: { type: 'label', label: title }, summary: `${who} ${verb} label ${title}`.trim() })
    }
  }
  const people = (change: Change<GitLabUser> | undefined, added: [EventAction, string], removed: [EventAction, string]) => {
    const { added: joined, removed: left } = diff(change, user => user.username)
    for (const [users, [action, verb]] of [[joined, added], [left, removed]] as const) {
      for (const user of users) {
        events.push({ kind: 'assignment', action, detail: { type: 'assignment', assignee: toActor(instance, user) }, summary: `${who} ${verb} ${user.username}` })
      }
    }
  }
  people(changes.assignees, ['assigned', 'assigned'], ['unassigned', 'unassigned'])
  people(changes.reviewers, ['review_requested', 'requested review from'], ['other', 'removed the review request for'])
  return events
}

function eventKindFor(payload: GitLabWebhookPayload): EventKind {
  const attributes = payload.object_attributes
  switch (payload.object_kind) {
    case 'note':
      return attributes?.noteable_type !== 'Commit' && (attributes?.type === 'DiffNote' || attributes?.position) ? 'review_comment' : 'comment'
    case 'push':
      return 'commit'
    case 'emoji':
      return 'reaction'
    case 'issue':
    case 'merge_request':
      switch (attributes?.action) {
        case 'approved':
        case 'approval':
          return 'review'
        case 'open':
        case 'close':
        case 'reopen':
        case 'merge':
          return 'state_change'
        case 'update':
          if (payload.changes?.labels) {
            return 'label'
          }
          if (payload.changes?.assignees || payload.changes?.reviewers) {
            return 'assignment'
          }
          return 'other'
        default:
          return 'other'
      }
    default:
      return 'other'
  }
}

export function translateGitLabWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const event = headerValue(delivery.headers, EVENT_HEADER)
  if (!event) {
    throw new WebhookVerificationError(`Missing ${EVENT_HEADER} header`, { forge: FORGE, instance })
  }
  const deliveryId = headerValue(delivery.headers, DELIVERY_HEADER) ?? crypto.randomUUID()
  const payload = JSON.parse(bodyText(delivery.body)) as GitLabWebhookPayload
  const repo = payload.project?.path_with_namespace
    ? toRepoRef(instance, payload.project.path_with_namespace, payload.project.id)
    : payload.path_with_namespace ? toRepoRef(instance, payload.path_with_namespace, payload.project_id) : undefined
  const user = payload.user?.username
    ? toActor(instance, { id: payload.user.id ?? 0, ...payload.user, username: payload.user.username })
    : undefined

  const attributes = payload.object_attributes
  const subject = payload.object_kind === 'note'
    ? payload.merge_request
      ? { kind: 'pull_request' as const, iid: payload.merge_request.iid }
      : payload.issue ? { kind: 'issue' as const, iid: payload.issue.iid } : undefined
    : payload.object_kind === 'merge_request' && attributes?.iid !== undefined
      ? { kind: 'pull_request' as const, iid: attributes.iid }
      : payload.object_kind === 'issue' && attributes?.iid !== undefined
        ? { kind: 'issue' as const, iid: attributes.iid }
        : undefined
  const thread: ThreadRef | undefined = repo && subject
    ? { forge: FORGE, instance, repo, kind: subject.kind, number: String(subject.iid) }
    : undefined
  const commit: CommitRef | undefined = repo && !thread && payload.object_kind === 'note' && payload.commit?.id
    ? { forge: FORGE, instance, repo, sha: payload.commit.id }
    : undefined
  const snapshot = thread && snapshotOf(instance, payload.object_kind === 'note' ? payload.merge_request ?? payload.issue : attributes)

  const level = repoLevel(instance, payload, user?.login ?? payload.user_username ?? 'someone', repo)
  if (level) {
    return [{
      forge: FORGE,
      instance,
      id: deliveryId,
      kind: level.kind,
      action: level.action,
      kindRaw: payload.object_kind ?? payload.event_name ?? event,
      summary: level.summary,
      ...eventTime(toDate(repoLevelTime(payload))),
      actor: user,
      repo,
      detail: level.detail,
      source: 'webhook',
      payload,
    }]
  }

  const time = eventTime(toDate(threadTime(payload)))
  const changes = changeEvents(instance, payload, user?.login ?? 'someone')
  if (changes.length) {
    return changes.map((change, index) => ({
      forge: FORGE,
      instance,
      id: changes.length === 1 ? deliveryId : `${deliveryId}:${index}`,
      ...change,
      kindRaw: `${payload.object_kind}.update`,
      actionRaw: 'update',
      ...time,
      actor: user,
      repo,
      thread,
      threadSnapshot: snapshot,
      source: 'webhook',
      payload,
    }))
  }

  const kind = eventKindFor(payload)
  const action = attributes?.action
  return [{
    forge: FORGE,
    instance,
    id: deliveryId,
    kind,
    kindRaw: action ? `${payload.object_kind}.${action}` : payload.object_kind ?? event,
    action: action === 'update' && attributes?.oldrev ? 'synchronised' : action === 'merge' ? 'merged' : eventAction(action),
    actionRaw: action,
    detail: kind === 'review_comment'
      ? { type: kind, comment: thread && attributes?.id !== undefined ? { forge: FORGE, instance, thread, id: String(attributes.id) } : undefined, body: attributes?.note }
      : kind === 'comment'
        ? { type: kind, comment: attributes?.id === undefined ? undefined : thread ? { forge: FORGE, instance, thread, id: String(attributes.id) } : commit && { forge: FORGE, instance, commit, id: String(attributes.id) }, body: attributes?.note }
        : kind === 'state_change'
          ? { type: 'state_change', state: action === 'merge' ? 'merged' : action === 'close' ? 'closed' : 'open' }
          : kind === 'review'
            ? { type: 'review', state: 'approved', stateRaw: action, review: thread && payload.user?.username ? { forge: FORGE, instance, thread, id: approvalId(payload.user) } : undefined }
            : undefined,
    summary: payload.object_kind === 'note'
      ? `${user?.login ?? 'someone'} commented`
      : `${user?.login ?? 'someone'} ${action ? `${action} ` : ''}${payload.object_kind ?? event}`.trim(),
    ...time,
    actor: user,
    repo,
    thread,
    commit,
    threadSnapshot: snapshot,
    source: 'webhook',
    payload,
  }]
}
