import { describe, expect, it } from 'vitest'
import { generateSchemas, ROOT_TYPES, standaloneSchema } from '../../scripts/generate-schemas.ts'
import { schemas } from '../../src/schema/index.ts'

describe('model schemas', () => {
  it('cover every root type', () => {
    expect(ROOT_TYPES.filter(name => !(name in schemas))).toEqual([])
  })

  it('match the public types', () => {
    expect(generateSchemas()).toEqual(schemas)
  }, 30_000)

  it('leave no dangling references', () => {
    const refs = [...JSON.stringify(schemas).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map(([, name]) => name!)

    expect([...new Set(refs)].filter(name => !(name in schemas))).toEqual([])
  })

  it('emits standalone documents with only the definitions they reference', () => {
    for (const name of Object.keys(schemas)) {
      const document = standaloneSchema(name, schemas as Parameters<typeof standaloneSchema>[1])
      const refs = new Set([...JSON.stringify(document).matchAll(/"\$ref":"#\/definitions\/([^"]+)"/g)].map(([, ref]) => ref!))

      expect([...refs].sort()).toEqual(Object.keys(document.definitions as object).sort())
    }
  })
})
