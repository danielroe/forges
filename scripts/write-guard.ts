import type { FetchLike } from '../src/fetch.ts'
import type { RepoRef } from '../src/model.ts'

export interface GuardOptions {
  /** URL prefixes writes may target. Read on every request, so entries added later count. */
  scope: string[]
  /** Allows a write outside `scope`, judged by its URL and JSON body. */
  allows?: (url: string, body: unknown) => boolean
  /** Further URL prefixes this credential may write to, such as the bot account's own notifications. */
  account?: string[]
  /** The repositories a GraphQL request may name by owner and name. */
  repos: RepoRef[]
}

function parse(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  }
  catch {
    return undefined
  }
}

function within(url: string, prefixes: string[]): boolean {
  return prefixes.some(prefix => url === prefix || url.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || url.startsWith(`${prefix}?`))
}

/** Every string that is an id: under a key naming one (`id`, `labelIds`), or shaped like a GitHub node id. */
function ids(value: unknown, key = ''): string[] {
  if (typeof value === 'string') {
    return /ids?$/i.test(key) || /^[A-Z][A-Z_]{0,5}_[\w-]{8,}$/i.test(value) || /^MD[A-Z0-9+/]{8,}={0,2}$/i.test(value) ? [value] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => ids(item, key))
  }
  return value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => ids(item, name)) : []
}

function strings(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    into.add(value)
  }
  else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => strings(item, into))
  }
}

/**
 * Wraps `fetch` so that it refuses, before sending, any write outside the
 * scratch repository. REST writes must target a URL in `scope`. A GraphQL
 * mutation may only name ids that an earlier response from the scratch
 * repository returned, and a GraphQL read may only name the scratch
 * repositories, so ids from anywhere else never become writable.
 */
export function guardedFetch(fetch: FetchLike, options: GuardOptions): FetchLike {
  const seen = new Set<string>()
  const scoped = (variables: Record<string, unknown>) => 'owner' in variables || 'name' in variables
  const named = (variables: Record<string, unknown>) => options.repos.some(repo => variables.owner === repo.owner && variables.name === repo.name)
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = parse(typeof init?.body === 'string' ? init.body : undefined)
    const graphql = new URL(input).pathname.endsWith('/graphql')
    let trusted = within(input, options.scope)
    if (graphql) {
      const { query = '', variables = {}, operationName } = (body ?? {}) as { query?: string, variables?: Record<string, unknown>, operationName?: string }
      const namedIds = ids(variables)
      const known = namedIds.every(id => seen.has(id))
      if (/^\s*mutation\b/.test(query) && (!known || !namedIds.length)) {
        throw new Error(`Refused the GraphQL mutation ${operationName ?? ''}: it names an id that did not come from the scratch repository`)
      }
      // A query that names neither a repository nor an id is not tied to the scratch repository, so its ids stay untrusted.
      trusted = known && (scoped(variables) ? named(variables) : namedIds.length > 0)
    }
    else if (method !== 'GET' && method !== 'HEAD' && !trusted && !within(input, options.account ?? [])) {
      if (!options.allows?.(input, body)) {
        throw new Error(`Refused ${method} ${input}: write recordings only write to the scratch repository`)
      }
      trusted = true
    }
    const response = await fetch(input, init)
    if (trusted) {
      strings(parse(await response.clone().text()), seen)
    }
    return response
  }
}
