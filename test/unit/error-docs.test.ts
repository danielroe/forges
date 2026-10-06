import { describe, expect, it } from 'vitest'
import { errorData } from '../../scripts/errors.ts'
import * as forges from '../../src/index.ts'

const errors = errorData(forges)

describe('error reference', () => {
  it('lists every exported error class once', () => {
    const exported = Object.entries(forges)
      .filter(([, value]) => typeof value === 'function' && (value === forges.ForgeError || value.prototype instanceof forges.ForgeError))
      .map(([name]) => name)

    expect(errors.map(entry => entry.name).sort()).toEqual(exported.sort())
  })

  it('matches the runtime inheritance', () => {
    for (const entry of errors) {
      const parent = Object.getPrototypeOf((forges as Record<string, unknown>)[entry.name]) as { name: string }

      expect(entry.extends).toBe(parent.name)
    }
  })

  it('describes every class', () => {
    expect(errors.filter(entry => !entry.description.length).map(entry => entry.name)).toEqual([])
  })
})
