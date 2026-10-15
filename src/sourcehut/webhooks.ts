import type { WebhookHandlers } from '../define.ts'
import type { ForgeEventInput, WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { SourcehutOptions } from './index.ts'
import { bodyText, headerValue } from '../crypto.ts'
import { WebhookVerificationError } from '../errors.ts'
import { eventTime } from '../events.ts'
import { toDate } from '../utils.ts'
import { FORGE } from './normalise.ts'

/** The public key of `sr.ht`, from https://man.sr.ht/graphql.md#webhook-authenticity. */
export const SRHT_WEBHOOK_PUBLIC_KEY = 'uX7KWyyDNMaBma4aVbJ/cbUQpdjqczuCyK/HxzV+f+4='

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0)) as Uint8Array<ArrayBuffer>
}

async function verifyEd25519(publicKey: string, signature: string, message: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(publicKey), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify('Ed25519', key, fromBase64(signature), message)
  }
  catch {
    return false
  }
}

interface ShWebhookNode {
  uuid?: string
  event?: string
  date?: string
  repository?: { name?: string, owner?: { canonicalName?: string }, rid?: string }
  pusher?: { canonicalName?: string }
  updates?: Array<{ ref?: { name?: string }, old?: { id?: string }, new?: { id?: string } }>
}

function webhookNode(body: string): ShWebhookNode | undefined {
  try {
    const parsed = JSON.parse(body) as { data?: { webhook?: unknown } }
    const node: unknown = parsed?.data?.webhook ?? parsed
    // A primitive or array is not a delivery; treating it as one would fabricate an event.
    return typeof node === 'object' && node !== null && !Array.isArray(node) ? node as ShWebhookNode : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Sourcehut signs a delivery with the instance's ed25519 key over the raw body
 * plus `X-Payload-Nonce`, so verification needs the published public key, not a secret.
 */
export const sourcehutWebhooks: WebhookHandlers<SourcehutOptions> = ({ options, instance }) => {
  const publicKey = options.webhookPublicKey ?? SRHT_WEBHOOK_PUBLIC_KEY
  const origin = { forge: FORGE, instance }
  return {
    events: [
      { kind: 'push' },
      { kind: 'repo', action: 'created' },
      { kind: 'repo', action: 'edited' },
      { kind: 'repo', action: 'deleted' },
    ] satisfies WebhookEventType[],
    async verify(delivery: WebhookDelivery) {
      const signature = headerValue(delivery.headers, 'x-payload-signature')
      const nonce = headerValue(delivery.headers, 'x-payload-nonce')
      if (!signature || !nonce) {
        return false
      }
      const body = bytes(delivery.body)
      const suffix = new TextEncoder().encode(nonce)
      const message = new Uint8Array(body.length + suffix.length)
      message.set(body)
      message.set(suffix, body.length)
      return verifyEd25519(publicKey, signature, message)
    },
    translate(delivery: WebhookDelivery) {
      const node = webhookNode(bodyText(delivery.body))
      if (!node) {
        throw new WebhookVerificationError('Sourcehut delivery is not a GraphQL result', origin)
      }
      const repo = node.repository ? { ...origin, owner: repoOwner(node), name: node.repository.name ?? '' } : undefined
      const base = { ...origin, ...eventTime(toDate(node.date)), source: 'webhook' as const, payload: node }
      if (node.event === 'GIT_POST_RECEIVE') {
        return (node.updates ?? []).map((update, index): ForgeEventInput => ({
          ...base,
          id: `${node.uuid ?? 'delivery'}-${index}`,
          kind: 'push',
          kindRaw: node.event,
          actionRaw: 'created',
          summary: `${node.pusher?.canonicalName ?? 'someone'} pushed to ${update.ref?.name ?? 'a ref'}`,
          actor: node.pusher ? { ...origin, login: node.pusher.canonicalName ?? '', id: '', isBotHint: false } : undefined,
          repo,
          detail: { type: 'push', ref: update.ref?.name ?? '', before: update.old?.id, after: update.new?.id, forced: false, commits: [] },
        }))
      }
      if (node.event === 'REPO_CREATED' || node.event === 'REPO_UPDATE' || node.event === 'REPO_DELETED') {
        const action = node.event === 'REPO_CREATED' ? 'created' : node.event === 'REPO_DELETED' ? 'deleted' : 'edited'
        return [{
          ...base,
          id: node.uuid ?? 'delivery',
          kind: 'repo',
          kindRaw: node.event,
          actionRaw: action,
          summary: `${node.event} on ${repo ? `${repo.owner}/${repo.name}` : 'a repository'}`,
          repo,
        }]
      }
      // A git pre-receive, or an event from a service whose payload we do not map: report it rather than call it a repo edit.
      return [{
        ...base,
        id: node.uuid ?? 'delivery',
        kind: 'other',
        kindRaw: node.event ?? 'delivery',
        actionRaw: 'other',
        summary: `${node.event ?? 'delivery'} on ${repo ? `${repo.owner}/${repo.name}` : 'a repository'}`,
        repo,
      }]
    },
  }
}

function repoOwner(node: ShWebhookNode): string {
  return node.repository?.owner?.canonicalName ?? ''
}
