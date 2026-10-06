import { addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from 'nuxt/kit'
import { errorData } from '../../scripts/errors.ts'
import * as forges from '../../src/index.ts'

export default defineNuxtModule({
  meta: { name: 'error-reference' },
  setup(_options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const errors = errorData(forges)

    nuxt.options.alias['#error-reference'] = addTemplate({
      filename: 'error-reference.js',
      getContents: () => `export const errors = ${JSON.stringify(errors)}`,
    }).dst

    addTypeTemplate({
      filename: 'error-reference.d.ts',
      getContents: () => [
        `import type { ErrorClass } from '${resolve('../../scripts/errors.ts')}'`,
        `export type { ErrorClass, ErrorField, ErrorText } from '${resolve('../../scripts/errors.ts')}'`,
        `export declare const errors: ErrorClass[]`,
      ].join('\n'),
    })
  },
})
