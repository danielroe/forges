import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineNuxtModule } from 'nuxt/kit'
import { generateApiDocs } from '../../scripts/api-docs/generate.ts'
import { docsSections, withSection } from '../../scripts/docs-sections.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const contentDir = fileURLToPath(new URL('../content/', import.meta.url))

/**
 * Keeps the generated docs in step with the source: it writes the pages of the
 * reference, and refreshes the generated sections of the hand-written pages, such
 * as the capability matrix, before the content is read.
 */
export default defineNuxtModule({
  meta: { name: 'api-reference' },
  async setup(_options, nuxt) {
    if (nuxt.options._prepare) {
      return
    }
    generateApiDocs({ root, contentDir })
    await refreshSections()

    // The pages come from `src/`, so a change there restarts the dev server to regenerate them.
    nuxt.options.watch.push(fileURLToPath(new URL('../../src/', import.meta.url)))
  },
})

async function refreshSections(): Promise<void> {
  for (const section of await docsSections()) {
    const path = fileURLToPath(new URL(section.page, `file://${contentDir}`))
    const page = readFileSync(path, 'utf8')
    const updated = withSection(page, section)
    if (updated !== page) {
      writeFileSync(path, updated)
    }
  }
}
