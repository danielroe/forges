import { fromBase64 } from './contents.ts'
import { toBase64 } from './crypto.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function singleKey(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value)
  return keys.length === 1
    ? keys[0]
    : undefined
}

/** `Date`s as `{ "$date": ISO }`, bytes as `{ "$bytes": base64 }`. */
export function encode(value: unknown): unknown {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('Cannot encode an invalid Date')
    }
    return {
      $date: value.toISOString(),
    }
  }
  if (value instanceof Uint8Array) {
    return {
      $bytes: toBase64(value),
    }
  }
  if (Array.isArray(value)) {
    return value.map(encode)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    encode(item),
  ]))
}

/** Restores the `Date` and `Uint8Array` values in encoded JSON. */
export function decode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decode)
  }
  if (!isRecord(value)) {
    return value
  }
  const key = singleKey(value)
  if (key === '$date') {
    const date = value[key]
    if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) {
      throw new TypeError('Invalid $date')
    }
    return new Date(date)
  }
  if (key === '$bytes') {
    const bytes = value[key]
    if (typeof bytes !== 'string') {
      throw new TypeError('Invalid $bytes')
    }
    try {
      return fromBase64(bytes)
    }
    catch {
      throw new TypeError('Invalid $bytes')
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    decode(item),
  ]))
}
