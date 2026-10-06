import { readFileSync } from 'node:fs'
import { addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from 'nuxt/kit'
import { capabilityData } from '../../scripts/capabilities.ts'
import * as forges from '../../src/index.ts'

function frontmatter(page: string, key: string): string | undefined {
  const value = page.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1]?.trim()
  return value?.startsWith('"') ? JSON.parse(value) : value
}

export default defineNuxtModule({
  meta: { name: 'capabilities' },
  setup(_options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const { providers, groups } = capabilityData(forges)

    const pages = providers.map(({ slug }) => readFileSync(resolve(`../content/4.providers/${slug}.md`), 'utf8'))
    const data = {
      providers: providers.map((provider, index) => ({
        ...provider,
        title: frontmatter(pages[index]!, 'title') ?? provider.name,
        description: frontmatter(pages[index]!, 'description') ?? '',
        icon: frontmatter(pages[index]!, 'icon') ?? 'i-lucide-server',
        to: `/providers/${provider.slug}`,
      })),
      groups,
    }

    nuxt.options.alias['#capabilities'] = addTemplate({
      filename: 'capabilities.js',
      getContents: () => Object.entries(data).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)}`).join('\n'),
    }).dst

    addTypeTemplate({
      filename: 'capabilities.d.ts',
      getContents: () => [
        `import type { CapabilityGroup, CapabilityProvider } from '${resolve('../../scripts/capabilities.ts')}'`,
        `export type { CapabilityGroup, CapabilityProvider, CapabilityRow, SupportCell, SupportLevel } from '${resolve('../../scripts/capabilities.ts')}'`,
        `export interface DocsProvider extends CapabilityProvider {`,
        `  title: string`,
        `  description: string`,
        `  icon: string`,
        `  to: string`,
        `}`,
        `export declare const providers: DocsProvider[]`,
        `export declare const groups: CapabilityGroup[]`,
      ].join('\n'),
    })
  },
})
