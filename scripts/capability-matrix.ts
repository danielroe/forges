import { readFileSync, writeFileSync } from 'node:fs'
import { docsSections, withSection } from './docs-sections.ts'

for (const section of await docsSections()) {
  const page = new URL(`../docs/content/${section.page}`, import.meta.url)
  writeFileSync(page, withSection(readFileSync(page, 'utf8'), section))
}
