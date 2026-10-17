import type { WebhookHandlers } from '../define.ts'
import type { WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { SourcehutOptions } from './index.ts'
import { headerValue } from '../crypto.ts'

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

/**
 * Sourcehut signs a delivery with the instance's ed25519 key over the raw body
 * plus `X-Payload-Nonce`, so verification needs the published public key, not a secret.
 */
export const sourcehutWebhooks: WebhookHandlers<SourcehutOptions> = ({ options, instance }) => {
  const publicKey = options.webhookPublicKey ?? SRHT_WEBHOOK_PUBLIC_KEY
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
    translate: async delivery => (await import('./events.ts')).translateSourcehutWebhook(instance, delivery),
  }
}
