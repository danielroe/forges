import type { ForgeProvider, Forges, ForgeWarning, RepoRef } from 'forges'
import { createForges } from 'forges'
import { providersFromEnv } from 'forges/env'

export interface InboxEnv {
  forges: Forges
  /** `FORGES_<KIND>_DEMO_REPO` entries, used where a provider has no notifications. */
  repos: RepoRef[]
  warnings: ForgeWarning[]
}

/** Builds providers from `FORGES_*` environment variables. */
export function fromEnv(env: Record<string, string | undefined>): InboxEnv {
  const providers: ForgeProvider[] = []
  const repos: RepoRef[] = []
  const warnings: ForgeWarning[] = []

  for (const entry of providersFromEnv(env)) {
    if (!entry.factory) {
      warnings.push({
        code: 'provider_skipped',
        message: `${entry.kind}${entry.suffix ? ` (${entry.suffix})` : ''}: ${entry.skipped ?? 'not configured'}`,
        subject: entry.kind,
      })
      continue
    }
    const provider = entry.factory.create()
    providers.push(provider)
    if (entry.demoRepo) {
      repos.push({
        forge: provider.kind,
        instance: provider.instance,
        owner: entry.demoRepo.owner,
        name: entry.demoRepo.name,
      })
    }
  }

  return { forges: createForges(providers), repos, warnings }
}
