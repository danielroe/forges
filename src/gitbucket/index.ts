import type { RedeclaredSupport } from '../capabilities.ts'
import type { ProviderFactoryFunction } from '../define.ts'
import type { GitHubContext, GitHubProfile, GitHubSpec } from '../github/definition.ts'
import type { AnonymousAuth, ForgeOptionsBase, TokenAuth } from '../provider.ts'
import { redeclare } from '../capabilities.ts'
import { CAPABILITY_TABLE } from '../capability-table.ts'
import { defineForgeProvider } from '../define.ts'
import { UnsupportedOperationError } from '../errors.ts'
import { githubDefinition } from '../github/definition.ts'
import { commitsPage, threadsPage } from './lists.ts'
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

/** Where GitBucket 4.48 parts ways with GitHub: no such feature (`'not_applicable'`), no endpoint for it (`false`), or no fixture yet (`'unverified'`). */
const LEVELS: Record<string, RedeclaredSupport> = {
  'users.sponsorable': 'not_applicable',
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
  // A pull request shares the issue endpoints for these, but no fixture covers that yet.
  'threads.comments': { pull_request: 'unverified' },
  'threads.getComment': { pull_request: 'unverified' },
  'threads.createComment': { pull_request: 'unverified' },
  'threads.updateComment': { pull_request: 'unverified' },
  'threads.create': { pull_request: 'unverified' },
  'threads.setLabels': { pull_request: 'unverified' },
  'threads.addLabels': { pull_request: 'unverified' },
  'threads.removeLabels': { pull_request: 'unverified' },
  // `GET /user/repos` is shadowed by `GET /user/:id`, so it answers 404.
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
  // An issue has no edit endpoint; a pull request does, and it works, but no fixture covers it yet.
  'threads.update': { issue: false, pull_request: 'unverified' },
  'threads.close': { issue: false, pull_request: 'unverified' },
  'threads.reopen': { issue: false, pull_request: 'unverified' },
  'threads.setMilestone': false,
  'threads.setAssignees': false,
  'threads.requestReview': false,
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
  const { merge, update } = threads
  return {
    ...spec,
    threads: {
      ...threads,
      listPage: { ...threads.listPage, run: threadsPage(fetcher, origin) },
      // Labels or assignees send a pull request's update to the issue endpoint, which GitBucket lacks.
      update: update && { ...update, run: (ref, input, options) => input.labels || input.assignees
        ? Promise.reject(new UnsupportedOperationError('GitBucket edits a pull request\'s title, body and state only; set labels with `setLabels()`', origin))
        : update.run(ref, input, options) },
      // GitBucket ignores the head a merge expects, so it would merge a branch that has moved.
      merge: merge && { ...merge, run: (ref, options) => options?.sha
        ? Promise.reject(new UnsupportedOperationError('GitBucket ignores the head a merge expects, so `sha` is unsupported; read the pull request first if it matters', origin))
        : merge.run(ref, options) },
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
