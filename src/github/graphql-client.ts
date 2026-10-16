import type { Fetcher } from '../fetch.ts'
import type { BaseOptions } from '../model.ts'
import { ForgeApiError, InsufficientScopeError, isSecondaryRateLimit, RateLimitedError } from '../errors.ts'
import { rateLimitOf, rateLimitReset } from '../fetch.ts'
import { FORGE } from './normalise.ts'

type Documents = typeof import('./graphql.ts')

/** Names of the GraphQL documents in `./graphql`. */
export type DocumentName = { [K in keyof Documents]: Documents[K] extends string ? K : never }[keyof Documents]

export function graphqlUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.host === 'api.github.com') {
    return 'https://api.github.com/graphql'
  }
  return `${url.origin}${url.pathname.replace(/\/v3\/?$/, '')}/graphql`
}

interface GraphQLResponse<T> {
  data?: T
  errors?: GraphQLErrors
}

type GraphQLErrors = Array<{ message: string, type?: string }>

/**
 * A failed GraphQL response as an error: `InsufficientScopeError` when the token lacks a scope a field needs, and
 * `RateLimitedError` for a rate limit, which GitHub reports with a `200`.
 */
export function graphqlError(operationName: string | undefined, errors: GraphQLErrors | undefined, url: string, context: { instance: string }, response?: Response): ForgeApiError {
  const message = `GraphQL ${operationName ?? 'request'} failed: ${errors?.map(error => error.message).join('; ') || 'Empty GraphQL response'}`
  const body = JSON.stringify(errors ?? null).slice(0, 512)
  const errorContext = { forge: FORGE, instance: context.instance, url, method: 'POST' }
  const secondary = errors?.some(error => isSecondaryRateLimit(error.message)) ?? false
  if (secondary || errors?.some(error => error.type === 'RATE_LIMITED')) {
    const budget = response && rateLimitOf(response)
    const resetAt = response && (rateLimitReset(response, budget) ?? (secondary ? undefined : budget?.resetAt))
    return new RateLimitedError(message, 200, body, { ...errorContext, resetAt, secondary })
  }
  const scopeError = errors?.find(error => error.type === 'INSUFFICIENT_SCOPES')
  if (!scopeError) {
    return new ForgeApiError(message, 200, body, errorContext)
  }
  return new InsufficientScopeError(message, 200, body, {
    ...errorContext,
    acceptedScopes: quotedScopes(scopeError.message.match(/requires one of the following scopes: \[([^\]]*)\]/)?.[1]),
    grantedScopes: quotedScopes(scopeError.message.match(/has only been granted the: \[([^\]]*)\]/)?.[1]),
  })
}

function quotedScopes(list: string | undefined): string[] | undefined {
  return list === undefined ? undefined : [...list.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

interface GraphQLOperation {
  type: 'query' | 'mutation' | 'subscription'
  name?: string
}

const OPERATION_TYPES = new Set(['query', 'mutation', 'subscription'])

/** The operations a GraphQL document declares, read from its top level so that fields, variables, strings and comments don't count. */
export function graphqlOperations(document: string): GraphQLOperation[] {
  const operations: GraphQLOperation[] = []
  let depth = 0
  let definitionStart = true
  let awaitingName: GraphQLOperation | undefined
  for (const [token] of document.matchAll(/"""(?:\\"""|[\s\S])*?"""|"(?:\\.|[^"\\\n\r])*"|#[^\n\r]*|[{}()]|[$@]?[_a-z]\w*/gi)) {
    if (token[0] === '"' || token[0] === '#') {
      continue
    }
    if (token === '{' || token === '(') {
      if (depth === 0 && definitionStart && token === '{') {
        operations.push({ type: 'query' })
      }
      depth++
      definitionStart = false
      awaitingName = undefined
    }
    else if (token === '}' || token === ')') {
      depth--
      definitionStart = depth === 0 && token === '}'
    }
    else if (depth === 0) {
      if (awaitingName && /^[_a-z]/i.test(token)) {
        awaitingName.name = token
      }
      awaitingName = definitionStart && OPERATION_TYPES.has(token) ? { type: token as GraphQLOperation['type'] } : undefined
      if (awaitingName) {
        operations.push(awaitingName)
      }
      definitionStart = false
    }
  }
  return operations
}

/** Runs a named document from `./graphql`, or a query built at the call site. The module loads on first use. */
export type GraphQLClient = <T>(query: DocumentName | { query: string }, variables: Record<string, unknown>, options?: BaseOptions) => Promise<T>

export function createGraphQLClient(fetcher: Fetcher, url: string, context: { instance: string }): GraphQLClient {
  return async <T>(document: DocumentName | { query: string }, variables: Record<string, unknown>, options?: BaseOptions): Promise<T> => {
    const query = typeof document === 'string' ? (await import('./graphql.ts'))[document] : document.query
    const operationName = graphqlOperations(query)[0]?.name
    const { data, response } = await fetcher.json<GraphQLResponse<T>>(url, {
      method: 'POST',
      json: { query, variables, operationName },
      signal: options?.signal,
    })
    if (data.errors?.length || !data.data) {
      throw graphqlError(operationName, data.errors, url, context, response)
    }
    return data.data
  }
}
