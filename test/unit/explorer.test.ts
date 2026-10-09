import type { ExplorerInput } from '../../docs/shared/explorer.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { annotateJson, pageSchema } from '../../docs/app/utils/explorer-json.ts'
import { explorerHovers, explorerPageMembers } from '../../docs/shared/explorer-hovers.ts'
import {
  EXPLORER_FORGES,
  EXPLORER_OPERATIONS,
  explorerCode,
  explorerRefs,
} from '../../docs/shared/explorer.ts'
import { ENTRIES } from '../../scripts/api-docs/config.ts'
import { extractApi } from '../../scripts/api-docs/extract.ts'
import { generateApiDocs } from '../../scripts/api-docs/generate.ts'
import { github } from '../../src/github/index.ts'
import { schemas } from '../../src/schema/index.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const model = extractApi({ root, entries: ENTRIES })

/** Every input an explorer can show: each forge's sample, with both thread kinds, and with and without a ref. */
const inputs = EXPLORER_FORGES.flatMap(forge =>
  (['issue', 'pull_request'] as const).flatMap(kind =>
    ['', 'main'].map(ref => ({ forge, input: { ...forge.sample, kind, ref } as ExplorerInput })),
  ),
)

describe('explorer operations', () => {
  it('call methods that every provider has', () => {
    const provider = github().create() as unknown as Record<string, Record<string, unknown>>
    for (const { method } of EXPLORER_OPERATIONS) {
      const [namespace, name] = method.split('.') as [string, string]
      expect(typeof provider[namespace]?.[name], method).toBe('function')
    }
  })

  it('define at most one operation per verb', () => {
    const verbs = EXPLORER_OPERATIONS.map(operation => operation.verb)
    expect(new Set(verbs).size).toBe(verbs.length)
  })

  it('declare the type that the method they call resolves to', () => {
    const symbols = model.entries.flatMap(entry => entry.symbols)
    const namespaces = symbols.find(symbol => symbol.name === 'ForgeProvider')!.members
    for (const { method, returns } of EXPLORER_OPERATIONS) {
      const [namespace, name] = method.split('.') as [string, string]
      const api = symbols.find(symbol => symbol.name === namespaces.find(member => member.name === namespace)?.reference)
      const declared = api?.members.find(member => member.name === name)?.signatures[0]?.returns.type
      // A missing result is no type of its own: the result shows nothing then.
      expect(declared?.replace(/^Promise<(.+)>$/, '$1').replace(/ \| undefined$/, ''), method).toBe(returns)
    }
  })

  it('load the factory of every forge that has a provider here', async () => {
    for (const forge of EXPLORER_FORGES) {
      if (!forge.load) {
        // Only a forge whose provider needs credentials to be created goes without one.
        expect(forge.authRequired, forge.forge).toBe(true)
        continue
      }
      const module = await forge.load() as Record<string, unknown>
      expect(typeof module[forge.factory], forge.forge).toBe('function')
    }
  })

  it('build refs for the forge of the provider', () => {
    const provider = github().create()
    const { repo, thread } = explorerRefs(provider, EXPLORER_FORGES[0]!.sample)
    expect(repo).toEqual({ forge: 'github', instance: 'github.com', owner: 'nuxt', name: 'nuxt' })
    expect(thread).toMatchObject({ repo, kind: 'pull_request', number: '36493' })
  })
})

describe('explorer code', () => {
  it('marks every form value and name where it appears', () => {
    for (const { forge, input } of inputs) {
      for (const operation of EXPLORER_OPERATIONS) {
        const { text, values, symbols } = explorerCode(operation, forge, input)
        const label = `${forge.forge} ${operation.verb}`
        expect(text, label).not.toMatch(/[]/)
        for (const { field, start, end } of values) {
          expect(text.slice(start, end), `${label} ${field}`).toMatch(/^['[]/)
        }
        for (const { id, start, end } of symbols) {
          const name = id.startsWith('const:') ? id.split(':')[1] : id.split(/[:.]/).at(-1)
          expect(text.slice(start, end), `${label} ${id}`).toBe(name)
        }
      }
    }
  })

  it('keeps lines to 80 characters, except around a long string', () => {
    for (const { forge, input } of inputs) {
      for (const operation of EXPLORER_OPERATIONS) {
        for (const line of explorerCode(operation, forge, input).text.split('\n')) {
          if (line.length > 80) {
            expect(line, `${forge.forge} ${operation.verb}`).toMatch(/'[^']{50,}'/)
          }
        }
      }
    }
  })

  it('type-checks against the library for every operation and forge', () => {
    const files = new Map<string, string>()
    for (const { forge, input } of inputs.filter(entry => entry.input.ref === 'main')) {
      for (const operation of EXPLORER_OPERATIONS) {
        files.set(
          join(root, `test/.explorer/${forge.forge}-${operation.verb}-${input.kind}.ts`),
          `${explorerCode(operation, forge, input).text}\nexport {}\n`,
        )
      }
    }
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ['node'],
    }
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile
    host.fileExists = name => files.has(name) || ts.sys.fileExists(name)
    host.readFile = name => files.get(name) ?? ts.sys.readFile(name)
    host.getSourceFile = (name, version) =>
      files.has(name)
        ? ts.createSourceFile(name, files.get(name)!, version)
        : getSourceFile(name, version)
    const program = ts.createProgram([...files.keys()], options, host)
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.file && files.has(diagnostic.file.fileName))
      .map(
        diagnostic =>
          `${diagnostic.file!.fileName.split('/').at(-1)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      )
    expect(errors).toEqual([])
  }, 60_000)
})

describe('explorer results', () => {
  const thread = {
    ref: {
      forge: 'github',
      instance: 'github.com',
      repo: { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' },
      kind: 'pull_request',
      number: '7',
    },
    kind: 'pull_request',
    title: 'Fix it',
    state: 'merged',
    stateRaw: 'closed',
    isDraft: false,
    assignees: [],
    reviewers: [],
    labels: [],
    createdAt: new Date('2026-01-02T03:04:05Z'),
    raw: { node_id: 'PR_1' },
  }

  it('prints a result as JSON.stringify does, with the payload left out', () => {
    const { text } = annotateJson(thread, { $ref: '#/components/schemas/Thread' }, schemas, true)
    expect(text).toBe(JSON.stringify({ ...thread, raw: '…' }, null, 2))
  })

  it('describes each key from the schema of its type', () => {
    const { text, keys } = annotateJson(
      thread,
      { $ref: '#/components/schemas/Thread' },
      schemas,
      true,
    )
    const info = (name: string) =>
      keys.find(key => text.slice(key.start, key.end) === `"${name}"`)?.info
    expect(info('stateRaw')).toMatchObject({ owner: 'Thread', type: 'string', optional: true })
    expect(info('owner')).toMatchObject({ owner: 'RepoRef', type: 'string', optional: false })
    expect(info('state')?.type).toBe('ThreadState')
  })

  it('picks the variant of a union whose constant fields match', () => {
    const subject = { type: 'repo', repo: thread.ref.repo }
    const { keys } = annotateJson(
      { subject },
      {
        type: 'object',
        properties: { subject: { $ref: '#/components/schemas/NotificationSubject' } },
      },
      schemas,
      true,
    )
    expect(keys.find(key => key.info.name === 'repo')?.info).toMatchObject({
      owner: 'NotificationSubject',
      type: 'RepoRef',
    })
  })

  it('builds the schema of a page from the members of Page<T>', () => {
    const schema = pageSchema('Thread', explorerPageMembers(model))
    expect(schema.properties.items).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Thread' },
      description: undefined,
    })
    expect(schema.properties.cursor.$ref).toBe('#/components/schemas/Cursor')
    expect(schema.required).toEqual(['items'])
  })
})

describe('explorer hovers', () => {
  const hovers = explorerHovers(model)

  it('describe every method, factory and declared type that the code shows', () => {
    for (const { forge, input } of inputs) {
      for (const operation of EXPLORER_OPERATIONS) {
        for (const { id } of explorerCode(operation, forge, input).symbols) {
          const key = id.startsWith('const:')
            ? `type:${id
              .split(':')[2]!
              .replace(/^Page<.+>$/, 'Page')
              .replace(/\[\]$/, '')}`
            : id
          // Results that are no model type, such as `string`, have nothing to describe.
          if (!/^type:[a-z]/.test(key) && !key.startsWith('type:ReadableStream') && key !== 'type:void') {
            expect(hovers[key], `${forge.forge} ${operation.verb} ${id}`).toBeDefined()
          }
        }
      }
    }
  })
})

describe('reference pages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'explorer-'))
  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  it('show an explorer for every operation', () => {
    const { files } = generateApiDocs({ root, contentDir: directory })
    const shown = new Set(
      files.flatMap(file =>
        [...file.content.matchAll(/::api-explorer\{verb="([^"]+)"\}/g)].map(match => match[1]),
      ),
    )
    expect([...shown].sort()).toEqual(
      EXPLORER_OPERATIONS.map(operation => operation.verb).sort(),
    )
  }, 60_000)
})
