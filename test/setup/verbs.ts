import type { ForgeProvider } from '../../src/provider.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { afterAll, vi } from 'vitest'

/**
 * Records every provider verb a test file calls successfully, per forge and
 * thread kind, into `test/.verbs/`. `scripts/check-capabilities.ts` reads the
 * files after the run and fails for any capability declared `true` that no
 * test reached.
 */
const exercised = new Map<string, Set<string>>()

function kindOf(args: unknown[]): string | undefined {
  const [first, second] = args as Array<Record<string, unknown> | undefined>
  const thread = first?.thread as Record<string, unknown> | undefined
  if (Array.isArray(first)) {
    return (first[0] as Record<string, unknown> | undefined)?.kind as string | undefined
  }
  return (thread?.kind ?? first?.kind ?? second?.kind) as string | undefined
}

function record(forge: string, verb: string, args: unknown[]): void {
  const set = exercised.get(forge) ?? new Set<string>()
  exercised.set(forge, set)
  set.add(verb)
  const kind = kindOf(args)
  if (kind) {
    set.add(`${verb}:${kind}`)
  }
}

function trackIterable<T extends AsyncIterable<unknown>>(iterable: T, done: () => void): T {
  const original = iterable[Symbol.asyncIterator].bind(iterable)
  return new Proxy(iterable, {
    get(target, property, receiver) {
      if (property !== Symbol.asyncIterator) {
        return Reflect.get(target, property, receiver)
      }
      return () => {
        const iterator = original()
        return new Proxy(iterator, {
          get(inner, name, innerReceiver) {
            if (name !== 'next') {
              const value = Reflect.get(inner, name, innerReceiver) as unknown
              return typeof value === 'function' ? value.bind(inner) : value
            }
            return async (...args: []) => {
              const result = await inner.next(...args)
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

function trackGroup(forge: string, group: string, value: object): object {
  return new Proxy(value, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown
      if (typeof member !== 'function' || typeof property !== 'string') {
        return member
      }
      const verb = `${group}.${property}`
      return (...args: unknown[]) => {
        const result = (member as (...args: unknown[]) => unknown).apply(target, args)
        if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
          return trackIterable(result as AsyncIterable<unknown>, () => record(forge, verb, args))
        }
        if (result instanceof Promise) {
          return result.then((value) => {
            record(forge, verb, args)
            return value
          })
        }
        record(forge, verb, args)
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
        ? trackGroup(target.forge, property, member)
        : member
    },
  })
}

vi.mock('../../src/define.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../src/define.ts')>()
  return {
    ...actual,
    defineForgeProvider: (definition: Parameters<typeof actual.defineForgeProvider>[0]) => {
      const factory = actual.defineForgeProvider(definition)
      return (options?: unknown) => {
        const built = factory(options as never)
        return { ...built, create: () => trackProvider(built.create()) }
      }
    },
  }
})

afterAll(() => {
  if (!exercised.size) {
    return
  }
  const directory = new URL('../.verbs/', import.meta.url)
  mkdirSync(directory, { recursive: true })
  const file = `${process.pid}-${Math.random().toString(36).slice(2)}.json`
  writeFileSync(new URL(file, directory), JSON.stringify(Object.fromEntries([...exercised].map(([forge, verbs]) => [forge, [...verbs].sort()]))))
})
