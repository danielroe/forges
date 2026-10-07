import type * as Forges from '../src/index.ts'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Inline text from JSDoc. `code` spans come from backticks, `link` names the class a `{@link}` points to. */
export type ErrorText = Array<{ text: string, code?: boolean, link?: string }>

export interface ErrorField {
  name: string
  optional: boolean
  /** The type as written in the source. */
  type: string
  /** The members of a named union of literals, such as `ForbiddenReason`. */
  values?: string[]
  description?: ErrorText
}

export interface ErrorClass {
  name: string
  /** Anchor on the errors reference page. */
  id: string
  extends: string
  description: ErrorText
  /** Public properties the class declares, without inherited ones. */
  fields: ErrorField[]
  /** Names of the direct subclasses, in display order. */
  children: string[]
}

const SOURCE = fileURLToPath(new URL('../src/errors.ts', import.meta.url))

function text(parts: ts.SymbolDisplayPart[]): ErrorText {
  const segments: ErrorText = []
  for (const part of parts) {
    if (part.kind === 'linkName') {
      segments.push({ text: part.text, code: true, link: part.text })
    }
    else if (part.kind !== 'link') {
      part.text.replace(/\s+/g, ' ').split('`').forEach((chunk, index) => chunk && segments.push(index % 2 ? { text: chunk, code: true } : { text: chunk }))
    }
  }
  return segments.reduce<ErrorText>((merged, segment) => {
    const last = merged.at(-1)
    if (last && !last.code && !segment.code) {
      last.text += segment.text
    }
    else {
      merged.push({ ...segment })
    }
    return merged
  }, [])
}

function literals(checker: ts.TypeChecker, node: ts.TypeNode): string[] | undefined {
  const reference = ts.isArrayTypeNode(node) ? node.elementType : node
  if (!ts.isTypeReferenceNode(reference)) {
    return undefined
  }
  const type = checker.getTypeFromTypeNode(reference)
  const members = type.isUnion() ? type.types : [type]
  return members.every(member => member.isStringLiteral())
    ? members.map(member => `'${(member as ts.StringLiteralType).value}'`)
    : undefined
}

const HIDDEN = ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static | ts.ModifierFlags.Override

function isField(member: ts.ClassElement): member is ts.PropertyDeclaration & { name: ts.Identifier, type: ts.TypeNode } {
  return ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && !!member.type && !(ts.getCombinedModifierFlags(member) & HIDDEN)
}

/** Every error class `forges` exports, in tree order from `ForgeError`: subclasses with their own subclasses first, then source order. */
export function errorData(forges: typeof Forges): ErrorClass[] {
  const program = ts.createProgram([SOURCE], { lib: ['lib.es2022.d.ts'], types: [], module: ts.ModuleKind.NodeNext, strict: true, allowImportingTsExtensions: true, noEmit: true })
  const checker = program.getTypeChecker()
  const docs = (name: ts.Identifier) => text(checker.getSymbolAtLocation(name)!.getDocumentationComment(checker))

  const classes = new Map<string, ErrorClass>()
  for (const declaration of program.getSourceFile(SOURCE)!.statements) {
    if (!ts.isClassDeclaration(declaration) || !declaration.name || !(declaration.name.text in forges)) {
      continue
    }
    const fields = declaration.members.filter(isField).map((member) => {
      const description = docs(member.name)
      const values = literals(checker, member.type)
      return {
        name: member.name.text,
        optional: !!member.questionToken,
        type: member.type.getText(),
        ...values ? { values } : {},
        ...description.length ? { description } : {},
      }
    })
    const name = declaration.name.text
    classes.set(name, {
      name,
      id: name.toLowerCase(),
      extends: declaration.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression.getText() ?? 'Error',
      description: docs(declaration.name),
      fields,
      children: [],
    })
  }

  for (const entry of classes.values()) {
    classes.get(entry.extends)?.children.push(entry.name)
  }
  for (const entry of classes.values()) {
    entry.children.sort((a, b) => Number(!classes.get(a)!.children.length) - Number(!classes.get(b)!.children.length))
  }

  const ordered: ErrorClass[] = []
  const visit = (name: string) => {
    const entry = classes.get(name)!
    ordered.push(entry)
    entry.children.forEach(visit)
  }
  visit(forges.ForgeError.name)
  return ordered
}
