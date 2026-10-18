/**
 * The web links of each forge without its API client: building and reading
 * web URLs, and writing and reading references. Each factory takes the
 * `baseUrl` and `instance` its provider takes.
 */
import type { ForgeWeb, WebForges, WebOptions } from '../web.ts'
import { AZURE_DEVOPS_WEB } from '../azure-devops/web.ts'
import { BITBUCKET_WEB } from '../bitbucket/web.ts'
import { FORGEJO_WEB, GITEA_WEB } from '../forgejo/web.ts'
import { GITEE_WEB } from '../gitee/web.ts'
import { GITHUB_WEB } from '../github/web.ts'
import { GITLAB_WEB } from '../gitlab/web.ts'
import { PUSHIN_WEB } from '../pushin/web.ts'
import { SOURCEHUT_WEB } from '../sourcehut/web.ts'
import { TANGLED_WEB } from '../tangled/web.ts'
import { defineForgeWeb, routeForges } from '../web.ts'

export type { ParsedForgeUrl, ParsedReference, ParseReferencesOptions, ReferenceOptions, RepoSection, RoutedForge, UrlTarget, WebOptions } from '../web.ts'
export type { ForgeWeb, WebForges }

/** The web links of Azure DevOps Services, or an Azure DevOps Server collection. */
export const azureDevOps: (options?: WebOptions) => ForgeWeb<'azure-devops'> = /* @__PURE__ */ defineForgeWeb(AZURE_DEVOPS_WEB)
/** The web links of Bitbucket Cloud. */
export const bitbucket: (options?: WebOptions) => ForgeWeb<'bitbucket'> = /* @__PURE__ */ defineForgeWeb(BITBUCKET_WEB)
/** The web links of Codeberg or another Forgejo instance. */
export const forgejo: (options?: WebOptions) => ForgeWeb<'forgejo'> = /* @__PURE__ */ defineForgeWeb(FORGEJO_WEB)
/** The web links of gitea.com or another Gitea instance. */
export const gitea: (options?: WebOptions) => ForgeWeb<'gitea'> = /* @__PURE__ */ defineForgeWeb(GITEA_WEB)
/** The web links of Gitee. */
export const gitee: (options?: WebOptions) => ForgeWeb<'gitee'> = /* @__PURE__ */ defineForgeWeb(GITEE_WEB)
/** The web links of github.com or a GitHub Enterprise instance. */
export const github: (options?: WebOptions) => ForgeWeb<'github'> = /* @__PURE__ */ defineForgeWeb(GITHUB_WEB)
/** The web links of gitlab.com or a self-managed GitLab instance. */
export const gitlab: (options?: WebOptions) => ForgeWeb<'gitlab'> = /* @__PURE__ */ defineForgeWeb(GITLAB_WEB)
/** The web links of Pushin.eu. */
export const pushin: (options?: WebOptions) => ForgeWeb<'pushin'> = /* @__PURE__ */ defineForgeWeb(PUSHIN_WEB)
/** The web links of sr.ht or another Sourcehut instance. */
export const sourcehut: (options?: WebOptions) => ForgeWeb<'sourcehut'> = /* @__PURE__ */ defineForgeWeb(SOURCEHUT_WEB)
/** The web links of Tangled. */
export const tangled: (options?: WebOptions) => ForgeWeb<'tangled'> = /* @__PURE__ */ defineForgeWeb(TANGLED_WEB)

/**
 * Combines forges into a registry that reads URLs and references on any of them.
 * @param forges Forges that the factories of `forges/web` create, or providers.
 * @example
 * ```ts
 * import { createForges, github, gitlab } from 'forges/web'
 *
 * const forges = createForges([github(), gitlab({ baseUrl: 'https://gitlab.example.com' })])
 * const parsed = forges.parseUrl('https://gitlab.example.com/acme/widgets/-/merge_requests/3')
 * ```
 */
export function createForges<const T extends ForgeWeb>(forges: readonly T[]): WebForges<T> {
  return routeForges(forges)
}
