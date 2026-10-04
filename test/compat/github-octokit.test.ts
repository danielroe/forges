import type { RestEndpointMethodTypes } from '@octokit/rest'
import type {
  GitHubCheckRun,
  GitHubCodeScanningAlert,
  GitHubCollaborator,
  GitHubCombinedStatus,
  GitHubComment,
  GitHubCommitStatus,
  GitHubDependabotAlert,
  GitHubInstallation,
  GitHubInstallationToken,
  GitHubIssue,
  GitHubLabel,
  GitHubMilestone,
  GitHubNotification,
  GitHubReaction,
  GitHubReactions,
  GitHubRelease,
  GitHubRepository,
  GitHubRepositoryDetail,
  GitHubSecretScanningAlert,
  GitHubTimelineEntry,
  GitHubUser,
} from '../../src/github/types.ts'
import type { ResolvedThreadRef } from '../../src/model.ts'
import type { ForgeProvider } from '../../src/provider.ts'
import type { FixtureCall } from '../utils/fixtures.ts'
import { generateKeyPairSync } from 'node:crypto'
import { Octokit } from '@octokit/rest'
import { describe, expect, it } from 'vitest'
import { ForgeTimeoutError } from '../../src/errors.ts'
import { github } from '../../src/github/index.ts'
import { fixtureFetch } from '../utils/fixtures.ts'

const TOKEN = 'ghp_compatsuitetoken'
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const repo = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' } as const

const pull: ResolvedThreadRef = { forge: 'github', instance: 'github.com', repo, kind: 'pull_request', number: '42' }
const notification = { forge: 'github', instance: 'github.com', id: '901234567' } as const

interface Comparable {
  method: string
  path: string
  query: Array<[string, string]>
  body: unknown
  ifNoneMatch: string | null
}

/** Reduces a request to what GitHub acts on. Header policy is compared separately. */
function comparable(call: FixtureCall): Comparable {
  const url = new URL(call.url)
  return {
    method: call.method,
    path: url.pathname,
    query: [...url.searchParams].sort(([a], [b]) => a.localeCompare(b)),
    body: call.body ? JSON.parse(call.body) : undefined,
    ifNoneMatch: call.headers.get('if-none-match'),
  }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const item of iterable) {
    items.push(item)
  }
  return items
}

function harness() {
  const ours = fixtureFetch('github')
  const theirs = fixtureFetch('github')
  return {
    provider: github({ auth: { type: 'token', token: TOKEN }, fetch: ours.fetch }).create(),
    octokit: new Octokit({ auth: TOKEN, request: { fetch: theirs.fetch } }),
    ours: ours.calls,
    theirs: theirs.calls,
  }
}

async function compare(
  run: (provider: ForgeProvider) => Promise<unknown>,
  reference: (octokit: Octokit) => Promise<unknown>,
): Promise<{ ours: FixtureCall[], theirs: FixtureCall[] }> {
  const h = harness()
  await run(h.provider)
  await reference(h.octokit)
  expect(h.ours.map(comparable)).toEqual(h.theirs.map(comparable))
  return { ours: h.ours, theirs: h.theirs }
}

const owner = 'acme'
const name = 'widgets'

describe('request compatibility with Octokit', () => {
  it('lists notifications across every page, without a conditional header on later pages', async () => {
    const h = harness()
    await drain(h.provider.notifications!.list({ cursor: { etag: 'W/"stale"' } }))
    await h.octokit.paginate(h.octokit.rest.activity.listNotificationsForAuthenticatedUser, { all: false })
    const rest = h.ours.filter(call => !call.url.endsWith('/graphql'))

    expect(rest.map(call => ({ ...comparable(call), ifNoneMatch: null }))).toEqual(h.theirs.map(comparable))
    expect(rest.map(call => call.headers.get('if-none-match'))).toEqual(['W/"stale"', null])
  })

  it('sends If-None-Match for a conditional notifications poll', async () => {
    const etag = 'W/"e1a7c5f0c0de4f0b9d6b5d2b0a1f3c21"'
    await compare(
      provider => provider.notifications!.listPage({ cursor: { etag } }).catch(() => undefined),
      octokit => octokit.rest.activity.listNotificationsForAuthenticatedUser({ all: false, headers: { 'if-none-match': etag } }).catch(() => undefined),
    )
  })

  it('marks a thread read', async () => {
    await compare(
      provider => provider.notifications!.markRead!(notification),
      octokit => octokit.rest.activity.markThreadAsRead({ thread_id: 901234567 }),
    )
  })

  it('marks a thread done with DELETE on the thread', async () => {
    await compare(
      provider => provider.notifications!.markDone!(notification),
      octokit => octokit.rest.activity.markThreadAsDone({ thread_id: 901234567 }),
    )
  })

  it('unsubscribes by deleting the thread subscription', async () => {
    await compare(
      provider => provider.notifications!.unsubscribe!(notification),
      octokit => octokit.rest.activity.deleteThreadSubscription({ thread_id: 901234567 }),
    )
  })

  it('gets a pull request with its check runs and combined status', async () => {
    await compare(
      provider => provider.threads.get(pull),
      async (octokit) => {
        const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: 42 })
        await octokit.rest.checks.listForRef({ owner, repo: name, ref: data.head.sha, per_page: 100 })
        await octokit.rest.repos.getCombinedStatusForRef({ owner, repo: name, ref: data.head.sha, per_page: 100 })
      },
    )
  })

  it('lists the checks on a pull request', async () => {
    await compare(
      provider => provider.threads.checks!(pull),
      async (octokit) => {
        const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: 42 })
        await octokit.rest.checks.listForRef({ owner, repo: name, ref: data.head.sha, per_page: 100 })
        await octokit.rest.repos.getCombinedStatusForRef({ owner, repo: name, ref: data.head.sha, per_page: 100 })
      },
    )
  })

  it('lists, gets and reads the latest release', async () => {
    await compare(
      async (provider) => {
        await provider.releases!.listPage(repo)
        await provider.releases!.get({ forge: 'github', instance: 'github.com', repo, id: '9001' })
        await provider.releases!.latest(repo)
      },
      async (octokit) => {
        await octokit.rest.repos.listReleases({ owner, repo: name })
        await octokit.rest.repos.getRelease({ owner, repo: name, release_id: 9001 })
        await octokit.rest.repos.getLatestRelease({ owner, repo: name })
      },
    )
  })

  it('lists open Dependabot, code scanning and secret scanning alerts', async () => {
    await compare(
      provider => drain(provider.securityAlerts!.list(repo)),
      async (octokit) => {
        await octokit.rest.dependabot.listAlertsForRepo({ owner, repo: name, state: 'open' })
        await octokit.rest.codeScanning.listAlertsForRepo({ owner, repo: name, state: 'open' })
        await octokit.rest.secretScanning.listAlertsForRepo({ owner, repo: name, state: 'open' })
      },
    )
  })

  it('lists timeline events across every page', async () => {
    await compare(
      provider => drain(provider.threads.events(pull)),
      octokit => octokit.paginate(octokit.rest.issues.listEventsForTimeline, { owner, repo: name, issue_number: 42 }),
    )
  })

  it('comments on a pull request through the issues API', async () => {
    await compare(
      provider => provider.threads.comment!(pull, 'Thanks!'),
      octokit => octokit.rest.issues.createComment({ owner, repo: name, issue_number: 42, body: 'Thanks!' }),
    )
  })

  it('closes and reopens a pull request', async () => {
    await compare(
      async (provider) => {
        await provider.threads.close!(pull)
        await provider.threads.reopen!(pull)
      },
      async (octokit) => {
        await octokit.rest.pulls.update({ owner, repo: name, pull_number: 42, state: 'closed' })
        await octokit.rest.pulls.update({ owner, repo: name, pull_number: 42, state: 'open' })
      },
    )
  })

  it('reads the repository, approves, then merges', async () => {
    await compare(
      provider => provider.threads.approveAndMerge!(pull),
      async (octokit) => {
        await octokit.rest.repos.get({ owner, repo: name })
        await octokit.rest.pulls.createReview({ owner, repo: name, pull_number: 42, event: 'APPROVE' })
        await octokit.rest.pulls.merge({ owner, repo: name, pull_number: 42, merge_method: 'squash' })
      },
    )
  })

  it('lists reviews and their inline comments, with resolution state from GraphQL', async () => {
    const h = harness()
    await h.provider.threads.reviewsPage(pull)
    await h.octokit.rest.pulls.listReviews({ owner, repo: name, pull_number: 42 })
    await h.octokit.rest.pulls.listReviewComments({ owner, repo: name, pull_number: 42, per_page: 100 })
    const rest = h.ours.filter(call => !call.url.endsWith('/graphql'))

    expect(rest.map(comparable)).toEqual(h.theirs.map(comparable))
    expect(h.ours.at(-1)!.operationName).toBe('ReviewThreads')
  })

  it('creates and submits a review', async () => {
    await compare(
      async (provider) => {
        const review = await provider.threads.createReview(pull, { body: 'nit' })
        await provider.threads.submitReview(review.ref, 'approve', 'LGTM')
      },
      async (octokit) => {
        await octokit.rest.pulls.createReview({ owner, repo: name, pull_number: 42, body: 'nit' })
        await octokit.rest.pulls.submitReview({ owner, repo: name, pull_number: 42, review_id: 880099, event: 'APPROVE', body: 'LGTM' })
      },
    )
  })

  it('writes a commit status and re-requests a check run', async () => {
    const sha = '6dcb09b5b57875f334f61aebed695e2e4193db5e'
    await compare(
      async (provider) => {
        await provider.checks.report(repo, sha, { name: 'forges/coverage', state: 'success', description: '84%', url: 'https://ci.example/run/1' })
        await provider.checks.rerun({ forge: 'github', instance: 'github.com', repo, id: '4002', type: 'check_run' })
      },
      async (octokit) => {
        await octokit.rest.repos.createCommitStatus({ owner, repo: name, sha, state: 'success', context: 'forges/coverage', description: '84%', target_url: 'https://ci.example/run/1' })
        await octokit.rest.checks.rerequestRun({ owner, repo: name, check_run_id: 4002 })
      },
    )
  })

  it('reads workflow runs, jobs and a job log', async () => {
    await compare(
      async (provider) => {
        const { items } = await provider.ci.runsPage(repo)
        await provider.ci.jobsPage(items[0]!.ref)
        await provider.ci.log({ forge: 'github', instance: 'github.com', repo, id: '4002' })
      },
      async (octokit) => {
        await octokit.rest.actions.listWorkflowRunsForRepo({ owner, repo: name })
        await octokit.rest.actions.listJobsForWorkflowRun({ owner, repo: name, run_id: 77 })
        await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo: name, job_id: 4002 })
      },
    )
  })

  it('manages webhooks and their deliveries', async () => {
    const hook = { forge: 'github', instance: 'github.com', target: repo, id: '12345678' } as const
    await compare(
      async (provider) => {
        await provider.webhooks.listPage(repo)
        await provider.webhooks.create(repo, { url: 'https://hooks.example/forges', events: ['state_change', 'push'], secret: 's3cret' })
        await provider.webhooks.update(hook, { active: false, nativeEvents: ['push'] })
        await provider.webhooks.deliveriesPage(hook)
        await provider.webhooks.redeliver({ forge: 'github', instance: 'github.com', hook, id: '55001' })
        await provider.webhooks.delete(hook)
      },
      async (octokit) => {
        await octokit.rest.repos.listWebhooks({ owner, repo: name })
        await octokit.rest.repos.createWebhook({
          owner,
          repo: name,
          name: 'web',
          active: true,
          events: ['issues', 'pull_request', 'discussion', 'push'],
          config: { url: 'https://hooks.example/forges', content_type: 'json', secret: 's3cret' },
        })
        await octokit.rest.repos.updateWebhook({ owner, repo: name, hook_id: 12345678, active: false, events: ['push'] })
        await octokit.rest.repos.listWebhookDeliveries({ owner, repo: name, hook_id: 12345678 })
        await octokit.rest.repos.redeliverWebhookDelivery({ owner, repo: name, hook_id: 12345678, delivery_id: 55001 })
        await octokit.rest.repos.deleteWebhook({ owner, repo: name, hook_id: 12345678 })
      },
    )
  })

  it('searches issues and repositories', async () => {
    await compare(
      async (provider) => {
        await provider.search.threadsPage({ text: 'crash', repo, kind: 'issue', state: 'open', sort: 'updated', direction: 'desc' })
        await provider.search.reposPage({ text: 'widgets', owner: 'acme', sort: 'stars' })
      },
      async (octokit) => {
        await octokit.rest.search.issuesAndPullRequests({ q: 'crash repo:acme/widgets is:issue state:open', sort: 'updated', order: 'desc' })
        await octokit.rest.search.repos({ q: 'widgets user:acme', sort: 'stars' })
      },
    )
  })

  it('reads contents, trees, refs, commits and a comparison', async () => {
    const sha = '6dcb09b5b57875f334f61aebed695e2e4193db5e'
    await compare(
      async (provider) => {
        await provider.contents.file(repo, 'package.json', { ref: 'main', as: 'text' })
        await provider.contents.treePage(repo, { ref: 'main', recursive: true })
        await provider.contents.branchesPage(repo)
        await provider.contents.tagsPage(repo)
        await provider.contents.commitsPage(repo)
        await provider.contents.commit(repo, sha)
        await provider.contents.compare(repo, 'v1.0.0', 'main')
      },
      async (octokit) => {
        await octokit.rest.repos.getContent({ owner, repo: name, path: 'package.json', ref: 'main' })
        await octokit.rest.git.getTree({ owner, repo: name, tree_sha: 'main', recursive: '1' })
        await octokit.rest.repos.listBranches({ owner, repo: name })
        await octokit.rest.repos.listTags({ owner, repo: name })
        await octokit.rest.repos.listCommits({ owner, repo: name })
        await octokit.rest.repos.getCommit({ owner, repo: name, ref: sha })
        await octokit.rest.repos.compareCommits({ owner, repo: name, base: 'v1.0.0', head: 'main' })
      },
    )
  })

  it('reads a release by tag and downloads an asset', async () => {
    const h = harness()

    const release = await h.provider.releases.getByTag(repo, 'v1.2.0')
    await h.provider.releases.downloadAsset(release.assets![0]!.ref!)
    await h.octokit.rest.repos.getReleaseByTag({ owner, repo: name, tag: 'v1.2.0' })
    await h.octokit.rest.repos.getReleaseAsset({ owner, repo: name, asset_id: 7001, headers: { accept: 'application/octet-stream' } })

    // Octokit stops at the redirect; the provider follows it to the CDN itself, so only the API calls compare.
    expect(h.ours.slice(0, 2).map(comparable)).toEqual(h.theirs.map(comparable))
    expect(h.ours[2]!.url).toContain('objects.githubusercontent.com')
    expect(h.ours[2]!.headers.get('authorization')).toBeNull()
  })

  it('lists the files and commits of a pull request', async () => {
    await compare(
      async (provider) => {
        await provider.threads.filesPage(pull)
        await provider.threads.commitsPage(pull)
      },
      async (octokit) => {
        await octokit.rest.pulls.listFiles({ owner, repo: name, pull_number: 42 })
        await octokit.rest.pulls.listCommits({ owner, repo: name, pull_number: 42 })
      },
    )
  })

  it('lists the authenticated account\'s repositories', async () => {
    await compare(
      provider => drain(provider.repos.list()),
      octokit => octokit.paginate(octokit.rest.repos.listForAuthenticatedUser),
    )
  })

  it('gets a repository', async () => {
    await compare(
      provider => provider.repos.get(repo),
      octokit => octokit.rest.repos.get({ owner, repo: name }),
    )
  })

  it('lists pull requests through the issues API, as GitHub filters by label and author only there', async () => {
    const h = harness()
    await drain(h.provider.threads.list(repo, { kind: 'pull_request' }))
    await h.octokit.paginate(h.octokit.rest.issues.listForRepo, { owner, repo: name, state: 'open', sort: 'created', direction: 'desc' })
    const rest = h.ours.filter(call => !call.url.endsWith('/graphql'))

    expect(rest.map(comparable)).toEqual(h.theirs.map(comparable))
    expect(h.ours.length - rest.length).toBe(1)
  })

  it('lists, edits and deletes conversation comments', async () => {
    const commentRef = { forge: 'github', instance: 'github.com', thread: pull, id: '770001' }
    await compare(
      async (provider) => {
        await drain(provider.threads.comments(pull))
        await provider.threads.editComment!(commentRef, 'Edited')
        await provider.threads.deleteComment!(commentRef)
      },
      async (octokit) => {
        await octokit.paginate(octokit.rest.issues.listComments, { owner, repo: name, issue_number: 42 })
        await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: 770001, body: 'Edited' })
        await octokit.rest.issues.deleteComment({ owner, repo: name, comment_id: 770001 })
      },
    )
  })

  it('lists the reactions on a thread', async () => {
    await compare(
      provider => drain(provider.threads.reactions(pull)),
      octokit => octokit.paginate(octokit.rest.reactions.listForIssue, { owner, repo: name, issue_number: 42 }),
    )
  })

  it('searches commits, which has its own rate-limit pool', async () => {
    await compare(
      provider => provider.search.commitsPage({ author: 'octocat', sort: 'committer_date', direction: 'asc' }),
      octokit => octokit.rest.search.commits({ q: 'author:octocat', sort: 'committer-date', order: 'asc' }),
    )
  })

  it('creates an issue', async () => {
    await compare(
      provider => provider.threads.create!(repo, { kind: 'issue', title: 'New issue', body: 'Details' }),
      octokit => octokit.rest.issues.create({ owner, repo: name, title: 'New issue', body: 'Details' }),
    )
  })

  it('updates a pull request title', async () => {
    await compare(
      provider => provider.threads.update!(pull, { title: 'Renamed' }),
      octokit => octokit.rest.pulls.update({ owner, repo: name, pull_number: 42, title: 'Renamed' }),
    )
  })

  it('replaces labels, replaces assignees and requests reviewers', async () => {
    await compare(
      async (provider) => {
        await provider.threads.setLabels!(pull, ['bug'])
        await provider.threads.setAssignees!(pull, ['octocat'])
        await provider.threads.requestReview!(pull, ['hubot'])
      },
      async (octokit) => {
        await octokit.rest.issues.setLabels({ owner, repo: name, issue_number: 42, labels: ['bug'] })
        await octokit.rest.issues.update({ owner, repo: name, issue_number: 42, assignees: ['octocat'] })
        await octokit.rest.pulls.requestReviewers({ owner, repo: name, pull_number: 42, reviewers: ['hubot'] })
      },
    )
  })

  it('marks every notification read, globally and for one repository', async () => {
    const before = new Date('2025-09-18T00:00:00Z')
    await compare(
      async (provider) => {
        await provider.notifications!.markAllRead!({ before })
        await provider.notifications!.markAllRead!({ repo })
      },
      async (octokit) => {
        await octokit.rest.activity.markNotificationsAsRead({ last_read_at: before.toISOString() })
        await octokit.rest.activity.markRepoNotificationsAsRead({ owner, repo: name })
      },
    )
  })

  it('reads the GHES version from /meta', async () => {
    const ours = fixtureFetch('github')
    const theirs = fixtureFetch('github')
    await github({ baseUrl: 'https://ghe.example.com/api/v3', auth: { type: 'token', token: TOKEN }, fetch: ours.fetch }).create().refreshCapabilities()
    await new Octokit({ auth: TOKEN, baseUrl: 'https://ghe.example.com/api/v3', request: { fetch: theirs.fetch } }).rest.meta.get()

    expect(ours.calls.map(comparable)).toEqual(theirs.calls.map(comparable))
  })

  it('gets a repository through request()', async () => {
    await compare(
      provider => provider.request('GET', '/repos/acme/widgets'),
      octokit => octokit.rest.repos.get({ owner, repo: name }),
    )
  })

  describe('app authentication', () => {
    function appHarness(installationId?: number) {
      const ours = fixtureFetch('github')
      const theirs = fixtureFetch('github')
      const provider = github({ auth: { type: 'app', appId: 12345, privateKey, installationId }, fetch: ours.fetch }).create()
      return { provider, ours: ours.calls, theirs }
    }

    it('exchanges a JWT for an installation token', async () => {
      const { provider, ours, theirs } = appHarness(55123)
      await provider.notifications!.markRead!(notification)
      const jwt = ours[0]!.authorization!.split(' ')[1]!
      await new Octokit({ auth: jwt, request: { fetch: theirs.fetch } }).rest.apps.createInstallationAccessToken({ installation_id: 55123 })

      expect(comparable(ours[0]!)).toEqual(comparable(theirs.calls[0]!))
      expect(ours[0]!.authorization!.split(' ')[0]!.toLowerCase()).toBe(theirs.calls[0]!.authorization!.split(' ')[0])
    })

    it('gets one installation', async () => {
      const { provider, ours, theirs } = appHarness()
      await provider.installations!.get('55123')
      const jwt = ours[0]!.authorization!.split(' ')[1]!
      await new Octokit({ auth: jwt, request: { fetch: theirs.fetch } }).rest.apps.getInstallation({ installation_id: 55123 })

      expect(ours.map(comparable)).toEqual(theirs.calls.map(comparable))
    })

    it('lists installations and their repositories', async () => {
      const { provider, ours, theirs } = appHarness()
      await drain(provider.installations!.list())
      await drain(provider.installations!.repos('55123'))
      const jwt = ours[0]!.authorization!.split(' ')[1]!
      await new Octokit({ auth: jwt, request: { fetch: theirs.fetch } }).paginate(
        new Octokit({ auth: jwt, request: { fetch: theirs.fetch } }).rest.apps.listInstallations,
      )
      const tokenExchange = ours.find(call => call.url.endsWith('/access_tokens'))!
      theirs.calls.push(tokenExchange)
      await new Octokit({ auth: 'ghs_fixtureinstallationtoken', request: { fetch: theirs.fetch } }).paginate(
        new Octokit({ auth: 'ghs_fixtureinstallationtoken', request: { fetch: theirs.fetch } }).rest.apps.listReposAccessibleToInstallation,
      )

      expect(ours.map(comparable)).toEqual(theirs.calls.map(comparable))
    })
  })
})

describe('deliberate differences from Octokit', () => {
  it('resolves discussion notification numbers with one extra GraphQL query per page, since REST gives them no URL', async () => {
    const h = harness()
    await drain(h.provider.notifications!.list())
    await h.octokit.paginate(h.octokit.rest.activity.listNotificationsForAuthenticatedUser, { all: false })

    expect(h.ours.filter(call => call.url.endsWith('/graphql')).map(call => call.operationName)).toEqual(['RecentDiscussions'])
    expect(h.theirs.some(call => call.url.endsWith('/graphql'))).toBe(false)
  })

  it('sends Accept: application/vnd.github+json, the media type GitHub documents, not Octokit\'s v3 alias', async () => {
    const h = harness()
    await h.provider.notifications!.markRead!(notification)
    await h.octokit.rest.activity.markThreadAsRead({ thread_id: 901234567 })

    expect(h.ours[0]!.headers.get('accept')).toBe('application/vnd.github+json')
    expect(h.theirs[0]!.headers.get('accept')).toBe('application/vnd.github.v3+json')
  })

  it('pins X-GitHub-Api-Version so responses do not shift under a new server default', async () => {
    const h = harness()
    await h.provider.notifications!.markRead!(notification)
    await h.octokit.rest.activity.markThreadAsRead({ thread_id: 901234567 })

    expect(h.ours[0]!.headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(h.theirs[0]!.headers.get('x-github-api-version')).toBeNull()
  })

  it('uses the Bearer scheme for personal access tokens, where Octokit sends the legacy token scheme', async () => {
    const h = harness()
    await h.provider.notifications!.markRead!(notification)
    await h.octokit.rest.activity.markThreadAsRead({ thread_id: 901234567 })

    expect(h.ours[0]!.authorization).toBe(`Bearer ${TOKEN}`)
    expect(h.theirs[0]!.authorization).toBe(`token ${TOKEN}`)
  })

  it('names GraphQL operations so fixtures and logs can tell documents apart, which Octokit does not', async () => {
    const h = harness()
    await h.provider.threads.get({ ...pull, kind: 'discussion', number: '31' })
    await h.octokit.graphql('query DiscussionThread($n: Int!) { repository(owner: "acme", name: "widgets") { discussion(number: $n) { id } } }', { n: 31 }).catch(() => undefined)

    expect(comparable(h.ours[0]!).path).toBe(comparable(h.theirs[0]!).path)
    expect(JSON.parse(h.ours[0]!.body!).operationName).toBe('DiscussionThread')
    expect(JSON.parse(h.theirs[0]!.body!).operationName).toBeUndefined()
  })

  it('times out hung requests, which Octokit leaves to the caller', async () => {
    const provider = github({
      auth: { type: 'token', token: TOKEN },
      timeout: 20,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
      }),
    }).create()

    await expect(provider.request('GET', '/repos/acme/widgets')).rejects.toThrow(ForgeTimeoutError)
  })
})

type AllKeys<T> = T extends unknown ? keyof T : never
/** Keys we read that exist on no member of Octokit's response type. Must be `never`. */
type Undocumented<Ours, Theirs> = Exclude<keyof Ours, AllKeys<NonNullable<Theirs>>>

type Rest = RestEndpointMethodTypes
type OctokitNotification = Rest['activity']['listNotificationsForAuthenticatedUser']['response']['data'][number]
type OctokitIssue = Rest['issues']['get']['response']['data']
type OctokitPull = Rest['pulls']['get']['response']['data']
type OctokitTimeline = Rest['issues']['listEventsForTimeline']['response']['data'][number]
type OctokitInstallation = Rest['apps']['listInstallations']['response']['data'][number]
type OctokitToken = Rest['apps']['createInstallationAccessToken']['response']['data']
type OctokitRepo = Rest['repos']['get']['response']['data']
type OctokitComment = Rest['issues']['getComment']['response']['data']
type OctokitCollaborator = Rest['repos']['listCollaborators']['response']['data'][number]
type OctokitMilestone = Rest['issues']['listMilestones']['response']['data'][number]
type OctokitLabel = Rest['issues']['listLabelsForRepo']['response']['data'][number]
type OctokitReaction = Rest['reactions']['listForIssue']['response']['data'][number]
type OctokitCheckRun = Rest['checks']['listForRef']['response']['data']['check_runs'][number]
type OctokitCombinedStatus = Rest['repos']['getCombinedStatusForRef']['response']['data']
type OctokitRelease = Rest['repos']['getRelease']['response']['data']
type OctokitDependabotAlert = Rest['dependabot']['getAlert']['response']['data']
type OctokitCodeScanningAlert = Rest['codeScanning']['getAlert']['response']['data']
type OctokitSecretScanningAlert = Rest['secretScanning']['getAlert']['response']['data']

describe('response fields read by the normaliser exist on Octokit\'s types', () => {
  it('reads only documented fields', () => {
    expectNever<Undocumented<GitHubNotification, OctokitNotification>>()
    expectNever<Undocumented<GitHubNotification['subject'], OctokitNotification['subject']>>()
    expectNever<Undocumented<GitHubRepository, OctokitRepo>>()
    expectNever<Undocumented<GitHubRepositoryDetail, OctokitRepo>>()
    expectNever<Undocumented<GitHubComment, OctokitComment>>()
    expectNever<Undocumented<GitHubIssue, OctokitIssue | OctokitPull>>()
    expectNever<Undocumented<GitHubCollaborator, OctokitCollaborator>>()
    expectNever<Undocumented<GitHubMilestone, OctokitMilestone>>()
    expectNever<Undocumented<GitHubLabel, OctokitLabel>>()
    expectNever<Undocumented<GitHubReaction, OctokitReaction>>()
    expectNever<Undocumented<GitHubReactions, NonNullable<OctokitIssue['reactions']>>>()
    expectNever<Undocumented<GitHubUser, NonNullable<OctokitIssue['user']>>>()
    expectNever<Undocumented<GitHubTimelineEntry, OctokitTimeline>>()
    expectNever<Undocumented<GitHubInstallation, OctokitInstallation>>()
    expectNever<Undocumented<GitHubInstallationToken, OctokitToken>>()
    expectNever<Undocumented<GitHubCheckRun, OctokitCheckRun>>()
    expectNever<Undocumented<GitHubCombinedStatus, OctokitCombinedStatus>>()
    expectNever<Undocumented<GitHubCommitStatus, OctokitCombinedStatus['statuses'][number]>>()
    expectNever<Undocumented<GitHubRelease, OctokitRelease>>()
    expectNever<Undocumented<GitHubDependabotAlert, OctokitDependabotAlert>>()
    expectNever<Undocumented<GitHubCodeScanningAlert, OctokitCodeScanningAlert>>()
    expectNever<Undocumented<GitHubSecretScanningAlert, OctokitSecretScanningAlert>>()
  })
})

function expectNever<T extends never>(..._: T[]): void {}
