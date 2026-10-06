import { addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from 'nuxt/kit'
import { eventData } from '../../scripts/events.ts'
import * as forges from '../../src/index.ts'

export default defineNuxtModule({
  meta: { name: 'events' },
  setup(_options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const data = eventData(forges)

    nuxt.options.alias['#events'] = addTemplate({
      filename: 'events.js',
      getContents: () => Object.entries(data).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)}`).join('\n'),
    }).dst

    addTypeTemplate({
      filename: 'events.d.ts',
      getContents: () => [
        `import type { EventKindRow, EventProvider } from '${resolve('../../scripts/events.ts')}'`,
        `export type { EventCell, EventDetailField, EventDetailShape, EventKindRow, EventProvider } from '${resolve('../../scripts/events.ts')}'`,
        `export declare const providers: EventProvider[]`,
        `export declare const kinds: EventKindRow[]`,
        `export declare const withoutWebhooks: string[]`,
      ].join('\n'),
    })
  },
})
