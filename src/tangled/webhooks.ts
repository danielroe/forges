import type { WebhookHandlers } from '../define.ts'
import type { EventAction, EventKind, ForgeEventInput, RepoRef, WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { TangledOptions } from './index.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventAction } from '../events.ts'
import { toDate } from '../utils.ts'
import { refEvent, verifyHmacSignature } from '../webhooks.ts'
import { FORGE } from './normalise.ts'

export const SIGNATURE_HEADER = 'x-tangled-signature-256'
export const EVENT_HEADER = 'x-tangled-event'
export const DELIVERY_HEADER = 'x-tangled-delivery'

const PULL_ACTIONS: Record<string, EventAction> = { created: 'opened', resubmitted: 'synchronised' }

export function verifyTangledSignature(delivery: WebhookDelivery, secret: string | undefined): Promise<boolean> {
  return verifyHmacSignature(delivery, secret, { header: SIGNATURE_HEADER, prefix: 'sha256=' })
}

interface TangledWebhookPayload {
  action?: string
  ref?: string
  before?: string
  after?: string
  pusher?: { did: string }
  sender?: { did: string }
  repository?: { name: string, full_name?: string, owner?: { did: string }, updated_at?: string }
  pull_request?: { number: number, title?: string, state?: string, created_at?: string, html_url?: string }
  commits?: Array<{ sha?: string, id?: string, message?: string, author?: { did?: string, name?: string } }>
}

/** A ref that did not exist before the push, or no longer exists after it. */
const ZERO_SHA = '0000000000000000000000000000000000000000'

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
    return [{
      forge: FORGE,
      instance,
      id: deliveryId,
      kind: PULL_KINDS[action] ?? 'other',
      kindRaw: event,
      action: PULL_ACTIONS[action] ?? eventAction(action),
      actionRaw: action,
      summary: `${who} ${action === 'resubmitted' ? 'pushed a new round to' : action} pull request #${payload.pull_request.number}`,
      occurredAt: action === 'created' ? toDate(payload.pull_request.created_at) ?? new Date() : new Date(),
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

const TANGLED_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'push' },
]

export const tangledWebhooks: WebhookHandlers<TangledOptions> = ({ options, instance, baseUrl }) => ({
  events: TANGLED_WEBHOOK_EVENTS,
  verify: delivery => verifyTangledSignature(delivery, options.webhookSecret),
  translate: async (delivery) => {
    const events = await translateTangledWebhook(instance, delivery, baseUrl)
    if (!options.resolveDisplayNumber) {
      return events
    }
    for (const event of events) {
      const thread = event.thread
      if (thread?.displayNumber && !thread.number) {
        const number = await options.resolveDisplayNumber(thread.repo, thread.kind, thread.displayNumber)
        if (number) {
          event.thread = { ...thread, number, externalId: number }
        }
      }
    }
    return events
  },
})
