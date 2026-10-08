import type { Branch, CiRun, Release, Repo, RepoRef, Thread, ThreadRef } from '../../src/model.ts'
import type { ForgeProvider, ForgeVerb } from '../../src/provider.ts'

/** What one recording covers: the repository and the threads read from it. */
export interface RecordingManifest {
  /** The provider's API base when recorded; absent for recordings of the default instance. */
  baseUrl?: string
  repo: RepoRef
  pull?: ThreadRef
  issue?: ThreadRef
  discussion?: ThreadRef
  recordsUrl?: string
  /** When the recording was made; replay runs at this instant so fallback timestamps match. */
  recordedAt: string
  /** Names of the steps that recorded successfully, in order. */
  steps: string[]
}

/** Values earlier steps found, for later steps to use. */
export interface StepContext {
  repo?: Repo
  pull?: Thread
  login?: string
  headSha?: string
  branches?: Branch[]
  releases?: Release[]
  runs?: CiRun[]
}

export interface Step {
  name: string
  verb: ForgeVerb
  kind?: 'issue' | 'pull_request' | 'discussion'
  run: (provider: ForgeProvider, manifest: RecordingManifest, context: StepContext) => Promise<unknown>
}

const page = { perPage: 3 }

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not found by an earlier step`)
  }
  return value
}

function threadSteps(kind: 'issue' | 'pull_request' | 'discussion', key: 'issue' | 'pull' | 'discussion'): Step[] {
  const ref = (manifest: RecordingManifest) => need(manifest[key], `manifest.${key}`)
  const steps: Step[] = [
    { name: `${key}`, verb: 'threads.get', kind, run: async (provider, manifest, context) => {
      const thread = await provider.threads.get(ref(manifest))
      if (key === 'pull') {
        context.pull = thread
        context.headSha = thread.branches?.head.sha
      }
      context.login ??= thread.author?.login
      return thread
    } },
    { name: `${key} list`, verb: 'threads.listPage', kind, run: (provider, manifest) => provider.threads.listPage(manifest.repo, { kind, ...page }) },
    { name: `${key} getMany`, verb: 'threads.getMany', kind, run: (provider, manifest) => provider.threads.getMany([ref(manifest)]) },
    { name: `${key} events`, verb: 'threads.eventsPage', kind, run: (provider, manifest) => provider.threads.eventsPage(ref(manifest), page) },
    { name: `${key} comments`, verb: 'threads.commentsPage', kind, run: (provider, manifest) => provider.threads.commentsPage(ref(manifest), page) },
    { name: `${key} reactions`, verb: 'threads.reactionsPage', kind, run: (provider, manifest) => provider.threads.reactionsPage(ref(manifest), page) },
    { name: `${key} subscription`, verb: 'threads.subscription', kind, run: (provider, manifest) => provider.threads.subscription(ref(manifest)) },
  ]
  if (kind === 'pull_request') {
    steps.push(
      { name: 'pull reviews', verb: 'threads.reviewsPage', kind, run: (provider, manifest) => provider.threads.reviewsPage(ref(manifest), page) },
      { name: 'pull checks', verb: 'threads.checks', kind, run: (provider, manifest) => provider.threads.checks(ref(manifest)) },
      { name: 'pull files', verb: 'threads.filesPage', kind, run: (provider, manifest) => provider.threads.filesPage(ref(manifest), page) },
      { name: 'pull commits', verb: 'threads.commitsPage', kind, run: (provider, manifest) => provider.threads.commitsPage(ref(manifest), page) },
      { name: 'pull reviewer candidates', verb: 'repos.reviewerCandidatesPage', run: (provider, manifest) => provider.repos.reviewerCandidatesPage(ref(manifest), page) },
    )
  }
  return steps
}

/**
 * Every read a recording covers, in the order it runs. The recorder runs each
 * step the provider supports against the live forge; the replay test runs the
 * ones the manifest lists against the fixtures and snapshots the output.
 */
export const STEPS: Step[] = [
  { name: 'repo', verb: 'repos.get', run: async (provider, manifest, context) => {
    context.repo = await provider.repos.get(manifest.repo)
    return context.repo
  } },
  { name: 'labels', verb: 'repos.labelsPage', run: (provider, manifest) => provider.repos.labelsPage(manifest.repo, page) },
  { name: 'milestones', verb: 'repos.milestonesPage', run: (provider, manifest) => provider.repos.milestonesPage(manifest.repo, page) },
  { name: 'collaborators', verb: 'repos.collaboratorsPage', run: (provider, manifest) => provider.repos.collaboratorsPage(manifest.repo, page) },
  { name: 'assignable users', verb: 'repos.assignableUsersPage', run: (provider, manifest) => provider.repos.assignableUsersPage(manifest.repo, page) },
  ...threadSteps('pull_request', 'pull'),
  ...threadSteps('issue', 'issue'),
  ...threadSteps('discussion', 'discussion'),
  { name: 'permission', verb: 'repos.permissionFor', run: (provider, manifest, context) => provider.repos.permissionFor(manifest.repo, need(context.login, 'a login')) },
  { name: 'user', verb: 'users.get', run: (provider, _manifest, context) => provider.users.get(need(context.login, 'a login')) },
  { name: 'me', verb: 'users.me', run: provider => provider.users.me() },
  { name: 'own repos', verb: 'repos.listPage', run: provider => provider.repos.listPage(page) },
  { name: 'notifications', verb: 'notifications.listPage', run: provider => provider.notifications.listPage(page) },
  { name: 'unread count', verb: 'notifications.unreadCount', run: provider => provider.notifications.unreadCount() },
  { name: 'checks', verb: 'checks.list', run: (provider, manifest, context) => provider.checks.list(manifest.repo, need(context.headSha, 'the pull head sha')) },
  { name: 'ci runs', verb: 'ci.runsPage', run: async (provider, manifest, context) => {
    const result = await provider.ci.runsPage(manifest.repo, page)
    context.runs = result.items
    return result
  } },
  { name: 'ci run', verb: 'ci.run', run: (provider, _manifest, context) => provider.ci.run(need(context.runs?.[0], 'a CI run').ref) },
  { name: 'ci jobs', verb: 'ci.jobsPage', run: (provider, _manifest, context) => provider.ci.jobsPage(need(context.runs?.[0], 'a CI run').ref, page) },
  { name: 'readme', verb: 'contents.file', run: (provider, manifest) => provider.contents.file(manifest.repo, 'README.md', { as: 'text' }) },
  { name: 'tree', verb: 'contents.treePage', run: (provider, manifest) => provider.contents.treePage(manifest.repo, page) },
  { name: 'branches', verb: 'contents.branchesPage', run: async (provider, manifest, context) => {
    const result = await provider.contents.branchesPage(manifest.repo, page)
    context.branches = result.items
    return result
  } },
  { name: 'tags', verb: 'contents.tagsPage', run: (provider, manifest) => provider.contents.tagsPage(manifest.repo, page) },
  { name: 'resolve default branch', verb: 'contents.resolveRef', run: (provider, manifest, context) => provider.contents.resolveRef(manifest.repo, need(context.repo?.defaultBranch, 'the default branch')) },
  { name: 'commits', verb: 'contents.commitsPage', run: (provider, manifest) => provider.contents.commitsPage(manifest.repo, page) },
  { name: 'commit', verb: 'contents.commit', run: (provider, manifest, context) => provider.contents.commit(manifest.repo, need(context.headSha, 'the pull head sha')) },
  { name: 'compare', verb: 'contents.compare', run: (provider, manifest, context) => provider.contents.compare(manifest.repo, need(context.pull?.branches?.base.ref, 'the pull base'), need(context.headSha, 'the pull head sha')) },
  { name: 'releases', verb: 'releases.listPage', run: async (provider, manifest, context) => {
    const result = await provider.releases.listPage(manifest.repo, page)
    context.releases = result.items
    return result
  } },
  { name: 'latest release', verb: 'releases.latest', run: (provider, manifest) => provider.releases.latest(manifest.repo) },
  { name: 'release', verb: 'releases.get', run: (provider, _manifest, context) => provider.releases.get(need(context.releases?.[0], 'a release').ref) },
  { name: 'release by tag', verb: 'releases.getByTag', run: (provider, manifest, context) => provider.releases.getByTag(manifest.repo, need(context.releases?.[0], 'a release').tag) },
  { name: 'search threads', verb: 'search.threadsPage', run: (provider, manifest) => provider.search.threadsPage({ text: 'fix', repo: manifest.repo, ...page }) },
  { name: 'search repos', verb: 'search.reposPage', run: (provider, manifest) => provider.search.reposPage({ text: manifest.repo.name, ...page }) },
  { name: 'search commits', verb: 'search.commitsPage', run: (provider, manifest) => provider.search.commitsPage({ text: 'fix', repo: manifest.repo, ...page }) },
  { name: 'webhooks', verb: 'webhooks.listPage', run: (provider, manifest) => provider.webhooks.listPage(manifest.repo, page) },
  { name: 'security alerts', verb: 'securityAlerts.listPage', run: (provider, manifest) => provider.securityAlerts.listPage(manifest.repo, page) },
]
