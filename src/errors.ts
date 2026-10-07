import type { ForgeInstance, ForgeKind, MergeMethod } from './model.ts'

/** Where an error happened: the forge, the instance and the request. */
export interface ForgeErrorContext {
  forge?: ForgeKind
  instance?: ForgeInstance
  url?: string
  method?: string
}

/** Base class for every error that forges throws. */
export class ForgeError extends Error {
  override name = 'ForgeError'
  /** The forge that the request went to. */
  readonly forge?: ForgeKind
  readonly instance?: ForgeInstance
  readonly url?: string
  readonly method?: string

  constructor(message: string, context: ForgeErrorContext = {}, options?: ErrorOptions) {
    super(message, options)
    this.forge = context.forge
    this.instance = context.instance
    this.url = context.url
    this.method = context.method
  }
}

/** The forge responded with an error. */
export class ForgeApiError extends ForgeError {
  override name = 'ForgeApiError'
  readonly status: number
  /** Truncated response body, for diagnostics. */
  readonly body: string

  constructor(message: string, status: number, body: string, context?: ForgeErrorContext, options?: ErrorOptions) {
    super(message, context, options)
    this.status = status
    this.body = body
  }
}

/** A 404: the resource does not exist, or the credential cannot see it. Many forges respond the same way to both. */
export class NotFoundError extends ForgeApiError {
  override name = 'NotFoundError'
}

/**
 * A 401, or a 403 with a request budget of zero (GitHub GraphQL), for a request
 * sent without credentials. A rejected credential is {@link TokenRevokedError}.
 */
export class AuthenticationRequiredError extends ForgeApiError {
  override name = 'AuthenticationRequiredError'
}

/** A rate limit was hit and a retry didn't help. */
export class RateLimitedError extends ForgeApiError {
  override name = 'RateLimitedError'
  /** When the limit resets, when the forge says. */
  readonly resetAt?: Date
  /** A secondary (abuse) limit, which has no remaining-request counter. */
  readonly secondary: boolean

  constructor(
    message: string,
    status: number,
    body: string,
    options: { resetAt?: Date, secondary?: boolean } & ForgeErrorContext = {},
    errorOptions?: ErrorOptions,
  ) {
    super(message, status, body, options, errorOptions)
    this.resetAt = options.resetAt
    this.secondary = options.secondary ?? false
  }
}

/** The credential was revoked or expired. */
export class TokenRevokedError extends ForgeApiError {
  override name = 'TokenRevokedError'
}

/** The credential is valid but lacks the scope or permission for this call. */
export class InsufficientScopeError extends ForgeApiError {
  override name = 'InsufficientScopeError'
}

/**
 * Why the forge refused a request the credential is otherwise valid for.
 * `unknown` is a 403 whose body matched nothing recognised.
 */
export type ForbiddenReason = 'org_restriction' | 'sso_required' | 'rate_limit_abuse' | 'resource_protected' | 'unknown'

/**
 * The forge refused the request for a reason other than a missing scope: an
 * organisation policy, an SSO requirement, an abuse limit, or a protected
 * resource. A missing scope is {@link InsufficientScopeError}.
 */
export class ForbiddenError extends ForgeApiError {
  override name = 'ForbiddenError'
  /** Why the forge refused the request. */
  readonly reason: ForbiddenReason
  /** The forge's own wording, for diagnostics and for reasons not yet mapped. */
  readonly reasonRaw?: string

  constructor(message: string, status: number, body: string, reason: ForbiddenReason, context?: ForgeErrorContext & { reasonRaw?: string }, options?: ErrorOptions) {
    super(message, status, body, context, options)
    this.reason = reason
    this.reasonRaw = context?.reasonRaw
  }
}

/** Body patterns that identify a 403 reason, most specific first. */
const FORBIDDEN_PATTERNS: Array<[ForbiddenReason, RegExp]> = [
  ['org_restriction', /third[- ]party application|OAuth App access restrictions|organization has enabled OAuth|not authorized by the organization|blocked by the organization/i],
  ['sso_required', /SAML|single sign[- ]on|\bSSO\b|must be granted .* organization/i],
  ['rate_limit_abuse', /abuse detection|secondary rate limit/i],
  ['resource_protected', /archived|read[- ]only|protected branch|repository has been disabled|is disabled/i],
]

/**
 * Classifies a 403 body. Returns `undefined` for a body that names no policy
 * the caller could act on, which stays {@link InsufficientScopeError}.
 */
export function forbiddenReason(body: string): { reason: ForbiddenReason, reasonRaw?: string } | undefined {
  for (const [reason, pattern] of FORBIDDEN_PATTERNS) {
    const match = body.match(pattern)
    if (match) {
      return { reason, reasonRaw: match[0] }
    }
  }
  return undefined
}

/** The pull request cannot be merged yet, typically because of failing or pending checks or branch protection. */
export class MergeBlockedError extends ForgeApiError {
  override name = 'MergeBlockedError'
}

/** The merge conflicts with the base branch, or the head moved since `sha` was read. */
export class MergeConflictError extends ForgeApiError {
  override name = 'MergeConflictError'
}

/** A request or a pending merge exceeded `timeout`. */
export class ForgeTimeoutError extends ForgeError {
  override name = 'ForgeTimeoutError'
  /** The timeout that was exceeded, in milliseconds. */
  readonly timeout: number

  constructor(message: string, timeout: number, context?: ForgeErrorContext, options?: ErrorOptions) {
    super(message, context, options)
    this.timeout = timeout
  }
}

/** A subscription connection closed or failed. Resume from `cursor`. */
export class SubscriptionClosedError extends ForgeError {
  override name = 'SubscriptionClosedError'
  /** The cursor of the last event received. Pass it to `subscribe()` to resume. */
  readonly cursor?: string

  constructor(message: string, cursor: string | undefined, context?: ForgeErrorContext, options?: ErrorOptions) {
    super(message, context, options)
    this.cursor = cursor
  }
}

/** The request never got a response: DNS, TLS, connection refused or a proxy refusal. */
export class ForgeNetworkError extends ForgeError {
  override name = 'ForgeNetworkError'
}

/** A delivery's signature didn't match. */
export class WebhookVerificationError extends ForgeError {
  override name = 'WebhookVerificationError'
}

/** The forge doesn't support the operation. */
export class UnsupportedOperationError extends ForgeError {
  override name = 'UnsupportedOperationError'
}

/** A write was called on a provider constructed with `readOnly: true`. */
export class ReadOnlyError extends UnsupportedOperationError {
  override name = 'ReadOnlyError'
}

/** `contents.file` was asked for text and the file's bytes are not valid UTF-8. */
export class ContentNotTextError extends ForgeError {
  override name = 'ContentNotTextError'
}

/** A ref names a forge instance no registered provider serves. */
export class UnknownForgeError extends ForgeError {
  override name = 'UnknownForgeError'
}

/** Maps a generic merge-endpoint failure onto {@link MergeBlockedError} or {@link MergeConflictError}. */
export function toMergeError(error: unknown): unknown {
  if (!(error instanceof ForgeApiError) || error.constructor !== ForgeApiError) {
    return error
  }
  const context = { forge: error.forge, instance: error.instance, url: error.url, method: error.method }
  if (error.status === 405) {
    return new MergeBlockedError('Pull request is not mergeable yet', error.status, error.body, context, { cause: error })
  }
  if (error.status === 406 || error.status === 409) {
    return new MergeConflictError('Pull request conflicts with its base or the head has moved', error.status, error.body, context, { cause: error })
  }
  return error
}

/** The thread ref has no number, or is a kind the provider cannot address. */
export class UnresolvedThreadError extends ForgeError {
  override name = 'UnresolvedThreadError'
}

/** No merge method was given, and the repository allows several or reports none. */
export class MergeMethodRequiredError extends ForgeError {
  override name = 'MergeMethodRequiredError'
  /** The merge methods that the repository allows. */
  readonly allowed: MergeMethod[]

  constructor(allowed: MergeMethod[], context?: ForgeErrorContext, options?: ErrorOptions) {
    super(allowed.length
      ? `Repository allows ${allowed.join(', ')}; pass \`method\` to choose one`
      : 'Repository reports no merge method this provider can use; pass `method` explicitly', context, options)
    this.allowed = allowed
  }
}

/** Picks the only allowed merge method, or throws {@link MergeMethodRequiredError}. */
export function soleMergeMethod(allowed: Partial<Record<MergeMethod, boolean | undefined>>, context?: ForgeErrorContext): MergeMethod {
  const methods = (Object.keys(allowed) as MergeMethod[]).filter(method => allowed[method])
  if (methods.length !== 1) {
    throw new MergeMethodRequiredError(methods, context)
  }
  return methods[0]!
}
