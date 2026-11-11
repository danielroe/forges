export interface Schema {
  [key: string]: Json
}

export type Json = null | boolean | number | string | Json[] | Schema

const COMPONENT_REF = '#/components/schemas/'

export const BYTES_SCHEMA: Schema = {
  type: 'object',
  properties: {
    $bytes: { type: 'string', contentEncoding: 'base64' },
  },
  required: ['$bytes'],
  additionalProperties: false,
  description: 'Bytes, as `{ "$bytes": "<base64>" }`.',
}

export const STREAM_SCHEMA: Schema = {
  type: 'string',
  format: 'binary',
  description: 'The bytes, as `application/octet-stream`.',
}

export function isRecord(value: Json | undefined): value is Schema {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Every OpenAPI component a schema references. */
export function* refs(value: Json): Generator<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* refs(item)
    }
  }
  else if (isRecord(value)) {
    if (typeof value.$ref === 'string' && value.$ref.startsWith(COMPONENT_REF)) {
      yield value.$ref.slice(COMPONENT_REF.length)
    }
    for (const item of Object.values(value)) {
      yield* refs(item)
    }
  }
}

/** `ts-json-schema-generator` pads `{@link X}` with spaces and keeps the indentation of wrapped doc lines. */
export function tidyDescriptions(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(tidyDescriptions)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'description' && typeof item === 'string'
      ? item.replace(/\{@link\s+([^\s}]+)\s*\}/g, '{@link $1}').replace(/ {2,}/g, ' ').replace(/(\{@link [^}]+\}) ([.,:;])/g, '$1$2')
      : tidyDescriptions(item),
  ]))
}

/** OpenAPI component names allow only `[A-Za-z0-9._-]`: `Page<Repo>` becomes `PageOfRepo`. */
export function componentName(name: string): string {
  return name.replace(/<(.+)>$/, 'Of$1').replace(/[^\w.-]/g, '_')
}

/** Rewrites generated refs to OpenAPI components and drops `never` properties. */
export function clean(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(clean)
  }
  if (!isRecord(value)) {
    return value
  }
  const result: Schema = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === '$ref' && typeof item === 'string') {
      result[key] = `${COMPONENT_REF}${componentName(decodeURIComponent(item.replace(/^#\/definitions\//, '')))}`
    }
    else if (key === 'properties' && isRecord(item)) {
      result[key] = Object.fromEntries(Object.entries(item)
        .filter(([, property]) => !isNever(property))
        .map(([name, property]) => [
          name,
          clean(property),
        ]))
    }
    else {
      result[key] = clean(item)
    }
  }
  return result
}

/** The `never` the generator emits for `AbortSignal` and other hidden types. */
function isNever(value: Json): boolean {
  return isRecord(value) && isRecord(value.not) && Object.keys(value.not).length === 0
}

export function sortByKey<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]!]))
}
