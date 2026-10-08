import type { BundledLanguage } from 'shiki'
import { addTemplate, addTypeTemplate, defineNuxtModule } from 'nuxt/kit'
import { createHighlighter } from 'shiki'
import { documentedExamples, exampleSource, repositoryUrl } from '../../scripts/examples.ts'
import { codeThemes } from '../shared/code-theme.ts'

const LANGUAGES: Record<string, BundledLanguage> = { ts: 'ts', json: 'json', md: 'md' }

export default defineNuxtModule({
  meta: { name: 'examples' },
  setup(_options, nuxt) {
    const examples = documentedExamples()
    let highlighter: ReturnType<typeof createHighlighter> | undefined

    async function data(name: string) {
      highlighter ??= createHighlighter({ themes: Object.values(codeThemes), langs: Object.values(LANGUAGES) })
      const shiki = await highlighter
      const { url, files, entry } = exampleSource(name)
      return {
        name,
        url,
        entry,
        files: files.map(({ path, content }) => ({
          path,
          content,
          url: `${repositoryUrl()}/blob/main/examples/${name}/${path}`,
          // The docs' global `.shiki` styles add a background to every token, so the `<pre>` drops the class and theme variables.
          html: shiki.codeToHtml(content, { lang: LANGUAGES[path.split('.').pop()!] ?? 'text', themes: codeThemes, defaultColor: false }).replace(/^<pre[^>]*>/, '<pre>'),
        })),
      }
    }

    for (const { name } of examples) {
      addTemplate({
        filename: `examples/${name}.js`,
        getContents: async () => `export default ${JSON.stringify(await data(name))}`,
      })
    }

    nuxt.options.alias['#examples'] = addTemplate({
      filename: 'examples/index.js',
      getContents: () => `export default {\n${examples.map(({ name }) => `  ${JSON.stringify(name)}: () => import('./${name}.js').then(module => module.default),`).join('\n')}\n}`,
    }).dst

    addTypeTemplate({
      filename: 'examples/index.d.ts',
      getContents: () => [
        `export interface ExampleFile { path: string, content: string, url: string, html: string }`,
        `export interface Example { name: string, url: string, entry: string, files: ExampleFile[] }`,
        `declare const examples: Record<string, () => Promise<Example>>`,
        `export default examples`,
      ].join('\n'),
    })
  },
})
