import { addTemplate, addTypeTemplate, defineNuxtModule } from 'nuxt/kit'
import { forgeExamples } from '../shared/forge-examples.ts'
import { createExampleHighlighter } from '../shared/highlight.ts'

export default defineNuxtModule({
  meta: { name: 'landing-examples' },
  setup(_options, nuxt) {
    let highlighter: ReturnType<typeof createExampleHighlighter> | undefined

    for (const example of forgeExamples) {
      addTemplate({
        filename: `landing-examples/${example.slug}.js`,
        getContents: async () => {
          highlighter ??= createExampleHighlighter()
          const { highlight } = await highlighter
          return `export default ${JSON.stringify({ html: highlight(example.code) })}`
        },
      })
    }

    nuxt.options.alias['#landing-examples'] = addTemplate({
      filename: 'landing-examples/index.js',
      // The first example renders on load, so it ships with the page rather than in its own chunk.
      getContents: () => [
        `import initial from './${forgeExamples[0]!.slug}.js'`,
        `export { initial }`,
        `export default [`,
        ...forgeExamples.map((example, index) => `  { name: ${JSON.stringify(example.name)}, slug: ${JSON.stringify(example.slug)}, load: ${index ? `() => import('./${example.slug}.js').then(module => module.default)` : '() => Promise.resolve(initial)'} },`),
        `]`,
      ].join('\n'),
    }).dst

    addTypeTemplate({
      filename: 'landing-examples/index.d.ts',
      getContents: () => [
        `export interface HighlightedExample { html: string }`,
        `export interface ForgeExample { name: string, slug: string, load: () => Promise<HighlightedExample> }`,
        `export declare const initial: HighlightedExample`,
        `declare const examples: ForgeExample[]`,
        `export default examples`,
      ].join('\n'),
    })

    nuxt.hook('close', async () => (await highlighter)?.dispose())
  },
})
