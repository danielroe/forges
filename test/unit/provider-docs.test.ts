import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { matrix, matrixProviders, providerSection, withSection } from '../../scripts/capabilities.ts'
import * as forges from '../../src/index.ts'

describe('provider pages', () => {
  it.each(matrixProviders(forges))('keeps the $name capability section in step with the provider', ({ slug, provider }) => {
    const page = readFileSync(new URL(`../../docs/content/4.providers/${slug}.md`, import.meta.url), 'utf8')

    expect(page).toBe(withSection(page, providerSection(provider)))
  })

  it('keeps the capability matrix page in step with the providers', () => {
    const page = readFileSync(new URL('../../docs/content/5.reference/2.capability-matrix.md', import.meta.url), 'utf8')

    expect(page).toBe(withSection(page, matrix(forges)))
  })
})
