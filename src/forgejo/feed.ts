import type { EventAction, EventDetail, EventKind, ForgeEventInput, ForgeOrigin, RepoRef, ReviewState, ThreadRef, ThreadState } from '../model.ts'
import type { ForgejoActivity, ForgejoPushContent } from './types.ts'
import { eventTime } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { toActor, toRepoRef } from './normalise.ts'

interface FeedThreadOp {
  thread: 'issue' | 'pull_request'
  kind: EventKind
  action: EventAction
  state?: ThreadState
  review?: ReviewState
}

/** Activity types about an issue or a pull request, whose `content` starts with its number. */
const FEED_THREAD_OPS: Record<string, FeedThreadOp> = {
  create_issue: { thread: 'issue', kind: 'state_change', action: 'opened', state: 'open' },
  close_issue: { thread: 'issue', kind: 'state_change', action: 'closed', state: 'closed' },
  reopen_issue: { thread: 'issue', kind: 'state_change', action: 'reopened', state: 'open' },
  comment_issue: { thread: 'issue', kind: 'comment', action: 'created' },
  create_pull_request: { thread: 'pull_request', kind: 'state_change', action: 'opened', state: 'open' },
  close_pull_request: { thread: 'pull_request', kind: 'state_change', action: 'closed', state: 'closed' },
  reopen_pull_request: { thread: 'pull_request', kind: 'state_change', action: 'reopened', state: 'open' },
  merge_pull_request: { thread: 'pull_request', kind: 'state_change', action: 'merged', state: 'merged' },
  auto_merge_pull_request: { thread: 'pull_request', kind: 'state_change', action: 'merged', state: 'merged' },
  pull_request_ready_for_review: { thread: 'pull_request', kind: 'state_change', action: 'ready_for_review', state: 'open' },
  comment_pull: { thread: 'pull_request', kind: 'comment', action: 'created' },
  approve_pull_request: { thread: 'pull_request', kind: 'review', action: 'submitted', review: 'approved' },
  reject_pull_request: { thread: 'pull_request', kind: 'review', action: 'submitted', review: 'changes_requested' },
  pull_review_dismissed: { thread: 'pull_request', kind: 'review', action: 'other', review: 'dismissed' },
}

/** Splits thread activity `content` into the thread number and its text. */
function threadContent(content = ''): [string, string] {
  if (content.startsWith('[')) {
    try {
      const [number = '', text = ''] = JSON.parse(content) as string[]
      return [String(number), text]
    }
    catch {
      return ['', content]
    }
  }
  const index = content.indexOf('|')
  return index < 0 ? [content, ''] : [content.slice(0, index), content.slice(index + 1)]
}

function pushContent(content: string | undefined): ForgejoPushContent {
  try {
    return content ? JSON.parse(content) as ForgejoPushContent : {}
  }
  catch {
    return {}
  }
}

function feedLevel(origin: ForgeOrigin, raw: ForgejoActivity, repo: RepoRef | undefined, who: string): Pick<ForgeEventInput, 'kind' | 'action' | 'detail' | 'summary' | 'thread'> {
  const ref = raw.ref_name ?? ''
  const name = ref.replace(/^refs\/(?:heads|tags)\//, '')
  // Gitea before 1.14 stored the short name of a pushed tag, and those rows were never migrated
  const refType = raw.op_type === 'push_tag' || raw.op_type === 'delete_tag' || ref.startsWith('refs/tags/') ? 'tag' : 'branch'
  switch (raw.op_type) {
    case 'commit_repo':
    case 'mirror_sync_push': {
      const push = pushContent(raw.content)
      return refEvent(who, {
        ref,
        before: /\/compare\/([0-9a-f]+)\.\.\./.exec(push.CompareURL ?? '')?.[1],
        after: push.HeadCommit?.Sha1 ?? push.Commits?.[0]?.Sha1,
        commits: push.Commits?.map(commit => ({ sha: commit.Sha1, message: commit.Message, author: commit.AuthorName })),
        commitCount: push.Len,
      })
    }
    case 'push_tag':
    case 'mirror_sync_create':
    case 'delete_tag':
    case 'delete_branch':
    case 'mirror_sync_delete': {
      const action = raw.op_type === 'push_tag' || raw.op_type === 'mirror_sync_create' ? 'created' : 'deleted'
      return { kind: 'ref', action, detail: { type: 'ref', ref: name, refType }, summary: `${who} ${action} ${refType} ${name}` }
    }
    case 'create_repo':
      return { kind: 'repo', action: 'created', summary: `${who} created the repository` }
    case 'rename_repo':
      return { kind: 'repo', action: 'renamed', detail: { type: 'repo_renamed', from: raw.content ?? '', to: raw.repo?.name ?? '' }, summary: `${who} renamed the repository` }
    case 'transfer_repo':
      return { kind: 'repo', action: 'transferred', detail: { type: 'repo_transferred', fromOwner: raw.content?.split('/')[0], toOwner: raw.repo?.owner?.login }, summary: `${who} transferred the repository` }
    case 'publish_release':
      return { kind: 'release', action: 'published', summary: `${who} published ${raw.content || name || 'a release'}` }
  }
  const op = FEED_THREAD_OPS[raw.op_type]
  if (!op) {
    return { kind: 'other', summary: `${who} ${raw.op_type.replaceAll('_', ' ')}` }
  }
  const [number, text] = threadContent(raw.content)
  const thread: ThreadRef | undefined = repo && number ? { ...origin, repo, kind: op.thread, number } : undefined
  const noun = op.thread === 'issue' ? 'issue' : 'pull request'
  const detail: EventDetail = op.kind === 'comment'
    ? { type: 'comment', comment: thread && raw.comment ? { ...origin, thread, id: String(raw.comment.id) } : undefined, body: raw.comment?.body ?? text }
    : op.review
      ? { type: 'review', state: op.review, stateRaw: raw.op_type, body: text || undefined }
      : { type: 'state_change', state: op.state }
  const summary = op.kind === 'comment'
    ? `${who} commented on ${noun} ${number}`
    : op.review ? `${who} reviewed ${noun} ${number} (${op.review})` : `${who} ${op.action.replaceAll('_', ' ')} ${noun} ${number}`
  return { kind: op.kind, action: op.action, thread, detail, summary: summary.trim() }
}

/** Normalises an item of a repository's or a user's activity feed. */
export function toFeedEvent(origin: ForgeOrigin, raw: ForgejoActivity): ForgeEventInput {
  const actor = toActor(origin, raw.act_user)
  const repo = raw.repo ? toRepoRef(origin, raw.repo) : undefined
  return {
    ...origin,
    id: String(raw.id),
    kindRaw: raw.op_type,
    ...feedLevel(origin, raw, repo, actor?.login ?? 'someone'),
    ...eventTime(toDate(raw.created)),
    actor,
    repo,
    ...typeof raw.is_private === 'boolean' ? { isPublic: !raw.is_private } : {},
    source: 'poll',
    payload: raw,
  }
}
