import type { ForgeEventInput } from '../model.ts'
import type { SubscribeOptions } from '../provider.ts'
import type { JetstreamCommitEvent, JetstreamEvent } from './types.ts'
import { SubscriptionClosedError } from '../errors.ts'

/** The subset of the WHATWG `WebSocket` the subscription uses. */
export interface WebSocketLike {
  addEventListener: (type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown, code?: number, reason?: string }) => void) => void
  close: (code?: number, reason?: string) => void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export interface JetstreamSubscriptionOptions extends SubscribeOptions {
  url: string
  collections: readonly string[]
  createWebSocket: WebSocketFactory
  toEvent: (event: JetstreamCommitEvent) => Promise<ForgeEventInput | undefined>
  context: { forge: string, instance: string }
}

export function jetstreamUrl(base: string, collections: readonly string[], cursor?: string): string {
  const url = new URL(base)
  for (const collection of collections) {
    url.searchParams.append('wantedCollections', collection)
  }
  if (cursor) {
    url.searchParams.set('cursor', cursor)
  }
  return url.toString()
}

interface SubscriptionItem {
  event: ForgeEventInput
  cursor: string
}

type Settled = { done: false, value: SubscriptionItem } | { done: true } | { error: unknown }

/**
 * Streams Jetstream commit events as normalised events. Messages are
 * translated strictly in arrival order, so a yielded cursor never skips an
 * earlier event.
 */
export function subscribeJetstream(options: JetstreamSubscriptionOptions): AsyncIterable<SubscriptionItem> {
  return {
    [Symbol.asyncIterator]() {
      const queue: Settled[] = []
      const waiters: Array<(settled: Settled) => void> = []
      let lastCursor = options.cursor
      let finished = false
      let chain = Promise.resolve()

      function settle(settled: Settled): void {
        if (finished) {
          return
        }
        if ('error' in settled || settled.done) {
          finished = true
        }
        const waiter = waiters.shift()
        if (waiter) {
          waiter(settled)
        }
        else {
          queue.push(settled)
        }
      }

      const socket = options.createWebSocket(jetstreamUrl(options.url, options.collections, options.cursor))

      function stop(): void {
        if (!finished) {
          settle({ done: true })
        }
        socket.close(1000)
      }

      if (options.signal?.aborted) {
        stop()
      }
      options.signal?.addEventListener('abort', stop, { once: true })

      socket.addEventListener('message', ({ data }) => {
        chain = chain.then(async () => {
          if (finished) {
            return
          }
          const message = JSON.parse(String(data)) as JetstreamEvent
          const cursor = String(message.time_us)
          if (message.kind !== 'commit') {
            lastCursor = cursor
            return
          }
          const event = await options.toEvent(message)
          lastCursor = cursor
          if (event) {
            settle({ done: false, value: { event, cursor } })
          }
        }).catch((error: unknown) => {
          settle({ error: new SubscriptionClosedError('Failed to translate a subscription message', lastCursor, options.context, { cause: error }) })
          socket.close(1011)
        })
      })
      socket.addEventListener('error', (event) => {
        chain = chain.then(() => settle({ error: new SubscriptionClosedError('Subscription connection failed', lastCursor, options.context, { cause: event }) }))
      })
      socket.addEventListener('close', ({ code, reason }) => {
        chain = chain.then(() => settle({
          error: new SubscriptionClosedError(`Subscription closed (${code ?? 'no code'}${reason ? `: ${reason}` : ''})`, lastCursor, options.context),
        }))
      })

      return {
        next(): Promise<IteratorResult<SubscriptionItem>> {
          const settled = queue.shift()
          const resolve = (value: Settled): IteratorResult<SubscriptionItem> => {
            if ('error' in value) {
              throw value.error
            }
            return value.done ? { done: true, value: undefined } : value
          }
          if (settled) {
            return Promise.resolve().then(() => resolve(settled))
          }
          if (finished) {
            return Promise.resolve({ done: true, value: undefined })
          }
          return new Promise<Settled>(waiter => waiters.push(waiter)).then(resolve)
        },
        return(): Promise<IteratorResult<SubscriptionItem>> {
          options.signal?.removeEventListener('abort', stop)
          stop()
          queue.length = 0
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}
