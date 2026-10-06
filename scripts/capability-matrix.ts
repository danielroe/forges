import { readFileSync, writeFileSync } from 'node:fs'
import * as forges from '../src/index.ts'

import { matrix, matrixProviders, providerSection, withSection } from './capabilities.ts'

for (const { slug, provider } of matrixProviders(forges)) {
  const page = new URL(`../docs/content/4.providers/${slug}.md`, import.meta.url)
  writeFileSync(page, withSection(readFileSync(page, 'utf8'), providerSection(provider)))
}
const page = new URL('../docs/content/5.reference/2.capability-matrix.md', import.meta.url)
writeFileSync(page, withSection(readFileSync(page, 'utf8'), matrix(forges)))
console.info(matrix(forges))
