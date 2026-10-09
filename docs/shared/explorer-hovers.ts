import type { ApiMember, ApiModel, ApiSignature, ApiSymbol } from '../../scripts/api-docs/types.ts'
import { EXPLORER_FORGES, EXPLORER_OPERATIONS } from './explorer.ts'

/** What hovering a name in an explorer's code shows. */
export interface ExplorerHover {
  signature: string
  description?: string
}

function params(signature: ApiSignature): string {
  return signature.params.map(param => `${param.rest ? '...' : ''}${param.name}${param.optional ? '?' : ''}: ${param.type}`).join(', ')
}

/** A member of `Page<T>`, which has no JSON Schema of its own because it is generic. */
export interface ExplorerPageMember {
  name: string
  type: string
  optional: boolean
  description: string
}

/** The members of `Page<T>`, from which the explorer builds the schema of a page of results. */
export function explorerPageMembers(model: ApiModel): ExplorerPageMember[] {
  const page = model.entries.flatMap(entry => entry.symbols).find(symbol => symbol.name === 'Page')
  return (page?.members ?? []).map(({ name, type, optional, description }) => ({ name, type, optional, description }))
}

/** Names the explorer's code can hover, keyed as `explorerCode()` marks them, with their signatures and JSDoc. */
export function explorerHovers(model: ApiModel): Record<string, ExplorerHover> {
  const symbols = new Map<string, ApiSymbol>()
  for (const symbol of model.entries.flatMap(entry => entry.symbols)) {
    if (!symbols.has(symbol.name)) {
      symbols.set(symbol.name, symbol)
    }
  }
  const hovers: Record<string, ExplorerHover> = {}

  for (const { factory } of EXPLORER_FORGES) {
    const symbol = symbols.get(factory)
    const [signature] = symbol?.signatures ?? []
    if (!symbol || !signature) {
      continue
    }
    hovers[`factory:${factory}`] = { signature: `function ${factory}(${params(signature)}): ${signature.returns.type}`, description: symbol.description }
    const optionsType = signature.params[0]?.type
    for (const member of symbols.get(optionsType ?? '')?.members ?? []) {
      hovers[`option:${factory}:${member.name}`] = { signature: `(property) ${optionsType}.${member.name}${member.optional ? '?' : ''}: ${member.type}`, description: member.description }
    }
  }

  const create = symbols.get('ForgeProviderFactory')?.members.find(member => member.name === 'create')
  if (create) {
    hovers.create = { signature: '(method) ForgeProviderFactory.create(): ForgeProvider', description: create.description }
  }

  // Each method through the namespace that holds it, such as `ThreadsApi` for `provider.threads`.
  const namespaces = symbols.get('ForgeProvider')?.members ?? []
  for (const { method } of EXPLORER_OPERATIONS) {
    const [namespace, name] = method.split('.') as [string, string]
    const api = symbols.get(namespaces.find(member => member.name === namespace)?.reference ?? '')
    const member = api?.members.find(entry => entry.name === name)
    const [signature] = member?.signatures ?? []
    if (!api || !member || !signature) {
      continue
    }
    // A `...Page` method shares the description of the iterable it pages.
    const described: ApiMember | undefined = member.description ? member : api.members.find(entry => entry.name === name.replace(/Page$/, ''))
    hovers[`method:${method}`] = { signature: `(method) ${api.name}.${name}(${params(signature)}): ${signature.returns.type}`, description: described?.description }
  }

  // The types of the constants that the code declares, for `const repo: RepoRef` and the like.
  const types = new Set(['ForgeOrigin', 'RepoRef', 'ThreadRef', 'ForgeProvider', 'Page', ...EXPLORER_OPERATIONS.map(operation => operation.returns.replace(/^Page<(\w+)>$/, '$1').replace(/\[\]$/, ''))])
  for (const name of types) {
    const symbol = symbols.get(name)
    if (symbol) {
      hovers[`type:${name}`] = { signature: `${symbol.kind === 'type' ? 'type' : 'interface'} ${name}`, description: symbol.description }
    }
  }
  return hovers
}
