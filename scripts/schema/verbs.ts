import type { Json, Schema } from './json.ts'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { CAPABILITY_TABLE } from '../../src/capability-table.ts'
import { awaited, schemaGenerator } from './generator.ts'
import { clean, componentName, isRecord, refs, sortByKey, STREAM_SCHEMA, tidyDescriptions } from './json.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** One parameter of a provider verb. */
interface VerbParam {
  name: string
  schema: Schema
  optional: boolean
  /** The parameter carries the request's `signal`. */
  options?: true
  description?: string
}

/** The signature of one provider verb, as `forges/schema` publishes it. */
export interface VerbSignature {
  summary?: string
  write: boolean
  account: boolean
  /** Answers with one `Page` of a listing. */
  listing?: true
  params: VerbParam[]
  /** The result is a byte stream. */
  stream?: true
  result: Schema
}

/** A parameter while its overloads are being merged. */
interface ParamDraft extends Omit<VerbParam, 'schema'> {
  types: ts.TypeNode[]
}

function docOf(declaration: ts.ParameterDeclaration, tags: readonly ts.JSDocTag[]): { description?: string } {
  const name = declaration.name.getText()
  const description = tags
    .filter((tag): tag is ts.JSDocParameterTag => ts.isJSDocParameterTag(tag) && tag.name.getText() === name)
    .map(tag => ts.getTextOfJSDocComment(tag.comment))
    .find(Boolean)
  return description
    ? { description }
    : {}
}

/** Every provider verb and the components its schemas reference. */
export function generateVerbSignatures(): { components: Record<string, Schema>, verbs: Record<string, VerbSignature> } {
  const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram([`${root}src/index.ts`], parsed.options)
  const checker = program.getTypeChecker()
  const index = program.getSourceFile(`${root}src/index.ts`)!
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(index)!)
  const exported = (name: string): ts.Symbol => {
    const symbol = exports.find(candidate => candidate.name === name)
    if (!symbol) {
      throw new Error(`forges exports no ${name}`)
    }
    return symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol
  }
  const iterable = exported('ForgeIterable')
  const listing = exported('ForgeListing')
  const pageSymbol = exported('Page')
  const page = pageSymbol.declarations?.[0]
  if (!page) {
    throw new Error('Page has no declaration')
  }
  const provider = checker.getDeclaredTypeOfSymbol(exported('ForgeProvider'))
  const generator = schemaGenerator(program, { iterable, listing, page })

  // Components are the model types, the public options types and the few provider data types; helpers are inlined.
  const model = program.getSourceFile(`${root}src/model.ts`)!
  const names = new Set([
    ...checker.getExportsOfModule(checker.getSymbolAtLocation(model)!).map(symbol => symbol.name),
    ...exports.map(symbol => symbol.name).filter(name => /Options$|Query$/.test(name)),
    'ForgeCapabilities',
    'SubscriptionItem',
    'WebhookDelivery',
  ])
  const isComponent = (definition: string) => names.has(definition.replace(/<[\s\S]*$/, ''))
  const inline = (value: Json, stack: string[] = []): Json => {
    if (Array.isArray(value)) {
      return value.map(item => inline(item, stack))
    }
    if (!isRecord(value)) {
      return value
    }
    const { $ref, ...rest } = value
    const name = typeof $ref === 'string'
      ? decodeURIComponent($ref.replace(/^#\/definitions\//, ''))
      : undefined
    if (name && !isComponent(name)) {
      if (stack.includes(name)) {
        throw new Error(`${name} refers to itself, and forges doesn't export it to name it by`)
      }
      return {
        ...inline(generator.definitions[name]! as Schema, [...stack, name]) as Schema,
        ...inline(rest, stack) as Schema,
      }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      inline(item, stack),
    ]))
  }
  const cleanInline = (value: Json): Schema => clean(tidyDescriptions(inline(value))) as Schema

  const classes = new Map<string, Pick<VerbSignature, 'write' | 'account'> & { listing: boolean }>()
  for (const capability of CAPABILITY_TABLE) {
    const listings = new Set(capability.listings ?? [])
    for (const verb of capability.verbs ?? []) {
      const previous = classes.get(verb) ?? { write: false, account: false, listing: false }
      classes.set(verb, {
        write: previous.write || !!capability.write,
        account: previous.account || !!capability.account,
        listing: previous.listing || listings.has(verb),
      })
    }
  }

  const verbs: Record<string, VerbSignature> = {}
  for (const [name, { write, account, listing }] of [...classes].sort(([left], [right]) => left.localeCompare(right))) {
    const [namespace, method] = name.split('.') as [string, string]
    const namespaceSymbol = provider.getProperty(namespace)
    if (!namespaceSymbol) {
      throw new Error(`ForgeProvider has no ${namespace} for ${name}`)
    }
    const member = checker.getTypeOfSymbol(namespaceSymbol).getProperty(method)
    if (!member) {
      throw new Error(`ForgeProvider.${namespace} has no ${method}`)
    }
    const overloads = checker.getTypeOfSymbol(member)
      .getCallSignatures()
      .map(signature => signature.getDeclaration())
      .filter((declaration): declaration is ts.SignatureDeclaration => !!declaration)
    if (!overloads.length) {
      throw new Error(`${name} has no call signature`)
    }
    const tags = (member.declarations ?? []).flatMap(declaration => ts.getJSDocTags(declaration))

    const params: ParamDraft[] = []
    for (const overload of overloads) {
      overload.parameters.forEach((declaration, index) => {
        const param = (params[index] ??= {
          name: declaration.name.getText(),
          optional: false,
          ...(declaration.type && checker.getNonNullableType(checker.getTypeAtLocation(declaration)).getProperty('signal')
            ? { options: true as const }
            : {}),
          ...docOf(declaration, tags),
          types: [],
        })
        param.optional ||= !!declaration.questionToken || !!declaration.initializer
        if (declaration.type) {
          param.types.push(declaration.type)
        }
      })
    }
    // A parameter missing from some overloads is optional in all of them.
    for (const param of params.slice(Math.min(...overloads.map(overload => overload.parameters.length)))) {
      param.optional = true
    }
    const resultTypes = overloads.map(overload => awaited(program, overload.type!))
    const result = cleanInline(generator.of(resultTypes))
    const summary = ts.displayPartsToString(member.getDocumentationComment(checker))
    verbs[name] = {
      ...(summary
        ? { summary }
        : {}),
      write,
      account,
      ...(listing
        ? { listing: true as const }
        : {}),
      params: params.map(({ types, ...param }) => ({
        ...param,
        schema: cleanInline(generator.of(types)),
      })),
      ...(JSON.stringify(result).includes(JSON.stringify(STREAM_SCHEMA))
        ? { stream: true as const }
        : {}),
      result,
    }
  }

  const components = sortByKey(Object.fromEntries(Object.entries(generator.definitions)
    .filter(([name]) => isComponent(name))
    .map(([name, definition]) => {
      const component = componentName(name)
      return [
        component,
        {
          ...cleanInline(definition as Schema),
          'x-forges-type': component,
        },
      ]
    })))
  const reached = new Set<string>()
  const reach = (value: Json): void => {
    for (const name of refs(value)) {
      if (!reached.has(name)) {
        reached.add(name)
        const component = components[name]
        if (component) {
          reach(component)
        }
      }
    }
  }
  reach(verbs as unknown as Json)
  return {
    components: Object.fromEntries([...reached].filter(name => name in components).sort().map(name => [name, components[name]!])),
    verbs,
  }
}
