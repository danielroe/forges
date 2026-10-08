import type { TwoslashShikiFunction } from '@shikijs/twoslash'
import { fileURLToPath } from 'node:url'
import { createTransformerFactory, rendererRich } from '@shikijs/twoslash'
import { createHighlighter } from 'shiki'
import { createTwoslasher } from 'twoslash'
import ts from 'typescript'
import { codeTheme } from './code-theme.ts'

type Environment = NonNullable<ReturnType<ReturnType<typeof createTwoslasher>['getCacheMap']>> extends Map<string, infer T> ? T : never

const MAX_MEMBERS = 16
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function identifierAt(source: ts.SourceFile, position: number): ts.Node | undefined {
  function visit(node: ts.Node): ts.Node | undefined {
    if (position < node.getStart(source) || position >= node.getEnd()) {
      return undefined
    }
    return ts.forEachChild(node, visit) ?? (ts.isIdentifier(node) ? node : undefined)
  }
  return visit(source)
}

function isProjectType(symbol: ts.Symbol | undefined) {
  return symbol?.declarations?.some(declaration => !declaration.getSourceFile().fileName.includes('/node_modules/')) ?? false
}

/** Lists the members of a named object type declared in this repository, one level deep. */
function expandType(env: Environment, filename: string, position: number): string | undefined {
  const program = env.languageService.getProgram()
  const source = program?.getSourceFile(`${root}/${filename}`)
  const node = source && identifierAt(source, position)
  if (!program || !node) {
    return undefined
  }
  const checker = program.getTypeChecker()
  const type = checker.getTypeAtLocation(node)
  const symbol = type.aliasSymbol ?? type.getSymbol()
  const members = checker.getPropertiesOfType(type)
  if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length || !members.length || members.length > MAX_MEMBERS || !isProjectType(symbol) || symbol!.name.startsWith('__')) {
    return undefined
  }
  const lines = members.map((member) => {
    const optional = member.flags & ts.SymbolFlags.Optional ? '?' : ''
    return `  ${member.name}${optional}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(member, node))}`
  })
  return `interface ${checker.symbolToString(symbol!)} {\n${lines.join('\n')}\n}`
}

function createExpandingTwoslasher(): TwoslashShikiFunction {
  const twoslasher = createTwoslasher({
    vfsRoot: root,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: ['node'],
    },
  })

  return (code, extension, options) => {
    const expanded = new Map<number, string>()
    const result = twoslasher(code, extension, {
      ...options,
      shouldGetHoverInfo(_identifier, start, filename) {
        for (const env of twoslasher.getCacheMap()?.values() ?? []) {
          const text = expandType(env, filename, start)
          if (text) {
            expanded.set(start, text)
          }
        }
        return true
      },
    })
    for (const node of result.nodes) {
      const text = node.type === 'hover' && expanded.get(node.start)
      if (text && !node.text.includes('{')) {
        node.text = `${node.text}\n\n${text}`
      }
    }
    return result
  }
}

export async function createExampleHighlighter() {
  const highlighter = await createHighlighter({ themes: [codeTheme], langs: ['ts'] })
  const twoslash = createTransformerFactory(createExpandingTwoslasher(), rendererRich({
    processHoverDocs: docs => docs.split(/\n\s*\n/)[0]!.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replaceAll('`', ''),
    hast: {
      hoverPopup: { properties: { ariaHidden: 'true' } },
    },
  }))({})

  return {
    highlight: (code: string) => highlighter.codeToHtml(code, {
      lang: 'ts',
      theme: codeTheme,
      transformers: [twoslash],
    }).replace(/<pre[^>]*>/g, '<pre>'),
    dispose: () => highlighter.dispose(),
  }
}
