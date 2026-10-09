import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Where the forge data a test hands a provider came from: a recording of the
 * live forge, or a fixture hand-authored from the forge's documentation.
 * `test/setup/verbs.ts` counts a call towards the capability check only when
 * every response or delivery it used has a provenance.
 */
export type Provenance = 'recorded' | 'documented'

/** The sources a verb call used, while it runs; `'unknown'` is data from anywhere else. */
const sources = new AsyncLocalStorage<Set<Provenance | 'unknown'>>()

export function traceSources<T>(into: Set<Provenance | 'unknown'>, run: () => T): T {
  return sources.run(into, run)
}

export function noteSource(source: Provenance | undefined): void {
  sources.getStore()?.add(source ?? 'unknown')
}

const responses = new WeakMap<Response, Provenance>()
const payloads = new Map<string, Provenance>()
const streams = new WeakMap<object, Provenance>()

export function markResponse(response: Response, provenance: Provenance): void {
  responses.set(response, provenance)
}

export function responseProvenance(response: Response): Provenance | undefined {
  return responses.get(response)
}

/** Marks a webhook body, by its text, as one a forge sent or documents. */
export function markPayload(body: string, provenance: Provenance): string {
  payloads.set(body, provenance)
  return body
}

export function payloadProvenance(body: unknown): Provenance | undefined {
  return typeof body === 'string' ? payloads.get(body) : undefined
}

/** Marks the messages a fake socket replays, such as a recorded Jetstream session. */
export function markStream<T extends object>(messages: T, provenance: Provenance): T {
  streams.set(messages, provenance)
  return messages
}

export function streamProvenance(messages: object): Provenance | undefined {
  return streams.get(messages)
}
