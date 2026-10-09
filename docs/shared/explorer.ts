import type { ForgeProvider, ForgeVerb, RepoRef, ThreadKind, ThreadRef } from 'forges'
import { CAPABILITY_TABLE } from '../../src/capability-table.ts'

/** A form field. Each operation shows the ones it reads, after the repository's owner and name. */
export type ExplorerField
  = | 'owner' | 'name' | 'kind' | 'number' | 'state' | 'path' | 'ref' | 'sha' | 'tag' | 'releaseId' | 'base' | 'head'
    | 'login' | 'query' | 'runId' | 'title' | 'body' | 'labels' | 'assignees' | 'reviewers' | 'method' | 'reaction'
    | 'reviewEvent' | 'reviewId' | 'reviewThread' | 'closeReason' | 'milestone' | 'canonical' | 'targetOwner'
    | 'targetName' | 'labelName' | 'colour' | 'role' | 'key' | 'commentId' | 'notificationId' | 'webhookId'
    | 'deliveryId' | 'webhookUrl' | 'secret' | 'checkName' | 'checkState' | 'checkId'

/** The values a form holds. Lists are comma-separated. */
export type ExplorerInput = Record<ExplorerField, string>

/** Fields whose sample values only exist in the sample's repository, such as a commit sha. */
export const REPOSITORY_FIELDS: ExplorerField[] = ['number', 'sha', 'base', 'head', 'tag', 'releaseId', 'runId']

export interface ExplorerFieldConfig {
  label: string
  /** Options of a select. */
  items?: string[]
  /** A comma-separated list, passed as an array. */
  list?: boolean
  /** Left out of the call when empty. */
  optional?: boolean
  /** The value until a sample or the person fills it in. */
  default?: string
  placeholder?: string
}

const options = (...values: string[]) => values

export const EXPLORER_FIELDS: Record<ExplorerField, ExplorerFieldConfig> = {
  owner: { label: 'Owner' },
  name: { label: 'Repository' },
  kind: { label: 'Kind', items: options('pull_request', 'issue'), default: 'pull_request' },
  number: { label: 'Number' },
  state: { label: 'State', items: options('open', 'closed', 'merged', 'all'), default: 'open' },
  path: { label: 'Path', default: 'README.md' },
  ref: { label: 'Branch, tag or sha', optional: true, placeholder: 'default branch' },
  sha: { label: 'Commit sha' },
  tag: { label: 'Tag' },
  releaseId: { label: 'Release id' },
  base: { label: 'Base' },
  head: { label: 'Head' },
  login: { label: 'Login' },
  query: { label: 'Search text', default: 'bug' },
  runId: { label: 'Run id' },
  title: { label: 'Title', default: 'Fix the flaky test' },
  body: { label: 'Body', default: 'Thanks for the report!' },
  labels: { label: 'Labels', list: true, default: 'bug, help wanted' },
  assignees: { label: 'Assignees', list: true, default: 'alice' },
  reviewers: { label: 'Reviewers', list: true, default: 'alice, bob' },
  method: { label: 'Merge method', items: options('merge', 'squash', 'rebase', 'rebase_merge', 'fast_forward_only'), default: 'squash' },
  reaction: { label: 'Reaction', items: options('+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'), default: '+1' },
  reviewEvent: { label: 'Review event', items: options('approve', 'request_changes', 'comment'), default: 'approve' },
  reviewId: { label: 'Review id', default: '123' },
  reviewThread: { label: 'Review thread id', default: '456' },
  closeReason: { label: 'Reason', items: options('completed', 'not_planned', 'duplicate'), default: 'completed' },
  milestone: { label: 'Milestone', default: 'v1.0' },
  canonical: { label: 'Duplicate of number', default: '1' },
  targetOwner: { label: 'Target owner', default: 'acme' },
  targetName: { label: 'Target repository', default: 'archive' },
  labelName: { label: 'Label', default: 'needs triage' },
  colour: { label: 'Colour', placeholder: 'six-digit hex', default: 'fbca04' },
  role: { label: 'Role', items: options('read', 'triage', 'write', 'maintain', 'admin'), default: 'write' },
  key: { label: 'Key', default: 'release-notes' },
  commentId: { label: 'Comment id', default: '123' },
  notificationId: { label: 'Notification id', default: '1' },
  webhookId: { label: 'Webhook id', default: '1' },
  deliveryId: { label: 'Delivery id', default: '1' },
  webhookUrl: { label: 'Webhook URL', default: 'https://example.com/webhooks' },
  secret: { label: 'Secret', default: 'a-new-secret' },
  checkName: { label: 'Check name', default: 'lint' },
  checkState: { label: 'Check state', items: options('success', 'failure', 'pending', 'neutral'), default: 'success' },
  checkId: { label: 'Check id', default: '789' },
}

/** Values for the fields that samples leave out. Writes never run, so these only fill the code. */
const DEFAULTS = Object.fromEntries(Object.entries(EXPLORER_FIELDS).map(([field, config]) => [field, config.default ?? ''])) as ExplorerInput

/** A forge in the explorer. Every one gets the code builder; those whose API answers CORS requests can also run. */
export interface ExplorerForge {
  name: string
  icon: string
  /** The factory, Lite where there is one, and the subpath it is imported from. */
  factory: string
  module: string
  /**
   * Imports `module`, which holds `factory`, for the explorer's own provider. Written out per forge, so that the bundler
   * splits each provider into a chunk of its own. Absent for a forge whose provider can't be created without credentials.
   */
  load?: () => Promise<object>
  /** The forge kind, which also keys the forge in the explorer and in links, such as `?forge=forgejo`. */
  forge: string
  instance: string
  /** Credentials as code, for writes and for reads that need an account. */
  auth: string
  /** Every call needs `auth`, reads too. */
  authRequired?: boolean
  /** Factory options besides `auth`, passed to the explorer's provider and printed in the code. */
  options?: (input: ExplorerInput) => Record<string, string>
  /** Why calls can't run from a browser, when they can't. */
  blocked?: string
  sample: ExplorerInput
}

const token = (env: string) => `{ type: 'token', token: process.env.${env}! }`

function sample(values: Partial<ExplorerInput>): ExplorerInput {
  const merged = { ...DEFAULTS, ...values }
  return { ...merged, base: merged.base || merged.tag || merged.sha, head: merged.head || 'main' }
}

// Runnable samples are public repositories that answer anonymous requests: a merged pull request, its author,
// the latest release, a commit and its parent (a small diff to compare), and a CI run, where the forge has them.
export const EXPLORER_FORGES: ExplorerForge[] = [
  { name: 'GitHub', icon: 'i-simple-icons-github', factory: 'githubLite', module: 'github', load: () => import('forges/github'), forge: 'github', instance: 'github.com', auth: token('GITHUB_TOKEN'), sample: sample({ owner: 'nuxt', name: 'nuxt', number: '36493', login: 'danielroe', tag: 'v4.6.0', releaseId: '404130846', sha: '0296ca413dc7ab2e29555e7109f35581b81d5c41', base: '85b8d54f6ce49f4d0f199e90513b1e5d5fa22196', head: 'main', runId: '37772560463' }) },
  { name: 'GitLab', icon: 'i-simple-icons-gitlab', factory: 'gitlabLite', module: 'gitlab', load: () => import('forges/gitlab'), forge: 'gitlab', instance: 'gitlab.com', auth: token('GITLAB_TOKEN'), sample: sample({ owner: 'inkscape', name: 'inkscape', number: '8209', login: 'guillaume.turri', tag: 'INKSCAPE_1_4', releaseId: 'INKSCAPE_1_4', sha: '10b831ed45817ecb05f7c6239fe97d56c196c9cc', base: '41d0bb9160ba8c4e8b31d07c301f83b4e43771e3', head: 'master', runId: '2926543070' }) },
  { name: 'Codeberg', icon: 'i-simple-icons-forgejo', factory: 'forgejoLite', module: 'forgejo', load: () => import('forges/forgejo'), forge: 'forgejo', instance: 'codeberg.org', auth: token('CODEBERG_TOKEN'), sample: sample({ owner: 'forgejo', name: 'forgejo', number: '14752', login: '0ko', tag: 'v16.0.5', releaseId: '12250357', sha: 'd915e5a5abb92527ac7fd0d60997b5fc57cf8467', base: 'adfdb1a53298d953669fcf49d61393a32b256fb5', head: 'forgejo' }) },
  { name: 'Gitea', icon: 'i-simple-icons-gitea', factory: 'giteaLite', module: 'gitea', load: () => import('forges/gitea'), forge: 'gitea', instance: 'gitea.com', auth: token('GITEA_TOKEN'), sample: sample({ owner: 'gitea', name: 'tea', number: '1114', login: 'ongolk', tag: 'v0.16.0', releaseId: '945508', sha: 'bcd62a1fb2ce6fdd51ebea91cc33ddbcae000b68', base: '6daaa7c05e7883d4468fc7b40c2f71e0ea75562a', head: 'main' }) },
  { name: 'Bitbucket', icon: 'i-simple-icons-bitbucket', factory: 'bitbucketLite', module: 'bitbucket', load: () => import('forges/bitbucket'), forge: 'bitbucket', instance: 'bitbucket.org', auth: token('BITBUCKET_TOKEN'), sample: sample({ owner: 'tutorials', name: 'markdowndemo', number: '80', login: 'brennan', sha: '5b6c39df3196eeeb8a36684beb9a3df854a0b5f3', base: '59a1e452abc40869b12cf13f476531bf5774d0d0', head: 'master' }) },
  { name: 'Gitee', icon: 'i-simple-icons-gitee', factory: 'giteeLite', module: 'gitee', load: () => import('forges/gitee'), forge: 'gitee', instance: 'gitee.com', auth: token('GITEE_TOKEN'), sample: sample({ owner: 'mindspore', name: 'mindspore', number: '91608', login: 'liangchenghui', tag: 'v2.7.2', releaseId: '569215', sha: '0487e01a5e79464fcaf8ac90d9121f9f7a679a24', base: '6de371cd62ddc66dcf20e1843dfe15f31998342c', head: 'master' }) },
  {
    name: 'Tangled',
    icon: 'i-lucide-spool',
    factory: 'tangledLite',
    module: 'tangled',
    load: () => import('forges/tangled'),
    forge: 'tangled',
    instance: 'tangled.org',
    auth: `{ type: 'app_password', identifier: 'alice.example.com', password: process.env.TANGLED_APP_PASSWORD! }`,
    // Reading through the index and a records cache takes a few requests, rather than one to each author's server.
    options: () => ({ listSource: 'index', recordsUrl: 'https://slingshot.microcosm.blue' }),
    // A Tangled thread's number is the AT-URI of its record.
    sample: sample({ owner: 'tangled.org', name: 'core', number: 'at://did:plc:xasnlahkri4ewmbuzly2rlc5/sh.tangled.repo.pull/3mwqc5pt6dc5d', login: 'boltless.me' }),
  },
  {
    name: 'Azure DevOps',
    icon: 'i-simple-icons-azuredevops',
    factory: 'azureDevOpsLite',
    module: 'azure-devops',
    load: () => import('forges/azure-devops'),
    forge: 'azure-devops',
    instance: 'dev.azure.com',
    auth: token('AZURE_DEVOPS_TOKEN'),
    options: input => ({ organization: input.owner.split('/')[0]! }),
    blocked: 'Azure DevOps answers few anonymous requests, even for public projects.',
    sample: sample({ owner: 'acme/Widgets', name: 'widgets', number: '42', login: 'alice', sha: 'main', tag: 'v1.0.0', releaseId: '1', runId: '1' }),
  },
  { name: 'Cursor Origin', icon: 'i-simple-icons-cursor', factory: 'cursorOriginLite', module: 'cursor-origin', forge: 'cursor-origin', instance: 'origin.cursor.com', auth: token('CURSOR_AUTH_TOKEN'), authRequired: true, blocked: 'Cursor Origin needs a token for every request.', sample: sample({ owner: 'acme', name: 'api', number: '42', login: 'alice', sha: 'main', tag: 'v1.0.0', releaseId: '1', runId: '1' }) },
  { name: 'pushin.eu', icon: 'i-lucide-send', factory: 'pushin', module: 'pushin', load: () => import('forges/pushin'), forge: 'pushin', instance: 'pushin.eu', auth: token('PUSHIN_TOKEN'), blocked: 'The pushin.eu API doesn\'t allow requests from browsers.', sample: sample({ owner: 'pjullrich', name: 'pushin', number: '1', login: 'pjullrich', sha: 'main', tag: 'v1.0.0', releaseId: '1', runId: '1' }) },
]

/** The refs a call takes, built from the form. */
interface Refs {
  origin: { forge: string, instance: string }
  repo: RepoRef
  thread: ThreadRef
}

/** Writes code for the call's arguments. `value` and `list` mark form values, so the page can tie them to their inputs. */
interface CodeContext {
  input: ExplorerInput
  /** `...origin`, which spreads the forge and instance into refs written out in full. */
  origin: string
  value: (field: ExplorerField) => string
  list: (field: ExplorerField) => string
}

export interface ExplorerOperation {
  /** The verb whose reference section shows the explorer, such as `threads.list`. */
  verb: ForgeVerb
  /** The method the code calls, which can be the `...Page` variant of the verb. */
  method: string
  /** The model type it resolves to, such as `Thread` or `Page<Thread>`, for the hovers on the result; `void` when it resolves to nothing. */
  returns: string
  /** The refs the code declares before the call. */
  uses: 'none' | 'repo' | 'thread'
  fields: (input: ExplorerInput) => ExplorerField[]
  /** The thread kind that support depends on, if any. */
  kind?: (input: ExplorerInput) => ThreadKind
  args: (context: CodeContext) => string
  /** Present when the explorer can make the call. Writes, reads that need an account and streams can't, yet. */
  run?: (provider: ForgeProvider, input: ExplorerInput, refs: Refs) => Promise<unknown>
  /** Needs credentials, so the code passes `auth`, and the call never runs here. Derived from the capability table. */
  auth: boolean
}

const listOf = (text: string) => text.split(',').map(item => item.trim()).filter(Boolean)
const fields = (...names: ExplorerField[]) => () => names
const threadKind = (input: ExplorerInput) => input.kind as ThreadKind
const perPage = { perPage: 5 }

/** Verbs that need credentials: the capability table's writes and account reads. */
const SIGNED_IN = new Set([
  ...CAPABILITY_TABLE.flatMap(entry => entry.write || entry.account ? entry.verbs ?? [] : []),
  // Reads the table lets an anonymous provider try, but that every forge refuses without signing in.
  'repos.collaborators',
  'repos.permissionFor',
  'repos.reviewerCandidates',
])

type Spec = Omit<ExplorerOperation, 'verb' | 'method' | 'fields' | 'uses' | 'returns' | 'auth'> & Partial<Pick<ExplorerOperation, 'method' | 'fields' | 'uses' | 'returns'>>

function operation(verb: string, spec: Spec): ExplorerOperation {
  const auth = SIGNED_IN.has(verb)
  return { verb: verb as ForgeVerb, method: verb, uses: 'repo', fields: fields(), returns: 'void', ...spec, auth, run: auth ? undefined : spec.run }
}

/** A read on a repository, through the `...Page` variant for listings. */
function repoRead(verb: string, returns: string, run: NonNullable<Spec['run']>): ExplorerOperation {
  const page = returns.startsWith('Page<')
  return operation(verb, { method: page ? `${verb}Page` : verb, returns, args: () => page ? 'repo, { perPage: 5 }' : 'repo', run })
}

/** A read on a thread, through the `...Page` variant for listings. */
function threadRead(verb: string, returns: string, run: NonNullable<Spec['run']>): ExplorerOperation {
  const page = returns.startsWith('Page<')
  return operation(verb, { method: page ? `${verb}Page` : verb, returns, uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => page ? 'thread, { perPage: 5 }' : 'thread', run })
}

/** A write on a thread. */
function threadWrite(verb: string, returns: string, extra: ExplorerField[], args: Spec['args']): ExplorerOperation {
  return operation(verb, { returns, uses: 'thread', fields: () => ['kind', 'number', ...extra], kind: threadKind, args })
}

/** A ref to something on the repository, such as a webhook, written out in full. */
const repoChild = (key: string, field: ExplorerField) => ({ origin, value }: CodeContext) => `{ ${origin}, ${key === 'repo' ? 'repo' : `${key}: repo`}, id: ${value(field)} }`

export const EXPLORER_OPERATIONS: ExplorerOperation[] = [
  // Repositories
  repoRead('repos.get', 'Repo', (p, _, { repo }) => p.repos.get(repo)),
  operation('repos.list', { method: 'repos.listPage', returns: 'Page<Repo>', uses: 'none', args: () => '{ perPage: 5 }' }),
  repoRead('repos.labels', 'Page<Label>', (p, _, { repo }) => p.repos.labelsPage(repo, perPage)),
  repoRead('repos.milestones', 'Page<Milestone>', (p, _, { repo }) => p.repos.milestonesPage(repo, perPage)),
  // Forges only show who can push to a repository to someone signed in.
  operation('repos.collaborators', { method: 'repos.collaboratorsPage', returns: 'Page<Collaborator>', args: () => 'repo, { perPage: 5 }' }),
  operation('repos.permissionFor', { returns: 'RepoRole', fields: fields('login'), args: ({ value }) => `repo, ${value('login')}` }),
  repoRead('repos.assignableUsers', 'Page<Actor>', (p, _, { repo }) => p.repos.assignableUsersPage(repo, perPage)),
  operation('repos.reviewerCandidates', { method: 'repos.reviewerCandidatesPage', returns: 'Page<Actor>', uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => 'thread, { perPage: 5 }' }),
  operation('repos.createLabel', { returns: 'Label', fields: fields('labelName', 'colour'), args: ({ value }) => `repo, { name: ${value('labelName')}, colour: ${value('colour')} }` }),
  operation('repos.addCollaborator', { fields: fields('login', 'role'), args: ({ value }) => `repo, ${value('login')}, ${value('role')}` }),

  // Threads
  threadRead('threads.get', 'Thread', (p, _, { thread }) => p.threads.get(thread)),
  operation('threads.getMany', { returns: 'GetManyResult[]', uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => '[thread]', run: (p, _, { thread }) => p.threads.getMany([thread]) }),
  operation('threads.list', { method: 'threads.listPage', returns: 'Page<Thread>', fields: fields('kind', 'state'), kind: threadKind, args: ({ value }) => `repo, { kind: ${value('kind')}, state: ${value('state')}, perPage: 5 }`, run: (p, input, { repo }) => p.threads.listPage(repo, { kind: input.kind as 'issue' | 'pull_request', state: input.state as 'open' | 'closed' | 'merged' | 'all', perPage: 5 }) }),
  threadRead('threads.events', 'Page<ForgeEvent>', (p, _, { thread }) => p.threads.eventsPage(thread, perPage)),
  threadRead('threads.comments', 'Page<Comment>', (p, _, { thread }) => p.threads.commentsPage(thread, perPage)),
  threadRead('threads.reactions', 'Page<Reaction>', (p, _, { thread }) => p.threads.reactionsPage(thread, perPage)),
  operation('threads.subscription', { returns: 'SubscriptionState', uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => 'thread' }),
  operation('threads.checks', { returns: 'Page<Check>', uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => 'thread', run: (p, _, { thread }) => p.threads.checks(thread) }),
  threadRead('threads.reviews', 'Page<Review>', (p, _, { thread }) => p.threads.reviewsPage(thread, perPage)),
  threadRead('threads.files', 'Page<ChangedFile>', (p, _, { thread }) => p.threads.filesPage(thread, perPage)),
  threadRead('threads.commits', 'Page<Commit>', (p, _, { thread }) => p.threads.commitsPage(thread, perPage)),
  operation('threads.create', {
    returns: 'Thread',
    fields: input => input.kind === 'pull_request' ? ['kind', 'title', 'body', 'head', 'base'] : ['kind', 'title', 'body', 'labels'],
    kind: threadKind,
    args: ({ value, list, input }) => `repo, {\n  kind: ${value('kind')},\n  title: ${value('title')},\n  body: ${value('body')},\n${input.kind === 'pull_request' ? `  head: ${value('head')},\n  base: ${value('base')},` : `  labels: ${list('labels')},`}\n}`,
  }),
  threadWrite('threads.update', 'Thread', ['title', 'body'], ({ value }) => `thread, { title: ${value('title')}, body: ${value('body')} }`),
  threadWrite('threads.comment', 'Comment', ['body'], ({ value }) => `thread, ${value('body')}`),
  threadWrite('threads.upsertComment', 'UpsertCommentResult', ['key', 'body'], ({ value }) => `thread, { key: ${value('key')}, body: ${value('body')} }`),
  threadWrite('threads.editComment', 'Comment', ['commentId', 'body'], ({ origin, value }) => `{ ${origin}, thread, id: ${value('commentId')} }, ${value('body')}`),
  threadWrite('threads.deleteComment', 'void', ['commentId'], ({ origin, value }) => `{ ${origin}, thread, id: ${value('commentId')} }`),
  threadWrite('threads.close', 'void', ['closeReason'], ({ value }) => `thread, { reason: ${value('closeReason')} }`),
  threadWrite('threads.reopen', 'void', [], () => 'thread'),
  threadWrite('threads.merge', 'void', ['method'], ({ value }) => `thread, { method: ${value('method')} }`),
  threadWrite('threads.approve', 'void', ['body'], ({ value }) => `thread, ${value('body')}`),
  threadWrite('threads.approveAndMerge', 'void', ['method'], ({ value }) => `thread, { method: ${value('method')} }`),
  threadWrite('threads.createReview', 'Review', ['reviewEvent', 'body'], ({ value }) => `thread, { event: ${value('reviewEvent')}, body: ${value('body')} }`),
  threadWrite('threads.submitReview', 'Review', ['reviewId', 'reviewEvent', 'body'], ({ origin, value }) => `{ ${origin}, thread, id: ${value('reviewId')} }, ${value('reviewEvent')}, ${value('body')}`),
  threadWrite('threads.resolveReviewThread', 'void', ['reviewThread'], ({ value }) => `thread, ${value('reviewThread')}`),
  threadWrite('threads.unresolveReviewThread', 'void', ['reviewThread'], ({ value }) => `thread, ${value('reviewThread')}`),
  threadWrite('threads.requestReview', 'void', ['reviewers'], ({ list }) => `thread, ${list('reviewers')}`),
  threadWrite('threads.setAssignees', 'void', ['assignees'], ({ list }) => `thread, ${list('assignees')}`),
  threadWrite('threads.addLabels', 'void', ['labels'], ({ list }) => `thread, ${list('labels')}`),
  threadWrite('threads.removeLabels', 'void', ['labels'], ({ list }) => `thread, ${list('labels')}`),
  threadWrite('threads.setLabels', 'void', ['labels'], ({ list }) => `thread, ${list('labels')}`),
  threadWrite('threads.setMilestone', 'void', ['milestone'], ({ value }) => `thread, ${value('milestone')}`),
  threadWrite('threads.react', 'void', ['reaction'], ({ value }) => `thread, ${value('reaction')}`),
  threadWrite('threads.unreact', 'void', ['reaction'], ({ value }) => `thread, ${value('reaction')}`),
  threadWrite('threads.subscribe', 'void', [], () => 'thread'),
  threadWrite('threads.unsubscribe', 'void', [], () => 'thread'),
  threadWrite('threads.markDuplicate', 'void', ['canonical'], ({ origin, value, input }) => `thread, { ${origin}, repo, kind: '${input.kind}', number: ${value('canonical')} }`),
  threadWrite('threads.transfer', 'ThreadRef', ['targetOwner', 'targetName'], ({ origin, value }) => `thread, { ${origin}, owner: ${value('targetOwner')}, name: ${value('targetName')} }`),

  // Releases
  repoRead('releases.list', 'Page<Release>', (p, _, { repo }) => p.releases.listPage(repo, perPage)),
  operation('releases.get', { returns: 'Release', fields: fields('releaseId'), args: repoChild('repo', 'releaseId'), run: (p, input, { origin, repo }) => p.releases.get({ ...origin, repo, id: input.releaseId }) }),
  operation('releases.getByTag', { returns: 'Release', fields: fields('tag'), args: ({ value }) => `repo, ${value('tag')}`, run: (p, input, { repo }) => p.releases.getByTag(repo, input.tag) }),
  repoRead('releases.latest', 'Release', (p, _, { repo }) => p.releases.latest(repo)),
  operation('releases.downloadAsset', { returns: 'ReadableStream<Uint8Array>', fields: fields('releaseId'), args: ({ origin, value }) => `{ ${origin}, repo, release: { ${origin}, repo, id: ${value('releaseId')} }, id: '1' }` }),

  // Contents
  operation('contents.file', { returns: 'FileContent', fields: fields('path', 'ref'), args: ({ value, input }) => `repo, ${value('path')}, { ${input.ref ? `ref: ${value('ref')}, ` : ''}as: 'text' }`, run: (p, input, { repo }) => p.contents.file(repo, input.path, { ref: input.ref || undefined, as: 'text' }) }),
  operation('contents.tree', { method: 'contents.treePage', returns: 'Page<TreeEntry>', fields: fields('ref'), args: ({ value, input }) => `repo, { ${input.ref ? `ref: ${value('ref')}, ` : ''}perPage: 5 }`, run: (p, input, { repo }) => p.contents.treePage(repo, { ref: input.ref || undefined, perPage: 5 }) }),
  repoRead('contents.branches', 'Page<Branch>', (p, _, { repo }) => p.contents.branchesPage(repo, perPage)),
  repoRead('contents.tags', 'Page<Tag>', (p, _, { repo }) => p.contents.tagsPage(repo, perPage)),
  operation('contents.resolveRef', { returns: 'string', fields: fields('head'), args: ({ value }) => `repo, ${value('head')}`, run: (p, input, { repo }) => p.contents.resolveRef(repo, input.head) }),
  repoRead('contents.commits', 'Page<Commit>', (p, _, { repo }) => p.contents.commitsPage(repo, perPage)),
  operation('contents.commit', { returns: 'Commit', fields: fields('sha'), args: ({ value }) => `repo, ${value('sha')}`, run: (p, input, { repo }) => p.contents.commit(repo, input.sha) }),
  operation('contents.compare', { returns: 'Comparison', fields: fields('base', 'sha'), args: ({ value }) => `repo, ${value('base')}, ${value('sha')}`, run: (p, input, { repo }) => p.contents.compare(repo, input.base, input.sha) }),

  // Checks and CI
  operation('checks.list', { returns: 'Page<Check>', fields: fields('sha'), args: ({ value }) => `repo, ${value('sha')}`, run: (p, input, { repo }) => p.checks.list(repo, input.sha) }),
  operation('checks.report', { returns: 'Check', fields: fields('sha', 'checkName', 'checkState'), args: ({ value }) => `repo, ${value('sha')}, { name: ${value('checkName')}, state: ${value('checkState')} }` }),
  operation('checks.rerun', { fields: fields('checkId'), args: ({ origin, value }) => `{ ${origin}, repo, id: ${value('checkId')}, type: 'check_run' }` }),
  repoRead('ci.runs', 'Page<CiRun>', (p, _, { repo }) => p.ci.runsPage(repo, perPage)),
  operation('ci.run', { returns: 'CiRun', fields: fields('runId'), args: repoChild('repo', 'runId'), run: (p, input, { origin, repo }) => p.ci.run({ ...origin, repo, id: input.runId }) }),
  operation('ci.jobs', { method: 'ci.jobsPage', returns: 'Page<CiJob>', fields: fields('runId'), args: context => `${repoChild('repo', 'runId')(context)}, { perPage: 5 }`, run: (p, input, { origin, repo }) => p.ci.jobsPage({ ...origin, repo, id: input.runId }, perPage) }),
  operation('ci.log', { returns: 'ReadableStream<Uint8Array>', fields: fields('runId'), args: ({ origin, value }) => `{ ${origin}, repo, run: { ${origin}, repo, id: ${value('runId')} }, id: '1' }` }),
  repoRead('securityAlerts.list', 'Page<SecurityAlert>', (p, _, { repo }) => p.securityAlerts.listPage(repo, perPage)),

  // Notifications
  operation('notifications.list', { method: 'notifications.listPage', returns: 'Page<Notification>', uses: 'none', args: () => '{ perPage: 5 }' }),
  operation('notifications.unreadCount', { returns: 'number', uses: 'none', args: () => '' }),
  operation('notifications.markRead', { uses: 'none', fields: fields('notificationId'), args: ({ origin, value }) => `{ ${origin}, id: ${value('notificationId')} }` }),
  operation('notifications.markDone', { uses: 'none', fields: fields('notificationId'), args: ({ origin, value }) => `{ ${origin}, id: ${value('notificationId')} }` }),
  operation('notifications.unsubscribe', { uses: 'none', fields: fields('notificationId'), args: ({ origin, value }) => `{ ${origin}, id: ${value('notificationId')} }` }),
  operation('notifications.markAllRead', { args: () => '{ repo }' }),
  operation('notifications.markAllDone', { args: () => '{ repo }' }),

  // Webhooks
  operation('webhooks.list', { method: 'webhooks.listPage', returns: 'Page<Webhook>', args: () => 'repo, { perPage: 5 }' }),
  operation('webhooks.deliveries', { method: 'webhooks.deliveriesPage', returns: 'Page<WebhookDeliveryRecord>', fields: fields('webhookId'), args: context => `${repoChild('target', 'webhookId')(context)}, { perPage: 5 }` }),
  operation('webhooks.create', { returns: 'Webhook', fields: fields('webhookUrl', 'secret'), args: ({ value }) => `repo, { url: ${value('webhookUrl')}, secret: ${value('secret')}, events: ['comment', 'state_change'] }` }),
  operation('webhooks.update', { returns: 'Webhook', fields: fields('webhookId', 'webhookUrl'), args: context => `${repoChild('target', 'webhookId')(context)}, { url: ${context.value('webhookUrl')} }` }),
  operation('webhooks.delete', { fields: fields('webhookId'), args: repoChild('target', 'webhookId') }),
  operation('webhooks.rotateSecret', { returns: 'Webhook', fields: fields('webhookId', 'secret'), args: context => `${repoChild('target', 'webhookId')(context)}, ${context.value('secret')}` }),
  operation('webhooks.redeliver', { fields: fields('webhookId', 'deliveryId'), args: context => `{ ${context.origin}, hook: ${repoChild('target', 'webhookId')(context)}, id: ${context.value('deliveryId')} }` }),

  // Accounts and search
  operation('users.get', { returns: 'User', uses: 'none', fields: fields('login'), args: ({ value }) => value('login'), run: (p, input) => p.users.get(input.login) }),
  operation('users.me', { returns: 'User', uses: 'none', args: () => '' }),
  operation('search.threads', { method: 'search.threadsPage', returns: 'Page<Thread>', fields: fields('query'), args: ({ value }) => `{ repo, text: ${value('query')}, perPage: 5 }`, run: (p, input, { repo }) => p.search.threadsPage({ repo, text: input.query, perPage: 5 }) }),
  operation('search.repos', { method: 'search.reposPage', returns: 'Page<Repo>', uses: 'none', fields: fields('query'), args: ({ value }) => `{ text: ${value('query')}, perPage: 5 }`, run: (p, input) => p.search.reposPage({ text: input.query, perPage: 5 }) }),
  operation('search.commits', { method: 'search.commitsPage', returns: 'Page<Commit>', fields: fields('query'), args: ({ value }) => `{ repo, text: ${value('query')}, perPage: 5 }`, run: (p, input, { repo }) => p.search.commitsPage({ repo, text: input.query, perPage: 5 }) }),
]

/** The fields an operation shows: the repository's owner and name first, when the call takes the repository. */
export function explorerFields(operation: ExplorerOperation, input: ExplorerInput): ExplorerField[] {
  return [...operation.uses === 'none' ? [] : ['owner', 'name'] as const, ...operation.fields(input)]
}

/** The refs the form describes, for a call. */
export function explorerRefs(provider: ForgeProvider, input: ExplorerInput): Refs {
  const origin = { forge: provider.forge, instance: provider.instance }
  const repo = { ...origin, owner: input.owner, name: input.name }
  return { origin, repo, thread: { ...origin, repo, kind: threadKind(input), number: input.number } }
}

// Private-use characters, which `literal()` strips from the text, delimit the form values in the code.
const START = '\uE000'
const SEPARATOR = '\uE001'
const END = '\uE002'

function literal(text: string): string {
  return `'${text.replace(/[\uE000\uE001\uE002]/g, '').replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`
}

/** Marks a form value, or with an `@` key, a name the page can show a hover for. */
function mark(key: ExplorerField | `@${string}`, code: string): string {
  return `${START}${key}${SEPARATOR}${code}${END}`
}

export interface ExplorerCode {
  text: string
  /** Where each form value sits in `text`, as offsets. */
  values: Array<{ field: ExplorerField, start: number, end: number }>
  /** Where each name with a hover sits in `text`, keyed as in `#explorer-hovers`, or `const:<name>:<type>` for a constant. */
  symbols: Array<{ id: string, start: number, end: number }>
}

const MAX_LINE = 80

/** The length a line shows, without the markers around form values. */
function visibleLength(line: string): number {
  return line.replace(/\uE000[^\uE001]*\uE001|\uE002/g, '').length
}

/** The brackets and commas of `text` that sit outside string literals. */
function structure(text: string): Array<{ index: number, char: string }> {
  const marks: Array<{ index: number, char: string }> = []
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (char === '\\') {
        index++
      }
      else if (char === '\'') {
        quoted = false
      }
    }
    else if (char === '\'') {
      quoted = true
    }
    else if ('{[()]},'.includes(char)) {
      marks.push({ index, char })
    }
  }
  return marks
}

/** Splits `text` at commas outside brackets and string literals. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (const { index, char } of structure(text)) {
    if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
    else if (char !== ',') {
      depth += '{[('.includes(char) ? 1 : -1
    }
  }
  return [...parts, text.slice(start).trim()].filter(Boolean)
}

/** The span of a line's last outermost pair of one kind of bracket, such as the last object literal. */
function lastOutermost(line: string, open: string, close: string): [number, number] | undefined {
  let depth = 0
  let start = -1
  let span: [number, number] | undefined
  for (const { index, char } of structure(line)) {
    if (char === open && depth++ === 0) {
      start = index
    }
    else if (char === close && --depth === 0) {
      span = [start, index]
    }
  }
  return span
}

/** `line` with the contents of `span` as one entry per line, each wrapped again if it is still too long. */
function expand(line: string, [open, close]: [number, number], indent: string): string {
  const entries = splitTopLevel(line.slice(open + 1, close)).map(entry => wrap(`${indent}  ${entry},`))
  return `${line.slice(0, open + 1)}\n${entries.join('\n')}\n${indent}${line.slice(close)}`
}

/**
 * Breaks a line that is too long the way Prettier would: the last object literal one entry per line,
 * or, when what comes before that object is already too long, every argument of the call.
 */
function wrap(line: string): string {
  if (line.includes('\n') || visibleLength(line) <= MAX_LINE) {
    return line
  }
  const indent = /^\s*/.exec(line)![0]
  const object = lastOutermost(line, '{', '}')
  if (object && visibleLength(line.slice(0, object[0] + 1)) <= MAX_LINE) {
    return expand(line, object, indent)
  }
  const call = lastOutermost(line, '(', ')')
  return call && call[1] > call[0] + 1 ? expand(line, call, indent) : line
}

/** The code that makes the same call, and where the form values appear in it. */
export function explorerCode(operation: ExplorerOperation, forge: ExplorerForge, input: ExplorerInput): ExplorerCode {
  const context: CodeContext = {
    input,
    origin: '...origin',
    value: field => mark(field, literal(input[field])),
    list: field => mark(field, `[${listOf(input[field]).map(literal).join(', ')}]`),
  }
  const args = operation.args(context)

  const symbol = (id: string, name: string) => mark(`@${id}`, name)
  const factory = symbol(`factory:${forge.factory}`, forge.factory)
  const factoryOptions = [
    ...Object.entries(forge.options?.(input) ?? {}).map(([key, value]) => `${key}: ${literal(value)}`),
    ...operation.auth || forge.authRequired ? [`auth: ${forge.auth}`] : [],
  ]
    .map(entry => entry.replace(/^(\w+):/, (_, key: string) => `${symbol(`option:${forge.factory}:${key}`, key)}:`))

  const refs: string[] = []
  if (operation.uses !== 'none' || args.includes('...origin')) {
    refs.push(`const ${symbol('const:origin:ForgeOrigin', 'origin')} = { forge: '${forge.forge}', instance: '${forge.instance}' } as const`)
  }
  if (operation.uses !== 'none') {
    refs.push(`const ${symbol('const:repo:RepoRef', 'repo')} = { ...origin, owner: ${context.value('owner')}, name: ${context.value('name')} } as const`)
  }
  if (operation.uses === 'thread') {
    refs.push(`const ${symbol('const:thread:ThreadRef', 'thread')} = { ...origin, repo, kind: ${context.value('kind')}, number: ${context.value('number')} } as const`)
  }
  const [namespace, method] = operation.method.split('.') as [string, string]
  const call = `await forge.${namespace}.${symbol(`method:${operation.method}`, method)}(${args})`

  const marked = [
    `import { ${factory} } from 'forges/${forge.module}'`,
    wrap(`const ${symbol('const:forge:ForgeProvider', 'forge')} = ${factory}(${factoryOptions.length ? `{ ${factoryOptions.join(', ')} }` : ''}).${symbol('create', 'create')}()`),
    ...refs.length ? [refs.map(wrap).join('\n')] : [],
    wrap(operation.returns === 'void' ? call : `const ${symbol(`const:result:${operation.returns}`, 'result')} = ${call}`),
  ].join('\n\n')

  const values: ExplorerCode['values'] = []
  const symbols: ExplorerCode['symbols'] = []
  let text = ''
  let last = 0
  for (const match of marked.matchAll(/\uE000([^\uE001]+)\uE001([^\uE002]*)\uE002/g)) {
    text += marked.slice(last, match.index)
    const [key, code] = [match[1]!, match[2]!]
    const span = { start: text.length, end: text.length + code.length }
    if (key.startsWith('@')) {
      symbols.push({ id: key.slice(1), ...span })
    }
    else {
      values.push({ field: key as ExplorerField, ...span })
    }
    text += code
    last = match.index + match[0].length
  }
  return { text: text + marked.slice(last), values, symbols }
}
