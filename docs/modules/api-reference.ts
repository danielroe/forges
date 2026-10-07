import { fileURLToPath } from 'node:url'
import { defineNuxtModule } from 'nuxt/kit'
import { generateApiDocs } from '../../scripts/api-docs/generate.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const outDir = fileURLToPath(new URL('../content/5.reference/', import.meta.url))

/** Generates the API reference pages from the source before the content is read. */
export default defineNuxtModule({
  meta: { name: 'api-reference' },
  setup(_options, nuxt) {
    if (nuxt.options._prepare) {
      return
    }
    generateApiDocs({ root, outDir })

    // The pages come from `src/`, so a change there restarts the dev server to regenerate them.
    nuxt.options.watch.push(fileURLToPath(new URL('../../src/', import.meta.url)))
  },
})
