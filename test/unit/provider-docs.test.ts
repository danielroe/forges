import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { capabilityData } from '../../scripts/capabilities.ts'
import { docsSections, withSection } from '../../scripts/docs-sections.ts'
import * as forges from '../../src/index.ts'

const sections = await docsSections()

describe('generated docs', () => {
  it.each(sections)('keeps the $marker section of $page in step with the source', (section) => {
    const page = readFileSync(new URL(`../../docs/content/${section.page}`, import.meta.url), 'utf8')

    expect(page).toBe(withSection(page, section))
  })

  it('gives the structured matrix one cell per provider in every row', () => {
    const { providers, groups } = capabilityData(forges)
    const rows = groups.flatMap(group => group.rows)

    expect(new Set(groups.map(group => group.name)).size).toBe(groups.length)
    expect(rows.every(row => row.cells.length === providers.length)).toBe(true)
    expect(providers.every(({ summary }) => Object.values(summary).reduce((total, count) => total + count) === rows.length)).toBe(true)
  })
})
