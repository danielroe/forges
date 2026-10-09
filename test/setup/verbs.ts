import type { FetchLike } from '../../src/fetch.ts'
import type { ForgeProvider } from '../../src/provider.ts'
import type { Provenance } from '../utils/provenance.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { afterAll, vi } from 'vitest'
import { noteSource, payloadProvenance, responseProvenance, traceSources } from '../utils/provenance.ts'
import { verbsDirectory } from './verbs-directory.ts'

/**
 * Records every provider verb a test file calls successfully, per forge and
 * thread kind, into `test/.verbs/` (or `FORGES_VERBS_DIR`). Calls on anonymous
 * providers are recorded under `<forge>:anonymous` as well.
 *
 * A call is also recorded with the provenance of the forge data it used:
 * `#recorded` when every response came from a recording of the live forge,
 * `#documented` when some came from a fixture hand-authored from the forge's
 * documentation, and `#offline` when it made no request at all. A call that
 * used any other response, such as an inline override, gets no provenance.
 * `scripts/check-capabilities.ts` reads the files after the run.
 */
const exercised = new Map<string, Set<string>>()

type Sources = Set<Provenance | 'unknown'>

/** Webhook verbs read a delivery instead of a response, so the delivery's provenance counts. */
const PAYLOAD_VERBS = new Set(['webhooks.verify', 'webhooks.ingest'])

function kindOf(args: unknown[]): string | undefined {
  const [first, second] = args as Array<Record<string, unknown> | undefined>
  const thread = first?.thread as Record<string, unknown> | undefined
  if (Array.isArray(first)) {
    return (first[0] as Record<string, unknown> | undefined)?.kind as string | undefined
  }
  return (thread?.kind ?? first?.kind ?? second?.kind) as string | undefined
}

function provenanceOf(verb: string, sources: Sources): string | undefined {
  if (sources.has('unknown')) {
    return undefined
  }
  if (!sources.size) {
    return PAYLOAD_VERBS.has(verb) ? undefined : 'offline'
  }
  return sources.has('documented') ? 'documented' : 'recorded'
}

function record(provider: ForgeProvider, verb: string, args: unknown[], sources: Sources): void {
  const kind = kindOf(args)
  const provenance = provenanceOf(verb, sources)
  for (const key of provider.authKind === 'anonymous' ? [provider.forge, `${provider.forge}:anonymous`] : [provider.forge]) {
    const set = exercised.get(key) ?? new Set<string>()
    exercised.set(key, set)
    for (const name of kind ? [verb, `${verb}:${kind}`] : [verb]) {
      set.add(name)
      if (provenance) {
        set.add(`${name}#${provenance}`)
      }
    }
  }
}

function trackIterable<T extends AsyncIterable<unknown>>(iterable: T, sources: Sources, done: () => void): T {
  const original = iterable[Symbol.asyncIterator].bind(iterable)
  return new Proxy(iterable, {
    get(target, property, receiver) {
      if (property !== Symbol.asyncIterator) {
        return Reflect.get(target, property, receiver)
      }
      return () => {
        const iterator = traceSources(sources, original)
        return new Proxy(iterator, {
          get(inner, name, innerReceiver) {
            if (name !== 'next') {
              const value = Reflect.get(inner, name, innerReceiver) as unknown
              return typeof value === 'function' ? value.bind(inner) : value
            }
            return async (...args: []) => {
              const result = await traceSources(sources, () => inner.next(...args))
              if (!result.done) {
                done()
              }
              return result
            }
          },
        })
      }
    },
  })
}

function trackGroup(provider: ForgeProvider, group: string, value: object): object {
  return new Proxy(value, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown
      if (typeof member !== 'function' || typeof property !== 'string') {
        return member
      }
      const verb = `${group}.${property}`
      return (...args: unknown[]) => {
        const sources: Sources = new Set()
        if (PAYLOAD_VERBS.has(verb)) {
          sources.add(payloadProvenance((args[0] as { body?: unknown } | undefined)?.body) ?? 'unknown')
        }
        const result = traceSources(sources, () => (member as (...args: unknown[]) => unknown).apply(target, args))
        if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
          return trackIterable(result as AsyncIterable<unknown>, sources, () => record(provider, verb, args, sources))
        }
        if (result instanceof Promise) {
          return result.then((value) => {
            record(provider, verb, args, sources)
            return value
          })
        }
        record(provider, verb, args, sources)
        return result
      }
    },
  })
}

export function trackProvider(provider: ForgeProvider): ForgeProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown
      return member && typeof member === 'object' && typeof property === 'string' && property !== 'capabilities'
        ? trackGroup(target, property, member)
        : member
    },
  })
}

/** Notes the provenance of every response the provider receives, for the verb call in progress. */
function traced(fetch: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init)
    noteSource(responseProvenance(response))
    return response
  }
}

vi.mock('../../src/define.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../src/define.ts')>()
  return {
    ...actual,
    defineForgeProvider: (definition: Parameters<typeof actual.defineForgeProvider>[0]) => {
      const factory = actual.defineForgeProvider(definition)
      return (options?: { fetch?: FetchLike }) => {
        const built = factory((options?.fetch ? { ...options, fetch: traced(options.fetch) } : options) as never)
        return { ...built, create: () => trackProvider(built.create()) }
      }
    },
  }
})

afterAll(() => {
  if (!exercised.size) {
    return
  }
  mkdirSync(verbsDirectory, { recursive: true })
  const file = `${process.pid}-${Math.random().toString(36).slice(2)}.json`
  writeFileSync(new URL(file, verbsDirectory), JSON.stringify(Object.fromEntries([...exercised].map(([forge, verbs]) => [forge, [...verbs].sort()]))))
})
