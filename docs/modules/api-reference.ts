import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { addTemplate, addTypeTemplate, defineNuxtModule } from 'nuxt/kit'
import { generateApiDocs } from '../../scripts/api-docs/generate.ts'
import { docsSections, withSection } from '../../scripts/docs-sections.ts'
import { explorerHovers, explorerPageMembers } from '../shared/explorer-hovers.ts'

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
    addTypeTemplate({
      filename: 'explorer-hovers.d.ts',
      getContents: () => [
        `declare const hovers: Record<string, { signature: string, description?: string }>`,
        `export default hovers`,
        `export declare const page: Array<{ name: string, type: string, optional: boolean, description: string }>`,
      ].join('\n'),
    })

    // Preparing only writes types. Writing the hovers there too would replace a running dev server's with empty ones.
    if (nuxt.options._prepare) {
      return
    }
    const { model } = generateApiDocs({ root, contentDir })
    const hovers = explorerHovers(model)
    const page = explorerPageMembers(model)
    // The explorer imports this as `#build/explorer-hovers.js` on first use, so its hovers stay out of the page bundle.
    addTemplate({
      filename: 'explorer-hovers.js',
      // Written to disk, so that `#build/` resolves it in the browser as well as on the server.
      write: true,
      getContents: () => `export default ${JSON.stringify(hovers)}\nexport const page = ${JSON.stringify(page)}`,
    })
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
