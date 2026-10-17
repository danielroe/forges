import type { ProviderFactoryFunction } from '../define.ts'
import type { ForgejoOptions, ForgejoProfile } from '../forgejo/index.ts'
import { defineForgeProvider } from '../define.ts'
import { forgejoDefinition } from '../forgejo/index.ts'
import { GITEA_HEADERS } from '../forgejo/webhook-events.ts'

/** Options for `gitea()`, the same as for `forgejo()`. */
export type GiteaOptions = ForgejoOptions

/**
 * Gitea shares Forgejo's REST API. It differs in its default instance, its
 * webhook headers (`X-Gitea-*` only) and its capability profile.
 */
export const GITEA_PROFILE: ForgejoProfile = {
  forge: 'gitea',
  defaultBaseUrl: 'https://gitea.com',
  headers: GITEA_HEADERS,
}

/** Creates a Gitea provider for gitea.com or any self-hosted Gitea instance. */
export const gitea: ProviderFactoryFunction<GiteaOptions, true, 'gitea'> = /* @__PURE__ */ defineForgeProvider(/* @__PURE__ */ forgejoDefinition(GITEA_PROFILE))
