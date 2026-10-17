import type { FetcherOptions } from '../fetch.ts'
import type { BaseOptions, InstallationToken } from '../model.ts'
import type { AnonymousAuth, AppAuth, TokenAuth } from '../provider.ts'
import type { GitHubInstallationToken } from './types.ts'
import { signRs256Jwt } from '../crypto.ts'
import { abortable, createFetcher } from '../fetch.ts'
import { resolveToken } from '../utils.ts'

/**
 * What a GitHub token can call:
 *
 * - `classic`: a personal access token (classic) or an OAuth app token;
 * - `fine-grained`: a fine-grained personal access token;
 * - `app-user`: a GitHub App user access token;
 * - `installation`: a GitHub App installation access token, such as the `GITHUB_TOKEN` of a workflow.
 */
export type GitHubTokenKind = 'classic' | 'fine-grained' | 'app-user' | 'installation'

/** A GitHub token. */
export interface GitHubTokenAuth extends TokenAuth {
  /** What kind of token `token` is. Read from the prefix of a string `token` when omitted. */
  kind?: GitHubTokenKind
}

/** The credentials GitHub accepts: a token, a GitHub App, or none for anonymous reads. */
export type GitHubAuth = GitHubTokenAuth | AppAuth | AnonymousAuth

const TOKEN_PREFIXES: Array<[string, GitHubTokenKind]> = [['ghp_', 'classic'], ['gho_', 'classic'], ['github_pat_', 'fine-grained'], ['ghu_', 'app-user'], ['ghs_', 'installation']]

/** The kind of a GitHub token, from its `kind` or the prefix of `token`; `undefined` when neither tells. */
export function tokenKindOf(auth: GitHubTokenAuth, token: string | undefined = typeof auth.token === 'string' ? auth.token : undefined): GitHubTokenKind | undefined {
  return auth.kind ?? (token === undefined ? undefined : TOKEN_PREFIXES.find(([prefix]) => token.startsWith(prefix))?.[1])
}

export type AuthContext = Pick<FetcherOptions, 'baseUrl' | 'fetch' | 'timeout' | 'headers' | 'onRetry' | 'onRateLimit'>

/**
 * App-level credential state, shared with the per-installation providers
 * derived from it so the JWT and each installation token are minted once.
 */
export interface AppCredentials {
  appJwt: () => Promise<string>
  installationToken: (installationId: string, options?: BaseOptions) => Promise<string>
  /** The full token response, cached alongside the token. */
  installationTokenDetails: (installationId: string, options?: BaseOptions) => Promise<InstallationToken>
}

const JWT_LIFETIME_SECONDS = 540
const REFRESH_MARGIN_MS = 60_000

export function createAppCredentials(auth: AppAuth, context: AuthContext): AppCredentials {
  let jwt: { value: Promise<string>, expiresAt: number } | undefined
  const tokens = new Map<string, InstallationToken>()
  // Exchanges in flight, so concurrent requests share one.
  const exchanges = new Map<string, Promise<InstallationToken>>()

  async function appJwt(): Promise<string> {
    if (jwt && jwt.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
      return jwt.value
    }
    const now = Math.floor(Date.now() / 1000)
    const value = signRs256Jwt(auth.privateKey, {
      iss: String(auth.appId),
      iat: now - 60,
      exp: now + JWT_LIFETIME_SECONDS,
    })
    const entry = { value, expiresAt: (now + JWT_LIFETIME_SECONDS) * 1000 }
    jwt = entry
    value.catch(() => {
      if (jwt === entry) {
        jwt = undefined
      }
    })
    return value
  }

  const fetcher = createFetcher({
    ...context,
    authHeaders: async () => ({ authorization: `Bearer ${await appJwt()}` }),
  })

  async function installationTokenDetails(installationId: string, options?: BaseOptions): Promise<InstallationToken> {
    options?.signal?.throwIfAborted()
    const cached = tokens.get(installationId)
    if (cached && cached.expiresAt.getTime() > Date.now() + REFRESH_MARGIN_MS) {
      return cached
    }
    let exchange = exchanges.get(installationId)
    if (!exchange) {
      // Not bound to one caller's signal: aborting stops only that caller's wait.
      exchange = fetcher.json<GitHubInstallationToken>(
        `/app/installations/${installationId}/access_tokens`,
        { method: 'POST' },
      ).then(({ data }) => {
        const token: InstallationToken = {
          token: data.token,
          expiresAt: new Date(data.expires_at),
          permissions: data.permissions ?? {},
          repositorySelection: data.repository_selection,
        }
        tokens.set(installationId, token)
        return token
      })
      const forget = () => exchanges.delete(installationId)
      exchange.then(forget, forget)
      exchanges.set(installationId, exchange)
    }
    return abortable(exchange, options?.signal)
  }

  return {
    appJwt,
    installationTokenDetails,
    installationToken: async (installationId, options) => (await installationTokenDetails(installationId, options)).token,
  }
}

export function createAuthHeaders(
  auth: GitHubAuth | undefined,
  credentials: AppCredentials | undefined,
): () => Promise<Record<string, string>> {
  if (!auth || auth.type === 'anonymous') {
    return async () => ({})
  }
  if (auth.type === 'token') {
    return async () => ({ authorization: `Bearer ${await resolveToken(auth)}` })
  }
  const app = credentials!
  const installationId = auth.installationId
  if (installationId === undefined) {
    return async () => ({ authorization: `Bearer ${await app.appJwt()}` })
  }
  return async () => ({ authorization: `Bearer ${await app.installationToken(String(installationId))}` })
}
