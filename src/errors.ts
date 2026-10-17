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

/** The forge rate limited the request and a retry didn't help. Every rate limit rejects with this class, primary or secondary. */
export class RateLimitedError extends ForgeApiError {
  override name = 'RateLimitedError'
  /** When to send again: after the forge's `retry-after`, or when a used-up budget resets. Absent when the forge names neither. */
  readonly resetAt?: Date
  /**
   * Whether the forge applied a secondary limit, such as a limit on concurrent requests or on content creation,
   * rather than a used-up request budget. No remaining-request counter predicts it.
   */
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
  /** Scopes that would allow the request, any one of them, where the forge names them (GitHub's `X-Accepted-OAuth-Scopes`). */
  readonly acceptedScopes?: string[]
  /** Scopes the credential holds, where the forge reports them (GitHub's `X-OAuth-Scopes`). */
  readonly grantedScopes?: string[]
  /** Fine-grained permissions that would allow the request, verbatim, such as `issues=write` (GitHub's `X-Accepted-GitHub-Permissions`). */
  readonly acceptedPermissionsRaw?: string

  constructor(message: string, status: number, body: string, context?: ForgeErrorContext & Pick<InsufficientScopeError, 'acceptedScopes' | 'grantedScopes' | 'acceptedPermissionsRaw'>, options?: ErrorOptions) {
    super(message, status, body, context, options)
    this.acceptedScopes = context?.acceptedScopes
    this.grantedScopes = context?.grantedScopes
    this.acceptedPermissionsRaw = context?.acceptedPermissionsRaw
  }
}

/**
 * Why the forge refused a request the credential is otherwise valid for.
 * `unknown` is a 403 whose body matched nothing recognised.
 */
export type ForbiddenReason = 'org_restriction' | 'sso_required' | 'immutable_release' | 'resource_protected' | 'unknown'

/**
 * The forge refused the request for a reason other than a missing scope or a
 * rate limit: an organisation policy, an SSO requirement, a protected
 * resource, or a release the forge has marked immutable. A missing scope is
 * {@link InsufficientScopeError}, and a rate limit {@link RateLimitedError}.
 */
export class ForbiddenError extends ForgeApiError {
  override name = 'ForbiddenError'
  /** Why the forge refused the request. */
  readonly reason: ForbiddenReason
  /** The forge's own wording, for diagnostics and for reasons that have no `ForbiddenReason`. */
  readonly reasonRaw?: string
  /** Where the user authorises the credential for the organisation, when `reason` is `sso_required` and the forge links it (GitHub's `X-GitHub-SSO`). */
  readonly ssoUrl?: string

  constructor(message: string, status: number, body: string, reason: ForbiddenReason, context?: ForgeErrorContext & { reasonRaw?: string, ssoUrl?: string }, options?: ErrorOptions) {
    super(message, status, body, context, options)
    this.reason = reason
    this.reasonRaw = context?.reasonRaw
    this.ssoUrl = context?.ssoUrl
  }
}

/** Body patterns that identify a 403 reason, most specific first. */
const FORBIDDEN_PATTERNS: Array<[ForbiddenReason, RegExp]> = [
  ['org_restriction', /third[- ]party application|OAuth App access restrictions|organization has enabled OAuth|not authorized by the organization|blocked by the organization/i],
  ['sso_required', /SAML|single sign[- ]on|\bSSO\b|must be granted .* organization/i],
  ['resource_protected', /archived|read[- ]only|protected branch|repository has been disabled|is disabled/i],
  ['unknown', /contributor list is too large[^".]*/i],
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

const SECONDARY_RATE_LIMIT_RE = /secondary rate limit|abuse detection|submitted too quickly/i

/** Whether an error message names a secondary rate limit, such as GitHub's limits on concurrency and content creation. */
export function isSecondaryRateLimit(message: string): boolean {
  return SECONDARY_RATE_LIMIT_RE.test(message)
}

/** The pull request cannot be merged yet, typically because of failing or pending checks or branch protection. */
export class MergeBlockedError extends ForgeApiError {
  override name = 'MergeBlockedError'
}

/** The merge conflicts with the base branch, or the head moved since `sha` was read. */
export class MergeConflictError extends ForgeApiError {
  override name = 'MergeConflictError'
}

/** `contents.commitFiles()` was given an `expectedHead`, or `threads.updateBranch()` a `sha`, and the branch no longer points at it. */
export class BranchMovedError extends ForgeApiError {
  override name = 'BranchMovedError'
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

/** `contents.getFile` was asked for text and the file's bytes are not valid UTF-8. */
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
