import { readdirSync, readFileSync } from 'node:fs'

const IGNORED = new Set(['node_modules', 'dist', 'coverage', '.output', '.nuxt'])

export interface ExampleFile {
  /** Path inside the example, such as `src/cli.ts`. */
  path: string
  content: string
}

export interface ExampleSource {
  name: string
  /** URL of the example's folder on GitHub. */
  url: string
  /** Files sorted with each directory's subdirectories before its files. */
  files: ExampleFile[]
  /** The file shown first: the largest file in `src/`. */
  entry: string
}

const root = new URL('../', import.meta.url)

/** The GitHub URL of the repository, from the root `package.json`. */
export function repositoryUrl(): string {
  const { repository } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { repository: { url: string } }
  return repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
}

function walk(directory: URL, prefix = ''): ExampleFile[] {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => !IGNORED.has(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return entries.flatMap(entry => entry.isDirectory()
    ? walk(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`)
    : [{ path: `${prefix}${entry.name}`, content: readFileSync(new URL(entry.name, directory), 'utf8') }])
}

/** The files of `examples/<name>`, as the docs show them. */
export function exampleSource(name: string): ExampleSource {
  const files = walk(new URL(`examples/${name}/`, root))
  const sources = files.filter(file => file.path.startsWith('src/'))
  const entry = sources.reduce((largest, file) => file.content.length > largest.content.length ? file : largest, sources[0] ?? files[0]!)
  return { name, url: `${repositoryUrl()}/tree/main/examples/${name}`, files, entry: entry.path }
}

/** Examples with a docs page, keyed by the page's path under `docs/content/`. */
export function documentedExamples(): Array<{ page: string, name: string }> {
  const examples = new Set(readdirSync(new URL('examples/', root)))
  return readdirSync(new URL('docs/content/6.examples/', root))
    .map(file => ({ page: `6.examples/${file}`, name: file.replace(/^\d+\./, '').replace(/\.md$/, '') }))
    .filter(({ name }) => examples.has(name))
}
