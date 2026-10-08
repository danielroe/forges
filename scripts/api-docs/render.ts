import type { LinkResolver } from './markdown.ts'
import type { ApiDoc, ApiMember, ApiParam, ApiSignature, ApiSymbol } from './types.ts'
import { cell, code, prose, typeCell, typeToMarkdown } from './markdown.ts'

export interface RenderContext {
  resolve: LinkResolver
  /** A sentence about the capability that a verb such as `threads.comment` belongs to. */
  capability: (verb: string) => string | undefined
  /** Writes a heading. The page records it, so that a link to `target` can point at it. */
  heading: (level: number, text: string, target?: ApiSymbol | ApiMember) => string
}

export interface MemberOptions {
  /** The `...Page` method that goes with an iterable, documented in the same section. */
  twin?: ApiMember
  /** The verb that the member backs, such as `threads.comment`. */
  verb?: string
  /** What to put before the name in the heading, such as `repos.`. */
  qualifier?: string
}

/** A symbol as a section with the heading `level`: its comment, signatures and members. */
export function renderSymbol(symbol: ApiSymbol, level: number, context: RenderContext): string {
  const callable = symbol.kind === 'function'
  const blocks = [context.heading(level, code(`${symbol.name}${callable ? '()' : ''}`), symbol), ...docBlocks(symbol, context)]

  if (callable) {
    blocks.push(...symbol.signatures.flatMap((signature, index) => renderSignature(symbol.name, signature, 'function', context, overloadLabel(index, symbol.signatures.length))))
  }
  else if (symbol.kind === 'variable' && symbol.type) {
    blocks.push(`**type:** ${typeToMarkdown(symbol.type, context.resolve)}`)
  }
  else if (symbol.kind === 'class') {
    blocks.push(...renderClassHead(symbol, context))
  }
  else {
    blocks.push(...renderTypeHead(symbol, context))
  }

  blocks.push(...renderMembers(symbol.members, context))
  return blocks.join('\n\n')
}

/** A member of a type as a section, such as a method of a namespace. */
export function renderMember(member: ApiMember, level: number, context: RenderContext, { verb, qualifier = '', twin }: MemberOptions = {}): string {
  const method = member.kind === 'method'
  const name = `${qualifier}${member.name}`
  const blocks = [context.heading(level, code(`${name}${method ? '()' : ''}`), member), ...docBlocks(member, context)]

  const capability = verb && context.capability(verb)
  if (capability) {
    blocks.push(capability)
  }

  const [first] = member.signatures
  if (method && twin && first) {
    blocks.push(...renderPair(name, member, twin, first, context))
  }
  else if (method) {
    blocks.push(...member.signatures.flatMap((signature, index) => renderSignature(name, signature, 'method', context, overloadLabel(index, member.signatures.length))))
  }
  else if (member.kind === 'property') {
    blocks.push(`**type:** ${typeToMarkdown(`${member.type}${member.optional ? ' | undefined' : ''}`, context.resolve)}`)
    if (member.default) {
      blocks.push(`**default:** ${code(member.default)}`)
    }
  }
  if (member.inheritedFrom) {
    blocks.push(`Inherited from ${typeToMarkdown(member.inheritedFrom, context.resolve)}.`)
  }
  return blocks.join('\n\n')
}

/** An iterable and its page variant in one section: both signatures, the shared parameters, and both return values. */
function renderPair(name: string, member: ApiMember, twin: ApiMember, signature: ApiSignature, context: RenderContext): string[] {
  const [twinSignature] = twin.signatures
  if (!twinSignature) {
    return member.signatures.flatMap(entry => renderSignature(name, entry, 'method', context))
  }
  const returns = [[name, signature], [`${name}Page`, twinSignature]] as const
  return [
    `\`\`\`ts\n${returns.map(([title, entry]) => signatureText(title, entry, 'method')).join('\n')}\n\`\`\``,
    ...renderParams(signature.params, context),
    ['**Returns:**', ...returns.map(([title, entry]) => `- ${code(`${title}()`)}: ${typeToMarkdown(entry.returns.type, context.resolve)}`)].join('\n'),
  ]
}

function overloadLabel(index: number, count: number): string | undefined {
  return count > 1 ? `**Overload ${index + 1} of ${count}**` : undefined
}

/** The call as written in code, such as `comment(ref: ThreadRef, body: string): Promise<Comment>`. */
export function signatureText(name: string, signature: ApiSignature, kind: 'function' | 'method' | 'constructor'): string {
  const params = signature.params.map(paramText).join(', ')
  const generics = signature.typeParameters ?? ''
  if (kind === 'constructor') {
    return `new ${name}${generics}(${params})`
  }
  return `${kind === 'function' ? 'function ' : ''}${name}${generics}(${params}): ${signature.returns.type}`
}

/** The code block, the parameters and the return value of one signature. */
function renderSignature(name: string, signature: ApiSignature, kind: 'function' | 'method' | 'constructor', context: RenderContext, label?: string): string[] {
  const blocks: string[] = []
  if (signature.doc) {
    blocks.push(...docBlocks(signature.doc, context))
  }
  blocks.push(`\`\`\`ts\n${signatureText(name, signature, kind)}\n\`\`\``)
  blocks.push(...renderParams(signature.params, context))

  if (kind !== 'constructor' && (signature.returns.type !== 'void' || signature.returns.description)) {
    const description = signature.returns.description && ` ${prose(signature.returns.description, context.resolve)}`
    blocks.push(`**Returns:** ${typeToMarkdown(signature.returns.type, context.resolve)}${description}`)
  }
  if (signature.throws.length) {
    blocks.push(['**Throws:**', ...signature.throws.map(text => `- ${prose(text, context.resolve)}`)].join('\n'))
  }
  return label ? [label, ...blocks] : blocks
}

/** The parameters as a table, with a description column when any parameter has a description or a default. */
function renderParams(params: ApiParam[], context: RenderContext): string[] {
  if (!params.length) {
    return []
  }
  const describe = (param: ApiParam) => [cell(param.description, context.resolve), param.default && `Defaults to ${code(param.default).replace(/\|/g, '\\|')}.`].filter(Boolean).join(' ')
  const described = params.some(describe)
  const rows = params.map((param) => {
    const name = code(`${param.rest ? '...' : ''}${param.name}${param.optional ? '?' : ''}`)
    const type = typeCell(param.type, context.resolve)
    return described ? `| ${name} | ${type} | ${describe(param)} |` : `| ${name} | ${type} |`
  })
  const header = described ? ['| Parameter | Type | Description |', '| --- | --- | --- |'] : ['| Parameter | Type |', '| --- | --- |']
  return [[...header, ...rows].join('\n')]
}

function paramText(param: ApiParam): string {
  const name = `${param.rest ? '...' : ''}${param.name}${param.optional && !param.default ? '?' : ''}`
  return `${name}: ${param.type}${param.default ? ` = ${param.default}` : ''}`
}

function renderClassHead(symbol: ApiSymbol, context: RenderContext): string[] {
  const blocks: string[] = []
  if (symbol.extends.length) {
    blocks.push(`**extends:** ${symbol.extends.map(name => typeToMarkdown(name, context.resolve)).join(', ')}`)
  }
  blocks.push(...symbol.constructors.flatMap((signature, index) => renderSignature(symbol.name, signature, 'constructor', context, overloadLabel(index, symbol.constructors.length))))
  return blocks
}

function renderTypeHead(symbol: ApiSymbol, context: RenderContext): string[] {
  const blocks: string[] = []
  if (symbol.typeParameters) {
    blocks.push(`**type parameters:** ${code(symbol.typeParameters.slice(1, -1))}`)
  }
  if (symbol.extends.length) {
    blocks.push(`**extends:** ${symbol.extends.map(name => typeToMarkdown(name, context.resolve)).join(', ')}`)
  }
  if (symbol.variants) {
    blocks.push(['**one of:**', ...symbol.variants.map(variant => `- ${typeToMarkdown(variant, context.resolve)}`)].join('\n'))
  }
  else if (symbol.kind === 'type' && symbol.type && !symbol.members.length) {
    blocks.push(`**type:** ${typeToMarkdown(symbol.type, context.resolve)}`)
  }
  return blocks
}

/** A table of the members, or a line for a single one. The description column is left out when no member has one. */
function renderMembers(all: ApiMember[], context: RenderContext): string[] {
  const members = all.filter(member => member.kind !== 'group' || member.description)
  if (!members.length) {
    return []
  }

  const described = members.some(member => memberDescription(member, context, true))
  const defaults = members.some(member => member.default)
  const rows = members.map((member) => {
    const name = code(`${member.name}${member.kind === 'method' ? '()' : ''}${member.optional ? '?' : ''}`)
    const type = member.kind === 'group' ? '' : typeCell(member.kind === 'method' ? memberSignature(member) : member.type, context.resolve)
    const cells = [name, type, ...defaults ? [member.default ? code(member.default).replace(/\|/g, '\\|') : ''] : [], ...described ? [memberDescription(member, context, true)] : []]
    return `| ${cells.join(' | ')} |`
  })
  const columns = ['Member', 'Type', ...defaults ? ['Default'] : [], ...described ? ['Description'] : []]
  return [[`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...rows].join('\n')]
}

function docBlocks(doc: ApiDoc, context: RenderContext): string[] {
  const blocks: string[] = []
  if (doc.deprecated !== undefined) {
    blocks.push(`**Deprecated.** ${prose(doc.deprecated, context.resolve)}`.trim())
  }
  if (doc.description) {
    blocks.push(prose(doc.description, context.resolve))
  }
  for (const example of doc.examples) {
    blocks.push(`**Example**\n\n${example.includes('```') ? example : `\`\`\`ts\n${example}\n\`\`\``}`)
  }
  if (doc.see.length) {
    blocks.push(['**See also:**', ...doc.see.map(text => `- ${prose(text, context.resolve)}`)].join('\n'))
  }
  return blocks
}

function memberDescription(member: ApiMember, context: RenderContext, inTable = false): string {
  const description = inTable ? cell(member.description, context.resolve) : prose(member.description, context.resolve)
  const inherited = member.inheritedFrom && `Inherited from ${typeToMarkdown(member.inheritedFrom, context.resolve)}.`
  return [description, inherited].filter(Boolean).join(' ')
}

/** A method's signature in one line, for a table. */
function memberSignature(member: ApiMember): string {
  const [signature] = member.signatures
  return signature ? `(${signature.params.map(paramText).join(', ')}) => ${signature.returns.type}` : member.type
}
