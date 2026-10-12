import type { Fixture } from '../src/testing/index.ts'

/** A recording to stabilise: its manifest and the fixtures of each step, by step name. */
export interface Run {
  manifest: Record<string, unknown>
  steps: Map<string, Fixture[]>
}

export interface Stabilised extends Run {
  /** Identifiers of the current run, mapped to those of the previous run they stand for. */
  renamed: Map<string, string>
  /** Identifiers that could not be renamed, with the reason. */
  skipped: Map<string, string>
}

/** An ISO 8601 timestamp, or an RFC 2822 one as an email or patch header carries. */
const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d? (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d\d:\d\d:\d\d [+-]\d{4}/
const TOKEN = new RegExp(`${TIME.source}|%[\\dA-F]{2}|[\\w-]+`, 'gi')
/** Seconds or milliseconds since the epoch, between 2020 and 2033. */
const EPOCH = /^1[6-9]\d{8}(?:\d{3})?$/
/** Keys whose value names something, so that a short number there is an identifier rather than a count. */
const ID_KEY = /^(?:id|number|iid|index|node_id|nodeId|sha|uuid|cid|rkey|uri|ref|reference)$|_i?id$|Id$/

/**
 * Calls `visit` with each token of a string that can be an identifier: one
 * with a digit that is not a timestamp. A run of digits alone needs six or
 * more, unless its key names something, it follows `/`, `#` or `!`, or it is
 * the value of a query parameter such as `issue_iid`.
 */
function identifiers(text: string, key: string, visit: (token: string, index: number) => void): void {
  const named = ID_KEY.test(key)
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0]
    if (!/\d/.test(token) || token.startsWith('%') || TIME.test(token) || EPOCH.test(token)) {
      continue
    }
    const digits = /^\d+$/.test(token)
    const before = text.slice(0, match.index)
    const placed = /(?:[/#!]|%2F)$/i.test(before) || /(?:^|_)(?:id|iid|number|ref|sha)(?:=|%3D)$/i.test(before)
    if (digits ? named || token.length >= 6 || placed : token.length >= 6) {
      visit(token, match.index)
    }
  }
}

/** Whether a number names something: under a key that names something, or large enough not to be a count. */
function numberIsIdentifier(value: number, key: string): boolean {
  return Number.isInteger(value) && !EPOCH.test(String(value)) && (ID_KEY.test(key) || value >= 100_000)
}

/** Whether a number that `stabilise()` paired elsewhere is renamed here, which includes ids sent bare, as in a list of label ids. */
function numberIsRenamed(value: number, key: string): boolean {
  return numberIsIdentifier(value, key) || (Number.isInteger(value) && !EPOCH.test(String(value)) && value >= 1000)
}

type Visit = (current: unknown, previous: unknown, key: string) => void

function walk(current: unknown, previous: unknown, key: string, visit: Visit): void {
  if (current && previous && typeof current === 'object' && typeof previous === 'object') {
    if (Array.isArray(current) !== Array.isArray(previous)) {
      return
    }
    for (const [name, value] of Object.entries(current)) {
      if (Object.hasOwn(previous, name)) {
        walk(value, (previous as Record<string, unknown>)[name], Array.isArray(current) ? key : name, visit)
      }
    }
    return
  }
  visit(current, previous, key)
}

/** The text between tokens, which must match for two strings to be read as the same with different identifiers. */
function skeleton(text: string): string {
  return text.replace(TOKEN, '\u0000')
}

/** Whether two identifiers are of one kind: both numbers, both hexadecimal of one length, such as short SHAs, or both neither. */
function alike(a: string, b: string): boolean {
  const hex = /^[\da-f]+$/
  return (hex.test(a) && hex.test(b) && a.length === b.length) || /^\d+$/.test(a) === /^\d+$/.test(b)
}

/** Pairs the identifiers that differ between two values found at the same place. */
function learn(pairs: Map<string, Set<string>>, current: unknown, previous: unknown, key: string): void {
  if (current === previous) {
    return
  }
  const add = (from: string, to: string) => pairs.set(from, (pairs.get(from) ?? new Set()).add(to))
  if (typeof current === 'number' && typeof previous === 'number') {
    if (numberIsIdentifier(current, key) && numberIsIdentifier(previous, key)) {
      add(String(current), String(previous))
    }
    return
  }
  if (typeof current !== 'string' || typeof previous !== 'string' || skeleton(current) !== skeleton(previous)) {
    return
  }
  const at = (text: string) => {
    const indices = new Set<number>()
    identifiers(text, key, (_token, index) => indices.add(index))
    return indices
  }
  const ours = at(current)
  const theirs = at(previous)
  const others = [...previous.matchAll(TOKEN)]
  for (const [position, match] of [...current.matchAll(TOKEN)].entries()) {
    const other = others[position]!
    if (match[0] !== other[0] && ours.has(match.index) && theirs.has(other.index) && alike(match[0], other[0])) {
      add(match[0], other[0])
    }
  }
}

/** `value` with the identifiers in `map` renamed, by the same rules `stabilise()` renames a recording with. */
export function rename(value: unknown, key: string, map: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map(item => rename(item, key, map))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rename(item, name, map)]))
  }
  if (typeof value === 'number') {
    const renamed = numberIsRenamed(value, key) ? map.get(String(value)) : undefined
    return renamed === undefined ? value : Number(renamed)
  }
  if (typeof value !== 'string') {
    return value
  }
  const replacements: Array<[index: number, from: string, to: string]> = []
  identifiers(value, key, (token, index) => {
    const to = map.get(token) ?? (token.includes('-') ? token.replace(/\d{6,}/g, digits => map.get(digits) ?? digits) : token)
    if (to !== token) {
      replacements.push([index, token, to])
    }
  })
  let result = value
  for (const [index, from, to] of replacements.reverse()) {
    result = `${result.slice(0, index)}${to}${result.slice(index + from.length)}`
  }
  return result
}

function collect(value: unknown, key: string, into: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach(item => collect(item, key, into))
  }
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([name, item]) => collect(item, name, into))
  }
  else if (typeof value === 'number' && numberIsRenamed(value, key)) {
    into.add(String(value))
  }
  else if (typeof value === 'string') {
    identifiers(value, key, token => into.add(token))
  }
}

/** The fixtures with every timestamp masked. */
export function withoutTimestamps(fixtures: Fixture[]): Fixture[] {
  return JSON.parse(JSON.stringify(fixtures).replace(new RegExp(TIME.source, 'g'), '<time>')) as Fixture[]
}

/**
 * Renames the identifiers a run of write steps created to the ones the
 * previous run created in their place, so that a step whose responses are
 * otherwise the same differs only in timestamps. Identifiers are paired where
 * the two runs hold different values at the same place in the same request
 * or response, and renamed only where the pairing is one to one and the
 * previous value does not stand for something else in the current run.
 * Timestamps are left as they are.
 */
export function stabilise(current: Run, previous: Run): Stabilised {
  const pairs = new Map<string, Set<string>>()
  walk(current.manifest, previous.manifest, '', (a, b, key) => learn(pairs, a, b, key))
  for (const [name, fixtures] of current.steps) {
    const before = previous.steps.get(name)
    if (!before || before.length !== fixtures.length) {
      continue
    }
    fixtures.forEach((fixture, index) => {
      const other = before[index]!
      if (fixture.request.method === other.request.method) {
        walk(fixture, other, '', (a, b, key) => learn(pairs, a, b, key))
      }
    })
  }
  const skipped = new Map<string, string>()
  const sources = new Map<string, string[]>()
  for (const [from, to] of pairs) {
    if (to.size > 1) {
      skipped.set(from, `pairs with ${to.size} identifiers of the previous run`)
      continue
    }
    const target = [...to][0]!
    sources.set(target, [...sources.get(target) ?? [], from])
  }
  const map = new Map<string, string>()
  for (const [target, from] of sources) {
    if (from.length > 1) {
      from.forEach(source => skipped.set(source, `shares ${target} with ${from.length - 1} other identifiers`))
      continue
    }
    map.set(from[0]!, target)
  }
  const present = new Set<string>()
  collect(current.manifest, '', present)
  for (const fixtures of current.steps.values()) {
    collect(fixtures, '', present)
  }
  for (const [from, to] of map) {
    if (present.has(to) && !map.has(to)) {
      map.delete(from)
      skipped.set(from, `${to} stands for something else in this run`)
    }
  }
  return {
    manifest: rename(current.manifest, '', map) as Record<string, unknown>,
    steps: new Map([...current.steps].map(([name, fixtures]) => [name, rename(fixtures, '', map) as Fixture[]])),
    renamed: map,
    skipped,
  }
}
