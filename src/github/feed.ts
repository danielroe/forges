import type { ForgeEventInput, RepoRef } from '../model.ts'
import type { GitHubEventContext, GitHubEventPayload } from './events.ts'
import type { GitHubFeedEvent } from './types.ts'
import { toDate } from '../utils.ts'
import { toGitHubEvent } from './events.ts'
import { FORGE, toActor } from './normalise.ts'

/** Activity feed event types and the webhook events they correspond to. */
const FEED_EVENTS: Record<string, string> = {
  CommitCommentEvent: 'commit_comment',
  CreateEvent: 'create',
  DeleteEvent: 'delete',
  DiscussionEvent: 'discussion',
  IssueCommentEvent: 'issue_comment',
  IssuesEvent: 'issues',
  MemberEvent: 'member',
  PullRequestEvent: 'pull_request',
  PullRequestReviewCommentEvent: 'pull_request_review_comment',
  PullRequestReviewEvent: 'pull_request_review',
  PushEvent: 'push',
  ReleaseEvent: 'release',
}

/** Summaries of the feed event types that have no shared kind. */
const FEED_SUMMARIES: Record<string, string> = {
  ForkEvent: 'forked the repository',
  GollumEvent: 'edited the wiki',
  PublicEvent: 'made the repository public',
  SponsorshipEvent: 'changed a sponsorship',
  WatchEvent: 'starred the repository',
}

/** Normalises an item of a repository's or an account's activity feed. */
export function toFeedEvent(instance: string, raw: GitHubFeedEvent): ForgeEventInput {
  const type = raw.type ?? 'Event'
  const payload = (raw.payload ?? {}) as GitHubEventPayload
  const [owner = '', name = ''] = raw.repo?.name.split('/') ?? []
  const repo: RepoRef | undefined = raw.repo ? { forge: FORGE, instance, owner, name, externalId: String(raw.repo.id) } : undefined
  const actor = toActor(instance, raw.actor)
  const context: GitHubEventContext = {
    id: raw.id,
    kindRaw: payload.action ? `${type}.${payload.action}` : type,
    actionRaw: payload.action,
    source: 'poll',
    actor,
    repo,
    occurredAt: toDate(raw.created_at),
    payload: raw,
  }
  const event = FEED_EVENTS[type]
  if (!event) {
    return {
      forge: FORGE,
      instance,
      ...context,
      kind: 'other',
      summary: `${actor?.login ?? 'someone'} ${FEED_SUMMARIES[type] ?? type}`,
      occurredAt: context.occurredAt ?? new Date(),
      payload: raw,
    }
  }
  if (type === 'PullRequestReviewEvent' && payload.action === 'created') {
    return toGitHubEvent(instance, event, { ...payload, action: 'submitted' }, context)
  }
  return toGitHubEvent(instance, event, payload, context)
}
