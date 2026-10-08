import type { Fetcher } from '../fetch.ts'
import { ForgeApiError, InsufficientScopeError } from '../errors.ts'
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

/** A failed GraphQL response as an error: `InsufficientScopeError` when the token lacks a scope a field needs. */
export function graphqlError(operationName: string | undefined, errors: GraphQLErrors | undefined, url: string, context: { instance: string }): ForgeApiError {
  const message = errors?.map(error => error.message).join('; ') || 'Empty GraphQL response'
  const ErrorClass = errors?.some(error => error.type === 'INSUFFICIENT_SCOPES') ? InsufficientScopeError : ForgeApiError
  return new ErrorClass(`GraphQL ${operationName ?? 'request'} failed: ${message}`, 200, JSON.stringify(errors ?? null).slice(0, 512), {
    forge: FORGE,
    instance: context.instance,
    url,
    method: 'POST',
  })
}

/** Runs a named document from `./graphql`, or a query built at the call site. The module loads on first use. */
export type GraphQLClient = <T>(query: DocumentName | { query: string }, variables: Record<string, unknown>) => Promise<T>

export function createGraphQLClient(fetcher: Fetcher, url: string, context: { instance: string }): GraphQLClient {
  return async <T>(document: DocumentName | { query: string }, variables: Record<string, unknown>): Promise<T> => {
    const query = typeof document === 'string' ? (await import('./graphql.ts'))[document] : document.query
    const operationName = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1]
    const { data } = await fetcher.json<GraphQLResponse<T>>(url, {
      method: 'POST',
      json: { query, variables, operationName },
    })
    if (data.errors?.length || !data.data) {
      throw graphqlError(operationName, data.errors, url, context)
    }
    return data.data
  }
}
