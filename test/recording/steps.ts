import type { Branch, Check, CiJob, CiRun, Comment, Page, Release, Repo, RepoRef, Review, SecurityAlertKind, Thread, ThreadRef, TreeEntry, Webhook } from '../../src/model.ts'
import type { ForgeProvider, ForgeVerb } from '../../src/provider.ts'
import { sha256Hex } from '../../src/crypto.ts'
import { ForbiddenError, InsufficientScopeError, NotFoundError } from '../../src/errors.ts'

/** What one recording covers: the repository and the threads read from it. */
export interface RecordingManifest {
  /** The provider's API base when recorded; absent for recordings of the default instance. */
  baseUrl?: string
  /** The instance version, for a recording whose capabilities depend on it. */
  instanceVersion?: string
  /** Recorded without credentials, so replay creates the provider without them. */
  anonymous?: boolean
  /** The GitHub App installation the recording authenticated as, so replay authenticates as an app too. */
  installation?: string
  repo: RepoRef
  pull?: ThreadRef
  issue?: ThreadRef
  discussion?: ThreadRef
  /** A repository the credential administers: write recordings write to it, and reads use it for webhooks, and for collaborators, permissions or a release asset that the recorded repository refuses or lacks. */
  scratch?: RepoRef
  /** Where security alerts are read, when not from `repo`. */
  alerts?: RepoRef
  /** Where a write recording transfers an issue to. */
  transfer?: RepoRef
  /** Where a write recording adds a collaborator, when not the scratch repository. */
  collaborators?: RepoRef
  /** The secret recorded webhook deliveries are signed with. */
  webhookSecret?: string
  /** Names of the recorded webhook deliveries, each in `<name>.delivery.json`. */
  deliveries?: string[]
  recordsUrl?: string
  /** The Tangled account the recording signed in as, a handle or DID. */
  account?: string
  /** The account's PDS, when the recording named it rather than resolving it from the account. */
  pds?: string
  /** The Tangled notification service the recording read. */
  notificationsUrl?: string
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
  tree?: TreeEntry[]
  releases?: Release[]
  runs?: CiRun[]
  job?: CiJob
  webhook?: Webhook
  comment?: Comment
  review?: Review
  checks?: Check[]
  discussion?: Thread
}

export interface Step {
  name: string
  verb: ForgeVerb
  kind?: 'issue' | 'pull_request' | 'discussion' | 'commit' | Exclude<SecurityAlertKind, 'other'>
  /** Whether the step applies, beyond the provider supporting its verb. */
  when?: (provider: ForgeProvider, manifest: RecordingManifest) => boolean
  run: (provider: ForgeProvider, manifest: RecordingManifest, context: StepContext) => Promise<unknown>
}

const page = { perPage: 3 }

/** The pull's head, or for a forge whose pulls are patches without one, the head of a branch other than the default. */
const headOf = (context: StepContext) => need(context.headSha ?? context.branches?.find(branch => !branch.isDefault)?.sha, 'the pull head sha')

/** The largest log, in characters, a step keeps, and the largest release asset, in bytes, it downloads. */
export const LOG_LIMIT = 16_384
const ASSET_LIMIT = 65_536

/** Reads from the recorded repository, or from the scratch repository when only a collaborator may read it. */
async function orScratch<T>(manifest: RecordingManifest, read: (repo: RepoRef) => Promise<T>): Promise<T> {
  try {
    return await read(manifest.repo)
  }
  catch (error) {
    if (!manifest.scratch || !(error instanceof ForbiddenError || error instanceof InsufficientScopeError || error instanceof NotFoundError)) {
      throw error
    }
    return read(manifest.scratch)
  }
}

async function firstWithJobs(provider: ForgeProvider, runs: CiRun[]): Promise<Page<CiJob> | undefined> {
  let result: Page<CiJob> | undefined
  for (const run of runs) {
    result = await provider.ci.jobsPage(run.ref, page)
    if (result.items.length) {
      break
    }
  }
  return result
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

function namespaceOf(repo: RepoRef, owner: string): RepoRef {
  return { forge: repo.forge, instance: repo.instance, owner, name: '', kind: 'namespace' }
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not found by an earlier step`)
  }
  return value
}

/** Reads a discussion comment by the discussion's own node id, which must be rejected. */
const discussionNodeStep: Step = { name: 'discussion getComment of another node', verb: 'threads.getComment', kind: 'discussion', run: async (provider, _manifest, context) => {
  const id = need(need(context.discussion, 'the discussion').ref.externalId, 'the discussion node id')
  try {
    await provider.threads.getComment({ ...need(context.comment, 'a discussion comment').ref, id })
  }
  catch (error) {
    if (error instanceof NotFoundError) {
      return { rejected: error.name }
    }
    throw error
  }
  throw new Error('read a discussion comment from a node of another type')
} }

function threadSteps(kind: 'issue' | 'pull_request' | 'discussion', key: 'issue' | 'pull' | 'discussion'): Step[] {
  const ref = (manifest: RecordingManifest) => need(manifest[key], `manifest.${key}`)
  const steps: Step[] = [
    { name: `${key}`, verb: 'threads.get', kind, run: async (provider, manifest, context) => {
      const thread = await provider.threads.get(ref(manifest))
      if (key === 'pull') {
        context.pull = thread
        context.headSha = thread.branches?.head.sha
      }
      if (key === 'discussion') {
        context.discussion = thread
      }
      context.login ??= thread.author?.login
      return thread
    } },
    { name: `${key} list`, verb: 'threads.listPage', kind, run: (provider, manifest) => provider.threads.listPage(manifest.repo, { kind, ...page }) },
    // Anonymous GitHub reads share 60 requests an hour, and `issue getMany` covers the same REST fallback.
    { name: `${key} getMany`, verb: 'threads.getMany', kind, when: (provider, manifest) => key !== 'pull' || provider.forge !== 'github' || !manifest.anonymous, run: async (provider, manifest) => {
      const results = await provider.threads.getMany([ref(manifest)])
      const failed = results.find(result => !result.ok)
      if (failed) {
        throw new Error(`getMany could not read the thread: ${failed.warning.message}`)
      }
      return results
    } },
    { name: `${key} events`, verb: 'threads.eventsPage', kind, run: (provider, manifest) => provider.threads.eventsPage(ref(manifest), page) },
    { name: `${key} comments`, verb: 'threads.commentsPage', kind, run: async (provider, manifest, context) => {
      const result = await provider.threads.commentsPage(ref(manifest), page)
      context.comment = result.items[0]
      return result
    } },
    { name: `${key} getComment`, verb: 'threads.getComment', kind, run: (provider, _manifest, context) => provider.threads.getComment(need(context.comment, 'a comment').ref) },
    ...kind === 'discussion' ? [discussionNodeStep] : [],
    { name: `${key} reactions`, verb: 'threads.reactionsPage', kind, run: (provider, manifest) => provider.threads.reactionsPage(ref(manifest), page) },
    { name: `${key} subscription`, verb: 'threads.subscription', kind, run: (provider, manifest) => provider.threads.subscription(ref(manifest)) },
  ]
  if (kind === 'pull_request') {
    steps.push(
      { name: 'pull reviews', verb: 'threads.reviewsPage', kind, run: async (provider, manifest, context) => {
        const result = await provider.threads.reviewsPage(ref(manifest), page)
        context.review = result.items[0]
        return result
      } },
      { name: 'pull getReview', verb: 'threads.getReview', kind, run: (provider, _manifest, context) => provider.threads.getReview(need(context.review, 'a review').ref) },
      { name: 'pull checks', verb: 'threads.checks', kind, run: (provider, manifest) => provider.threads.checks(ref(manifest)) },
      { name: 'pull files', verb: 'threads.filesPage', kind, run: (provider, manifest) => provider.threads.filesPage(ref(manifest), page) },
      { name: 'pull commits', verb: 'threads.commitsPage', kind, run: (provider, manifest) => provider.threads.commitsPage(ref(manifest), page) },
      { name: 'pull reviewer candidates', verb: 'repos.reviewerCandidatesPage', run: (provider, manifest) => provider.repos.reviewerCandidatesPage(ref(manifest), page) },
    )
  }
  return steps
}

/** Reads of the pull request's head commit as a thread. */
function commitSteps(): Step[] {
  const ref = (manifest: RecordingManifest, context: StepContext): ThreadRef => {
    const repo = context.pull?.ref.repo ?? manifest.repo
    return { forge: repo.forge, instance: repo.instance, repo, kind: 'commit', number: need(context.headSha, 'the pull head sha') }
  }
  return [
    { name: 'commit thread', verb: 'threads.get', kind: 'commit', run: (provider, manifest, context) => provider.threads.get(ref(manifest, context)) },
    { name: 'commit events', verb: 'threads.eventsPage', kind: 'commit', run: (provider, manifest, context) => provider.threads.eventsPage(ref(manifest, context), page) },
    { name: 'commit comments', verb: 'threads.commentsPage', kind: 'commit', run: async (provider, manifest, context) => {
      const result = await provider.threads.commentsPage(ref(manifest, context), page)
      context.comment = result.items[0]
      return result
    } },
    { name: 'commit getComment', verb: 'threads.getComment', kind: 'commit', run: (provider, _manifest, context) => provider.threads.getComment(need(context.comment, 'a commit comment').ref) },
  ]
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
  { name: 'repo licence', verb: 'repos.get', run: (provider, manifest) => provider.repos.get(manifest.repo, { licence: true }) },
  { name: 'labels', verb: 'repos.labelsPage', run: (provider, manifest) => provider.repos.labelsPage(manifest.repo, page) },
  { name: 'milestones', verb: 'repos.milestonesPage', run: (provider, manifest) => provider.repos.milestonesPage(manifest.repo, page) },
  { name: 'collaborators', verb: 'repos.collaboratorsPage', run: (provider, manifest) => orScratch(manifest, repo => provider.repos.collaboratorsPage(repo, page)) },
  { name: 'assignable users', verb: 'repos.assignableUsersPage', run: (provider, manifest) => provider.repos.assignableUsersPage(manifest.repo, page) },
  ...threadSteps('pull_request', 'pull'),
  ...threadSteps('issue', 'issue'),
  ...threadSteps('discussion', 'discussion'),
  ...commitSteps(),
  { name: 'permission', verb: 'repos.permissionFor', run: (provider, manifest, context) => orScratch(manifest, repo => provider.repos.permissionFor(repo, need(context.login, 'a login'))) },
  { name: 'user', verb: 'users.get', run: (provider, _manifest, context) => provider.users.get(need(context.login, 'a login')) },
  { name: 'me', verb: 'users.me', run: provider => provider.users.me() },
  { name: 'own repos', verb: 'repos.listPage', run: provider => provider.repos.listPage(page) },
  { name: 'owner repos', verb: 'repos.byOwnerPage', run: (provider, manifest) => provider.repos.byOwnerPage(namespaceOf(manifest.repo, manifest.repo.owner), { visibility: 'public', sort: 'updated', subgroups: true, ...page }) },
  { name: 'user repos', verb: 'repos.byOwnerPage', run: (provider, manifest, context) => provider.repos.byOwnerPage(namespaceOf(manifest.repo, need(context.login, 'a login')), page) },
  { name: 'installations', verb: 'installations.listPage', run: provider => provider.installations.listPage(page) },
  { name: 'installation', verb: 'installations.get', run: (provider, manifest) => provider.installations.get(need(manifest.installation, 'manifest.installation')) },
  { name: 'installation repos', verb: 'installations.reposPage', run: (provider, manifest) => provider.installations.reposPage(need(manifest.installation, 'manifest.installation'), page) },
  { name: 'installation token', verb: 'installations.token', run: async (provider, manifest) => {
    const { token: _, ...details } = await provider.installations.token(need(manifest.installation, 'manifest.installation'))
    return details
  } },
  { name: 'notifications', verb: 'notifications.listPage', run: provider => provider.notifications.listPage(page) },
  { name: 'unread count', verb: 'notifications.unreadCount', run: provider => provider.notifications.unreadCount() },
  { name: 'checks', verb: 'checks.list', run: async (provider, manifest, context) => {
    const result = await provider.checks.list(manifest.repo, need(context.headSha, 'the pull head sha'))
    context.checks = result.items
    return result
  } },
  { name: 'ci runs', verb: 'ci.runsPage', run: async (provider, manifest, context) => {
    const result = await provider.ci.runsPage(manifest.repo, page)
    context.runs = result.items
    return result
  } },
  { name: 'ci runs by branch and state', verb: 'ci.runsPage', run: (provider, manifest, context) => provider.ci.runsPage(manifest.repo, { ...page, branch: need(context.repo?.defaultBranch, 'the default branch'), state: 'failure' }) },
  { name: 'ci run', verb: 'ci.run', run: (provider, _manifest, context) => provider.ci.run(need(context.runs?.[0], 'a CI run').ref) },
  { name: 'check', verb: 'checks.get', run: async (provider, manifest, context) => {
    const readable = (checks: Check[] = []) => checks.find(check => check.ref.type !== 'status')
    const check = readable(context.checks) ?? readable((await provider.checks.list(manifest.repo, need(context.runs?.[0]?.sha, 'a CI run sha'))).items)
    return provider.checks.get(need(check, 'a check other than a commit status').ref)
  } },
  { name: 'ci jobs', verb: 'ci.jobsPage', run: async (provider, manifest, context) => {
    const runs = need(context.runs?.length ? context.runs : undefined, 'a CI run')
    let result = await firstWithJobs(provider, runs)
    if (!result?.items.length && manifest.scratch) {
      result = await firstWithJobs(provider, (await provider.ci.runsPage(manifest.scratch, page)).items)
    }
    context.job = result?.items[0]
    return result
  } },
  { name: 'ci job', verb: 'ci.job', run: (provider, _manifest, context) => provider.ci.job(need(context.job, 'a CI job').ref) },
  // Anonymous GitHub reads share 60 requests an hour.
  { name: 'ci job by id', verb: 'ci.job', when: (provider, manifest) => provider.forge !== 'github' || !manifest.anonymous, run: (provider, _manifest, context) => {
    const { run: _run, ...ref } = need(context.job, 'a CI job').ref
    return provider.ci.job(ref)
  } },
  { name: 'ci log', verb: 'ci.log', run: async (provider, manifest, context) => {
    const read = async (job: CiJob | undefined) => text(await provider.ci.log(need(job, 'a CI job').ref))
    let log: string
    try {
      log = await read(context.job)
    }
    catch (error) {
      if (!manifest.scratch || !(error instanceof ForbiddenError || error instanceof InsufficientScopeError)) {
        throw error
      }
      log = await read((await firstWithJobs(provider, (await provider.ci.runsPage(manifest.scratch, page)).items))?.items[0])
    }
    return { length: log.length, head: log.slice(0, 2_000).split('\n').slice(0, 20) }
  } },
  { name: 'readme', verb: 'contents.file', run: (provider, manifest) => provider.contents.file(manifest.repo, 'README.md', { as: 'text' }) },
  { name: 'tree', verb: 'contents.treePage', run: async (provider, manifest, context) => {
    const result = await provider.contents.treePage(manifest.repo, page)
    context.tree = result.items
    return result
  } },
  { name: 'tree file', verb: 'contents.file', run: (provider, manifest, context) => provider.contents.file(manifest.repo, need(context.tree?.find(entry => entry.type === 'file'), 'a file in the tree').path, { as: 'text' }) },
  { name: 'branches', verb: 'contents.branchesPage', run: async (provider, manifest, context) => {
    const result = await provider.contents.branchesPage(manifest.repo, page)
    context.branches = result.items
    return result
  } },
  { name: 'tags', verb: 'contents.tagsPage', run: (provider, manifest) => provider.contents.tagsPage(manifest.repo, page) },
  { name: 'resolve default branch', verb: 'contents.resolveRef', run: (provider, manifest, context) => provider.contents.resolveRef(manifest.repo, need(context.repo?.defaultBranch, 'the default branch')) },
  { name: 'commits', verb: 'contents.commitsPage', run: (provider, manifest) => provider.contents.commitsPage(manifest.repo, page) },
  { name: 'commit', verb: 'contents.commit', run: (provider, manifest, context) => provider.contents.commit(manifest.repo, headOf(context)) },
  { name: 'compare', verb: 'contents.compare', run: (provider, manifest, context) => provider.contents.compare(manifest.repo, need(context.pull?.branches?.base.ref, 'the pull base'), headOf(context)) },
  { name: 'releases', verb: 'releases.listPage', run: async (provider, manifest, context) => {
    const result = await provider.releases.listPage(manifest.repo, page)
    context.releases = result.items
    return result
  } },
  { name: 'latest release', verb: 'releases.latest', run: (provider, manifest) => provider.releases.latest(manifest.repo) },
  { name: 'release', verb: 'releases.get', run: (provider, _manifest, context) => provider.releases.get(need(context.releases?.[0], 'a release').ref) },
  { name: 'release by tag', verb: 'releases.getByTag', run: (provider, manifest, context) => provider.releases.getByTag(manifest.repo, need(context.releases?.[0], 'a release').tag) },
  { name: 'release asset', verb: 'releases.downloadAsset', run: async (provider, manifest, context) => {
    const small = (releases: Release[]) => releases.flatMap(release => release.assets ?? []).filter(asset => asset.ref && asset.size !== undefined && asset.size <= ASSET_LIMIT).sort((a, b) => a.size! - b.size!)[0]
    const asset = need(small(context.releases ?? []) ?? (manifest.scratch && small((await provider.releases.listPage(manifest.scratch, page)).items)), 'a small release asset')
    const bytes = new Uint8Array(await new Response(await provider.releases.downloadAsset(asset.ref!)).arrayBuffer())
    return { name: asset.name, size: bytes.length, sha256: await sha256Hex(bytes) }
  } },
  { name: 'search threads', verb: 'search.threadsPage', run: (provider, manifest) => provider.search.threadsPage({ text: 'fix', repo: manifest.repo, ...page }) },
  { name: 'search repos', verb: 'search.reposPage', run: (provider, manifest) => provider.search.reposPage({ text: manifest.repo.name, ...page }) },
  { name: 'search commits', verb: 'search.commitsPage', run: (provider, manifest) => provider.search.commitsPage({ text: 'fix', repo: manifest.repo, ...page }) },
  { name: 'search code', verb: 'search.codePage', run: (provider, manifest) => provider.search.codePage({ text: 'import', repo: manifest.repo, ...page }) },
  { name: 'search code in owner', verb: 'search.codePage', run: (provider, manifest) => provider.search.codePage({ text: 'import', owner: manifest.repo.owner, ...page }) },
  { name: 'search code in scratch', verb: 'search.codePage', run: (provider, manifest) => {
    if (!manifest.scratch) {
      throw new Error('No scratch repository to search')
    }
    return provider.search.codePage({ text: manifest.scratch.name, repo: manifest.scratch, perPage: 20 })
  } },
  { name: 'webhooks', verb: 'webhooks.listPage', run: async (provider, manifest, context) => {
    const result = await provider.webhooks.listPage(manifest.scratch ?? manifest.repo, page)
    context.webhook = result.items[0]
    return result
  } },
  { name: 'webhook deliveries', verb: 'webhooks.deliveriesPage', run: (provider, _manifest, context) => provider.webhooks.deliveriesPage(need(context.webhook, 'a webhook').ref, page) },
  ...(['dependency', 'code_scanning', 'secret', 'advisory'] as const).map((kind): Step => ({
    name: `${kind.replace('_', ' ')} alerts`,
    verb: 'securityAlerts.listPage',
    kind,
    run: (provider, manifest) => provider.securityAlerts.listPage(manifest.alerts ?? manifest.repo, { kind, state: 'all', ...page }),
  })),
]
