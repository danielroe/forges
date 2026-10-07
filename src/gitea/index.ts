import type { ProviderFactoryFunction } from '../define.ts'
import type { ForgejoOptions, ForgejoProfile } from '../forgejo/index.ts'
import { defineForgeProvider } from '../define.ts'
import { forgejoDefinition } from '../forgejo/index.ts'
import { GITEA_HEADERS } from '../forgejo/webhook-events.ts'
import { forgejoWebhooks } from '../forgejo/webhooks.ts'

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

const GITEA = /* @__PURE__ */ forgejoDefinition(GITEA_PROFILE)

/** Creates a Gitea provider for gitea.com or any self-hosted Gitea instance. */
export const gitea: ProviderFactoryFunction<GiteaOptions> = /* @__PURE__ */ defineForgeProvider({ ...GITEA, webhooks: forgejoWebhooks(GITEA_PROFILE) })

/** `gitea()` without webhook ingestion, for bundles that never receive a delivery. */
export const giteaLite: ProviderFactoryFunction<GiteaOptions> = /* @__PURE__ */ defineForgeProvider(GITEA)
