import { readdirSync } from 'node:fs'
import * as forges from '../src/index.ts'

/** Generated content for the text between `<!-- <marker>:start -->` and `<!-- <marker>:end -->` of a docs page. */
export interface DocsSection {
  /** Path of the page under `docs/content/`. */
  page: string
  marker: string
  content: string
}

/** Produces sections from the forges entry point. Each file in `scripts/sections/` default-exports one. */
export type DocsSectionSource = (source: typeof forges) => DocsSection[]

/** Every generated docs section, from the files in `scripts/sections/`. */
export async function docsSections(): Promise<DocsSection[]> {
  const directory = new URL('./sections/', import.meta.url)
  const files = readdirSync(directory).filter(file => file.endsWith('.ts')).sort()
  const sources = await Promise.all(files.map(async file => (await import(new URL(file, directory).href) as { default: DocsSectionSource }).default))
  return sources.flatMap(source => source(forges))
}

/** Replaces the text between a marker pair of a Markdown page. */
export function withSection(page: string, { marker, content }: Pick<DocsSection, 'marker' | 'content'>): string {
  const start = `<!-- ${marker}:start -->`
  const end = `<!-- ${marker}:end -->`
  const from = page.indexOf(start)
  const to = page.indexOf(end)
  if (from < 0 || to < from) {
    throw new Error(`Page has no ${marker} markers`)
  }
  return `${page.slice(0, from + start.length)}\n${content}\n${page.slice(to)}`
}
