import type { WebhookHandlers } from '../define.ts'
import type { EventKind, ForgeEventInput, ThreadRef } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { GiteeOptions } from './index.ts'
import type { GiteeIssue, GiteePullRequest, GiteeRepository, GiteeUser } from './types.ts'
import { bodyText, headerValue, hmacSha256Base64, timingSafeEqual } from '../crypto.ts'
import { eventTime } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent, verifySharedToken } from '../webhooks.ts'
import { FORGE, toActor, toRepoRef } from './normalise.ts'
import { GITEE_WEBHOOK_EVENTS } from './webhook-events.ts'

/** Gitee rejects signatures more than an hour from the request time. */
const TOLERANCE_MS = 3_600_000

/**
 * Gitee sends either the hook password, or a signature, in `X-Gitee-Token`.
 * The signature is the URL-encoded base64 HMAC-SHA256 of
 * `<X-Gitee-Timestamp>\n<secret>` under the secret, with the timestamp in
 * milliseconds; it signs the timestamp, not the body.
 */
export async function verifyGiteeToken(delivery: WebhookDelivery, secret: string | undefined, now: number = Date.now()): Promise<boolean> {
  const token = headerValue(delivery.headers, 'x-gitee-token')
  const key = delivery.secret ?? secret
  if (!key || !token) {
    return false
  }
  if (verifySharedToken(delivery, secret, 'x-gitee-token')) {
    return true
  }
  const timestamp = headerValue(delivery.headers, 'x-gitee-timestamp')
  if (!timestamp || !(Math.abs(now - Number(timestamp)) <= TOLERANCE_MS)) {
    return false
  }
  const expected = await hmacSha256Base64(key, `${timestamp}\n${key}`)
  let received = token
  try {
    received = decodeURIComponent(token)
  }
  catch {}
  return timingSafeEqual(received, expected)
}

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
  const thread: ThreadRef | undefined = repo && payload.pull_request
    ? { forge: FORGE, instance, repo, kind: 'pull_request', number: String(payload.pull_request.number) }
    : repo && payload.issue
      ? { forge: FORGE, instance, repo, kind: 'issue', number: payload.issue.number }
      : undefined
  if (hook === 'note_hooks' || hook === 'Note Hook') {
    const comment = thread && payload.comment ? { forge: FORGE, instance, thread, id: String(payload.comment.id) } : undefined
    return [{ ...base, kind: 'comment', thread, detail: { type: 'comment', comment, body: payload.comment?.body }, summary: `${who} commented${thread ? ` on ${thread.kind === 'issue' ? '' : '!'}${thread.number}` : ''}` }]
  }
  return [{ ...base, kind: KINDS[payload.action ?? ''] ?? 'other', thread, summary: `${who} ${payload.action ?? 'changed'} ${thread ? `${thread.kind === 'issue' ? '' : '!'}${thread.number}` : hook}` }]
}

export const giteeWebhooks: WebhookHandlers<GiteeOptions> = ({ options, instance }) => ({
  events: GITEE_WEBHOOK_EVENTS,
  verify: delivery => verifyGiteeToken(delivery, options.webhookSecret),
  translate: delivery => translateGiteeWebhook(instance, delivery),
})
