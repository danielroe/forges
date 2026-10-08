import type { RenderContext } from './render.ts'
import type { ApiMember, ApiModel, ApiSymbol } from './types.ts'
import { code, prose, slug } from './markdown.ts'
import { renderMember, renderSymbol } from './render.ts'

/** What the capability table knows about a verb. */
export interface CapabilityInfo {
  /** Where the support lands on `ForgeCapabilities`. */
  capability: string
  perKind?: boolean
  write?: boolean
  account?: boolean
}

/** Which symbols or members a part of a page documents. A symbol belongs to the first part that selects it. */
export interface SectionConfig {
  /** Heading of the part. Without one, its symbols are headings of their own. */
  title?: string
  /** Markdown below the heading. */
  intro?: string
  /** Entry point to select from, `forges` by default. */
  entry?: string
  /** Symbols by name, or by a pattern on the name. */
  names?: Array<string | RegExp>
  /** Symbols by the file that declares them. */
  source?: RegExp
  /** Provider namespaces, by property name, each documented with its methods. */
  namespaces?: string[]
  /** The members of one interface, documented as sections of their own. */
  members?: { of: string, kind?: 'property' | 'method', withoutNamespaces?: boolean }
  /** A table that lists the namespaces and the pages that document them. */
  namespaceTable?: boolean
}

export interface PageConfig {
  /** File name and URL segment. Nuxt Content serves it in lower case. */
  slug: string
  /** Where the page lives when it is not part of the reference: its directory under the content directory, its URL base and its file name. */
  location?: { directory: string, basePath: string, file: string }
  /** What the sidebar shows. */
  title: string
  description: string
  /** The Lucide icon of the sidebar entry, as the hand-written pages have. */
  icon?: string
  /** What to find on the page and how to use it, as the overview describes it. Defaults to the description. */
  overview?: string
  intro?: string
  sections: SectionConfig[]
}

export interface PagesOptions {
  /** URL the pages are served under, such as `/reference`. */
  basePath: string
  /** Directory of the pages under the content directory, such as `5.reference`. */
  directory: string
  /** The entry point that owns shared symbols and the provider, such as `forges`. */
  main: string
  pages: PageConfig[]
  /** The icon of the overview in the sidebar. */
  overviewIcon?: string
  /** What the overview says before the pages. */
  overviewIntro?: string
  /** What the overview says after the pages. */
  overviewOutro?: string
  /** Pages that people write, which the overview describes after the generated ones. */
  overviewPages?: Array<{ title: string, url: string, overview: string }>
  /** Members to leave out of the pages, because a page describes them once for all. */
  hiddenMembers?: (symbol: ApiSymbol, member: ApiMember) => boolean
  capability: (verb: string) => CapabilityInfo | undefined
  /** The command that regenerates the pages, for the banner. */
  command: string
}

export interface GeneratedFile {
  /** Path from the content directory. */
  path: string
  content: string
}

export interface BuildResult {
  files: GeneratedFile[]
  /** Exports that no page selects, so that they landed on the last page. */
  unplaced: string[]
}

type Item
  = | { type: 'symbol', symbol: ApiSymbol }
    | { type: 'member', member: ApiMember, verb?: string, qualifier?: string, twin?: ApiMember }
    | { type: 'namespace', member: ApiMember, symbol: ApiSymbol, items: Item[] }
    | { type: 'namespaces' }

interface Section {
  title?: string
  intro?: string
  items: Item[]
}

interface Page {
  config: PageConfig
  sections: Section[]
  /** Symbols that the page's entry point exports and another page documents. */
  reexports: ApiSymbol[]
  /** Symbols that the page documents as a whole, so that a link goes to the page. */
  represents: ApiSymbol[]
}

interface Heading {
  text: string
  target?: ApiSymbol | ApiMember
}

const NAMESPACE_RE = /Api$/
const OTHER: PageConfig = {
  slug: 'other',
  title: 'Other exports',
  description: 'Exports that no page of the reference has a place for yet.',
  sections: [],
}

/** The pages of the reference, the overview that lists them, and the names of exports without a page. */
export function buildFiles(source: ApiModel, options: PagesOptions): BuildResult {
  const model = withoutHiddenMembers(source, options.hiddenMembers)
  const { pages, unplaced } = resolvePages(model, options)
  const url = (page: Page) => pageUrl(page, options)

  // The first pass renders every heading, to learn the anchor that each symbol gets.
  const links = new Map<string, string>()
  for (const page of pages) {
    const { headings } = renderPage(page, pages, () => undefined, options)
    const anchors = anchorsOf(headings)
    for (const [index, heading] of headings.entries()) {
      const target = heading.target
      if (target && isSymbol(target) && !links.has(target.name)) {
        links.set(target.name, `${url(page)}#${anchors[index]}`)
      }
    }
  }
  for (const page of pages) {
    for (const symbol of page.represents) {
      if (!links.has(symbol.name))
        links.set(symbol.name, url(page))
    }
  }

  const banner = `<!-- Do not edit by hand: \`${options.command}\` writes this page from the JSDoc comments in \`src/\`. -->`
  const files = pages.map((page, index): GeneratedFile => ({
    path: pagePath(page, index, options),
    content: [frontmatter(page.config.title, page.config.description, undefined, page.config.icon), banner, renderPage(page, pages, name => links.get(name), options).markdown].join('\n\n').concat('\n'),
  }))
  files.unshift(overview(pages, options, banner))
  return { files, unplaced }
}

/** The model without the members that `hidden` matches, such as `raw`, which a page describes once for all. */
export function withoutHiddenMembers(model: ApiModel, hidden?: PagesOptions['hiddenMembers']): ApiModel {
  if (!hidden)
    return model
  const cache = new Map<ApiSymbol, ApiSymbol>()
  const strip = (symbol: ApiSymbol): ApiSymbol => {
    let copy = cache.get(symbol)
    if (!copy) {
      copy = { ...symbol, members: symbol.members.filter(member => !hidden(symbol, member)) }
      cache.set(symbol, copy)
    }
    return copy
  }
  return { entries: model.entries.map(entry => ({ ...entry, symbols: entry.symbols.map(strip) })) }
}

/**
 * Names of the symbols and methods that the model leaves without a description,
 * as `Symbol` or `Symbol.method`. A property whose name says it all may go without.
 */
export function undocumented(model: ApiModel): string[] {
  const names = new Set<string>()
  for (const symbol of model.entries.flatMap(entry => entry.symbols)) {
    if (!symbol.description)
      names.add(symbol.name)
    for (const member of symbol.members) {
      if (!member.description && member.kind === 'method' && !member.inheritedFrom)
        names.add(`${symbol.name}.${member.name}`)
    }
  }
  return [...names]
}

function resolvePages(model: ApiModel, options: PagesOptions): { pages: Page[], unplaced: string[] } {
  const entries = new Map(model.entries.map(entry => [entry.specifier, entry.symbols]))
  const main = entries.get(options.main)
  if (!main) {
    throw new Error(`The model has no entry point ${options.main}`)
  }
  const owners = new Map<ApiSymbol, Page>()
  const provider = main.find(symbol => symbol.name === 'ForgeProvider')

  const pages = options.pages.map((config): Page => {
    const page: Page = { config, sections: [], reexports: [], represents: [] }
    for (const section of config.sections) {
      const pool = entries.get(section.entry ?? options.main) ?? []
      page.sections.push({ title: section.title, intro: section.intro, items: selectItems(section, pool, page, owners, provider) })
    }
    return page
  })

  const all = [...new Set(model.entries.flatMap(entry => entry.symbols))]
  const leftovers = all.filter(symbol => !owners.has(symbol))
  if (leftovers.length) {
    const other: Page = { config: OTHER, sections: [{ items: leftovers.map(symbol => ({ type: 'symbol', symbol })) }], reexports: [], represents: [] }
    pages.push(other)
  }
  return { pages, unplaced: leftovers.map(symbol => symbol.name) }
}

function selectItems(section: SectionConfig, pool: ApiSymbol[], page: Page, owners: Map<ApiSymbol, Page>, provider?: ApiSymbol): Item[] {
  const claim = (symbol: ApiSymbol) => {
    if (owners.has(symbol))
      return false
    owners.set(symbol, page)
    return true
  }

  if (section.namespaceTable) {
    return [{ type: 'namespaces' }]
  }

  if (section.namespaces) {
    return section.namespaces.map((name): Item => {
      const member = provider?.members.find(candidate => candidate.name === name)
      const symbol = member?.reference ? pool.find(candidate => candidate.name === member.reference) : undefined
      if (!member || !symbol) {
        throw new Error(`provider.${name} is not a namespace of ForgeProvider`)
      }
      claim(symbol)
      page.represents.push(symbol)
      const qualifier = section.namespaces!.length > 1 ? `${name}.` : ''
      return { type: 'namespace', member, symbol, items: pairPages(symbol.members.filter(entry => entry.kind !== 'group')).map(({ member: entry, twin }): Item => ({ type: 'member', member: entry, twin, verb: `${name}.${entry.name}`, qualifier })) }
    })
  }

  if (section.members) {
    const { of, kind, withoutNamespaces } = section.members
    const symbol = pool.find(candidate => candidate.name === of)
    if (!symbol) {
      throw new Error(`There is no export named ${of}`)
    }
    claim(symbol)
    page.represents.push(symbol)
    const namespaces = new Set(pool.filter(candidate => candidate.kind === 'interface' && NAMESPACE_RE.test(candidate.name)).map(candidate => candidate.name))
    return symbol.members
      .filter(member => member.kind !== 'group' && (!kind || member.kind === kind) && !(withoutNamespaces && member.reference && namespaces.has(member.reference)))
      .map((member): Item => ({ type: 'member', member }))
  }

  const selected: ApiSymbol[] = []
  const select = (symbols: ApiSymbol[]) => {
    for (const symbol of symbols) {
      if (claim(symbol)) {
        selected.push(symbol)
      }
      else if (owners.get(symbol) !== page && !page.reexports.includes(symbol)) {
        page.reexports.push(symbol)
      }
    }
  }
  for (const selector of section.names ?? []) {
    const matches = pool.filter(symbol => typeof selector === 'string' ? symbol.name === selector : selector.test(symbol.name))
    if (!matches.length && typeof selector === 'string') {
      throw new Error(`${page.config.slug}: "${section.title ?? 'untitled section'}" selects ${selector}, which ${section.entry ?? 'the main entry point'} does not export`)
    }
    select(matches)
  }
  if (section.source) {
    select(pool.filter(symbol => section.source!.test(symbol.source)))
  }
  return selected.map((symbol): Item => ({ type: 'symbol', symbol }))
}

/** Each method that has a `...Page` twin, with the twin, and the methods without one. The twins get no section of their own. */
function pairPages(members: ApiMember[]): Array<{ member: ApiMember, twin?: ApiMember }> {
  const names = new Set(members.map(member => member.name))
  return members.flatMap((member) => {
    if (member.kind === 'method' && member.name.endsWith('Page') && names.has(member.name.slice(0, -4))) {
      return []
    }
    const twin = member.kind === 'method' ? members.find(candidate => candidate.name === `${member.name}Page`) : undefined
    return [{ member, twin }]
  })
}

function renderPage(page: Page, pages: Page[], resolve: (name: string) => string | undefined, options: PagesOptions): { markdown: string, headings: Heading[] } {
  const headings: Heading[] = []
  const context: RenderContext = {
    resolve,
    capability: verb => describeCapability(options.capability(verb)),
    heading: (level, text, target) => {
      headings.push({ text, target })
      return `${'#'.repeat(level)} ${text}`
    },
  }

  const blocks: string[] = []
  if (page.config.intro) {
    blocks.push(prose(page.config.intro, resolve))
  }
  for (const section of page.sections) {
    if (!section.items.length && !section.intro)
      continue
    if (section.title) {
      blocks.push(context.heading(2, section.title))
    }
    if (section.intro) {
      blocks.push(prose(section.intro, resolve))
    }
    const level = section.title ? 3 : 2
    for (const item of section.items) {
      blocks.push(renderItem(item, level, context, pages, options))
    }
  }

  if (page.reexports.length) {
    const names = page.reexports.map(symbol => resolve(symbol.name) ? `[${code(symbol.name)}](${resolve(symbol.name)})` : code(symbol.name))
    blocks.push(`These exports are documented elsewhere: ${names.join(', ')}.`)
  }
  return { markdown: blocks.join('\n\n'), headings }
}

function renderItem(item: Item, level: number, context: RenderContext, pages: Page[], options: PagesOptions): string {
  if (item.type === 'symbol') {
    return renderSymbol(item.symbol, level, context)
  }
  if (item.type === 'member') {
    return renderMember(item.member, level, context, { verb: item.verb, qualifier: item.qualifier, twin: item.twin })
  }
  if (item.type === 'namespace') {
    const blocks = [context.heading(level, code(`provider.${item.member.name}`), item.symbol)]
    const description = item.member.description || item.symbol.description
    if (description) {
      blocks.push(prose(description, context.resolve))
    }
    blocks.push(...item.items.map(entry => renderItem(entry, level + 1, context, pages, options)))
    return blocks.join('\n\n')
  }
  return namespaceTable(pages, options)
}

/** The table that lists the namespaces, which needs the pages that document them. */
function namespaceTable(pages: Page[], options: PagesOptions): string {
  const rows = pages.flatMap(page => page.sections.flatMap(section => section.items.flatMap(item => item.type === 'namespace' ? [{ item, page }] : []))).map(({ item, page }) =>
    `| [${code(`provider.${item.member.name}`)}](${pageUrl(page, options)}#${slug(`provider.${item.member.name}`)}) | ${page.config.title} |`)
  return ['| Namespace | Documented under |', '| --- | --- |', ...rows].join('\n')
}

function anchorsOf(headings: Heading[]): string[] {
  const used = new Map<string, number>()
  return headings.map(({ text }) => {
    const base = slug(text)
    const count = used.get(base)
    used.set(base, (count ?? 0) + 1)
    return count === undefined ? base : `${base}-${count}`
  })
}

function isSymbol(target: ApiSymbol | ApiMember): target is ApiSymbol {
  return 'entries' in target
}

function describeCapability(info: CapabilityInfo | undefined): string | undefined {
  if (!info)
    return undefined
  const notes = [
    info.perKind ? 'Support differs by thread kind.' : '',
    info.write ? 'Read-only and anonymous providers reject it.' : '',
    !info.write && info.account ? 'Anonymous providers reject it.' : '',
  ].filter(Boolean)
  return [`**Capability:** ${code(info.capability)}.`, ...notes].join(' ')
}

function pageUrl(page: Page, options: PagesOptions): string {
  return `${page.config.location?.basePath ?? options.basePath}/${page.config.slug}`
}

/** Pages of the reference are numbered after the overview, which is the first. */
function pagePath(page: Page, index: number, options: PagesOptions): string {
  const { directory, file } = page.config.location ?? { directory: options.directory, file: `${String(index + 2).padStart(2, '0')}.${page.config.slug}.md` }
  return `${directory}/${file}`
}

function frontmatter(title: string, description: string, navigationTitle?: string, icon?: string): string {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    ...navigationTitle ? ['navigation:', `  title: ${JSON.stringify(navigationTitle)}`] : [],
    `description: ${JSON.stringify(description)}`,
    ...icon ? [`icon: ${icon}`] : [],
    '---',
  ].join('\n')
}

function overview(pages: Page[], options: PagesOptions, banner: string): GeneratedFile {
  const entries = [
    ...pages.filter(page => !page.config.location).map(page => ({ title: page.config.title, url: pageUrl(page, options), overview: page.config.overview ?? page.config.description })),
    ...options.overviewPages ?? [],
  ]
  const body = [
    frontmatter('Reference', 'The exports of forges, with their signatures, types and descriptions.', 'Overview', options.overviewIcon),
    banner,
    ...options.overviewIntro ? [options.overviewIntro] : [],
    ...entries.flatMap(entry => [`## ${entry.title}`, `${entry.overview} See [${entry.title}](${entry.url}).`]),
    ...options.overviewOutro ? [options.overviewOutro] : [],
  ]
  return { path: `${options.directory}/01.overview.md`, content: `${body.join('\n\n')}\n` }
}
