import type { RedeclaredSupport } from '../capabilities.ts'
import type { ProviderFactoryFunction } from '../define.ts'
import type { GitHubContext, GitHubProfile, GitHubSpec } from '../github/definition.ts'
import type { AnonymousAuth, ForgeOptionsBase, TokenAuth } from '../provider.ts'
import { redeclare } from '../capabilities.ts'
import { CAPABILITY_TABLE } from '../capability-table.ts'
import { defineForgeProvider } from '../define.ts'
import { UnsupportedOperationError } from '../errors.ts'
import { githubDefinition } from '../github/definition.ts'
import { labelWrites } from './labels.ts'
import { commitsPage, threadsPage } from './lists.ts'
import { mergePull } from './merge.ts'
import { GITBUCKET_WEB } from './web.ts'
import { GITBUCKET_NATIVE_EVENTS, GITBUCKET_WEBHOOK_EVENTS } from './webhook-events.ts'

/** The credentials GitBucket accepts: a personal access token, or none for anonymous reads. */
export type GitBucketAuth = TokenAuth | AnonymousAuth

/** Options for `gitbucket()`. */
export interface GitBucketOptions extends ForgeOptionsBase {
  /**
   * How to authenticate. Without credentials, only public reads work.
   * @default { type: 'anonymous' }
   */
  auth?: GitBucketAuth
  /** The root of your GitBucket server, such as `https://gitbucket.example.com`. `/api/v3` is appended. */
  baseUrl: string
}

/** Where GitBucket 4.48 parts ways with GitHub: no such feature (`'not_applicable'`), no endpoint for it (`false`), or verified where GitHub's is not (`true`). */
const LEVELS: Record<string, RedeclaredSupport> = {
  'users.sponsorable': 'not_applicable',
  'users.sponsorableMany': 'not_applicable',
  'users.block': 'not_applicable',
  'orgs.block': 'not_applicable',
  'orgs.teams': 'not_applicable',
  'orgs.teamMembers': 'not_applicable',
  'repos.issueTypes': 'not_applicable',
  'threads.setIssueType': 'not_applicable',
  'threads.reactions': 'not_applicable',
  'threads.react': 'not_applicable',
  'threads.lock': 'not_applicable',
  'threads.transfer': 'not_applicable',
  'threads.markDuplicate': 'not_applicable',
  'threads.hideComment': 'not_applicable',
  'commits.hideComment': 'not_applicable',
  'checks.get': 'not_applicable',
  'checks.rerun': 'not_applicable',
  'ci.runs': 'not_applicable',
  'ci.getRun': 'not_applicable',
  'ci.jobs': 'not_applicable',
  'ci.getJob': 'not_applicable',
  'ci.log': 'not_applicable',
  'ci.rerunFailed': 'not_applicable',
  'securityAlerts.list': 'not_applicable',
  'threads.requestReview': 'not_applicable',
  'repos.reviewerCandidates': 'not_applicable',
  'threads.getComment': { issue: true },
  // `GET /user/repos` is shadowed by `GET /user/:id`, so it responds with a 404.
  'repos.list': false,
  // Collaborators come back without a role, and the roles GitHub has beyond read, write and admin fail with a 500.
  'repos.collaborators': false,
  'repos.addCollaborator': false,
  'repos.contributors': false,
  'repos.contributorStats': false,
  'repos.permissionFor': false,
  'repos.branchRules': false,
  'repos.assignableUsers': false,
  'repos.events': false,
  'users.events': false,
  'threads.closingIssues': false,
  'threads.closingPullRequests': false,
  'threads.events': false,
  // The deletion goes through, but the response carries the comment id as its status code.
  'threads.deleteComment': false,
  // An issue has no edit endpoint; a pull request does.
  'threads.update': { issue: false },
  'threads.close': { issue: false },
  'threads.reopen': { issue: false },
  'threads.setMilestone': false,
  'threads.setAssignees': false,
  'threads.updateBranch': false,
  'threads.subscription': false,
  'threads.files': false,
  'threads.reviews': false,
  'threads.getReview': false,
  'threads.createReview': false,
  'threads.submitReview': false,
  'threads.replyToReviewComment': false,
  'threads.reviewThreads': false,
  'threads.resolveReviewThread': false,
  'notifications.list': false,
  'notifications.markRead': false,
  'notifications.markDone': false,
  'notifications.unsubscribe': false,
  'notifications.markAllRead': false,
  'notifications.markAllDone': false,
  'notifications.unreadCount': false,
  'contents.tree': false,
  'contents.compare': false,
  'contents.commitFiles': false,
  'commits.comments': false,
  'commits.getComment': false,
  'commits.createComment': false,
  'commits.updateComment': false,
  'commits.deleteComment': false,
  // A release is created without its tag, and draft, prerelease and the target are dropped; an update needs the whole release.
  'releases.create': false,
  'releases.update': false,
  'releases.downloadAsset': false,
  // An update needs the whole hook, while the provider sends only what changes.
  'webhooks.update': false,
  'webhooks.rotateSecret': false,
  'webhooks.deliveries': false,
  'webhooks.redeliver': false,
  'search.threads': false,
  'search.repos': false,
  'search.commits': false,
  'search.code': false,
}

/** GitBucket has no discussions, so no verb that takes a thread kind takes that one. */
const NO_DISCUSSIONS: Record<string, RedeclaredSupport> = Object.fromEntries(CAPABILITY_TABLE.filter(entry => entry.perKind).map(entry => [entry.capability, { discussion: 'not_applicable' }]))

/** Swaps in the verbs that GitBucket needs done its own way. */
function forGitBucket(spec: GitHubSpec, { fetcher, origin }: GitHubContext): GitHubSpec {
  const { threads, commits } = spec
  const { merge, create, update, setLabels, addLabels, removeLabels } = threads
  const labels = labelWrites(fetcher, origin)
  return {
    ...spec,
    threads: {
      ...threads,
      listPage: { ...threads.listPage, run: threadsPage(fetcher, origin) },
      listFilters: ['mentions', 'milestone'],
      setLabels: setLabels && { ...setLabels, run: labels.setLabels },
      addLabels: addLabels && { ...addLabels, run: labels.addLabels },
      removeLabels: removeLabels && { ...removeLabels, run: labels.removeLabels },
      // Labels or assignees on a pull request go through the issue edit endpoint, which GitBucket lacks.
      create: create && { ...create, run: (repo, input, options) => input.kind === 'pull_request' && (input.labels?.length || input.assignees?.length)
        ? Promise.reject(new UnsupportedOperationError('GitBucket opens a pull request without labels or assignees; set labels with `setLabels()` once it is open', origin))
        : create.run(repo, input, options) },
      update: update && { ...update, run: (ref, input, options) => input.labels || input.assignees
        ? Promise.reject(new UnsupportedOperationError('GitBucket edits a pull request\'s title, body and state only; set labels with `setLabels()`', origin))
        : update.run(ref, input, options) },
      merge: merge && { ...merge, run: mergePull(fetcher, origin) },
    },
    commits: commits?.listPage && { ...commits, listPage: { ...commits.listPage, run: commitsPage(commits.listPage.run) } },
  }
}

const GITBUCKET_PROFILE: GitHubProfile = {
  forge: 'gitbucket',
  web: GITBUCKET_WEB,
  authKinds: ['token', 'anonymous'],
  nativeEvents: GITBUCKET_NATIVE_EVENTS,
  webhookEvents: GITBUCKET_WEBHOOK_EVENTS,
  graphql: false,
  checkRuns: false,
  releasesByTag: true,
  meta: false,
  narrow: (spec, ctx) => redeclare(redeclare(forGitBucket(spec, ctx), NO_DISCUSSIONS), LEVELS),
}

/** Creates a GitBucket provider for a self-hosted GitBucket server, through the part of GitHub's REST API that it serves. */
export const gitbucket: ProviderFactoryFunction<GitBucketOptions, true, 'gitbucket'> = /* @__PURE__ */ defineForgeProvider(/* @__PURE__ */ githubDefinition(GITBUCKET_PROFILE))
