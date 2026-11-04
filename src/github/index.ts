import type { ProviderFactoryFunction } from '../define.ts'
import type { GitHubOptions, GitHubProvider } from './definition.ts'
import { defineForgeProvider } from '../define.ts'
import { GITHUB_PROFILE, githubDefinition } from './definition.ts'

export type { GitHubAuth, GitHubTokenAuth, GitHubTokenKind } from './auth.ts'
export type { GitHubGraphQL, GitHubOptions, GitHubProvider, TypedGraphQLDocument } from './definition.ts'

/** Creates a GitHub provider for github.com or a GitHub Enterprise Server instance. */
export const github: ProviderFactoryFunction<GitHubOptions, true, 'github', GitHubProvider> = /* @__PURE__ */ defineForgeProvider(/* @__PURE__ */ githubDefinition(GITHUB_PROFILE))
