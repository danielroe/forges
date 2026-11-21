import type { ProviderSpec, WebhookHandlers } from '../define.ts'
import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher } from '../fetch.ts'
import type {
  BaseOptions,
  EventKind,
  Page,
  RepoRef,
  Webhook,
  WebhookDeliveryRecord,
  WebhookRef,
  WebhookUpdate,
} from '../model.ts'
import type { TangledOptions } from './index.ts'
import type { RepoHandle, XrpcParams } from './records.ts'
import { verb } from '../define.ts'
import { NotFoundError, UnsupportedOperationError } from '../errors.ts'
import { toDate } from '../utils.ts'
import { eventKindsOf, nativeEventsFor, verifyHmacSignature } from '../webhooks.ts'
import { serviceDidForHost } from './atproto.ts'
import { FORGE } from './normalise.ts'
import { xrpcPath } from './records.ts'

export const SIGNATURE_HEADER = 'x-tangled-signature-256'

/** The Tangled event names behind each normalised kind, as a webhook subscription names them. */
export const NATIVE_EVENTS: Partial<Record<EventKind, readonly string[]>> = {
  push: ['push'],
  state_change: [
    'pull_request:created',
    'pull_request:closed',
    'pull_request:merged',
    'pull_request:reopened',
  ],
  commit: ['pull_request:resubmitted'],
  other: ['repository:renamed'],
}

export const tangledWebhooks: WebhookHandlers<TangledOptions> = ({ options, instance, baseUrl }) => ({
  events: [
    { kind: 'state_change', action: 'opened' },
    { kind: 'state_change', action: 'closed' },
    { kind: 'state_change', action: 'merged' },
    { kind: 'state_change', action: 'reopened' },
    { kind: 'commit', action: 'synchronised' },
    { kind: 'push' },
    { kind: 'ref' },
    { kind: 'other', action: 'renamed' },
  ],
  verify: delivery => verifyHmacSignature(delivery, options.webhookSecret, { header: SIGNATURE_HEADER, prefix: 'sha256=' }),
  translate: async delivery => (await import('./events.ts')).translateTangledWebhook(instance, delivery, baseUrl),
})

interface WebhookDeps {
  instance: string
  context: ForgeErrorContext
  fetcher: Fetcher
  repoFor: (repo: RepoRef, signal?: AbortSignal) => Promise<RepoHandle>
  serviceAuth: (aud: string, lxm: string, signal?: AbortSignal) => Promise<string>
}

interface RawWebhook {
  id: string
  url: string
  active: boolean
  events: string[]
  createdAt?: string
  updatedAt?: string
}

interface RawDelivery {
  id: string
  webhook: string
  event: string
  url: string
  requestBody?: unknown
  responseCode?: number
  responseBody?: unknown
  success: boolean
  createdAt: string
}

/** Manages the webhooks a repository's spindle delivers. */
export function createTangledWebhooks({ instance, context, fetcher, repoFor, serviceAuth }: WebhookDeps): ProviderSpec['webhooks'] {
  /** The repository's spindle, which serves `org.tangled.webhook.*`, and the repository's DID. */
  async function spindleOf(repo: RepoRef, signal?: AbortSignal): Promise<{ origin: string, did: string }> {
    const handle = await repoFor(repo, signal)
    const spindle = handle.view.value.spindle?.replace(/^did:web:/, '')
    if (!spindle) {
      throw new UnsupportedOperationError(`${repo.owner}/${repo.name} has no spindle, so it cannot have webhooks`, context)
    }
    return { origin: `https://${decodeURIComponent(spindle)}`, did: handle.did }
  }

  /** Calls a method of the spindle, with a service-auth token for its service DID. */
  async function call<T>(origin: string, nsid: string, init: { query?: XrpcParams, json?: unknown, signal?: AbortSignal } = {}): Promise<T> {
    const token = await serviceAuth(serviceDidForHost(origin), nsid, init.signal)
    return (await fetcher.json<T>(`${origin}${xrpcPath(nsid, init.query)}`, {
      ...init.json === undefined
        ? {}
        : { method: 'POST', json: init.json },
      headers: { authorization: `Bearer ${token}` },
      signal: init.signal,
    })).data
  }

  function toWebhook(target: RepoRef, raw: RawWebhook): Webhook {
    return {
      ref: {
        forge: FORGE,
        instance,
        target,
        id: raw.id,
      },
      url: raw.url,
      events: eventKindsOf(NATIVE_EVENTS, raw.events),
      nativeEvents: raw.events,
      active: raw.active,
      createdAt: toDate(raw.createdAt),
      updatedAt: toDate(raw.updatedAt),
      raw,
    }
  }

  async function listHooks(origin: string, did: string, signal?: AbortSignal): Promise<RawWebhook[]> {
    return (await call<{ webhooks?: RawWebhook[] }>(origin, 'org.tangled.webhook.listWebhooks', {
      query: { repo: did },
      signal,
    })).webhooks ?? []
  }

  /** Updates the hook and reads it back, as `updateWebhook` returns no body. */
  async function update(ref: WebhookRef, update: WebhookUpdate, options: BaseOptions = {}): Promise<Webhook> {
    const { origin, did } = await spindleOf(ref.target, options.signal)
    const events = update.events || update.nativeEvents
      ? nativeEventsFor(NATIVE_EVENTS, update.events, update.nativeEvents)
      : undefined
    await call(origin, 'org.tangled.webhook.updateWebhook', {
      json: {
        repo: did,
        webhook: ref.id,
        ...update.url
          ? { url: update.url }
          : {},
        ...update.active === undefined
          ? {}
          : { active: update.active },
        ...update.secret
          ? { secret: update.secret }
          : {},
        ...events
          ? { events }
          : {},
      },
      signal: options.signal,
    })
    const found = (await listHooks(origin, did, options.signal)).find(hook => hook.id === ref.id)
    if (!found) {
      throw new NotFoundError(`No webhook ${ref.id} on ${ref.target.owner}/${ref.target.name}`, 404, '', context)
    }
    return toWebhook(ref.target, found)
  }

  return {
    listPage: verb(true, async (target, listOptions = {}) => {
      if (!(await repoFor(target, listOptions.signal)).view.value.spindle) {
        return { items: [] }
      }
      const { origin, did } = await spindleOf(target, listOptions.signal)
      return {
        items: (await listHooks(origin, did, listOptions.signal)).map(raw => toWebhook(target, raw)),
      }
    }),
    create: verb('unverified', async (target, input, options = {}) => {
      const events = nativeEventsFor(NATIVE_EVENTS, input.events, input.nativeEvents)
      if (!events.length) {
        throw new UnsupportedOperationError('Tangled webhooks deliver pushes, renames and pull requests; none of the requested events', context)
      }
      const { origin, did } = await spindleOf(target, options.signal)
      const active = input.active ?? true
      const { id } = await call<{ id: string }>(origin, 'org.tangled.webhook.createWebhook', {
        json: {
          repo: did,
          url: input.url,
          active,
          events,
          ...input.secret
            ? { secret: input.secret }
            : {},
        },
        signal: options.signal,
      })
      return toWebhook(target, { id, url: input.url, active, events })
    }),
    update: verb('unverified', update),
    delete: verb('unverified', async (ref, options = {}) => {
      const { origin, did } = await spindleOf(ref.target, options.signal)
      await call(origin, 'org.tangled.webhook.deleteWebhook', {
        json: { repo: did, webhook: ref.id },
        signal: options.signal,
      })
    }),
    rotateSecret: verb('unverified', (ref, secret, options) => update(ref, { secret }, options)),
    deliveriesPage: verb(true, async (ref, listOptions = {}): Promise<Page<WebhookDeliveryRecord>> => {
      const { origin, did } = await spindleOf(ref.target, listOptions.signal)
      const { deliveries } = await call<{ deliveries?: RawDelivery[] }>(origin, 'org.tangled.webhook.listWebhookDeliveries', {
        query: {
          repo: did,
          webhooks: [ref.id],
          limit: listOptions.perPage ?? 50,
        },
        signal: listOptions.signal,
      })
      return {
        items: (deliveries ?? []).map(raw => ({
          ref: {
            forge: FORGE,
            instance,
            hook: ref,
            id: raw.id,
          },
          event: raw.event,
          status: raw.responseCode ?? 0,
          ok: raw.success,
          deliveredAt: toDate(raw.createdAt),
          raw,
        })),
      }
    }),
    redeliver: verb('unverified', async (ref, options = {}) => {
      const { origin, did } = await spindleOf(ref.hook.target, options.signal)
      await call(origin, 'org.tangled.webhook.retryWebhookDelivery', {
        json: { repo: did, webhook: ref.hook.id, delivery: ref.id },
        signal: options.signal,
      })
    }),
  }
}
