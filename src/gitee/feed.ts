import type { ForgeEventInput, RepoRef, ThreadRef } from '../model.ts'
import type { GiteeEvent } from './types.ts'
import { eventAction, eventTime } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE, toActor, toRepoRef } from './normalise.ts'

/** Summaries of the feed event types that have no shared kind. */
const FEED_SUMMARIES: Record<string, string> = {
  WatchEvent: 'watched the repository',
}

const THREAD_TYPES: Record<string, 'issue' | 'pull_request'> = {
  IssueEvent: 'issue',
  IssueCommentEvent: 'issue',
  PullRequestEvent: 'pull_request',
  PullRequestCommentEvent: 'pull_request',
}

function feedLevel(instance: string, raw: GiteeEvent, repo: RepoRef | undefined, who: string): Pick<ForgeEventInput, 'kind' | 'action' | 'detail' | 'summary' | 'thread'> {
  const type = raw.type ?? 'Event'
  const payload = raw.payload ?? {}
  switch (type) {
    case 'PushEvent':
      return refEvent(who, {
        ref: payload.ref ?? '',
        before: payload.before,
        after: payload.after,
        created: payload.created,
        deleted: payload.deleted,
        commits: payload.commits?.map(commit => ({ sha: commit.sha, message: commit.message, author: commit.author?.name, url: commit.url })),
        commitCount: payload.size,
      })
    case 'CreateEvent':
    case 'DeleteEvent': {
      const action = type === 'CreateEvent' ? 'created' : 'deleted'
      return { kind: 'ref', action, detail: { type: 'ref', ref: payload.ref ?? '', refType: payload.ref_type ?? 'branch' }, summary: `${who} ${action} ${payload.ref_type ?? 'ref'} ${payload.ref ?? ''}`.trim() }
    }
    case 'StarEvent':
      return { kind: 'star', action: 'created', summary: `${who} starred the repository` }
    case 'ForkEvent':
      return { kind: 'fork', action: 'created', summary: `${who} forked the repository` }
    case 'MemberEvent':
      return {
        kind: 'membership',
        action: payload.action === 'deleted' ? 'removed' : eventAction(payload.action) ?? 'other',
        detail: { type: 'membership', actionRaw: payload.action ?? 'member', member: payload.login ? toActor(instance, { id: payload.id ?? 0, login: payload.login, name: payload.name }) : undefined },
        summary: `${who} ${payload.action ?? 'changed'} member ${payload.login ?? ''}`.trim(),
      }
  }
  const kind = THREAD_TYPES[type]
  const number = type === 'IssueEvent' || type === 'PullRequestEvent' ? payload.number : (payload.pull_request ?? payload.issue)?.number
  const thread: ThreadRef | undefined = repo && kind && number !== undefined ? { forge: FORGE, instance, repo, kind, number: String(number) } : undefined
  const mention = thread ? ` ${kind === 'issue' ? '' : '!'}${thread.number}` : ''
  if (type === 'IssueCommentEvent' || type === 'PullRequestCommentEvent') {
    const comment = thread && payload.comment ? { forge: FORGE, instance, thread, id: String(payload.comment.id) } : undefined
    return { kind: 'comment', action: 'created', thread, detail: { type: 'comment', comment, body: payload.comment?.body }, summary: `${who} commented${mention && ` on${mention}`}` }
  }
  const action = eventAction(payload.action)
  if (thread && (action === 'opened' || action === 'closed' || action === 'reopened' || action === 'merged')) {
    return { kind: 'state_change', action, thread, detail: { type: 'state_change', state: action === 'merged' ? 'merged' : action === 'closed' ? 'closed' : 'open' }, summary: `${who} ${payload.action}${mention}` }
  }
  return { kind: 'other', thread, summary: `${who} ${FEED_SUMMARIES[type] ?? `${payload.action ?? ''} ${type}`.trim()}${mention}` }
}

/** Normalises an item of a repository's or a user's activity feed. */
export function toFeedEvent(instance: string, raw: GiteeEvent): ForgeEventInput {
  const actor = toActor(instance, raw.actor)
  const repo = raw.repo ? toRepoRef(instance, raw.repo) : undefined
  const type = raw.type ?? 'Event'
  const action = raw.payload?.action
  return {
    forge: FORGE,
    instance,
    id: raw.id ?? '',
    kindRaw: action ? `${type}.${action}` : type,
    actionRaw: action,
    ...feedLevel(instance, raw, repo, actor?.login ?? 'someone'),
    ...eventTime(toDate(raw.created_at)),
    actor,
    repo,
    source: 'poll',
    payload: raw,
  }
}
