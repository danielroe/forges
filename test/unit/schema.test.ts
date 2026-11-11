import { describe, expect, it } from 'vitest'
import { generateSchemaBundle, ROOT_TYPES, standaloneSchema } from '../../scripts/generate-schemas.ts'
import { CAPABILITY_TABLE } from '../../src/capability-table.ts'
import { models, verbs } from '../../src/schema/index.ts'

describe('models', () => {
  it('cover every root type', () => {
    expect(ROOT_TYPES.filter(name => !(name in models))).toEqual([])
  })

  it('match the public models and verb signatures', () => {
    const bundle = generateSchemaBundle()
    expect(bundle.models).toEqual(models)
    expect(bundle.verbs).toEqual(verbs)
  }, 60_000)

  it('describe every capability verb', () => {
    const expected = [
      ...new Set(CAPABILITY_TABLE.flatMap(entry => entry.verbs ?? [])),
    ].sort()
    expect(Object.keys(verbs).sort()).toEqual(expected)
  })

  it('leave no dangling references', () => {
    const refs = [
      ...JSON.stringify({ models, verbs }).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g),
    ].map(([, name]) => name!)

    expect([
      ...new Set(refs),
    ].filter(name => !(name in models))).toEqual([])
  })

  it('emits standalone documents with only the definitions they reference', () => {
    for (const name of Object.keys(models)) {
      const document = standaloneSchema(name, models as Parameters<typeof standaloneSchema>[1])
      const refs = new Set([
        ...JSON.stringify(document).matchAll(/"\$ref":"#\/definitions\/([^"]+)"/g),
      ].map(([, ref]) => ref!))

      expect([...refs].sort()).toEqual(Object.keys(document.definitions as object).sort())
    }
  })
})

describe('verb signatures', () => {
  it('carries the JSDoc summary and parameter descriptions', () => {
    expect(verbs['repos.get']?.summary).toContain('Reads a repository')
    expect(verbs['repos.byOwner']?.params[0]?.description).toContain('A namespace ref')
  })

  it('mark the options parameter, and keep `signal` off the wire', () => {
    for (const [name, verb] of Object.entries(verbs)) {
      expect(verb.params.filter(param => param.options).length, name).toBeLessThanOrEqual(1)
      const options = verb.params.findIndex(param => param.options)
      if (options !== -1) {
        expect(options, name).toBe(verb.params.length - 1)
      }
    }
    expect(JSON.stringify({ models, verbs })).not.toContain('"signal":')
  })

  it('classify writes, account verbs and listings', () => {
    expect(verbs['repos.get']).toMatchObject({ write: false, account: false })
    expect(verbs['repos.list']).toMatchObject({ write: false, account: true, listing: true })
    expect(verbs['threads.close']).toMatchObject({ write: true })
    expect(verbs['threads.close']?.listing).toBeFalsy()
    expect(verbs['notifications.unsubscribe']).toMatchObject({ write: true, account: true })
    expect(verbs['notifications.unsubscribe']?.listing).toBeFalsy()
  })

  it('maps lib types to the wire: bytes tagged, streams marked', () => {
    expect(Object.keys(verbs).filter(name => verbs[name]!.stream).sort()).toEqual(['ci.log', 'releases.downloadAsset'])
    expect(JSON.stringify(models.FileContent)).toContain('"$bytes"')
    expect(JSON.stringify(models)).not.toContain('BYTES_PER_ELEMENT')
    expect(JSON.stringify(models)).not.toContain('x-forges-type":"Uint8Array"')
  })
})
