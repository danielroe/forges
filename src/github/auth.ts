import type { FetchLike } from '../fetch.ts'
import type { InstallationToken } from '../model.ts'
import type { AnonymousAuth, AppAuth, TokenAuth } from '../provider.ts'
import type { GitHubInstallationToken } from './types.ts'
import { signRs256Jwt } from '../crypto.ts'
import { createFetcher } from '../fetch.ts'
import { resolveToken } from '../utils.ts'

/** The credentials GitHub accepts: a token, a GitHub App, or none for anonymous reads. */
export type GitHubAuth = TokenAuth | AppAuth | AnonymousAuth

export interface AuthContext {
  baseUrl: string
  fetch?: FetchLike
  timeout?: number
  headers: Record<string, string>
}

/**
 * App-level credential state, shared with the per-installation providers
 * derived from it so the JWT and each installation token are minted once.
 */
export interface AppCredentials {
  appJwt: () => Promise<string>
  installationToken: (installationId: string) => Promise<string>
  /** The full token response, cached alongside the token. */
  installationTokenDetails: (installationId: string) => Promise<InstallationToken>
}

const JWT_LIFETIME_SECONDS = 540
const REFRESH_MARGIN_MS = 60_000

export function createAppCredentials(auth: AppAuth, context: AuthContext): AppCredentials {
  let jwt: { value: string, expiresAt: number } | undefined
  const tokens = new Map<string, InstallationToken>()

  async function appJwt(): Promise<string> {
    if (jwt && jwt.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
      return jwt.value
    }
    const now = Math.floor(Date.now() / 1000)
    const value = await signRs256Jwt(auth.privateKey, {
      iss: String(auth.appId),
      iat: now - 60,
      exp: now + JWT_LIFETIME_SECONDS,
    })
    jwt = { value, expiresAt: (now + JWT_LIFETIME_SECONDS) * 1000 }
    return value
  }

  const fetcher = createFetcher({
    baseUrl: context.baseUrl,
    fetch: context.fetch,
    timeout: context.timeout,
    headers: context.headers,
    authHeaders: async () => ({ authorization: `Bearer ${await appJwt()}` }),
  })

  async function installationTokenDetails(installationId: string): Promise<InstallationToken> {
    const cached = tokens.get(installationId)
    if (cached && cached.expiresAt.getTime() > Date.now() + REFRESH_MARGIN_MS) {
      return cached
    }
    const { data } = await fetcher.json<GitHubInstallationToken>(
      `/app/installations/${installationId}/access_tokens`,
      { method: 'POST' },
    )
    const token: InstallationToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at),
      permissions: data.permissions ?? {},
      repositorySelection: data.repository_selection,
    }
    tokens.set(installationId, token)
    return token
  }

  return {
    appJwt,
    installationTokenDetails,
    installationToken: async installationId => (await installationTokenDetails(installationId)).token,
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
