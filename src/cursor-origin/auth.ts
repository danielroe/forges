import type { Fetcher } from '../fetch.ts'
import type { InstallationToken } from '../model.ts'
import type { AppAuth, TokenAuth } from '../provider.ts'
import { signEdDsaJwt } from '../crypto.ts'

/**
 * A user access token (what the Origin CLI sends, for example
 * `CURSOR_AUTH_TOKEN`), or an Origin App: its id and Ed25519 PKCS#8 private
 * key, optionally scoped to one installation. Personal Cursor API keys are
 * not Origin bearer tokens.
 */
export type CursorOriginAuth = TokenAuth | AppAuth

export interface OriginAppCredentials {
  appJwt: () => Promise<string>
  installationTokenDetails: (installationId: string, options?: { signal?: AbortSignal }) => Promise<InstallationToken>
  installationToken: (installationId: string, options?: { signal?: AbortSignal }) => Promise<string>
}

/** Origin caps installation tokens at the lifetime of the JWT that minted them. */
const JWT_LIFETIME_SECONDS = 300
const REFRESH_MARGIN_MS = 60_000

export function createOriginAppCredentials(auth: AppAuth, createFetcher: (authHeaders: () => Promise<Record<string, string>>) => Fetcher): OriginAppCredentials {
  let jwt: { value: string, expiresAt: number } | undefined
  const tokens = new Map<string, InstallationToken>()
  const appId = String(auth.appId)

  async function appJwt(): Promise<string> {
    if (jwt && jwt.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
      return jwt.value
    }
    const now = Math.floor(Date.now() / 1000)
    const value = await signEdDsaJwt(auth.privateKey, { iss: appId, aud: 'origin-apps', iat: now, exp: now + JWT_LIFETIME_SECONDS }, appId)
    jwt = { value, expiresAt: (now + JWT_LIFETIME_SECONDS) * 1000 }
    return value
  }

  const fetcher = createFetcher(async () => ({ authorization: `Bearer ${await appJwt()}` }))

  async function installationTokenDetails(installationId: string, options?: { signal?: AbortSignal }): Promise<InstallationToken> {
    const cached = tokens.get(installationId)
    if (cached && cached.expiresAt.getTime() > Date.now() + REFRESH_MARGIN_MS) {
      return cached
    }
    const { data } = await fetcher.json<{ token: string, expiresAt: string }>(`/app/installations/${installationId}/access_tokens`, { method: 'POST', json: {}, signal: options?.signal })
    const token: InstallationToken = { token: data.token, expiresAt: new Date(data.expiresAt), permissions: {} }
    tokens.set(installationId, token)
    return token
  }

  return {
    appJwt,
    installationTokenDetails,
    installationToken: async (installationId, options) => (await installationTokenDetails(installationId, options)).token,
  }
}
