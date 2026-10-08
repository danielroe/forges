/** Documentation lifted from a JSDoc comment. */
export interface ApiDoc {
  /** Markdown. `{@link Name}` stays in place for the renderer to resolve. */
  description: string
  examples: string[]
  /** The `@deprecated` message, empty when the tag has none. */
  deprecated?: string
  /** The `@default` value, without backticks. */
  default?: string
  see: string[]
}

export interface ApiParam {
  name: string
  /** The type as written in the source. */
  type: string
  optional: boolean
  rest: boolean
  default?: string
  /** From the `@param` tag. */
  description: string
}

export interface ApiSignature {
  typeParameters?: string
  params: ApiParam[]
  returns: { type: string, description: string }
  throws: string[]
  /** Set when an overload has a comment of its own. */
  doc?: ApiDoc
}

export interface ApiMember extends ApiDoc {
  /** Dotted for members of a nested object type, such as `search.threads`. */
  name: string
  /** `group` is a nested object type that only holds further members. */
  kind: 'property' | 'method' | 'group'
  type: string
  optional: boolean
  readonly: boolean
  static: boolean
  signatures: ApiSignature[]
  /** The interface that declares the member, when it is not the one being documented. */
  inheritedFrom?: string
  /** The name of the type, when the property is typed as a single reference such as `ReposApi`. */
  reference?: string
}

export type ApiSymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable'

export interface ApiSymbol extends ApiDoc {
  name: string
  kind: ApiSymbolKind
  /** Path of the declaring file from the repository root. */
  source: string
  line: number
  typeParameters?: string
  /** Call signatures of a function, or of a variable that holds one. */
  signatures: ApiSignature[]
  /** Constructor signatures of a class. */
  constructors: ApiSignature[]
  members: ApiMember[]
  extends: string[]
  /** The aliased type, or the type of a variable. */
  type?: string
  /** The members of an alias that is a union. */
  variants?: string[]
  /** Specifiers of every entry point that exports the symbol, the first being its home. */
  entries: string[]
}

export interface ApiEntry {
  /** What a consumer imports, such as `forges/kit`. */
  specifier: string
  symbols: ApiSymbol[]
}

export interface ApiModel {
  entries: ApiEntry[]
}
