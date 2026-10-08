import type { ApiDoc, ApiEntry, ApiMember, ApiModel, ApiParam, ApiSignature, ApiSymbol, ApiSymbolKind } from './types.ts'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export interface ExtractOptions {
  /** Repository root. Declaration paths are reported relative to it. */
  root: string
  /** Entry points as `specifier: path`, the path relative to `root`. The first entry owns a symbol that several export. */
  entries: Record<string, string>
  /** `tsconfig.json` to take compiler options from, relative to `root`. */
  tsconfig?: string
}

interface Context {
  checker: ts.TypeChecker
  root: string
  isProject: (file: ts.SourceFile) => boolean
}

const BACKTICKS_RE = /^`|`$/g
const LEADING_DASH_RE = /^-\s*/
const WHITESPACE_RE = /\s+/g
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT_RE = /(^|\s)\/\/[^\n]*/g
const CLOSING_SEMICOLON_RE = /;\s*\}/g

/** Reads the public API of every entry point: its symbols, their signatures, members and JSDoc. */
export function extractApi({ root, entries, tsconfig = 'tsconfig.json' }: ExtractOptions): ApiModel {
  const files = Object.entries(entries).map(([specifier, path]) => [specifier, resolve(root, path)] as const)
  const program = ts.createProgram(files.map(([, file]) => file), compilerOptions(root, tsconfig))
  const context: Context = {
    checker: program.getTypeChecker(),
    root,
    isProject: file => !program.isSourceFileFromExternalLibrary(file) && !program.isSourceFileDefaultLibrary(file),
  }

  const symbols = new Map<ts.Symbol, ApiSymbol>()
  const result: ApiEntry[] = []
  for (const [specifier, file] of files) {
    const sourceFile = program.getSourceFile(file)
    const module = sourceFile && context.checker.getSymbolAtLocation(sourceFile)
    if (!module) {
      throw new Error(`Entry point ${specifier} (${file}) has no exports`)
    }

    const entry: ApiEntry = { specifier, symbols: [] }
    for (const exported of context.checker.getExportsOfModule(module)) {
      const target = exported.flags & ts.SymbolFlags.Alias ? context.checker.getAliasedSymbol(exported) : exported
      let symbol = symbols.get(target)
      if (!symbol) {
        symbol = describeSymbol(context, exported.name, target)
        if (!symbol) {
          continue
        }
        symbol.entries = []
        symbols.set(target, symbol)
      }
      symbol.entries.push(specifier)
      entry.symbols.push(symbol)
    }
    entry.symbols.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line)
    result.push(entry)
  }
  return { entries: result }
}

function compilerOptions(root: string, tsconfig: string): ts.CompilerOptions {
  const path = resolve(root, tsconfig)
  const { config, error } = ts.readConfigFile(path, ts.sys.readFile)
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  }
  return { ...ts.parseJsonConfigFileContent(config, ts.sys, dirname(path)).options, noEmit: true }
}

function describeSymbol(context: Context, name: string, symbol: ts.Symbol): ApiSymbol | undefined {
  const declaration = symbol.declarations?.find(node => context.isProject(node.getSourceFile()))
  const kind = declaration && kindOf(declaration)
  if (!declaration || !kind) {
    return undefined
  }

  const { checker } = context
  const position = declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart())
  const described: ApiSymbol = {
    ...docOf(checker, symbol),
    name,
    kind,
    source: relative(context.root, declaration.getSourceFile().fileName).split(sep).join('/'),
    line: position.line + 1,
    signatures: [],
    constructors: [],
    members: [],
    extends: [],
    entries: [],
  }

  if (ts.isFunctionDeclaration(declaration)) {
    const overloads = (symbol.declarations ?? []).filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !node.body)
    const declarations = overloads.length ? overloads : [declaration]
    described.signatures = declarations.map(node => signatureOf(context, node, node.name && checker.getSymbolAtLocation(node.name)))
  }
  else if (ts.isVariableDeclaration(declaration)) {
    describeVariable(context, described, declaration, symbol)
  }
  else if (ts.isClassDeclaration(declaration)) {
    describeClass(context, described, declaration)
  }
  else if (ts.isInterfaceDeclaration(declaration)) {
    described.typeParameters = typeParametersOf(declaration)
    described.extends = (declaration.heritageClauses ?? []).flatMap(clause => clause.types.map(type => squash(type.getText())))
    described.members = membersOf(context, checker.getDeclaredTypeOfSymbol(symbol), declaration.name.text)
  }
  else if (ts.isTypeAliasDeclaration(declaration)) {
    describeAlias(context, described, declaration, symbol)
  }
  return described
}

function kindOf(declaration: ts.Declaration): ApiSymbolKind | undefined {
  if (ts.isFunctionDeclaration(declaration))
    return 'function'
  if (ts.isClassDeclaration(declaration))
    return 'class'
  if (ts.isInterfaceDeclaration(declaration))
    return 'interface'
  if (ts.isTypeAliasDeclaration(declaration))
    return 'type'
  if (ts.isVariableDeclaration(declaration))
    return 'variable'
  return undefined
}

function describeVariable(context: Context, described: ApiSymbol, declaration: ts.VariableDeclaration, symbol: ts.Symbol): void {
  const { checker } = context
  const initializer = declaration.initializer
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const calls = type.getCallSignatures()

  if (!declaration.type && initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    described.kind = 'function'
    described.signatures = [signatureOf(context, initializer, symbol)]
  }
  else if (calls.length) {
    described.kind = 'function'
    described.signatures = calls.map(call => resolvedSignatureOf(context, call, declaration, symbol))
  }
  else {
    described.type = declaration.type ? squash(declaration.type.getText()) : checker.typeToString(type)
  }
}

function describeClass(context: Context, described: ApiSymbol, declaration: ts.ClassDeclaration): void {
  const { checker } = context
  described.typeParameters = typeParametersOf(declaration)
  described.extends = (declaration.heritageClauses ?? [])
    .filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap(clause => clause.types.map(type => squash(type.getText())))

  for (const member of declaration.members) {
    if (ts.isConstructorDeclaration(member)) {
      const symbol = checker.getSymbolAtLocation(declaration.name!)
      described.constructors.push(signatureOf(context, member, symbol))
      for (const parameter of member.parameters) {
        if (ts.isIdentifier(parameter.name) && ts.getCombinedModifierFlags(parameter) & ts.ModifierFlags.Public) {
          described.members.push(memberOfParameter(context, parameter))
        }
      }
      continue
    }
    const entry = isDocumentedClassMember(member) && memberOf(context, member)
    if (entry) {
      described.members.push(entry)
    }
  }
}

function describeAlias(context: Context, described: ApiSymbol, declaration: ts.TypeAliasDeclaration, symbol: ts.Symbol): void {
  described.typeParameters = typeParametersOf(declaration)
  described.type = squash(declaration.type.getText())
  if (ts.isUnionTypeNode(declaration.type)) {
    described.variants = declaration.type.types.map(type => squash(type.getText()))
  }
  if (ts.isTypeLiteralNode(declaration.type)) {
    described.members = membersOf(context, context.checker.getDeclaredTypeOfSymbol(symbol), declaration.name.text)
  }
}

/** Public instance and static members, minus `override name = '…'` fields that only repeat the class name. */
function isDocumentedClassMember(member: ts.ClassElement): member is ts.PropertyDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration {
  if (!ts.isPropertyDeclaration(member) && !ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member)) {
    return false
  }
  const flags = ts.getCombinedModifierFlags(member)
  if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected) || ts.isPrivateIdentifier(member.name)) {
    return false
  }
  return !(flags & ts.ModifierFlags.Override && ts.isPropertyDeclaration(member) && member.initializer && ts.isStringLiteral(member.initializer))
}

/** Properties and methods of `type`, each one flattened through nested object types, from files of the project only. */
function membersOf(context: Context, type: ts.Type, owner: string, prefix = ''): ApiMember[] {
  const members: ApiMember[] = []
  for (const property of context.checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0]
    if (!declaration || !context.isProject(declaration.getSourceFile()) || !isMemberDeclaration(declaration)) {
      continue
    }

    const parent = declaration.parent
    const declaredIn = ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ? parent.name?.text : undefined
    const member = memberOf(context, declaration, prefix)
    if (declaredIn && declaredIn !== owner && !prefix) {
      member.inheritedFrom = declaredIn
    }
    members.push(member)

    const nested = ts.isPropertySignature(declaration) && declaration.type && ts.isTypeLiteralNode(declaration.type)
    if (nested) {
      member.kind = 'group'
      for (const nestedMember of membersOf(context, context.checker.getTypeOfSymbolAtLocation(property, declaration), owner, `${member.name}.`)) {
        members.push(member.inheritedFrom ? { ...nestedMember, inheritedFrom: member.inheritedFrom } : nestedMember)
      }
    }
  }
  return members
}

type MemberDeclaration = ts.PropertySignature | ts.MethodSignature | ts.PropertyDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration

function isMemberDeclaration(node: ts.Declaration): node is MemberDeclaration {
  return ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
}

function memberOf(context: Context, declaration: MemberDeclaration, prefix = ''): ApiMember {
  const { checker } = context
  const symbol = checker.getSymbolAtLocation(declaration.name)
  const flags = ts.getCombinedModifierFlags(declaration)
  const typeNode = ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration) ? undefined : declaration.type
  const base = {
    ...symbol ? docOf(checker, symbol) : emptyDoc(),
    name: `${prefix}${declaration.name.getText()}`,
    optional: 'questionToken' in declaration && !!declaration.questionToken,
    readonly: !!(flags & ts.ModifierFlags.Readonly) || ts.isGetAccessorDeclaration(declaration),
    static: !!(flags & ts.ModifierFlags.Static),
  }

  const signatureNode = ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)
    ? declaration
    : typeNode && ts.isFunctionTypeNode(typeNode) ? typeNode : undefined
  if (signatureNode) {
    return { ...base, kind: 'method', type: squash(signatureNode.getText()), signatures: [signatureOf(context, signatureNode, symbol)] }
  }

  const type = typeNode ? squash(typeNode.getText()) : checker.typeToString(checker.getTypeAtLocation(declaration))
  return {
    ...base,
    kind: 'property',
    type,
    signatures: [],
    ...typeNode && ts.isTypeReferenceNode(typeNode) && !typeNode.typeArguments ? { reference: typeNode.typeName.getText() } : {},
  }
}

function memberOfParameter(context: Context, parameter: ts.ParameterDeclaration): ApiMember {
  const { checker } = context
  const symbol = checker.getSymbolAtLocation(parameter.name)
  const flags = ts.getCombinedModifierFlags(parameter)
  return {
    ...symbol ? docOf(checker, symbol) : emptyDoc(),
    name: parameter.name.getText(),
    kind: 'property',
    type: parameter.type ? squash(parameter.type.getText()) : checker.typeToString(checker.getTypeAtLocation(parameter)),
    optional: !!parameter.questionToken,
    readonly: !!(flags & ts.ModifierFlags.Readonly),
    static: false,
    signatures: [],
  }
}

/** A signature read from its declaration, so the types stay as the author wrote them. */
function signatureOf(context: Context, node: ts.SignatureDeclaration, symbol?: ts.Symbol): ApiSignature {
  const { checker } = context
  const signature = checker.getSignatureFromDeclaration(node)
  const tags = tagsOf(checker, symbol, signature)
  const parameterDocs = parameterDescriptions(tags)

  const params = node.parameters.map((parameter): ApiParam => {
    const name = parameter.name.getText()
    return {
      name,
      type: parameter.type ? squash(parameter.type.getText()) : checker.typeToString(checker.getTypeAtLocation(parameter)),
      optional: !!parameter.questionToken || !!parameter.initializer,
      rest: !!parameter.dotDotDotToken,
      ...parameter.initializer ? { default: squash(parameter.initializer.getText()) } : {},
      description: parameterDocs.get(name) ?? '',
    }
  })

  const returnType = node.type
    ? squash(node.type.getText())
    : signature ? checker.typeToString(checker.getReturnTypeOfSignature(signature)) : 'void'
  return finishSignature(tags, params, returnType, typeParametersOf(node), signature && ownDoc(checker, signature, symbol))
}

/** A signature read from the checker, for call signatures that come from a type such as `ProviderFactoryFunction<GitHubOptions>`. */
function resolvedSignatureOf(context: Context, signature: ts.Signature, location: ts.Node, symbol: ts.Symbol): ApiSignature {
  const { checker } = context
  const tags = tagsOf(checker, symbol, signature)
  const parameterDocs = parameterDescriptions(tags)

  const params = signature.getParameters().map((parameter): ApiParam => {
    const declaration = parameter.valueDeclaration
    const optional = !!declaration && ts.isParameter(declaration) && (!!declaration.questionToken || !!declaration.initializer)
    const type = checker.getTypeOfSymbolAtLocation(parameter, location)
    return {
      name: parameter.name,
      type: checker.typeToString(optional ? checker.getNonNullableType(type) : type),
      optional,
      rest: !!declaration && ts.isParameter(declaration) && !!declaration.dotDotDotToken,
      description: parameterDocs.get(parameter.name) ?? '',
    }
  })
  return finishSignature(tags, params, checker.typeToString(checker.getReturnTypeOfSignature(signature)), undefined)
}

function finishSignature(tags: ts.JSDocTagInfo[], params: ApiParam[], returnType: string, typeParameters?: string, doc?: ApiDoc): ApiSignature {
  const returns = tags.find(tag => tag.name === 'returns' || tag.name === 'return')
  return {
    ...typeParameters ? { typeParameters } : {},
    params,
    returns: { type: returnType, description: returns ? tagText(returns) : '' },
    throws: tags.filter(tag => tag.name === 'throws').map(tagText),
    ...doc ? { doc } : {},
  }
}

function typeParametersOf(node: ts.Node & { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }): string | undefined {
  return node.typeParameters?.length ? `<${node.typeParameters.map(parameter => squash(parameter.getText())).join(', ')}>` : undefined
}

/** Tags from the signature's own comment, or from the symbol that holds it when the signature has none. */
function tagsOf(checker: ts.TypeChecker, symbol: ts.Symbol | undefined, signature: ts.Signature | undefined): ts.JSDocTagInfo[] {
  const own = signature?.getJsDocTags() ?? []
  return own.length ? own : symbol?.getJsDocTags(checker) ?? []
}

/** The comment of one overload, when it differs from the comment of the symbol. */
function ownDoc(checker: ts.TypeChecker, signature: ts.Signature, symbol?: ts.Symbol): ApiDoc | undefined {
  const description = ts.displayPartsToString(signature.getDocumentationComment(checker))
  const symbolDescription = symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)) : ''
  return description && description !== symbolDescription ? docFrom(description, signature.getJsDocTags()) : undefined
}

function parameterDescriptions(tags: ts.JSDocTagInfo[]): Map<string, string> {
  const descriptions = new Map<string, string>()
  for (const tag of tags) {
    const parts = tag.text ?? []
    const name = parts.find(part => part.kind === 'parameterName')?.text
    if (tag.name === 'param' && name) {
      descriptions.set(name, ts.displayPartsToString(parts.filter(part => part.kind !== 'parameterName')).trim().replace(LEADING_DASH_RE, ''))
    }
  }
  return descriptions
}

function docOf(checker: ts.TypeChecker, symbol: ts.Symbol): ApiDoc {
  return docFrom(ts.displayPartsToString(symbol.getDocumentationComment(checker)), symbol.getJsDocTags(checker))
}

function docFrom(description: string, tags: ts.JSDocTagInfo[]): ApiDoc {
  const deprecated = tags.find(tag => tag.name === 'deprecated')
  const defaultValue = tags.find(tag => tag.name === 'default' || tag.name === 'defaultValue')
  return {
    description: description.trim(),
    examples: tags.filter(tag => tag.name === 'example').map(tagText),
    ...deprecated ? { deprecated: tagText(deprecated) } : {},
    ...defaultValue ? { default: tagText(defaultValue).replace(BACKTICKS_RE, '') } : {},
    see: tags.filter(tag => tag.name === 'see').map(tagText),
  }
}

function emptyDoc(): ApiDoc {
  return { description: '', examples: [], see: [] }
}

function tagText(tag: ts.JSDocTagInfo): string {
  return ts.displayPartsToString(tag.text).trim()
}

/** Source text on one line, without the comments inside it. */
function squash(text: string): string {
  return text.replace(BLOCK_COMMENT_RE, '').replace(LINE_COMMENT_RE, '$1').replace(WHITESPACE_RE, ' ').replace(CLOSING_SEMICOLON_RE, ' }').trim()
}
