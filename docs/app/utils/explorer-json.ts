type Schema = Record<string, any>

/** What a hover shows for one key of a result. */
export interface KeyInfo {
  /** The type that declares the key, such as `Thread`. */
  owner?: string
  name: string
  type: string
  optional: boolean
  description?: string
}

export interface AnnotatedJson {
  text: string
  /** Where each key sits in `text`, as offsets, with what is known about it. */
  keys: Array<{ start: number, end: number, info: KeyInfo }>
}

const REF = '#/components/schemas/'

/** The schema of `Page<item>`, built from the members of `Page<T>`: the published schemas have none, as it is generic. */
export function pageSchema(item: string, members: Array<{ name: string, type: string, optional: boolean, description: string }>): Schema {
  const schemaOf = (type: string): Schema => {
    const array = /^(\w+)\[\]$/.exec(type)
    if (array) {
      return { type: 'array', items: schemaOf(array[1] === 'T' ? item : array[1]!) }
    }
    return /^[A-Z]/.test(type) ? { $ref: `${REF}${type === 'T' ? item : type}` } : { type }
  }
  return {
    'x-forges-type': `Page<${item}>`,
    'type': 'object',
    'required': members.filter(member => !member.optional).map(member => member.name),
    'properties': Object.fromEntries(members.map(member => [member.name, { ...schemaOf(member.type), description: member.description || undefined }])),
  }
}

/**
 * Pretty-prints a result like `JSON.stringify(value, null, 2)`, and records the
 * schema of every key it can match. `hideRaw` replaces forge payloads with `…`.
 */
export function annotateJson(value: unknown, schema: Schema | undefined, schemas: Record<string, Schema>, hideRaw: boolean): AnnotatedJson {
  const keys: AnnotatedJson['keys'] = []
  let text = ''

  const deref = (entry: Schema | undefined): Schema | undefined => {
    let current = entry
    for (let depth = 0; current?.$ref && depth < 10; depth++) {
      current = schemas[String(current.$ref).slice(REF.length)]
    }
    return current
  }

  const variantsOf = (entry: Schema): Schema[] | undefined => entry.anyOf ?? entry.oneOf

  /** The object schema that `object` matches: a union picks the variant whose `const` properties agree. */
  const objectSchema = (object: Record<string, unknown>, entry: Schema | undefined): { owner?: string, schema: Schema } | undefined => {
    const resolved = deref(entry)
    if (!resolved) {
      return undefined
    }
    const owner = resolved['x-forges-type'] as string | undefined
    const variants = variantsOf(resolved)
    if (variants) {
      const match = variants.map(deref).find(variant => variant?.properties && Object.entries(variant.properties as Record<string, Schema>).every(([key, property]) => property.const === undefined || object[key] === property.const)
        && ((variant.required as string[] | undefined) ?? []).every(key => key in object))
      return match && { owner: (match['x-forges-type'] as string | undefined) ?? owner, schema: match }
    }
    return resolved.properties ? { owner, schema: resolved } : undefined
  }

  const itemsOf = (entry: Schema | undefined): Schema | undefined => {
    const resolved = deref(entry)
    return resolved?.items ?? variantsOf(resolved ?? {})?.map(deref).find(variant => variant?.items)?.items
  }

  const print = (entry: unknown, entrySchema: Schema | undefined, indent: string): void => {
    if (entry instanceof Date) {
      text += JSON.stringify(entry.toISOString())
    }
    else if (entry instanceof Uint8Array) {
      text += JSON.stringify(`Uint8Array(${entry.length})`)
    }
    else if (Array.isArray(entry)) {
      if (!entry.length) {
        text += '[]'
        return
      }
      const items = itemsOf(entrySchema)
      text += '['
      entry.forEach((item, index) => {
        text += `${index ? ',' : ''}\n${indent}  `
        print(item === undefined ? null : item, items, `${indent}  `)
      })
      text += `\n${indent}]`
    }
    else if (entry && typeof entry === 'object') {
      const fields = Object.entries(entry).filter(([, field]) => field !== undefined && typeof field !== 'function')
      if (!fields.length) {
        text += '{}'
        return
      }
      const matched = objectSchema(entry as Record<string, unknown>, entrySchema)
      const properties = (matched?.schema.properties ?? {}) as Record<string, Schema>
      const required = new Set((matched?.schema.required as string[] | undefined) ?? [])
      text += '{'
      fields.forEach(([key, field], index) => {
        text += `${index ? ',' : ''}\n${indent}  `
        const property = properties[key]
        const quoted = JSON.stringify(key)
        if (property) {
          keys.push({
            start: text.length,
            end: text.length + quoted.length,
            info: { owner: matched?.owner, name: key, type: typeText(property, schemas), optional: !required.has(key), description: property.description ?? deref(property)?.description },
          })
        }
        text += `${quoted}: `
        print(key === 'raw' && hideRaw ? '…' : field, property, `${indent}  `)
      })
      text += `\n${indent}}`
    }
    else {
      text += JSON.stringify(entry) ?? 'undefined'
    }
  }

  print(value, schema, '')
  return { text, keys }
}

/** A schema as a TypeScript type, such as `Label[]` or `'open' | 'closed'`. */
function typeText(schema: Schema, schemas: Record<string, Schema>): string {
  if (schema.$ref) {
    return String(schema.$ref).slice(REF.length)
  }
  if (schema['x-forges-type']) {
    return schema['x-forges-type']
  }
  if (schema.const !== undefined) {
    return literal(schema.const)
  }
  if (schema.enum) {
    return (schema.enum as unknown[]).map(literal).join(' | ')
  }
  const variants = schema.anyOf ?? schema.oneOf
  if (variants) {
    return (variants as Schema[]).map(variant => typeText(variant, schemas)).join(' | ')
  }
  if (schema.type === 'array') {
    const item = schema.items ? typeText(schema.items, schemas) : 'unknown'
    return item.includes(' | ') ? `(${item})[]` : `${item}[]`
  }
  if (schema.type === 'string' && schema.format === 'date-time') {
    return 'Date'
  }
  if (schema.type === 'integer') {
    return 'number'
  }
  if (schema.type === 'object') {
    return schema.properties ? `{ ${Object.keys(schema.properties).join(', ')} }` : 'Record<string, unknown>'
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(' | ')
  }
  return schema.type ?? 'unknown'
}

function literal(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value)
}
