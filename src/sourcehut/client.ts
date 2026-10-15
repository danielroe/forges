import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher } from '../fetch.ts'
import type { BaseOptions } from '../model.ts'
import { ForgeApiError, InsufficientScopeError } from '../errors.ts'

/** The Sourcehut services this provider talks to. */
export const SERVICES = ['meta', 'git', 'todo', 'lists', 'builds'] as const
export type Service = typeof SERVICES[number]

/** The host of one service on an instance, such as `git.sr.ht` for `sr.ht`. */
export function serviceHost(instance: string, service: Service): string {
  return `${service}.${instance}`
}

/** The `https://` root of one service on an instance. */
export function serviceUrl(instance: string, service: Service): string {
  return `https://${serviceHost(instance, service)}`
}

/** The operation name of a GraphQL document, read from its first definition. */
export function operationNameOf(document: string): string | undefined {
  return /^\s*(?:query|mutation|subscription)\s+([_a-z]\w*)/i.exec(document)?.[1]
}

interface ShGraphQLError {
  message: string
  path?: Array<string | number>
  extensions?: { category?: string, code?: string }
}

interface ShGraphQLResponse<T> {
  data?: T
  errors?: ShGraphQLError[]
}

function graphqlError(operationName: string | undefined, errors: ShGraphQLError[], url: string, context: ForgeErrorContext): ForgeApiError {
  const message = errors.map(error => error.message).join('; ') || 'Empty GraphQL response'
  const denied = errors.some(error => /permission|scope|access denied|not authorized|must be logged in/i.test(error.message))
  return new (denied ? InsufficientScopeError : ForgeApiError)(
    `GraphQL ${operationName ?? 'request'} failed: ${message}`,
    200,
    JSON.stringify(errors).slice(0, 512),
    { ...context, url, method: 'POST' },
  )
}

/** Runs a GraphQL document against one Sourcehut service. */
export interface SourcehutGraphQL {
  service: Service
  url: string
  query: <T>(document: string, variables?: Record<string, unknown>, options?: BaseOptions) => Promise<T>
}

export function createSourcehutClient(fetcher: Fetcher, service: Service, url: string, context: ForgeErrorContext): SourcehutGraphQL {
  return {
    service,
    url,
    async query<T>(document: string, variables: Record<string, unknown> = {}, options?: BaseOptions): Promise<T> {
      const operationName = operationNameOf(document)
      const { data } = await fetcher.json<ShGraphQLResponse<T>>(url, {
        method: 'POST',
        json: { query: document, variables, operationName },
        signal: options?.signal,
      })
      if (data.errors?.length || !data.data) {
        throw graphqlError(operationName, data.errors ?? [], url, context)
      }
      return data.data
    },
  }
}
