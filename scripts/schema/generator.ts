import type { BaseType, ChainNodeParser, Definition, SubNodeParser, SubTypeFormatter } from 'ts-json-schema-generator'
import type { Schema } from './json.ts'
import { BaseType as Base, Context, createFormatter, createParser, DEFAULT_CONFIG, NeverType, SchemaGenerator } from 'ts-json-schema-generator'
import ts from 'typescript'
import { BYTES_SCHEMA, STREAM_SCHEMA } from './json.ts'

/** The listing and page declarations the wire maps a listing to. */
export interface ForgesTypes {
  iterable: ts.Symbol
  listing: ts.Symbol
  page: ts.Declaration
  provider: ts.Symbol
}

const WIRE_SCHEMAS = {
  bytes: BYTES_SCHEMA,
  opaque: { type: 'object' } as Schema,
  stream: STREAM_SCHEMA,
}

type WireKind = keyof typeof WIRE_SCHEMAS

class WireType extends Base {
  readonly kind: WireKind

  constructor(kind: WireKind) {
    super()
    this.kind = kind
  }

  getId(): string {
    return `forges-${this.kind}`
  }
}

/** Types as the wire carries them: bytes as `{ $bytes }`, a byte stream as the response, `ForgeIterable` as its page. */
class WireTypes implements SubNodeParser, SubTypeFormatter {
  chain!: ChainNodeParser
  private readonly program: ts.Program
  private readonly forges: ForgesTypes

  constructor(program: ts.Program, forges: ForgesTypes) {
    this.program = program
    this.forges = forges
  }

  supportsNode(node: ts.Node): boolean {
    return !!this.lib(node) || this.isListing(node) || this.isOpaque(node)
  }

  createType(node: ts.Node, context: Context): BaseType {
    if (this.isOpaque(node)) {
      return new WireType('opaque')
    }
    if (this.isListing(node)) {
      const page = new Context(node as never)
      for (const argument of (node as ts.TypeReferenceNode).typeArguments ?? []) {
        page.pushArgument(this.chain.createType(argument as never, context))
      }
      return this.chain.createType(this.forges.page as never, page)
    }
    const name = this.lib(node)
    return name === 'Uint8Array'
      ? new WireType('bytes')
      : name === 'ReadableStream'
        ? new WireType('stream')
        : new NeverType()
  }

  supportsType(type: BaseType): boolean {
    return type instanceof WireType
  }

  getDefinition(type: BaseType): Definition {
    return WIRE_SCHEMAS[(type as WireType).kind] as Definition
  }

  getChildren(): BaseType[] {
    return []
  }

  private isListing(node: ts.Node): boolean {
    if (!ts.isTypeReferenceNode(node)) {
      return false
    }
    const symbol = resolvedSymbol(this.program, node.typeName)
    return symbol === this.forges.iterable || symbol === this.forges.listing
  }

  private isOpaque(node: ts.Node): boolean {
    return ts.isTypeReferenceNode(node)
      && (resolvedSymbol(this.program, node.typeName) === this.forges.provider || isLib(this.program, node, 'AsyncIterable'))
  }

  private lib(node: ts.Node): string | undefined {
    return ts.isTypeReferenceNode(node)
      ? ['Uint8Array', 'ReadableStream', 'AbortSignal'].find(name => isLib(this.program, node, name))
      : undefined
  }
}

/**
 * Schemas for type nodes in `program`, collecting the named types they reference into `definitions`. Parses with the
 * chain itself: the parser `createParser()` returns would inline a root reference such as `RepoRef`.
 */
export function schemaGenerator(program: ts.Program, forges: ForgesTypes) {
  const config = {
    ...DEFAULT_CONFIG,
    expose: 'all' as const,
    topRef: false,
    jsDoc: 'extended' as const,
    functions: 'hide' as const,
    additionalProperties: true,
    skipTypeCheck: true,
  }
  const wire = new WireTypes(program, forges)
  let chain!: ChainNodeParser
  const parser = createParser(program as never, config, (mutable) => {
    chain = mutable as ChainNodeParser
    wire.chain = chain
    chain.addNodeParser(wire)
  })
  const formatter = createFormatter(config, mutable => mutable.addTypeFormatter(wire))

  class GeneratedSchema extends SchemaGenerator {
    readonly definitions: Record<string, Definition> = {}

    /** The schema of one of `nodes`: overloads give a parameter several. */
    of(nodes: ts.TypeNode[]): Schema {
      const branches = nodes.map((node) => {
        const type = chain.createType(node as never, new Context())
        this.appendRootChildDefinitions(type, this.definitions)
        return this.typeFormatter.getDefinition(type) as Schema
      })
      const distinct = [
        ...new Map(branches.map(branch => [
          JSON.stringify(branch),
          branch,
        ])).values(),
      ]
      return distinct.length === 1
        ? distinct[0]!
        : { anyOf: distinct }
    }
  }

  return new GeneratedSchema(program as never, parser, formatter, config)
}

/** The symbol `node` names, following an export alias. */
function resolvedSymbol(program: ts.Program, node: ts.Node): ts.Symbol | undefined {
  if (!ts.isIdentifier(node)) {
    return undefined
  }
  const checker = program.getTypeChecker()
  const symbol = checker.getSymbolAtLocation(node)
  return symbol && (symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol)
}

/** The type a `Promise<T>` return resolves with. */
export function awaited(program: ts.Program, node: ts.TypeNode): ts.TypeNode {
  return ts.isTypeReferenceNode(node) && isLib(program, node, 'Promise') && node.typeArguments
    ? node.typeArguments[0]!
    : node
}

/** `node` names the global `name` from TypeScript's lib, not a `forges` type that happens to share it. */
function isLib(program: ts.Program, node: ts.TypeReferenceNode, name: string): boolean {
  if (!ts.isIdentifier(node.typeName) || node.typeName.text !== name) {
    return false
  }
  return !!resolvedSymbol(program, node.typeName)?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
}
