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
  authCode,
  authFromValues,
  explorable,
  EXPLORER_FORGES,
  EXPLORER_NAMESPACE_TITLES,
  EXPLORER_OPERATIONS,
  explorerCode,
  explorerRefs,
  isCredentialComplete,
  placeholderAuth,
} from '../../docs/shared/explorer.ts'
import { ENTRIES } from '../../scripts/api-docs/config.ts'
import { extractApi } from '../../scripts/api-docs/extract.ts'
import { generateApiDocs } from '../../scripts/api-docs/generate.ts'
import { matrixProviders } from '../../scripts/capabilities.ts'
import { github } from '../../src/github/index.ts'
import * as forges from '../../src/index.ts'
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
    const provider = github() as unknown as Record<string, Record<string, unknown>>
    for (const { verb } of EXPLORER_OPERATIONS) {
      const [namespace, name] = verb.split('.') as [string, string]
      expect(typeof provider[namespace]?.[name], verb).toBe('function')
    }
  })

  it('define at most one operation per verb', () => {
    const verbs = EXPLORER_OPERATIONS.map(operation => operation.verb)
    expect(new Set(verbs).size).toBe(verbs.length)
  })

  it('give every namespace an entry in the picker, so none is dropped', () => {
    const namespaces = new Set(EXPLORER_OPERATIONS.map(operation => operation.verb.split('.')[0]!))
    expect([...namespaces].filter(namespace => !(namespace in EXPLORER_NAMESPACE_TITLES))).toEqual([])
  })

  it('declare the type that the method they call resolves to', () => {
    const symbols = model.entries.flatMap(entry => entry.symbols)
    const namespaces = symbols.find(symbol => symbol.name === 'ForgeProvider')!.members
    for (const { verb, returns, page } of EXPLORER_OPERATIONS) {
      const [namespace, name] = verb.split('.') as [string, string]
      const api = symbols.find(symbol => symbol.name === namespaces.find(member => member.name === namespace)?.reference)
      const declared = api?.members.find(member => member.name === name)?.signatures[0]?.returns.type
      expect(declared?.replace(/^Promise<(.+)>$/, '$1'), verb).toBe(page ? returns.replace(/^Page</, 'ForgeListing<') : returns)
    }
  })

  it('create a provider with and without credentials for every forge', async () => {
    for (const forge of EXPLORER_FORGES) {
      const factory = (await forge.load() as Record<string, (options: object) => forges.ForgeProvider>)[forge.factory]!
      const options = forge.options?.(forge.sample) ?? {}
      if (!forge.signedIn) {
        expect(factory(options).authKind, forge.forge).toBe('anonymous')
      }
      for (const credential of forge.credentials) {
        expect(factory({ ...options, auth: placeholderAuth(credential) }).authKind, `${forge.forge} ${credential.kind}`).toBe(credential.kind)
      }
    }
  })

  it('list the forges in the order of the capability matrix', () => {
    expect(EXPLORER_FORGES.map(forge => forge.forge)).toEqual(matrixProviders(forges).map(provider => provider.slug))
  })

  it('run only calls that some forge supports here without credentials', async () => {
    const anonymous = await Promise.all(EXPLORER_FORGES.filter(forge => !forge.blocked).map(async (forge) => {
      const factory = (await forge.load() as Record<string, (options: object) => forges.ForgeProvider>)[forge.factory]!
      return factory(forge.options?.(forge.sample) ?? {})
    }))
    for (const operation of EXPLORER_OPERATIONS.filter(entry => entry.run && !entry.auth)) {
      const kinds = operation.kind ? (['issue', 'pull_request'] as const) : ([undefined] as const)
      const supported = anonymous.some(provider => kinds.some(kind => provider.can(operation.verb, kind)))
      expect(supported, operation.verb).toBe(true)
    }
  })

  it('run only calls that some forge supports here with credentials', async () => {
    const signedIn = await Promise.all(EXPLORER_FORGES.filter(forge => !forge.blocked && forge.credentials.some(credential => credential.runnable)).map(async (forge) => {
      const factory = (await forge.load() as Record<string, (options: object) => forges.ForgeProvider>)[forge.factory]!
      const options = forge.options?.(forge.sample) ?? {}
      return factory({ ...options, auth: placeholderAuth(forge.credentials.find(credential => credential.runnable)!) })
    }))
    for (const operation of EXPLORER_OPERATIONS.filter(entry => entry.run && entry.auth)) {
      const kinds = operation.kind ? (['issue', 'pull_request'] as const) : ([undefined] as const)
      const supported = signedIn.some(provider => kinds.some(kind => provider.can(operation.verb, kind)))
      expect(supported, operation.verb).toBe(true)
    }
  })

  it('build refs for the forge of the provider', () => {
    const provider = github()
    const { repo, thread } = explorerRefs(provider, EXPLORER_FORGES[0]!.sample)
    expect(repo).toEqual({ forge: 'github', instance: 'github.com', owner: 'nuxt', name: 'nuxt' })
    expect(thread).toMatchObject({ repo, kind: 'pull_request', number: '36506' })
  })
})

describe('explorer credentials', () => {
  it('offer every forge a credential, and only run the kinds the browser can build', () => {
    for (const forge of EXPLORER_FORGES) {
      expect(forge.credentials.length, forge.forge).toBeGreaterThan(0)
      for (const credential of forge.credentials) {
        expect(credential.fields.every(field => field.env || field.value), `${forge.forge} ${credential.kind}`).toBe(true)
        if (credential.runnable) {
          expect(['token', 'basic'], `${forge.forge} ${credential.kind}`).toContain(credential.kind)
        }
      }
    }
  })

  it('read each credential field from the environment in the code', () => {
    for (const forge of EXPLORER_FORGES) {
      for (const credential of forge.credentials) {
        const code = authCode(credential)
        expect(code).toContain(`type: '${credential.kind}'`)
        for (const field of credential.fields.filter(field => !field.optional)) {
          expect(code, `${forge.forge} ${credential.kind} ${field.field}`).toContain(field.value === undefined ? `process.env.${field.env}!` : `'${field.value}'`)
        }
      }
    }
  })

  it('build the auth a credential describes from the values the person typed', () => {
    const token = EXPLORER_FORGES.find(forge => forge.forge === 'github')!.credentials.find(credential => credential.kind === 'token')!
    expect(authFromValues(token, { TOKEN: ' ghp_x ' })).toEqual({ type: 'token', token: 'ghp_x' })

    const basic = EXPLORER_FORGES.find(forge => forge.forge === 'bitbucket')!.credentials.find(credential => credential.kind === 'basic')!
    expect(authFromValues(basic, { USERNAME: 'me@example.com', PASSWORD: 'secret' })).toEqual({ type: 'basic', username: 'me@example.com', password: 'secret' })
    expect(placeholderAuth(basic)).toEqual({ type: 'basic', username: 'placeholder', password: 'placeholder' })

    const app = EXPLORER_FORGES.find(forge => forge.forge === 'github')!.credentials.find(credential => credential.kind === 'app')!
    expect(authFromValues(app, { APP_ID: '1', PRIVATE_KEY: 'a\\nb', INSTALLATION_ID: '2' })).toEqual({ type: 'app', appId: '1', privateKey: 'a\nb', installationId: '2' })
    expect(authFromValues(app, { APP_ID: '1', PRIVATE_KEY: 'a\\nb' })).toEqual({ type: 'app', appId: '1', privateKey: 'a\nb' })
  })

  it('call a credential complete only with every required field', () => {
    const basic = EXPLORER_FORGES.find(forge => forge.forge === 'bitbucket')!.credentials.find(credential => credential.kind === 'basic')!
    expect(isCredentialComplete(basic, { USERNAME: 'me' })).toBe(false)
    expect(isCredentialComplete(basic, { USERNAME: 'me', PASSWORD: 'secret' })).toBe(true)

    const app = EXPLORER_FORGES.find(forge => forge.forge === 'github')!.credentials.find(credential => credential.kind === 'app')!
    expect(isCredentialComplete(app, { APP_ID: '1', PRIVATE_KEY: 'key' })).toBe(true)
  })

  it('print the chosen credential in the code, not the forge default', () => {
    const forge = EXPLORER_FORGES.find(entry => entry.forge === 'bitbucket')!
    const operation = EXPLORER_OPERATIONS.find(entry => entry.verb === 'notifications.list')!
    const basic = forge.credentials.find(credential => credential.kind === 'basic')!
    const code = explorerCode(operation, forge, forge.sample, basic).text
    expect(code).toContain('type: \'basic\'')
    expect(code).toContain('process.env.BITBUCKET_USERNAME!')
    expect(code).toContain('process.env.BITBUCKET_PASSWORD!')
    expect(code).not.toContain('BITBUCKET_TOKEN')
  })
})

describe('explorer code', () => {
  it('marks every form value and name where it appears', () => {
    for (const { forge, input } of inputs) {
      for (const operation of EXPLORER_OPERATIONS) {
        const { text, values, symbols } = explorerCode(operation, forge, input)
        const label = `${forge.forge} ${operation.verb}`
        expect(text, label).not.toMatch(/[\uE000-\uE002]/)
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

  it('escapes the characters that delimit form values', () => {
    const forge = EXPLORER_FORGES[0]!
    const operation = EXPLORER_OPERATIONS.find(entry => entry.verb === 'search.repos')!
    const query = 'a\uE000b\uE001c\uE002\'d\\'
    const { text, values } = explorerCode(operation, forge, { ...forge.sample, query })
    const literal = values.find(value => value.field === 'query')!
    expect(text.slice(literal.start, literal.end)).toBe(`'a\\uE000b\\uE001c\\uE002\\'d\\\\'`)
  })

  it('passes credentials only when the call needs them', () => {
    const forge = EXPLORER_FORGES[0]!
    const operation = EXPLORER_OPERATIONS.find(entry => entry.verb === 'repos.collaborators')!
    expect(explorerCode(operation, forge, forge.sample).text).not.toContain('auth:')
    expect(explorerCode(operation, forge, forge.sample, true).text).toContain(`auth: { type: 'token', token: process.env.GITHUB_TOKEN! }`)
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
          // Issues cover the code with credentials, and pull requests the code without.
          `${explorerCode(operation, forge, input, input.kind === 'issue').text}\nexport {}\n`,
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
              .replace(/ \| undefined$/, '')
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
    const { files } = generateApiDocs({ root, contentDir: directory, explorable })
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
