import type { WebSocketLike } from '../../src/tangled/subscribe.ts'
import { noteSource, streamProvenance } from './provenance.ts'

type Listener = (event: { data?: unknown, code?: number, reason?: string }) => void

/** Delivers `messages` in order after open, then drops the connection with 1006. */
export class FakeWebSocket implements WebSocketLike {
  readonly url: string
  closed = false
  private listeners: Record<string, Listener[]> = {}

  constructor(url: string, messages: readonly unknown[]) {
    this.url = url
    noteSource(streamProvenance(messages))
    setTimeout(() => {
      this.emit('open', {})
      for (const message of messages) {
        if (this.closed) {
          return
        }
        this.emit('message', { data: JSON.stringify(message) })
      }
      this.finish(1006, 'connection lost')
    })
  }

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener)
  }

  close(code = 1000): void {
    this.finish(code, '')
  }

  private finish(code: number, reason: string): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.emit('close', { code, reason })
  }

  private emit(type: string, event: Parameters<Listener>[0]): void {
    for (const listener of this.listeners[type] ?? []) {
      listener(event)
    }
  }
}
