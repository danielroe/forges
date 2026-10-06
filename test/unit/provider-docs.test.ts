import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { matrix, matrixProviders, providerSection, withSection } from '../../scripts/capabilities.ts'
import * as forges from '../../src/index.ts'

describe('provider pages', () => {
  it.each(matrixProviders(forges))('keeps the $name capability section in step with the provider', ({ slug, provider }) => {
    const page = readFileSync(new URL(`../../docs/content/4.providers/${slug}.md`, import.meta.url), 'utf8')

    expect(page).toBe(withSection(page, providerSection(provider)))
  })

  it.each([
    ['README', '../../README.md'],
    ['capability matrix page', '../../docs/content/5.reference/2.capability-matrix.md'],
  ])('keeps the %s in step with the providers', (_name, path) => {
    const page = readFileSync(new URL(path, import.meta.url), 'utf8')

    expect(page).toBe(withSection(page, matrix(forges)))
  })
})
