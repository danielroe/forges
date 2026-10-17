import type { EventKind, ForgeEventInput, ResolvedThreadRef, ThreadState } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GiteeIssue, GiteePullRequest, GiteeRepository, GiteeUser } from './types.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { eventTime, snapshotOfThread } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE, toActor, toIssueThread, toPullThread, toRepoRef } from './normalise.ts'

interface GiteeWebhookPayload {
  hook_name?: string
  action?: string
  timestamp?: string | number
  sender?: GiteeUser
  repository?: GiteeRepository
  project?: GiteeRepository
  issue?: GiteeIssue
  pull_request?: GiteePullRequest
  comment?: { id: number, body?: string, created_at?: string, user?: GiteeUser }
  noteable_type?: string
  ref?: string
  before?: string
  after?: string
  created?: boolean
  deleted?: boolean
  commits?: Array<{ id: string, message: string, timestamp?: string, url?: string, author?: { name?: string, username?: string } }>
  head_commit?: { id: string, timestamp?: string } | null
  user?: GiteeUser
}

const STATES: Record<string, ThreadState> = { open: 'open', reopen: 'open', close: 'closed', merge: 'merged' }

const KINDS: Record<string, EventKind> = {
  open: 'state_change',
  close: 'state_change',
  reopen: 'state_change',
  merge: 'state_change',
  state_change: 'state_change',
  approved: 'review',
  tested: 'review',
  assign: 'assignment',
  label: 'label',
}

/**
 * The time of the change a delivery reports, else the time its subject last
 * changed, else the time of the pushed head commit.
 */
function giteeTime(hook: string, payload: GiteeWebhookPayload): Date | undefined {
  const { action, comment, issue, pull_request: pull } = payload
  const subject = pull ?? issue
  let own: string | null | undefined
  if (hook === 'note_hooks' || hook === 'Note Hook') {
    own = comment?.created_at
  }
  else if (action === 'open') {
    own = subject?.created_at
  }
  else if (action === 'merge') {
    own = pull?.merged_at
  }
  else if (action === 'close') {
    own = pull ? pull.closed_at : issue?.finished_at
  }
  return toDate(own ?? subject?.updated_at ?? payload.head_commit?.timestamp ?? payload.commits?.at(-1)?.timestamp)
}

export function translateGiteeWebhook(instance: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const payload = JSON.parse(bodyText(delivery.body)) as GiteeWebhookPayload
  const hook = payload.hook_name ?? headerValue(delivery.headers, 'x-gitee-event') ?? ''
  const rawRepo = payload.repository ?? payload.project
  const repo = rawRepo ? toRepoRef(instance, rawRepo) : undefined
  const actor = toActor(instance, payload.sender ?? payload.user ?? payload.comment?.user)
  const who = actor?.login ?? 'someone'
  const base = {
    forge: FORGE,
    instance,
    id: headerValue(delivery.headers, 'x-gitee-delivery') ?? `${hook}:${payload.timestamp ?? Date.now()}`,
    kindRaw: payload.action ? `${hook}.${payload.action}` : hook,
    ...eventTime(giteeTime(hook, payload)),
    actor,
    repo,
    source: 'webhook' as const,
    payload,
  }
  if (hook === 'push_hooks' || hook === 'tag_push_hooks' || hook === 'Push Hook' || hook === 'Tag Push Hook') {
    return [{
      ...base,
      ...refEvent(who, {
        ref: payload.ref ?? '',
        before: payload.before,
        after: payload.after,
        created: payload.created,
        deleted: payload.deleted,
        commits: (payload.commits ?? []).map(commit => ({ sha: commit.id, message: commit.message, author: commit.author?.username ?? commit.author?.name, url: commit.url })),
      }),
    }]
  }
  const thread: ResolvedThreadRef | undefined = repo && payload.pull_request
    ? { forge: FORGE, instance, repo, kind: 'pull_request', number: String(payload.pull_request.number) }
    : repo && payload.issue
      ? { forge: FORGE, instance, repo, kind: 'issue', number: payload.issue.number }
      : undefined
  const raw = payload.pull_request ?? payload.issue
  const normalised = thread && (payload.pull_request ? toPullThread(thread, payload.pull_request) : payload.issue && toIssueThread(thread, payload.issue))
  const threadSnapshot = normalised && snapshotOfThread({ ...normalised, isDraft: payload.pull_request ? payload.pull_request.draft ?? undefined : false, labels: raw?.labels ? normalised.labels : undefined })
  if (hook === 'note_hooks' || hook === 'Note Hook') {
    const comment = thread && payload.comment ? { forge: FORGE, instance, thread, id: String(payload.comment.id) } : undefined
    return [{ ...base, kind: 'comment', thread, threadSnapshot, detail: { type: 'comment', comment, body: payload.comment?.body }, summary: `${who} commented${thread ? ` on ${thread.kind === 'issue' ? '' : '!'}${thread.number}` : ''}` }]
  }
  const state = STATES[payload.action ?? '']
  return [{ ...base, kind: KINDS[payload.action ?? ''] ?? 'other', thread, threadSnapshot, ...state ? { detail: { type: 'state_change', state } } : {}, summary: `${who} ${payload.action ?? 'changed'} ${thread ? `${thread.kind === 'issue' ? '' : '!'}${thread.number}` : hook}` }]
}
