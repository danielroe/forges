import { addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from 'nuxt/kit'
import { matrixProviders } from '../../scripts/capabilities.ts'
import * as forges from '../../src/index.ts'

export default defineNuxtModule({
  meta: { name: 'capabilities' },
  setup(_options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const providers = matrixProviders(forges).map(({ name, provider }) => ({ name, capabilities: provider.capabilities }))

    nuxt.options.alias['#capabilities'] = addTemplate({
      filename: 'capabilities.mjs',
      getContents: () => `export default ${JSON.stringify(providers)}`,
    }).dst

    addTypeTemplate({
      filename: 'types/capabilities.d.ts',
      getContents: () => [
        `declare module '#capabilities' {`,
        `  const providers: Array<{ name: string, capabilities: import('${resolve('../../src/provider.ts')}').ForgeCapabilities }>`,
        `  export default providers`,
        `}`,
      ].join('\n'),
    })
  },
})
