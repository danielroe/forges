import type { EventAction, EventKind, ForgeEventInput, RepoRef, ThreadState } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventAction, eventTime, threadSnapshot } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE, toActor } from './normalise.ts'

export const EVENT_HEADER = 'x-tangled-event'
export const DELIVERY_HEADER = 'x-tangled-delivery'

const PULL_ACTIONS: Record<string, EventAction> = { created: 'opened', resubmitted: 'synchronised' }

interface TangledWebhookPayload {
  action?: string
  ref?: string
  before?: string
  after?: string
  pusher?: { did: string }
  sender?: { did: string }
  repository?: { name: string, full_name?: string, owner?: { did: string }, updated_at?: string }
  pull_request?: {
    number: number
    title?: string
    body?: string
    state?: string
    target_branch?: string
    source?: { branch?: string, sha?: string }
    owner?: { did: string }
    created_at?: string
    html_url?: string
  }
  commits?: Array<{ sha?: string, id?: string, message?: string, author?: { did?: string, name?: string } }>
}

/** A ref that did not exist before the push, or no longer exists after it. */
const ZERO_SHA = '0000000000000000000000000000000000000000'

const PULL_STATES: Record<string, ThreadState> = { created: 'open', reopened: 'open', merged: 'merged', closed: 'closed' }

const PULL_KINDS: Record<string, EventKind> = {
  created: 'state_change',
  merged: 'state_change',
  closed: 'state_change',
  reopened: 'state_change',
  resubmitted: 'commit',
}

export function translateTangledWebhook(instance: string, delivery: WebhookDelivery, webUrl: string): ForgeEventInput[] {
  const event = headerValue(delivery.headers, EVENT_HEADER)
  if (!event) {
    throw new WebhookVerificationError(`Missing ${EVENT_HEADER} header`, { forge: FORGE, instance })
  }
  const deliveryId = headerValue(delivery.headers, DELIVERY_HEADER) ?? crypto.randomUUID()
  const payload = JSON.parse(bodyText(delivery.body)) as TangledWebhookPayload
  const ownerDid = payload.repository?.owner?.did ?? payload.repository?.full_name?.split('/')[0]
  const repo: RepoRef | undefined = payload.repository && ownerDid
    ? { forge: FORGE, instance, owner: ownerDid, name: payload.repository.name }
    : undefined
  const actorDid = payload.sender?.did ?? payload.pusher?.did
  const actor = actorDid
    ? { forge: FORGE, instance, login: actorDid, id: actorDid, url: `${webUrl}/${actorDid}`, isBotHint: false }
    : undefined
  const who = actor?.login ?? 'someone'

  if (event.startsWith('pull_request:') && payload.pull_request) {
    const action = payload.action ?? event.slice('pull_request:'.length)
    const pull = payload.pull_request
    const state = pull.state === 'open' || pull.state === 'closed' || pull.state === 'merged' ? pull.state : undefined
    return [{
      forge: FORGE,
      instance,
      id: deliveryId,
      kind: PULL_KINDS[action] ?? 'other',
      ...PULL_STATES[action] ? { detail: { type: 'state_change', state: PULL_STATES[action] } } : {},
      kindRaw: event,
      action: PULL_ACTIONS[action] ?? eventAction(action),
      actionRaw: action,
      summary: `${who} ${action === 'resubmitted' ? 'pushed a new round to' : action} pull request #${payload.pull_request.number}`,
      ...eventTime(action === 'created' ? toDate(payload.pull_request.created_at) : undefined),
      actor,
      repo,
      thread: repo
        ? {
            forge: FORGE,
            instance,
            repo,
            kind: 'pull_request',
            typeRaw: 'sh.tangled.repo.pull',
            displayNumber: String(payload.pull_request.number),
          }
        : undefined,
      threadSnapshot: threadSnapshot({
        title: pull.title,
        body: pull.body,
        state,
        stateRaw: pull.state,
        author: pull.owner && toActor(instance, { did: pull.owner.did }, webUrl),
        url: pull.html_url,
        branches: pull.target_branch && pull.source?.branch ? { head: { ref: pull.source.branch, sha: pull.source.sha }, base: { ref: pull.target_branch } } : undefined,
      }),
      source: 'webhook',
      payload,
    }]
  }

  const base = {
    forge: FORGE,
    instance,
    id: deliveryId,
    kindRaw: event,
    occurredAt: new Date(),
    undated: true,
    actor,
    repo,
    source: 'webhook' as const,
    payload,
  }

  if (event === 'push' && payload.ref) {
    return [{
      ...base,
      ...refEvent(who, {
        ref: payload.ref,
        before: payload.before,
        after: payload.after,
        created: payload.before === ZERO_SHA,
        deleted: payload.after === ZERO_SHA,
        commits: (payload.commits ?? []).map(commit => ({
          sha: commit.sha ?? commit.id ?? '',
          message: commit.message,
          author: commit.author?.did ?? commit.author?.name,
        })),
      }),
    }]
  }

  return [{ ...base, kind: 'other', summary: `${who} ${event}` }]
}
