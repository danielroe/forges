import type { RedeclaredSupport } from '../capabilities.ts'
import type { ProviderFactoryFunction } from '../define.ts'
import type { GitHubContext, GitHubProfile, GitHubSpec } from '../github/definition.ts'
import type { AnonymousAuth, ForgeOptionsBase, TokenAuth } from '../provider.ts'
import { redeclare } from '../capabilities.ts'
import { CAPABILITY_TABLE } from '../capability-table.ts'
import { defineForgeProvider } from '../define.ts'
import { UnsupportedOperationError } from '../errors.ts'
import { githubDefinition } from '../github/definition.ts'
import { UPSTREAM_WEB } from './web.ts'
import { UPSTREAM_NATIVE_EVENTS, UPSTREAM_WEBHOOK_EVENTS } from './webhook-events.ts'

/** The credentials Upstream accepts: a personal access token (`upt_…`), or none for public reads. */
export type UpstreamAuth = TokenAuth | AnonymousAuth

/** Options for `upstream()`. */
export interface UpstreamOptions extends ForgeOptionsBase {
  /**
   * How to authenticate. Without credentials, only public reads work.
   * @default { type: 'anonymous' }
   */
  auth?: UpstreamAuth
  /**
   * The root of the Upstream instance. `/api/v3` is appended.
   * @default 'https://upstream.codes'
   */
  baseUrl?: string
}

/** Where Upstream parts ways with GitHub: no such feature (`'not_applicable'`), or no endpoint for it in GitHub's API (`false`). */
const LEVELS: Record<string, RedeclaredSupport> = {
  'users.sponsorable': 'not_applicable',
  'users.sponsorableMany': 'not_applicable',
  'repos.issueTypes': 'not_applicable',
  'threads.setIssueType': 'not_applicable',
  'repos.milestones': 'not_applicable',
  'threads.setMilestone': 'not_applicable',
  // Upstream stores approved, changes-requested and commented reviews, but no pending ones.
  'threads.submitReview': false,
  // Upstream serves no GraphQL, which these go through.
  'threads.closingIssues': false,
  'threads.closingPullRequests': false,
  'threads.hideComment': false,
  'threads.markDuplicate': false,
  'threads.subscription': false,
  'threads.subscribe': false,
  'threads.reviewThreads': false,
  'threads.resolveReviewThread': false,
  'contents.commitFiles': false,
  // Upstream updates a change request's branch only when it mirrors a GitHub pull request.
  'threads.updateBranch': false,
  'users.events': false,
  'users.block': false,
  'orgs.block': false,
  'orgs.teams': false,
  'orgs.teamMembers': false,
  'repos.collaborators': false,
  'repos.addCollaborator': false,
  'repos.permissionFor': false,
  'repos.reviewerCandidates': false,
  'repos.contributors': false,
  'repos.contributorStats': false,
  'repos.branchRules': false,
  'threads.events': false,
  'threads.transfer': false,
  'threads.getReview': false,
  'threads.replyToReviewComment': false,
  'notifications.unsubscribe': false,
  'commits.comments': false,
  'commits.getComment': false,
  'commits.createComment': false,
  'commits.updateComment': false,
  'commits.deleteComment': false,
  'commits.hideComment': false,
  'ci.log': false,
  'ci.rerunFailed': false,
  'search.commits': false,
  // Upstream serves these, but the scratch repository has no CI run to record them with.
  'ci.getRun': 'unverified',
  'ci.jobs': 'unverified',
  'ci.getJob': 'unverified',
  'checks.get': 'unverified',
}

/** Writes Upstream serves that no recording reaches yet; anonymous providers have none. */
const UNVERIFIED_WRITES: Record<string, RedeclaredSupport> = {
  'checks.rerun': 'unverified',
  'webhooks.redeliver': 'unverified',
  // Only for all notifications: Upstream has no endpoint that marks one repository's read.
  'notifications.markAllRead': 'unverified',
}

/** Reads Upstream refuses without credentials. */
const ANONYMOUS_LEVELS: Record<string, RedeclaredSupport> = {
  'repos.assignableUsers': false,
}

/** Upstream's discussions aren't served through GitHub's API, so no verb that takes a thread kind takes that one. */
const NO_DISCUSSIONS: Record<string, RedeclaredSupport> = Object.fromEntries(CAPABILITY_TABLE.filter(entry => entry.perKind).map(entry => [
  entry.capability,
  { discussion: false },
]))

/** Swaps in the verbs that Upstream needs done its own way. */
function forUpstream(spec: GitHubSpec, { origin }: GitHubContext): GitHubSpec {
  const { notifications, search, threads } = spec
  const markAllRead = notifications?.markAllRead
  const createReview = threads.createReview
  const codePage = search?.codePage
  return {
    ...spec,
    // Upstream serves no Dependabot, code scanning or secret scanning alerts.
    securityAlerts: undefined,
    search: search && {
      ...search,
      codePage: codePage && {
        ...codePage,
        run: async (query) => {
          if (!query.repo && !/(?:^|\s)repo:/.test(query.queryRaw ?? '')) {
            throw new UnsupportedOperationError('Upstream searches code in one repository at a time, so a code search needs a `repo`', origin)
          }
          const { warnings, ...page } = await codePage.run(query)
          // Upstream sets `incomplete_results` on every code search, so it says nothing about this one.
          const kept = warnings?.filter(warning => warning.code !== 'search_incomplete')
          return kept?.length
            ? { ...page, warnings: kept }
            : page
        },
      },
    },
    threads: {
      ...threads,
      createReview: createReview && {
        ...createReview,
        run: (ref, input, options) => input.event
          ? createReview.run(ref, input, options)
          : Promise.reject(new UnsupportedOperationError('Upstream has no pending reviews, so a review needs an `event`', origin)),
      },
    },
    notifications: notifications && {
      ...notifications,
      markAllRead: markAllRead && {
        ...markAllRead,
        run: bulk => bulk?.repo
          ? Promise.reject(new UnsupportedOperationError('Upstream marks all notifications read, but not those of one repository', origin))
          : markAllRead.run(bulk),
      },
    },
  }
}

const UPSTREAM_PROFILE: GitHubProfile = {
  forge: 'upstream',
  web: UPSTREAM_WEB,
  authKinds: ['token', 'anonymous'],
  nativeEvents: UPSTREAM_NATIVE_EVENTS,
  webhookEvents: UPSTREAM_WEBHOOK_EVENTS,
  graphql: false,
  checkRuns: true,
  releasesByTag: false,
  meta: false,
  narrow: (spec, ctx) => {
    const anonymous = ctx.options.auth?.type !== 'token'
    return redeclare(redeclare(forUpstream(spec, ctx), NO_DISCUSSIONS), {
      ...LEVELS,
      ...anonymous
        ? ANONYMOUS_LEVELS
        : UNVERIFIED_WRITES,
    })
  },
}

/** Creates an Upstream provider, for upstream.codes by default, through the GitHub REST API it serves at `/api/v3`. */
export const upstream: ProviderFactoryFunction<UpstreamOptions, true, 'upstream'> = /* @__PURE__ */ defineForgeProvider(/* @__PURE__ */ githubDefinition(UPSTREAM_PROFILE))
