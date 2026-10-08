import type { CapabilityInfo, GeneratedFile } from './pages.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CAPABILITY_TABLE } from '../../src/capability-table.ts'
import { ENTRIES, GENERATED_DIRECTORIES, HIDDEN_MEMBERS, OVERVIEW_INTRO, OVERVIEW_OUTRO, OVERVIEW_PAGES, PAGES, REFERENCE_DIRECTORY } from './config.ts'
import { extractApi } from './extract.ts'
import { buildFiles, undocumented, withoutHiddenMembers } from './pages.ts'

export interface GenerateOptions {
  /** Repository root. */
  root: string
  /** The content directory of the docs. The directories of the generated pages may hold other pages, which are left alone. */
  contentDir: string
  /** URL the pages are served under. */
  basePath?: string
}

export interface GenerateResult {
  files: GeneratedFile[]
  /** Symbols and members without a description. */
  undocumented: string[]
  /** Exports that no page selects. */
  unplaced: string[]
}

/** The banner that every generated page carries right after its front matter. A page with it was written by this generator. */
const BANNER_RE = /^---\n(?:(?!---\n)[\s\S])*?---\n\n<!-- Do not edit by hand: `[^`]+` writes this page/

/** Builds the API reference from the source and writes it to `outDir`. */
export function generateApiDocs({ root, contentDir, basePath = '/reference' }: GenerateOptions): GenerateResult {
  const model = extractApi({ root, entries: ENTRIES })
  const { files, unplaced } = buildFiles(model, {
    basePath,
    directory: REFERENCE_DIRECTORY,
    main: 'forges',
    pages: PAGES,
    overviewIcon: 'i-lucide-book-open',
    overviewIntro: OVERVIEW_INTRO,
    overviewOutro: OVERVIEW_OUTRO,
    overviewPages: OVERVIEW_PAGES,
    hiddenMembers: HIDDEN_MEMBERS,
    capability: capabilityOf,
    command: 'pnpm docs:api',
  })
  writeFiles(contentDir, files)
  return { files, undocumented: undocumented(withoutHiddenMembers(model, HIDDEN_MEMBERS)), unplaced }
}

/** Replaces the pages of the previous run, and refuses to overwrite a file that it did not write. */
export function writeFiles(contentDir: string, files: GeneratedFile[]): void {
  const directories = new Set([...GENERATED_DIRECTORIES, ...files.map(file => dirname(file.path))])
  const previous = new Set<string>()
  for (const directory of directories) {
    mkdirSync(join(contentDir, directory), { recursive: true })
    for (const name of readdirSync(join(contentDir, directory))) {
      if (name.endsWith('.md') && BANNER_RE.test(readFileSync(join(contentDir, directory, name), 'utf8'))) {
        previous.add(join(contentDir, directory, name))
      }
    }
  }

  // Check every target before removing anything, so that a refusal leaves the earlier pages in place.
  for (const file of files) {
    const path = join(contentDir, file.path)
    if (existsSync(path) && !previous.has(path)) {
      throw new Error(`${path} exists and was not generated; rename it or the generated page`)
    }
  }
  for (const path of previous) {
    rmSync(path)
  }
  for (const file of files) {
    writeFileSync(join(contentDir, file.path), file.content)
  }
}

const VERBS = new Map<string, CapabilityInfo>(
  CAPABILITY_TABLE.flatMap(entry => (entry.verbs ?? []).map(verb => [verb, {
    capability: entry.capability,
    perKind: entry.perKind,
    write: entry.write,
    account: entry.account,
  }] as const)),
)

/** The capability behind a verb. A page method such as `repos.labelsPage` shares the entry of `repos.labels`. */
function capabilityOf(verb: string): CapabilityInfo | undefined {
  return VERBS.get(verb) ?? VERBS.get(verb.replace(/Page$/, ''))
}
