import type { Branch, Check, CiJob, CiRun, Comment, CommitComment, CommitRef, Page, Release, Repo, RepoRef, Review, SecurityAlertKind, Team, Thread, ThreadRef, TreeEntry, Webhook } from '../../src/model.ts'
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
  /** The account whose activity feed the recording reads, when not the author of `pull`. */
  feedUser?: string
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
  /** When webhook deliveries were recorded; replay runs at this instant. Step recordings keep it per step, in `step.json`. */
  recordedAt?: string
}

/** Values earlier steps found, for later steps to use. */
export interface StepContext {
  repo?: Repo
  pull?: Thread
  login?: string
  headSha?: string
  /** The sha the default branch resolves to. */
  defaultSha?: string
  branches?: Branch[]
  tree?: TreeEntry[]
  releases?: Release[]
  runs?: CiRun[]
  job?: CiJob
  webhook?: Webhook
  comment?: Comment
  commitComment?: CommitComment
  review?: Review
  checks?: Check[]
  discussion?: Thread
  teams?: Team[]
}

export interface Step {
  name: string
  verb: ForgeVerb
  kind?: 'issue' | 'pull_request' | 'discussion' | Exclude<SecurityAlertKind, 'other'>
  /** Whether the step applies, beyond the provider supporting its verb. */
  when?: (provider: ForgeProvider, manifest: RecordingManifest) => boolean
  run: (provider: ForgeProvider, manifest: RecordingManifest, context: StepContext) => Promise<unknown>
}

const page = { perPage: 3 }
/** GitHub reports unlinked contributors only once a page is wide enough to reach them. */
const unlinkedPage = { perPage: 30 }
/** Feeds mix many kinds of event, so a step reads more of one to cover them. */
const feedPage = { perPage: 10 }

/** The pull's head, else the head of a branch other than the default, else the default branch. */
const commitAt = (repo: RepoRef, sha: string): CommitRef => ({ forge: repo.forge, instance: repo.instance, repo, sha })
const headOf = (context: StepContext) => need(context.headSha ?? context.branches?.find(branch => !branch.isDefault)?.sha ?? context.defaultSha, 'the pull head sha')

/** The largest log, in characters, a step keeps, and the largest release asset, in bytes, it downloads. */
export const LOG_LIMIT = 16_384
const ASSET_LIMIT = 65_536

/** A branch of the GitHub scratch repository that both a ruleset and classic branch protection apply to. */
const PROTECTED_BRANCH = 'protected'

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

/** The teams of the scratch repository's owner, whose teams the fixtures set up, or else of the recorded repository's owner. */
async function orgTeams(provider: ForgeProvider, manifest: RecordingManifest): Promise<Page<Team>> {
  if (manifest.scratch) {
    try {
      const teams = await provider.orgs.teams(namespaceOf(manifest.scratch, manifest.scratch.owner), page).page()
      if (teams.items.length) {
        return teams
      }
    }
    catch (error) {
      if (!(error instanceof ForbiddenError || error instanceof InsufficientScopeError || error instanceof NotFoundError)) {
        throw error
      }
    }
  }
  return provider.orgs.teams(namespaceOf(manifest.repo, manifest.repo.owner), page).page()
}

async function firstWithJobs(provider: ForgeProvider, runs: CiRun[]): Promise<Page<CiJob> | undefined> {
  let result: Page<CiJob> | undefined
  for (const run of runs) {
    result = await provider.ci.jobs(run.ref, page).page()
    if (result.items.length) {
      break
    }
  }
  return result
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

/** Public threads with closing references, per instance, for recordings whose own pull request and issue have none. */
const LINKED: Record<string, { owner: string, name: string, pull: string, issue: string }> = {
  'github.com': { owner: 'h3js', name: 'h3', pull: '1559', issue: '1558' },
  'gitlab.com': { owner: 'gitlab-org', name: 'cli', pull: '4122', issue: '8622' },
}

function linked(manifest: RecordingManifest, kind: 'issue' | 'pull_request'): ThreadRef {
  const { owner, name, pull, issue } = need(LINKED[manifest.repo.instance], 'a linked thread on this instance')
  const repo: RepoRef = { forge: manifest.repo.forge, instance: manifest.repo.instance, owner, name }
  return { forge: repo.forge, instance: repo.instance, repo, kind, number: kind === 'issue' ? issue : pull }
}

const hasLinked = (_provider: ForgeProvider, manifest: RecordingManifest) => manifest.repo.instance in LINKED

function namespaceOf(repo: RepoRef, owner: string): RepoRef {
  return { forge: repo.forge, instance: repo.instance, owner, name: '', kind: 'namespace' }
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not found by an earlier step`)
  }
  return value
}

async function rejection(read: () => Promise<unknown>): Promise<{ rejected: string }> {
  try {
    await read()
  }
  catch (error) {
    if (error instanceof NotFoundError) {
      return { rejected: error.name }
    }
    throw error
  }
  throw new Error('read something that should not exist')
}

/** Reads a discussion comment by the discussion's own node id, which must be rejected. */
const discussionNodeStep: Step = { name: 'discussion getComment of another node', verb: 'threads.getComment', kind: 'discussion', run: async (provider, _manifest, context) => {
  const id = need(need(context.discussion, 'the discussion').ref.externalId, 'the discussion node id')
  return rejection(() => provider.threads.getComment({ ...need(context.comment, 'a discussion comment').ref, id }))
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
    { name: `${key} list`, verb: 'threads.list', kind, run: (provider, manifest) => provider.threads.list(manifest.repo, { kind, ...page }).page() },
    // Anonymous GitHub reads share 60 requests an hour, and `issue getMany` covers the same REST fallback.
    { name: `${key} getMany`, verb: 'threads.getMany', kind, when: (provider, manifest) => key !== 'pull' || provider.forge !== 'github' || !manifest.anonymous, run: async (provider, manifest) => {
      const results = await provider.threads.getMany([ref(manifest)])
      const failed = results.find(result => !result.ok)
      if (failed) {
        throw new Error(`getMany could not read the thread: ${failed.warning.message}`)
      }
      return results
    } },
    { name: `${key} events`, verb: 'threads.events', kind, run: (provider, manifest) => provider.threads.events(ref(manifest), page).page() },
    { name: `${key} comments`, verb: 'threads.comments', kind, run: async (provider, manifest, context) => {
      const result = await provider.threads.comments(ref(manifest), page).page()
      context.comment = result.items[0]
      return result
    } },
    { name: `${key} getComment`, verb: 'threads.getComment', kind, run: (provider, _manifest, context) => provider.threads.getComment(need(context.comment, 'a comment').ref) },
    ...kind === 'discussion' ? [discussionNodeStep] : [],
    { name: `${key} reactions`, verb: 'threads.reactions', kind, run: (provider, manifest) => provider.threads.reactions(ref(manifest), page).page() },
    { name: `${key} subscription`, verb: 'threads.subscription', kind, run: (provider, manifest) => provider.threads.subscription(ref(manifest)) },
  ]
  if (kind === 'issue') {
    steps.push(
      { name: 'issue closing pulls', verb: 'threads.closingPullRequests', run: (provider, manifest) => provider.threads.closingPullRequests(ref(manifest), page).page() },
      { name: 'linked issue closing pulls', verb: 'threads.closingPullRequests', when: hasLinked, run: (provider, manifest) => provider.threads.closingPullRequests(linked(manifest, 'issue'), page).page() },
    )
  }
  if (kind === 'pull_request') {
    steps.push(
      { name: 'pull reviews', verb: 'threads.reviews', kind, run: async (provider, manifest, context) => {
        const result = await provider.threads.reviews(ref(manifest), page).page()
        context.review = result.items[0]
        return result
      } },
      { name: 'pull getReview', verb: 'threads.getReview', kind, run: (provider, _manifest, context) => provider.threads.getReview(need(context.review, 'a review').ref) },
      { name: 'pull checks', verb: 'threads.checks', kind, run: (provider, manifest) => provider.threads.checks(ref(manifest)) },
      { name: 'pull files', verb: 'threads.files', kind, run: (provider, manifest) => provider.threads.files(ref(manifest), page).page() },
      { name: 'pull commits', verb: 'threads.commits', kind, run: (provider, manifest) => provider.threads.commits(ref(manifest), page).page() },
      { name: 'pull closing issues', verb: 'threads.closingIssues', run: (provider, manifest) => provider.threads.closingIssues(ref(manifest), page).page() },
      { name: 'linked pull closing issues', verb: 'threads.closingIssues', when: hasLinked, run: (provider, manifest) => provider.threads.closingIssues(linked(manifest, 'pull_request'), page).page() },
      { name: 'pull reviewer candidates', verb: 'repos.reviewerCandidates', run: (provider, manifest) => provider.repos.reviewerCandidates(ref(manifest), page).page() },
    )
  }
  return steps
}

/** Reads of the comments on the pull request's head commit. */
function commitSteps(): Step[] {
  return [
    { name: 'commit comments', verb: 'commits.comments', run: async (provider, manifest, context) => {
      const result = await provider.commits.comments(commitAt(context.pull?.ref.repo ?? manifest.repo, need(context.headSha, 'the pull head sha')), page).page()
      context.commitComment = result.items[0]
      return result
    } },
    { name: 'commit getComment', verb: 'commits.getComment', run: (provider, _manifest, context) => provider.commits.getComment(need(context.commitComment, 'a commit comment').ref) },
  ]
}

/** Reads that only Cloudflare Artifacts records, of the repositories its recording guide sets up. */
function artifactsSteps(): Step[] {
  const history = (manifest: RecordingManifest): RepoRef => ({ ...manifest.repo, owner: 'forges-fixtures-more', name: 'forges-history' })
  const steps: Step[] = [
    { name: 'artifacts resolve symbolic refs', verb: 'contents.resolveRef', run: async (provider, manifest) => ({
      head: await provider.contents.resolveRef(manifest.repo, 'HEAD'),
      full: await provider.contents.resolveRef(manifest.repo, 'refs/heads/main'),
    }) },
    { name: 'artifacts resolve unknown ref', verb: 'contents.resolveRef', run: (provider, manifest) => rejection(() => provider.contents.resolveRef(manifest.repo, 'forges-fixtures-missing')) },
    { name: 'artifacts file at HEAD', verb: 'contents.getFile', run: (provider, manifest) => provider.contents.getFile(manifest.repo, 'README.md', { ref: 'HEAD', as: 'text' }) },
    { name: 'artifacts commits pages', verb: 'commits.list', run: async (provider, manifest) => {
      const first = await provider.commits.list(manifest.repo, { perPage: 1, path: 'src' }).page()
      const second = await provider.commits.list(manifest.repo, { perPage: 1, cursor: need(first.cursor, 'a second page') }).page()
      return { first, second }
    } },
    { name: 'artifacts commits default page size', verb: 'commits.list', run: (provider, manifest) => provider.commits.list(manifest.repo, { perPage: 0 }).page() },
    { name: 'artifacts tree into a file', verb: 'contents.tree', run: (provider, manifest) => rejection(() => provider.contents.tree(manifest.repo, { path: 'README.md' }).page()) },
    { name: 'artifacts recursive tree', verb: 'contents.tree', run: async (provider, manifest) => (await provider.contents.tree(manifest.repo, { recursive: true }).page()).warnings },
    { name: 'artifacts shallow commit', verb: 'commits.get', run: async (provider, manifest) => {
      const oldest = (await provider.commits.list(manifest.repo, { perPage: 10 }).page()).items.at(-1)
      return provider.commits.get(need(oldest, 'the oldest commit').ref)
    } },
    { name: 'artifacts root commit', verb: 'commits.get', run: (provider, manifest) => provider.commits.get(commitAt(history(manifest), 'dd60772abb2766be477ea5be60edbbf9b33d3f56')) },
    { name: 'artifacts mode change commit', verb: 'commits.get', run: (provider, manifest) => provider.commits.get(commitAt(history(manifest), '40ef9975a51a1d897edaa9bcbf08138febfe7074')) },
    { name: 'artifacts rename commit', verb: 'commits.get', run: (provider, manifest) => provider.commits.get(commitAt(history(manifest), '4c696f46079a68e6774773fd7e49474df3829a08')) },
    { name: 'artifacts every namespace', verb: 'repos.list', run: async (provider) => {
      const names: string[] = []
      let cursor: Page<Repo>['cursor']
      do {
        const result = await provider.repos.list({ perPage: 1, cursor }).page()
        names.push(...result.items.map(repo => `${repo.ref.owner}/${repo.ref.name}`))
        cursor = result.cursor
      } while (cursor)
      return names
    } },
  ]
  return steps.map(step => ({ ...step, when: provider => provider.forge === 'cloudflare-artifacts' }))
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
  { name: 'labels', verb: 'repos.labels', run: (provider, manifest) => provider.repos.labels(manifest.repo, page).page() },
  { name: 'milestones', verb: 'repos.milestones', run: (provider, manifest) => provider.repos.milestones(manifest.repo, page).page() },
  { name: 'issue types', verb: 'repos.issueTypes', run: (provider, manifest) => provider.repos.issueTypes(manifest.repo) },
  { name: 'collaborators', verb: 'repos.collaborators', run: (provider, manifest) => orScratch(manifest, repo => provider.repos.collaborators(repo, page).page()) },
  { name: 'contributors', verb: 'repos.contributors', run: (provider, manifest) => provider.repos.contributors(manifest.repo, page).page() },
  // GitHub is the only forge that distinguishes contributors with an account from those without.
  { name: 'unlinked contributors', verb: 'repos.contributors', when: provider => provider.forge === 'github', run: (provider, manifest) => provider.repos.contributors(manifest.repo, { ...unlinkedPage, includeUnlinked: true }).page() },
  { name: 'templates', verb: 'repos.templates', run: (provider, manifest) => provider.repos.templates(manifest.repo) },
  { name: 'branch rules', verb: 'repos.branchRules', run: (provider, manifest, context) => provider.repos.branchRules(manifest.repo, need(context.repo?.defaultBranch, 'the default branch')) },
  { name: 'protected branch rules', verb: 'repos.branchRules', when: (provider, manifest) => provider.forge === 'github' && Boolean(manifest.scratch), run: (provider, manifest) => provider.repos.branchRules(need(manifest.scratch, 'manifest.scratch'), PROTECTED_BRANCH) },
  { name: 'contributor stats', verb: 'repos.contributorStats', run: (provider, manifest) => provider.repos.contributorStats(manifest.scratch ?? manifest.repo) },
  { name: 'assignable users', verb: 'repos.assignableUsers', run: (provider, manifest) => provider.repos.assignableUsers(manifest.repo, page).page() },
  { name: 'org teams', verb: 'orgs.teams', run: async (provider, manifest, context) => {
    const teams = await orgTeams(provider, manifest)
    context.teams = teams.items
    return teams
  } },
  { name: 'org team members', verb: 'orgs.teamMembers', run: (provider, _manifest, context) => provider.orgs.teamMembers(need(context.teams?.[0], 'a team').ref, page).page() },
  ...threadSteps('pull_request', 'pull'),
  { name: 'merged pull', verb: 'threads.get', kind: 'pull_request', run: async (provider, manifest) => {
    const listed = (await provider.threads.list(manifest.repo, { kind: 'pull_request', state: 'merged', perPage: 10 }).page()).items[0]
    return { listed, read: await provider.threads.get(need(listed, 'a merged pull request').ref) }
  } },
  ...threadSteps('issue', 'issue'),
  { name: 'issue list mentioning', verb: 'threads.list', kind: 'issue', when: (provider, manifest) => provider.forge === 'github' && !manifest.anonymous, run: (provider, manifest) => {
    return provider.threads.list(manifest.repo, { kind: 'issue', state: 'all', mentions: manifest.feedUser ?? 'danielroe', ...page }).page()
  } },
  { name: 'issue list in milestone', verb: 'threads.list', kind: 'issue', when: (provider, manifest) => provider.forge === 'github' && !manifest.anonymous, run: async (provider, manifest) => {
    const repo = manifest.scratch ?? manifest.repo
    const milestone = need((await provider.repos.milestones(repo, page).page()).items[0], 'a milestone')
    return provider.threads.list(repo, { kind: 'issue', state: 'all', milestone: milestone.title, ...page }).page()
  } },
  ...threadSteps('discussion', 'discussion'),
  ...commitSteps(),
  { name: 'permission', verb: 'repos.permissionFor', run: (provider, manifest, context) => orScratch(manifest, repo => provider.repos.permissionFor(repo, need(context.login, 'a login'))) },
  { name: 'user', verb: 'users.get', run: (provider, _manifest, context) => provider.users.get(need(context.login, 'a login')) },
  { name: 'sponsorable', verb: 'users.sponsorable', run: async (provider, manifest, context) => {
    const sponsorable: Record<string, boolean> = {}
    for (const login of [need(context.login, 'a login'), manifest.repo.owner]) {
      sponsorable[login] = await provider.users.sponsorable(login)
    }
    return sponsorable
  } },
  { name: 'user events', verb: 'users.events', run: (provider, manifest, context) => provider.users.events(manifest.feedUser ?? need(context.login, 'a login'), feedPage).page() },
  { name: 'repo events', verb: 'repos.events', run: (provider, manifest) => provider.repos.events(manifest.repo, feedPage).page() },
  { name: 'me', verb: 'users.me', run: provider => provider.users.me() },
  { name: 'own repos', verb: 'repos.list', run: provider => provider.repos.list(page).page() },
  { name: 'owner repos', verb: 'repos.byOwner', run: (provider, manifest) => provider.repos.byOwner(namespaceOf(manifest.repo, manifest.repo.owner), { visibility: 'public', sort: 'updated', subgroups: true, ...page }).page() },
  { name: 'user repos', verb: 'repos.byOwner', run: (provider, manifest, context) => {
    const threads = provider.can('threads.get', 'issue') || provider.can('threads.get', 'pull_request')
    return provider.repos.byOwner(namespaceOf(manifest.repo, need(context.login ?? (threads ? undefined : manifest.repo.owner), 'a login')), page).page()
  } },
  { name: 'installations', verb: 'installations.list', run: provider => provider.installations.list(page).page() },
  { name: 'installation', verb: 'installations.get', run: (provider, manifest) => provider.installations.get(need(manifest.installation, 'manifest.installation')) },
  { name: 'installation repos', verb: 'installations.repos', run: (provider, manifest) => provider.installations.repos(need(manifest.installation, 'manifest.installation'), page).page() },
  { name: 'installation token', verb: 'installations.token', run: async (provider, manifest) => {
    const { token: _, ...details } = await provider.installations.token(need(manifest.installation, 'manifest.installation'))
    return details
  } },
  { name: 'notifications', verb: 'notifications.list', run: provider => provider.notifications.list(page).page() },
  { name: 'unread count', verb: 'notifications.unreadCount', run: provider => provider.notifications.unreadCount() },
  { name: 'checks', verb: 'checks.list', run: async (provider, manifest, context) => {
    const result = await provider.checks.list(manifest.repo, need(context.headSha, 'the pull head sha'))
    context.checks = result.items
    return result
  } },
  { name: 'ci runs', verb: 'ci.runs', run: async (provider, manifest, context) => {
    const result = await provider.ci.runs(manifest.repo, page).page()
    context.runs = result.items
    return result
  } },
  { name: 'ci runs by branch and state', verb: 'ci.runs', run: (provider, manifest, context) => provider.ci.runs(manifest.repo, { ...page, branch: need(context.repo?.defaultBranch, 'the default branch'), state: 'failure' }).page() },
  { name: 'ci run', verb: 'ci.getRun', run: (provider, _manifest, context) => provider.ci.getRun(need(context.runs?.[0], 'a CI run').ref) },
  { name: 'check', verb: 'checks.get', run: async (provider, manifest, context) => {
    const readable = (checks: Check[] = []) => checks.find(check => check.ref.type !== 'status')
    const check = readable(context.checks) ?? readable((await provider.checks.list(manifest.repo, need(context.runs?.[0]?.sha, 'a CI run sha'))).items)
    return provider.checks.get(need(check, 'a check other than a commit status').ref)
  } },
  { name: 'ci jobs', verb: 'ci.jobs', run: async (provider, manifest, context) => {
    const runs = need(context.runs?.length ? context.runs : undefined, 'a CI run')
    let result = await firstWithJobs(provider, runs)
    if (!result?.items.length && manifest.scratch) {
      result = await firstWithJobs(provider, (await provider.ci.runs(manifest.scratch, page).page()).items)
    }
    context.job = result?.items[0]
    return result
  } },
  { name: 'ci job', verb: 'ci.getJob', run: (provider, _manifest, context) => provider.ci.getJob(need(context.job, 'a CI job').ref) },
  // Anonymous GitHub reads share 60 requests an hour.
  { name: 'ci job by id', verb: 'ci.getJob', when: (provider, manifest) => provider.forge !== 'github' || !manifest.anonymous, run: (provider, _manifest, context) => {
    const { run: _run, ...ref } = need(context.job, 'a CI job').ref
    return provider.ci.getJob(ref)
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
      log = await read((await firstWithJobs(provider, (await provider.ci.runs(manifest.scratch, page).page()).items))?.items[0])
    }
    return { length: log.length, head: log.slice(0, 2_000).split('\n').slice(0, 20) }
  } },
  { name: 'readme', verb: 'contents.getFile', run: (provider, manifest) => provider.contents.getFile(manifest.repo, 'README.md', { as: 'text' }) },
  { name: 'readme without metadata', verb: 'contents.getFile', run: (provider, manifest) => provider.contents.getFile(manifest.repo, 'README.md', { as: 'text', metadata: false }) },
  { name: 'tree', verb: 'contents.tree', run: async (provider, manifest, context) => {
    const result = await provider.contents.tree(manifest.repo, page).page()
    context.tree = result.items
    return result
  } },
  { name: 'tree file', verb: 'contents.getFile', run: (provider, manifest, context) => provider.contents.getFile(manifest.repo, need(context.tree?.find(entry => entry.type === 'file'), 'a file in the tree').path, { as: 'text' }) },
  { name: 'branches', verb: 'contents.branches', run: async (provider, manifest, context) => {
    const result = await provider.contents.branches(manifest.repo, page).page()
    context.branches = result.items
    return result
  } },
  { name: 'tags', verb: 'contents.tags', run: (provider, manifest) => provider.contents.tags(manifest.repo, page).page() },
  { name: 'resolve default branch', verb: 'contents.resolveRef', run: async (provider, manifest, context) => {
    context.defaultSha = await provider.contents.resolveRef(manifest.repo, need(context.repo?.defaultBranch, 'the default branch'))
    return context.defaultSha
  } },
  { name: 'commits', verb: 'commits.list', run: (provider, manifest) => provider.commits.list(manifest.repo, page).page() },
  { name: 'commit', verb: 'commits.get', run: (provider, manifest, context) => provider.commits.get(commitAt(manifest.repo, headOf(context))) },
  { name: 'compare', verb: 'contents.compare', run: (provider, manifest, context) => provider.contents.compare(manifest.repo, need(context.pull?.branches?.base.ref, 'the pull base'), headOf(context)) },
  { name: 'compare limited', verb: 'contents.compare', run: async (provider, manifest, context) => {
    const branch = need(context.repo?.defaultBranch, 'the default branch')
    const base = need((await provider.commits.list(manifest.repo, { ref: branch, perPage: 5 }).page()).items[4], 'a fifth commit').sha
    return provider.contents.compare(manifest.repo, base, branch, { commitLimit: 2, files: false })
  } },
  { name: 'releases', verb: 'releases.list', run: async (provider, manifest, context) => {
    const result = await provider.releases.list(manifest.repo, page).page()
    context.releases = result.items
    return result
  } },
  { name: 'latest release', verb: 'releases.latest', run: (provider, manifest) => provider.releases.latest(manifest.repo) },
  { name: 'release', verb: 'releases.get', run: (provider, _manifest, context) => provider.releases.get(need(context.releases?.[0], 'a release').ref) },
  { name: 'release by tag', verb: 'releases.getByTag', run: (provider, manifest, context) => provider.releases.getByTag(manifest.repo, need(context.releases?.[0], 'a release').tag) },
  { name: 'release asset', verb: 'releases.downloadAsset', run: async (provider, manifest, context) => {
    const small = (releases: Release[]) => releases.flatMap(release => release.assets ?? []).filter(asset => asset.ref && asset.size !== undefined && asset.size <= ASSET_LIMIT).sort((a, b) => a.size! - b.size!)[0]
    const asset = need(small(context.releases ?? []) ?? (manifest.scratch && small((await provider.releases.list(manifest.scratch, page).page()).items)), 'a small release asset')
    const bytes = new Uint8Array(await new Response(await provider.releases.downloadAsset(asset.ref!)).arrayBuffer())
    return { name: asset.name, size: bytes.length, sha256: await sha256Hex(bytes) }
  } },
  { name: 'search threads', verb: 'search.threads', run: (provider, manifest) => provider.search.threads({ text: 'fix', repo: manifest.repo, ...page }).page() },
  { name: 'search repos', verb: 'search.repos', run: (provider, manifest) => provider.search.repos({ text: manifest.repo.name, ...page }).page() },
  { name: 'search commits', verb: 'search.commits', run: (provider, manifest) => provider.search.commits({ text: 'fix', repo: manifest.repo, ...page }).page() },
  { name: 'search code', verb: 'search.code', run: (provider, manifest) => provider.search.code({ text: 'import', repo: manifest.repo, ...page }).page() },
  { name: 'search code in owner', verb: 'search.code', run: (provider, manifest) => provider.search.code({ text: 'import', owner: manifest.repo.owner, ...page }).page() },
  { name: 'search code in scratch', verb: 'search.code', run: (provider, manifest) => {
    if (!manifest.scratch) {
      throw new Error('No scratch repository to search')
    }
    return provider.search.code({ text: manifest.scratch.name, repo: manifest.scratch, perPage: 20 }).page()
  } },
  { name: 'webhooks', verb: 'webhooks.list', when: (_provider, manifest) => !!manifest.scratch, run: async (provider, manifest, context) => {
    const result = await provider.webhooks.list(manifest.scratch!, page).page()
    context.webhook = result.items[0]
    return result
  } },
  { name: 'webhook deliveries', verb: 'webhooks.deliveries', run: (provider, _manifest, context) => provider.webhooks.deliveries(need(context.webhook, 'a webhook').ref, page).page() },
  ...(['dependency', 'code_scanning', 'secret', 'advisory'] as const).map((kind): Step => ({
    name: `${kind.replace('_', ' ')} alerts`,
    verb: 'securityAlerts.list',
    kind,
    run: (provider, manifest) => provider.securityAlerts.list(manifest.alerts ?? manifest.repo, { kind, state: 'all', ...page }).page(),
  })),
  ...artifactsSteps(),
]
