import type { PagesOptions } from '../../scripts/api-docs/pages.ts'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { ENTRIES } from '../../scripts/api-docs/config.ts'
import { extractApi } from '../../scripts/api-docs/extract.ts'
import { generateApiDocs, writeFiles } from '../../scripts/api-docs/generate.ts'
import { slug, typeToMarkdown } from '../../scripts/api-docs/markdown.ts'
import { buildFiles } from '../../scripts/api-docs/pages.ts'
import { fake } from '../../src/fake/index.ts'
import * as forges from '../../src/index.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const directories: string[] = []

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'api-docs-'))
  directories.push(directory)
  return directory
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const BANNER = '<!-- Do not edit by hand: `pnpm docs:api` writes this page from the JSDoc comments in `src/`. -->'

/** A page as the generator writes it: front matter, then the banner. */
function generatedPage(text: string): string {
  return `---\ntitle: "Page"\n---\n\n${BANNER}\n\n${text}\n`
}

const OPTIONS: PagesOptions = {
  basePath: '/api',
  directory: 'reference',
  main: 'pkg',
  pages: [
    { slug: 'functions', title: 'Functions', description: 'Functions.', sections: [{ names: [/^(?:greet|shout|ANSWER|pick|Counter)$/] }] },
    { slug: 'types', title: 'Types', description: 'Types.', sections: [{ title: 'Options', names: ['GreetOptions', 'Base', 'Mood', 'Settings', 'Client'] }, { title: 'Errors', source: /entry/ }] },
    { slug: 'things', title: 'Things', description: 'Things.', sections: [{ namespaces: ['things'] }, { title: 'Unsupported', intro: 'Intro only.' }] },
  ],
  hiddenMembers: (symbol, member) => symbol.name === 'Settings' && /^raw$|Raw$/.test(member.name),
  capability: () => undefined,
  command: 'pnpm docs:api',
}

const SAMPLE = `
export interface Base {
  /** The identifier. */
  id: string
}

/** Options for {@link greet}, with a <tag>. */
export interface GreetOptions extends Base {
  /** Shout it. */
  loud?: boolean
  nested: {
    /** Deep value. */
    value: number
  }
}

/** How to say it. */
export type Mood = 'happy' | 'sad'

/** The answer. */
export const ANSWER = 42

/** Failure. */
export class SampleError extends Error {
  /** The code. */
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

/**
 * Says hello.
 *
 * @param name - Who to greet.
 * @param options Extra settings.
 * @returns The greeting.
 * @throws SampleError when the name is empty.
 * @example
 * greet('Ada')
 */
export function greet(name: string, options: GreetOptions = { id: 'x', nested: { value: 1 } }, ...rest: string[]): string {
  return name + options.id + rest.length
}

/** A shorter way. */
export const shout = (name: string): string => name.toUpperCase()

/** Picks. */
export function pick(a: string): string
export function pick(a: number): number
export function pick(a: string | number): string | number {
  return a
}

/** Counts. */
export class Counter {
  #n = 0

  /** The count so far. */
  get count(): number {
    return this.#n
  }
}

export interface Settings {
  /**
   * Where to log.
   * @default 'stdout'
   */
  target?: string
  raw: unknown
  stateRaw?: string
}

/** Talks to a server. */
export interface Client {
  /** Sends the request without parsing the response. */
  raw: () => Promise<void>
}

/** Reads things. */
export interface ThingsApi {
  /** Lists things. */
  list: (query?: string) => AsyncIterable<string>
  listPage: (query?: string) => Promise<string[]>
  /** Removes a thing. */
  remove: (id: string) => Promise<void>
}

/** The provider. */
export interface ForgeProvider {
  readonly things: ThingsApi
}
`

function sample() {
  const directory = temporary()
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2022', module: 'nodenext', strict: true, allowImportingTsExtensions: true, types: [] } }))
  writeFileSync(join(directory, 'entry.ts'), SAMPLE)
  return extractApi({ root: directory, entries: { pkg: 'entry.ts' }, tsconfig: 'tsconfig.json' })
}

describe('extractApi', () => {
  const symbols = new Map(sample().entries[0]!.symbols.map(symbol => [symbol.name, symbol]))

  it('reads functions with their parameters, defaults, tags and examples', () => {
    const greet = symbols.get('greet')!
    const [signature] = greet.signatures

    expect(greet.kind).toBe('function')
    expect(greet.description).toBe('Says hello.')
    expect(greet.examples).toEqual(['greet(\'Ada\')'])
    expect(signature!.params.map(param => [param.name, param.type, param.optional, param.rest])).toEqual([
      ['name', 'string', false, false],
      ['options', 'GreetOptions', true, false],
      ['rest', 'string[]', false, true],
    ])
    expect(signature!.params[0]!.description).toBe('Who to greet.')
    expect(signature!.params[1]!.default).toBe('{ id: \'x\', nested: { value: 1 } }')
    expect(signature!.returns).toEqual({ type: 'string', description: 'The greeting.' })
    expect(signature!.throws).toEqual(['SampleError when the name is empty.'])
  })

  it('treats arrow function constants as functions', () => {
    expect(symbols.get('shout')!.kind).toBe('function')
    expect(symbols.get('shout')!.signatures[0]!.returns.type).toBe('string')
  })

  it('reads constants, unions and classes', () => {
    expect(symbols.get('ANSWER')).toMatchObject({ kind: 'variable', type: '42' })
    expect(symbols.get('Mood')).toMatchObject({ kind: 'type', variants: ['\'happy\'', '\'sad\''] })
    const error = symbols.get('SampleError')!
    expect(error).toMatchObject({ kind: 'class', extends: ['Error'] })
    expect(error.constructors[0]!.params.map(param => param.name)).toEqual(['message', 'code'])
    expect(error.members.map(member => member.name)).toEqual(['code'])
  })

  it('flattens nested object types and marks inherited members', () => {
    const members = symbols.get('GreetOptions')!.members

    expect(members.map(member => [member.name, member.kind, member.inheritedFrom])).toEqual([
      ['loud', 'property', undefined],
      ['nested', 'group', undefined],
      ['nested.value', 'property', undefined],
      ['id', 'property', 'Base'],
    ])
  })

  it('reads a getter as a read-only property', () => {
    expect(symbols.get('Counter')!.members.map(member => [member.name, member.kind, member.readonly, member.description])).toEqual([['count', 'property', true, 'The count so far.']])
  })

  it('reads the default from the tag', () => {
    expect(symbols.get('Settings')!.members.find(member => member.name === 'target')).toMatchObject({ default: '\'stdout\'', description: 'Where to log.' })
  })

  it('reads every overload', () => {
    expect(symbols.get('pick')!.signatures.map(signature => signature.returns.type)).toEqual(['string', 'number'])
  })
})

describe('typeToMarkdown', () => {
  const resolve = (name: string) => ({ Thread: '/t', ThreadRef: '/r', CommentRef: '/c', verb: '/v' })[name as 'Thread']

  it('links a type that is, or wraps, one documented type', () => {
    expect(typeToMarkdown('Thread', resolve)).toBe('[`Thread`](/t)')
    expect(typeToMarkdown('Promise<Page<Thread>>', resolve)).toBe('[`Promise<Page<Thread>>`](/t)')
    expect(typeToMarkdown('ThreadRef | undefined', resolve)).toBe('[`ThreadRef | undefined`](/r)')
  })

  it('keeps a type plain when it has none or several documented types', () => {
    expect(typeToMarkdown('Promise<void>', resolve)).toBe('`Promise<void>`')
    expect(typeToMarkdown('ThreadRef | CommentRef', resolve)).toBe('`ThreadRef | CommentRef`')
  })

  it('ignores names inside strings, and names that start with a lowercase letter', () => {
    expect(typeToMarkdown('\'Thread\' | \'other\'', resolve)).toBe('`\'Thread\' | \'other\'`')
    expect(typeToMarkdown('(verb: string) => void', resolve)).toBe('`(verb: string) => void`')
  })
})

describe('buildFiles', () => {
  const { files, unplaced } = buildFiles(sample(), OPTIONS)
  const pages = new Map(files.map(file => [file.path, file.content]))
  const functions = pages.get('reference/02.functions.md')!
  const types = pages.get('reference/03.types.md')!
  const things = pages.get('reference/04.things.md')!

  it('numbers the pages after an overview that lists them', () => {
    expect([...pages.keys()]).toEqual(['reference/01.overview.md', 'reference/02.functions.md', 'reference/03.types.md', 'reference/04.things.md'])
    expect(pages.get('reference/01.overview.md')).toContain('## Types\n\nTypes. See [Types](/api/types).')
    expect(pages.get('reference/01.overview.md')).not.toContain('| Page |')
    expect(pages.get('reference/01.overview.md')).toMatch(/^---\ntitle: "Reference"\nnavigation:\n {2}title: "Overview"\n/)
    expect(unplaced).toEqual([])
  })

  it('writes front matter and a banner on every page', () => {
    expect(functions).toMatch(/^---\ntitle: "Functions"\n/)
    expect(functions).toContain('<!-- Do not edit by hand:')
  })

  it('renders a signature with its parameters as a table', () => {
    expect(functions).toContain('function greet(name: string, options: GreetOptions = { id: \'x\', nested: { value: 1 } }, ...rest: string[]): string')
    expect(functions).toContain('| `name` | `string` | Who to greet. |')
    expect(functions).toContain('| `options?` | [`GreetOptions`](/api/types#greetoptions) | Extra settings. Defaults to `{ id: \'x\', nested: { value: 1 } }`. |')
    expect(functions).toContain('| `...rest` | `string[]` |  |')
    expect(functions).toContain('**Returns:** `string` The greeting.')
  })

  it('writes a table for one parameter, and none for no parameters', () => {
    const shout = functions.slice(functions.indexOf('## `shout()`'))

    expect(shout).toContain('| Parameter | Type |\n| --- | --- |\n| `name` | `string` |')
  })

  it('numbers overloads', () => {
    expect(functions).toContain('**Overload 1 of 2**')
    expect(functions).toContain('**Overload 2 of 2**')
  })

  it('uses a table for any number of members', () => {
    expect(types).toContain('| `loud?` | `boolean` | Shout it. |')
    expect(types.slice(types.indexOf('### `Base`'))).toContain('| `id` | `string` | The identifier. |')
  })

  it('adds a default column when a member has a default', () => {
    expect(types).toContain('| Member | Type | Default | Description |')
    expect(types).toContain('| `target?` | `string` | `\'stdout\'` | Where to log. |')
  })

  it('leaves out the members that the configuration hides, and only those', () => {
    const settings = types.slice(types.indexOf('### `Settings`'), types.indexOf('### `Client`'))

    expect(settings).not.toContain('`raw`')
    expect(settings).not.toContain('stateRaw')
    expect(types.slice(types.indexOf('### `Client`'))).toContain('| `raw()` |')
  })

  it('documents an iterable and its page variant in one section', () => {
    expect(things).toContain('### `list()`')
    expect(things).not.toContain('### `listPage()`')
    expect(things).toContain('list(query?: string): AsyncIterable<string>\nlistPage(query?: string): Promise<string[]>')
    expect(things.match(/\| `query\?` \|/g)).toHaveLength(1)
    expect(things).toContain('- `listPage()`: `Promise<string[]>`')
    expect(things).toContain('### `remove()`')
  })

  it('writes a section that has an introduction and no members', () => {
    expect(things).toContain('## Unsupported\n\nIntro only.')
  })

  it('links documented types and escapes markup in prose', () => {
    expect(types).toContain('Options for [`greet`](/api/functions#greet)')
    expect(types).toContain('&lt;tag>')
    expect(types).not.toContain('{@link')
  })

  it('writes a page that has a location of its own there, and links to it', () => {
    const located = buildFiles(sample(), {
      ...OPTIONS,
      pages: [
        { slug: 'a', title: 'A', description: 'A.', sections: [{ names: ['ANSWER', 'greet'] }] },
        { slug: 'kit', title: 'Kit', description: 'Kit.', location: { directory: '7.guide', basePath: '/guide', file: '5.kit.md' }, sections: [{ names: ['Counter', 'GreetOptions', 'Base'] }] },
      ],
    })
    const paths = located.files.map(file => file.path)

    expect(paths).toContain('7.guide/5.kit.md')
    expect(located.files.find(file => file.path === 'reference/02.a.md')!.content).toContain('[`GreetOptions`](/guide/kit#greetoptions)')
    expect(located.files[0]!.content).not.toContain('/guide/kit')
  })

  it('throws for a name that no export has', () => {
    expect(() => buildFiles(sample(), { ...OPTIONS, pages: [{ slug: 'a', title: 'A', description: 'A.', sections: [{ title: 'Stale', names: ['Renamed'] }] }] })).toThrow('a: "Stale" selects Renamed')
  })
})

describe('writeFiles', () => {
  it('replaces the pages of an earlier run and leaves other files alone', () => {
    const directory = temporary()
    mkdirSync(join(directory, 'reference'))
    writeFileSync(join(directory, 'reference/11.hand.md'), 'mine')
    writeFiles(directory, [{ path: 'reference/01.old.md', content: generatedPage('old') }])
    writeFiles(directory, [{ path: 'reference/02.new.md', content: generatedPage('new') }])

    expect(existsSync(join(directory, 'reference/01.old.md'))).toBe(false)
    expect(readFileSync(join(directory, 'reference/02.new.md'), 'utf8')).toContain('new')
    expect(readFileSync(join(directory, 'reference/11.hand.md'), 'utf8')).toBe('mine')
  })

  it('does not remove a hand-written page that quotes the banner', () => {
    const directory = temporary()
    mkdirSync(join(directory, 'reference'))
    writeFileSync(join(directory, 'reference/11.hand.md'), `---\ntitle: "Hand"\n---\n\nThe generator writes this banner:\n\n${BANNER}\n`)
    writeFiles(directory, [{ path: 'reference/02.new.md', content: generatedPage('new') }])

    expect(existsSync(join(directory, 'reference/11.hand.md'))).toBe(true)
  })

  it('keeps the earlier pages when a target is taken by a hand-written page', () => {
    const directory = temporary()
    mkdirSync(join(directory, 'reference'))
    writeFiles(directory, [{ path: 'reference/01.old.md', content: generatedPage('old') }])
    writeFileSync(join(directory, 'reference/02.hand.md'), 'mine')

    expect(() => writeFiles(directory, [{ path: 'reference/02.hand.md', content: generatedPage('new') }])).toThrow('was not generated')
    expect(existsSync(join(directory, 'reference/01.old.md'))).toBe(true)
  })

  it('refuses to overwrite a page that it did not write', () => {
    const directory = temporary()
    mkdirSync(join(directory, 'reference'))
    writeFileSync(join(directory, 'reference/01.hand.md'), 'mine')

    expect(() => writeFiles(directory, [{ path: 'reference/01.hand.md', content: 'generated' }])).toThrow('was not generated')
    expect(readFileSync(join(directory, 'reference/01.hand.md'), 'utf8')).toBe('mine')
  })
})

/** The URLs of the pages that people write, from the paths under `docs/content`. */
function handWrittenUrls(): Set<string> {
  const urls = new Set<string>()
  const walk = (directory: string, segments: string[]) => {
    for (const name of readdirSync(join(root, 'docs/content', directory))) {
      const path = join(directory, name)
      if (statSync(join(root, 'docs/content', path)).isDirectory()) {
        walk(path, [...segments, name.replace(/^\d+\./, '')])
      }
      else if (name.endsWith('.md')) {
        const page = name.replace(/^\d+\./, '').replace(/\.md$/, '')
        urls.add(`/${[...segments, ...page === 'index' ? [] : [page]].join('/')}`)
      }
    }
  }
  walk('', [])
  return urls
}

describe('the forges reference', () => {
  const contentDir = temporary()
  mkdirSync(join(contentDir, '5.reference'))
  writeFileSync(join(contentDir, '5.reference/11.hand.md'), '# Hand written')
  const { files, unplaced, undocumented } = generateApiDocs({ root, contentDir })
  const reference = files.filter(file => file.path.startsWith('5.reference/'))
  const content = files.map(file => file.content).join('\n')

  it('describes every export and every method with a JSDoc comment', () => {
    expect(undocumented).toEqual([])
  })

  it('places every export on a page of the configuration', () => {
    expect(unplaced).toEqual([])
  })

  it('stays within the numbers that Git ignores, and apart from the hand-written pages', () => {
    expect(reference.map(file => file.path.replace('5.reference/', '')).filter(path => !/^(?:0[1-9]|10)\./.test(path))).toEqual([])
    expect(readdirSync(join(contentDir, '5.reference'))).toContain('11.hand.md')
    expect(files.filter(file => !file.path.startsWith('5.reference/')).map(file => file.path)).toEqual(['7.contributing/6.provider-kit.md'])
  })

  it('names every page in lower case, as Nuxt Content serves it', () => {
    expect(files.filter(file => file.path !== file.path.toLowerCase())).toEqual([])
  })

  it('reports the declaring file of every export with forward slashes', () => {
    const model = extractApi({ root, entries: ENTRIES })
    const sources = new Set(model.entries.flatMap(entry => entry.symbols.map(symbol => symbol.source)))

    expect([...sources].filter(source => !source.startsWith('src/') || source.includes('\\'))).toEqual([])
  })

  it('documents every runtime export of every entry point', async () => {
    const model = extractApi({ root, entries: ENTRIES })
    for (const [specifier, path] of Object.entries(ENTRIES)) {
      const documented = new Set(model.entries.find(entry => entry.specifier === specifier)!.symbols.map(symbol => symbol.name))
      const exported = Object.keys(await import(join(root, path)) as object)

      expect(exported.filter(name => !documented.has(name)), specifier).toEqual([])
    }
  })

  it('documents every method of every provider namespace', () => {
    const provider = fake().create()

    for (const [name, value] of Object.entries(provider)) {
      if (typeof value !== 'object' || value === null || name === 'capabilities')
        continue
      const start = content.indexOf(`## \`provider.${name}\``)
      expect(start, `section for provider.${name}`).toBeGreaterThan(-1)
      const section = content.slice(start + 1).split(/\n## /)[0]!
      const missing = Object.keys(value).filter(method => !section.includes(`${method}(`) && !new RegExp(`^### \`(?:${name}\\.)?${method}\``, 'm').test(section))

      expect(missing, `provider.${name}`).toEqual([])
    }
  })

  it('documents the helpers, the provider methods and the error classes', () => {
    for (const name of ['createForges', 'supports', 'supportOf', 'parseForgeUrl']) {
      expect(content).toMatch(new RegExp(`^#{2,3} \`${name}\\(\\)\`$`, 'm'))
    }
    expect(content).toContain('### `can()`')
    expect(content).toContain('### `support()`')
    for (const name of Object.keys(forges).filter(name => name.endsWith('Error'))) {
      expect(content).toContain(`## \`${name}\``)
    }
  })

  it('documents options and methods whose names end in Raw or are raw', () => {
    const requests = reference.find(file => file.path.endsWith('.requests.md'))!.content
    const kit = files.find(file => file.path.endsWith('provider-kit.md'))!.content
    const data = reference.find(file => file.path.endsWith('.data-model.md'))!.content

    expect(requests.slice(requests.indexOf('### `ForgeRawRequestOptions`'))).toContain('| `raw` |')
    expect(kit).toContain('| `raw()` |')
    expect(content).toMatch(/\| `reasonRaw\?` \|/)
    expect(data).not.toMatch(/\| `(?:raw|stateRaw|payload)\??` \|/)
  })

  it('leaves the entries of ForgeCapabilities to the capability matrix', () => {
    const capabilities = content.slice(content.indexOf('### `ForgeCapabilities`'), content.indexOf('### `Support`'))

    expect(capabilities).toContain('| `eventKinds` |')
    expect(capabilities).not.toContain('Support for')
  })

  it('documents defaults, examples and parameters', () => {
    expect(content).toContain('| Member | Type | Default | Description |')
    expect(content).toContain('**Example**')
    expect(content).toMatch(/\| `factories` \| .* \| Factories such as `github\(\)`/)
  })

  it('leaves no unresolved links or raw markup', () => {
    const prose = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

    expect(content).not.toContain('{@')
    expect(prose).not.toMatch(/<[A-Z]/i)
  })

  it('links only to pages and headings that exist', () => {
    const anchors = new Map<string, Set<string>>()
    for (const file of files) {
      const [directory, name] = file.path.split('/') as [string, string]
      const path = `/${directory.replace(/^\d+\./, '')}/${name.replace(/^\d+\./, '').replace(/\.md$/, '')}`
      const used = new Map<string, number>()
      const ids = new Set<string>()
      const headings = [...file.content.replace(/```[\s\S]*?```/g, '').matchAll(/^#{2,6} (.+)$/gm)]
      for (const [, heading] of headings) {
        const base = slug(heading!)
        const count = used.get(base)
        used.set(base, (count ?? 0) + 1)
        ids.add(count === undefined ? base : `${base}-${count}`)
      }
      expect(ids.size, `unique headings in ${path}`).toBe(headings.length)
      anchors.set(path, ids)
    }

    const known = handWrittenUrls()
    const broken: string[] = []
    for (const [, target] of content.matchAll(/\]\((\/[^)\s]*)\)/g)) {
      const [path, anchor] = target!.split('#') as [string, string | undefined]
      const ids = anchors.get(path)
      if (!ids && !known.has(path))
        broken.push(target!)
      else if (ids && anchor && !ids.has(anchor))
        broken.push(target!)
    }

    expect([...new Set(broken)]).toEqual([])
  })
})
