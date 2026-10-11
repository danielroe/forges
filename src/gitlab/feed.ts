import type { EventAction, ForgeEventInput, RepoRef, ThreadRef, ThreadState } from '../model.ts'
import type { GitLabEvent } from './types.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE, toActor, toThreadKind } from './normalise.ts'

const FEED_STATES: Record<string, { action: EventAction, state: ThreadState }> = {
  opened: { action: 'opened', state: 'open' },
  closed: { action: 'closed', state: 'closed' },
  reopened: { action: 'reopened', state: 'open' },
  accepted: { action: 'merged', state: 'merged' },
}

function feedThread(repo: RepoRef | undefined, type: string | null | undefined, number: number | string | null | undefined): ThreadRef | undefined {
  const kind = toThreadKind(type === 'WorkItem' ? 'Issue' : type ?? '')
  return repo && kind !== 'other' && number !== null && number !== undefined
    ? { forge: FORGE, instance: repo.instance, repo, kind, number: String(number) }
    : undefined
}

function feedLevel(instance: string, raw: GitLabEvent, repo: RepoRef | undefined, who: string): Pick<ForgeEventInput, 'kind' | 'action' | 'detail' | 'summary' | 'thread'> {
  const push = raw.push_data
  if (push) {
    const tag = push.ref_type === 'tag'
    return refEvent(who, {
      ref: `${tag ? 'refs/tags/' : 'refs/heads/'}${push.ref ?? ''}`,
      refType: tag ? 'tag' : 'branch',
      before: push.commit_from ?? undefined,
      after: push.commit_to ?? undefined,
      created: push.action === 'created',
      deleted: push.action === 'removed',
      commits: push.commit_to && push.commit_title ? [{ sha: push.commit_to, message: push.commit_title }] : [],
      commitCount: push.commit_count,
    })
  }
  const note = raw.note
  if (note) {
    const kind = note.type === 'DiffNote' || note.position ? 'review_comment' : 'comment'
    const thread = feedThread(repo, note.noteable_type, note.noteable_type === 'Commit' ? note.commit_id : note.noteable_iid)
    const comment = thread && { forge: FORGE, instance: thread.instance, thread, id: String(note.id) }
    return { kind, action: 'created', thread, detail: { type: kind, comment, body: note.body }, summary: `${who} commented` }
  }
  const thread = feedThread(repo, raw.target_type, raw.target_iid)
  const noun = thread?.kind === 'pull_request' ? 'merge request' : 'issue'
  const state = FEED_STATES[raw.action_name]
  if (thread && state) {
    return { kind: 'state_change', action: state.action, thread, detail: { type: 'state_change', state: state.state }, summary: `${who} ${state.action} ${noun}` }
  }
  if (thread && raw.action_name === 'approved') {
    return { kind: 'review', action: 'submitted', thread, detail: { type: 'review', state: 'approved', stateRaw: 'approved' }, summary: `${who} approved ${noun}` }
  }
  if (raw.target_type === 'Project' && (raw.action_name === 'joined' || raw.action_name === 'left')) {
    return {
      kind: 'membership',
      action: raw.action_name === 'joined' ? 'added' : 'removed',
      detail: { type: 'membership', actionRaw: raw.action_name, member: toActor(instance, raw.author) },
      summary: `${who} ${raw.action_name} the project`,
    }
  }
  if (raw.target_type === 'Project' && (raw.action_name === 'created' || raw.action_name === 'deleted' || raw.action_name === 'destroyed')) {
    return { kind: 'repo', action: raw.action_name === 'created' ? 'created' : 'deleted', summary: `${who} ${raw.action_name} the project` }
  }
  return { kind: 'other', thread, summary: `${who} ${raw.action_name} ${raw.target_type ?? ''}`.trim() }
}

/** Normalises an item of a project's or a user's activity feed; `repo` is the project, where it is known. */
export function toFeedEvent(instance: string, raw: GitLabEvent, repo: RepoRef | undefined): ForgeEventInput {
  const actor = toActor(instance, raw.author)
  return {
    forge: FORGE,
    instance,
    id: String(raw.id),
    kindRaw: [raw.target_type, raw.action_name].filter(Boolean).join('.'),
    actionRaw: raw.action_name,
    ...feedLevel(instance, raw, repo, actor?.login ?? raw.author_username ?? 'someone'),
    occurredAt: toDate(raw.created_at) ?? new Date(),
    actor,
    repo,
    source: 'poll',
    payload: raw,
  }
}
