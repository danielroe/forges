import type { CheckState, CloseReason, EventKind, ForgeProvider, ForgeVerb, HideCommentReason, LockReason, MergeMethod, ReactionContent, RepoRef, RepoRole, ReviewEvent, ThreadKind, ThreadRef, UpdateBranchMethod } from 'forges'
import { CAPABILITY_TABLE } from '../../src/capability-table.ts'

/** A form field. Each operation shows the ones it reads, after the repository's owner and name. */
export type ExplorerField
  = | 'owner' | 'name' | 'kind' | 'number' | 'state' | 'path' | 'ref' | 'sha' | 'tag' | 'releaseId' | 'base' | 'head'
    | 'login' | 'query' | 'runId' | 'title' | 'body' | 'labels' | 'assignees' | 'reviewers' | 'method' | 'reaction'
    | 'reviewEvent' | 'reviewId' | 'reviewThread' | 'closeReason' | 'milestone' | 'canonical' | 'targetOwner'
    | 'targetName' | 'labelName' | 'colour' | 'role' | 'team' | 'key' | 'commentId' | 'notificationId' | 'webhookId'
    | 'deliveryId' | 'webhookUrl' | 'secret' | 'checkName' | 'checkState' | 'checkId' | 'branch' | 'message' | 'content'
    | 'updateMethod' | 'lockReason' | 'hideReason'

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
  team: { label: 'Team', default: 'stewards' },
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
  branch: { label: 'Branch', default: 'docs/readme' },
  message: { label: 'Commit message', default: 'docs: update readme' },
  content: { label: 'File contents', default: '# widgets' },
  updateMethod: { label: 'Update method', items: options('merge', 'rebase'), default: 'merge' },
  lockReason: { label: 'Reason', items: options('off_topic', 'too_heated', 'resolved', 'spam'), default: 'too_heated' },
  hideReason: { label: 'Reason', items: options('abuse', 'duplicate', 'low_quality', 'off_topic', 'outdated', 'resolved', 'spam'), default: 'spam' },
}

/** Values for the fields that samples leave out. Writes never run, so these only fill the code. */
const DEFAULTS = Object.fromEntries(Object.entries(EXPLORER_FIELDS).map(([field, config]) => [field, config.default ?? ''])) as ExplorerInput

/** A forge in the explorer. Every one gets the code builder; those whose API accepts CORS requests can also run. */
export interface ExplorerForge {
  name: string
  /** The factory, and the subpath it is imported from. */
  factory: string
  module: string
  /**
   * Imports `module`, which holds `factory`, for the explorer's own providers. Written out per forge, so that the bundler
   * splits each provider into a chunk of its own.
   */
  load: () => Promise<object>
  /** The forge kind, which also keys the forge in the explorer and in links, such as `?forge=forgejo`. */
  forge: string
  instance: string
  /**
   * Credentials the explorer knows for this forge, in preference order. The code reads each field
   * from `env`; a credential the browser can run with is also offered as a form.
   */
  credentials: ExplorerCredential[]
  /** Factory options besides `auth`, passed to the explorer's providers and printed in the code. */
  options?: (input: ExplorerInput) => Record<string, string>
  /** Why calls can't run from a browser, when they can't. */
  blocked?: string
  /** The forge has no anonymous reads, so the code passes `auth` for every call. */
  signedIn?: true
  sample: ExplorerInput
}

/** One field of a credential, as the environment guide names it. */
export interface ExplorerCredentialField {
  /** The field name, such as `TOKEN`, `USERNAME` or `PRIVATE_KEY`. */
  field: string
  /** The environment variable the generated code reads, when the value is not fixed in the code. */
  env?: string
  /** A value the generated code writes literally, such as a sample account identifier. */
  value?: string
  /** Left out of the call when empty. */
  optional?: boolean
}

/** A credential the explorer accepts for a forge. */
export interface ExplorerCredential {
  /** The `auth.type` the credential builds. */
  kind: 'token' | 'basic' | 'app' | 'app_password'
  /** The fields the person fills in, in the order the code passes them. */
  fields: ExplorerCredentialField[]
  /**
   * Whether the browser can make a call with this credential, so the form offers it. False for the kinds
   * the explorer doesn't build (app, app_password) and for forges that refuse browsers.
   */
  runnable: boolean
}

/** An `auth` option with the secrets filled in. */
export type ExplorerAuth
  = | { type: 'token', token: string }
    | { type: 'basic', username: string, password: string }
    | { type: 'app', appId: string, privateKey: string, installationId?: string }
    | { type: 'app_password', identifier: string, password: string, pds?: string }

/** The environment variable a credential field reads, or the field name itself when there is none. */
function envOf(credential: ExplorerCredential, field: string): string {
  return credential.fields.find(entry => entry.field === field)?.env ?? field
}

/** Whether a credential carries `field`, and it holds a value. */
function has(credential: ExplorerCredential, values: Record<string, string>, field: string): boolean {
  return credential.fields.some(entry => entry.field === field) && Boolean(values[field]?.trim())
}

/** `auth` as code: each secret read from the environment, and each fixed value written as it is. */
export function authCode(credential: ExplorerCredential): string {
  const read = (field: string) => {
    const value = credential.fields.find(entry => entry.field === field)?.value
    return value === undefined ? `process.env.${envOf(credential, field)}!` : literal(value)
  }
  switch (credential.kind) {
    case 'token':
      return `{ type: 'token', token: ${read('TOKEN')} }`
    case 'basic':
      return `{ type: 'basic', username: ${read('USERNAME')}, password: ${read('PASSWORD')} }`
    case 'app':
      return `{ type: 'app', appId: ${read('APP_ID')}, privateKey: ${read('PRIVATE_KEY')} }`
    case 'app_password':
      return `{ type: 'app_password', identifier: ${read('IDENTIFIER')}, password: ${read('PASSWORD')} }`
  }
}

/** `auth` with placeholder secrets, for a provider that reports what calls with credentials support. */
export function placeholderAuth(credential: ExplorerCredential): ExplorerAuth {
  switch (credential.kind) {
    case 'token':
      return { type: 'token', token: 'placeholder' }
    case 'basic':
      return { type: 'basic', username: 'placeholder', password: 'placeholder' }
    case 'app':
      return { type: 'app', appId: 'placeholder', privateKey: 'placeholder' }
    case 'app_password':
      return { type: 'app_password', identifier: 'placeholder', password: 'placeholder' }
  }
}

/** The `auth` option for a real call, from the values the person typed. */
export function authFromValues(credential: ExplorerCredential, values: Record<string, string>): ExplorerAuth {
  switch (credential.kind) {
    case 'token':
      return { type: 'token', token: values.TOKEN!.trim() }
    case 'basic':
      return { type: 'basic', username: values.USERNAME!.trim(), password: values.PASSWORD!.trim() }
    case 'app':
      return {
        type: 'app',
        appId: values.APP_ID!.trim(),
        privateKey: values.PRIVATE_KEY!.replaceAll('\\n', '\n'),
        ...has(credential, values, 'INSTALLATION_ID') ? { installationId: values.INSTALLATION_ID!.trim() } : {},
      }
    case 'app_password':
      return {
        type: 'app_password',
        identifier: values.IDENTIFIER!.trim(),
        password: values.PASSWORD!.trim(),
        ...has(credential, values, 'PDS') ? { pds: values.PDS!.trim() } : {},
      }
  }
}

/** Whether every required field of a credential holds a value. */
export function isCredentialComplete(credential: ExplorerCredential, values: Record<string, string>): boolean {
  return credential.fields.every(entry => entry.optional || Boolean(values[entry.field]?.trim()))
}

const token = (env: string, runnable = true): ExplorerCredential => ({ kind: 'token', fields: [{ field: 'TOKEN', env }], runnable })
const basic = (env: string): ExplorerCredential => ({ kind: 'basic', fields: [{ field: 'USERNAME', env: `${env}_USERNAME` }, { field: 'PASSWORD', env: `${env}_PASSWORD` }], runnable: true })
const app = (env: string): ExplorerCredential => ({ kind: 'app', fields: [{ field: 'APP_ID', env: `${env}_APP_ID` }, { field: 'PRIVATE_KEY', env: `${env}_PRIVATE_KEY` }, { field: 'INSTALLATION_ID', env: `${env}_INSTALLATION_ID`, optional: true }], runnable: false })

function sample(values: Partial<ExplorerInput>): ExplorerInput {
  const merged = { ...DEFAULTS, ...values }
  return { ...merged, base: merged.base || merged.tag || merged.sha, head: merged.head || 'main' }
}

// Runnable samples are public repositories that respond to anonymous requests: a merged pull request, its author,
// the latest release, a commit and its parent (a small diff to compare), and a CI run, where the forge has them.
// The forges are in the order of the capability matrix.
export const EXPLORER_FORGES: ExplorerForge[] = [
  { name: 'GitHub', factory: 'github', module: 'github', load: () => import('forges/github'), forge: 'github', instance: 'github.com', credentials: [token('GITHUB_TOKEN'), app('GITHUB')], sample: sample({ owner: 'nuxt', name: 'nuxt', number: '36506', login: 'atinux', tag: 'v4.6.0', releaseId: '404130846', sha: '0296ca413dc7ab2e29555e7109f35581b81d5c41', base: '85b8d54f6ce49f4d0f199e90513b1e5d5fa22196', head: 'main', runId: '37772560463' }) },
  { name: 'GitLab', factory: 'gitlab', module: 'gitlab', load: () => import('forges/gitlab'), forge: 'gitlab', instance: 'gitlab.com', credentials: [token('GITLAB_TOKEN')], sample: sample({ owner: 'inkscape', name: 'inkscape', number: '8209', login: 'guillaume.turri', tag: 'INKSCAPE_1_4', releaseId: 'INKSCAPE_1_4', sha: '10b831ed45817ecb05f7c6239fe97d56c196c9cc', base: '41d0bb9160ba8c4e8b31d07c301f83b4e43771e3', head: 'master', runId: '2926543070' }) },
  { name: 'Bitbucket', factory: 'bitbucket', module: 'bitbucket', load: () => import('forges/bitbucket'), forge: 'bitbucket', instance: 'bitbucket.org', credentials: [token('BITBUCKET_TOKEN'), basic('BITBUCKET')], sample: sample({ owner: 'tutorials', name: 'markdowndemo', number: '80', login: 'brennan', sha: '5b6c39df3196eeeb8a36684beb9a3df854a0b5f3', base: '59a1e452abc40869b12cf13f476531bf5774d0d0', head: 'master' }) },
  { name: 'Codeberg', factory: 'forgejo', module: 'forgejo', load: () => import('forges/forgejo'), forge: 'forgejo', instance: 'codeberg.org', credentials: [token('CODEBERG_TOKEN')], sample: sample({ owner: 'forgejo', name: 'forgejo', number: '14752', login: '0ko', tag: 'v16.0.5', releaseId: '12250357', sha: 'd915e5a5abb92527ac7fd0d60997b5fc57cf8467', base: 'adfdb1a53298d953669fcf49d61393a32b256fb5', head: 'forgejo', runId: '7600293' }) },
  { name: 'Gitea', factory: 'gitea', module: 'gitea', load: () => import('forges/gitea'), forge: 'gitea', instance: 'gitea.com', credentials: [token('GITEA_TOKEN')], sample: sample({ owner: 'gitea', name: 'tea', number: '1081', login: 'appleboy', tag: 'v0.16.0', releaseId: '945508', sha: 'bcd62a1fb2ce6fdd51ebea91cc33ddbcae000b68', base: '6daaa7c05e7883d4468fc7b40c2f71e0ea75562a', head: 'main' }) },
  { name: 'Gitee', factory: 'gitee', module: 'gitee', load: () => import('forges/gitee'), forge: 'gitee', instance: 'gitee.com', credentials: [token('GITEE_TOKEN')], sample: sample({ owner: 'mindspore', name: 'mindspore', number: '91608', login: 'liangchenghui', tag: 'v2.7.2', releaseId: '569215', sha: '0487e01a5e79464fcaf8ac90d9121f9f7a679a24', base: '6de371cd62ddc66dcf20e1843dfe15f31998342c', head: 'master' }) },
  {
    name: 'Azure DevOps',
    factory: 'azureDevOps',
    module: 'azure-devops',
    load: () => import('forges/azure-devops'),
    forge: 'azure-devops',
    instance: 'dev.azure.com',
    credentials: [token('AZURE_DEVOPS_TOKEN'), basic('AZURE_DEVOPS')],
    options: input => ({ organization: input.owner.split('/')[0]! }),
    blocked: 'Azure DevOps rejects most anonymous requests, even for public projects.',
    sample: sample({ owner: 'acme/Widgets', name: 'widgets', number: '42', login: 'alice', sha: 'main', tag: 'v1.0.0', releaseId: '1', runId: '1' }),
  },
  { name: 'Cursor Origin', factory: 'cursorOrigin', module: 'cursor-origin', load: () => import('forges/cursor-origin'), forge: 'cursor-origin', instance: 'origin.cursor.com', credentials: [token('CURSOR_AUTH_TOKEN'), app('CURSOR')], sample: sample({ owner: 'acme', name: 'api', number: '42', login: 'alice', sha: 'main', tag: 'v1.0.0', releaseId: '1', runId: '1' }) },
  { name: 'pushin.eu', factory: 'pushin', module: 'pushin', load: () => import('forges/pushin'), forge: 'pushin', instance: 'pushin.eu', credentials: [token('PUSHIN_TOKEN', false)], blocked: 'The pushin.eu API doesn\'t allow requests from browsers.', sample: sample({ owner: 'pjullrich', name: 'pushin', number: '1', login: 'pjullrich', sha: 'main', tag: 'v1.0.0', releaseId: '1', runId: '1' }) },
  {
    name: 'Tangled',
    factory: 'tangled',
    module: 'tangled',
    load: () => import('forges/tangled'),
    forge: 'tangled',
    instance: 'tangled.org',
    // The sample identifier is literal, like the provider page, so only the password comes from the environment.
    credentials: [{ kind: 'app_password', fields: [{ field: 'IDENTIFIER', value: 'alice.example.com' }, { field: 'PASSWORD', env: 'TANGLED_APP_PASSWORD' }, { field: 'PDS', env: 'TANGLED_PDS', optional: true }], runnable: false }],
    // Reading through the index and a records cache takes a few requests, rather than one to each author's server.
    options: () => ({ listSource: 'index', recordsUrl: 'https://slingshot.microcosm.blue' }),
    // A Tangled thread's number is the AT-URI of its record.
    sample: sample({ owner: 'tangled.org', name: 'core', number: 'at://did:plc:xasnlahkri4ewmbuzly2rlc5/sh.tangled.repo.pull/3mwqc5pt6dc5d', login: 'boltless.me' }),
  },
  {
    name: 'Cloudflare Artifacts',
    factory: 'cloudflareArtifacts',
    module: 'cloudflare-artifacts',
    load: () => import('forges/cloudflare-artifacts'),
    forge: 'cloudflare-artifacts',
    instance: '023e105f4ecef8ad9ca31a8372d0c353.artifacts.cloudflare.net',
    credentials: [token('CLOUDFLARE_ARTIFACTS_TOKEN', false)],
    options: () => ({ accountId: '023e105f4ecef8ad9ca31a8372d0c353' }),
    blocked: 'The Cloudflare API doesn\'t allow requests from browsers, and Artifacts has no anonymous reads.',
    signedIn: true,
    sample: sample({ owner: 'forges-fixtures', name: 'forges', sha: 'main' }),
  },
  {
    name: 'Sourcehut',
    factory: 'sourcehut',
    module: 'sourcehut',
    load: () => import('forges/sourcehut'),
    forge: 'sourcehut',
    instance: 'sr.ht',
    credentials: [token('SOURCEHUT_TOKEN', false)],
    blocked: 'Sourcehut needs a token for every read, and its GraphQL services don\'t allow browser requests.',
    signedIn: true,
    // An issue lives on the repository's tracker, but a patchset lives on a mailing list, so the sample's
    // number is the scdoc issue and a patch call reads the `scdoc` list, which has none.
    sample: sample({ owner: '~sircmpwn', name: 'scdoc', number: '6', login: '~sircmpwn', sha: '24be30ef17d5ca0162f11b35258c8fa2413d556a', tag: '1.10.1', releaseId: '1.10.1', base: 'master', head: 'master', runId: '1' }),
  },
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
  /** The code reads one page of the listing with `page()`. */
  page: boolean
  /** The type it resolves to, such as `Thread`, `Page<Thread>` or `Release | undefined`, for the hovers on the result; `void` when it resolves to nothing. */
  returns: string
  /** The refs the code declares before the call. */
  uses: 'none' | 'repo' | 'thread'
  fields: (input: ExplorerInput) => ExplorerField[]
  /** The thread kind that support depends on, if any. */
  kind?: (input: ExplorerInput) => ThreadKind
  args: (context: CodeContext) => string
  /**
   * Present when the explorer can make the call: a read with an anonymous provider or the person's credential,
   * a write only after a confirmation. Streams can't run yet.
   */
  run?: (provider: ForgeProvider, input: ExplorerInput, refs: Refs) => Promise<unknown>
  /** A write or a read of the account, so the code always passes `auth`. */
  auth: boolean
  /** The call changes state, so the explorer asks for confirmation before running it. */
  mutates: boolean
}

const listOf = (text: string) => text.split(',').map(item => item.trim()).filter(Boolean)
const fields = (...names: ExplorerField[]) => () => names
const threadKind = (input: ExplorerInput) => input.kind as ThreadKind
const perPage = { perPage: 5 }

/** Verbs that need credentials on every forge: the capability table's writes and account reads. */
const SIGNED_IN = new Set(CAPABILITY_TABLE.flatMap(entry => entry.write || entry.account ? entry.verbs ?? [] : []))
/** Verbs that change state, which the explorer confirms before running. */
const WRITES = new Set(CAPABILITY_TABLE.flatMap(entry => entry.write ? entry.verbs ?? [] : []))
const LISTINGS = new Set(CAPABILITY_TABLE.flatMap(entry => entry.listings ?? []))

type Spec = Omit<ExplorerOperation, 'verb' | 'page' | 'fields' | 'uses' | 'returns' | 'auth' | 'mutates'> & Partial<Pick<ExplorerOperation, 'fields' | 'uses' | 'returns' | 'auth'>>

function operation(verb: string, spec: Spec): ExplorerOperation {
  // `auth` can override the table for a read that a forge only serves to signed-in users, such as security alerts.
  const auth = spec.auth ?? SIGNED_IN.has(verb)
  const returns = spec.returns ?? 'void'
  return { verb: verb as ForgeVerb, uses: 'repo', fields: fields(), ...spec, returns, page: LISTINGS.has(verb), auth, mutates: WRITES.has(verb) }
}

/** A read on a repository, of one page for listings. */
function repoRead(verb: string, returns: string, run: NonNullable<Spec['run']>): ExplorerOperation {
  return operation(verb, { returns, args: () => LISTINGS.has(verb) ? 'repo, { perPage: 5 }' : 'repo', run })
}

/** A read on a thread, of one page for listings. */
function threadRead(verb: string, returns: string, run: NonNullable<Spec['run']>): ExplorerOperation {
  return operation(verb, { returns, uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => LISTINGS.has(verb) ? 'thread, { perPage: 5 }' : 'thread', run })
}

/** A write on a thread. */
function threadWrite(verb: string, returns: string, extra: ExplorerField[], args: Spec['args'], run: Spec['run']): ExplorerOperation {
  return operation(verb, { returns, uses: 'thread', fields: () => ['kind', 'number', ...extra], kind: threadKind, args, run })
}

/** A ref to something on the repository, such as a webhook, written out in full. */
const repoChild = (key: string, field: ExplorerField) => ({ origin, value }: CodeContext) => `{ ${origin}, ${key === 'repo' ? 'repo' : `${key}: repo`}, id: ${value(field)} }`

export const EXPLORER_OPERATIONS: ExplorerOperation[] = [
  // Repositories
  repoRead('repos.get', 'Repo', (p, _, { repo }) => p.repos.get(repo)),
  operation('repos.list', { returns: 'Page<Repo>', uses: 'none', args: () => '{ perPage: 5 }', run: p => p.repos.list(perPage).page() }),
  operation('repos.byOwner', { returns: 'Page<Repo>', uses: 'none', fields: fields('owner'), args: ({ origin, value }) => `{ ${origin}, owner: ${value('owner')}, name: '', kind: 'namespace' }, { perPage: 5 }`, run: (p, input, { origin }) => p.repos.byOwner({ ...origin, owner: input.owner, name: '', kind: 'namespace' }, perPage).page() }),
  repoRead('repos.labels', 'Page<Label>', (p, _, { repo }) => p.repos.labels(repo, perPage).page()),
  repoRead('repos.milestones', 'Page<Milestone>', (p, _, { repo }) => p.repos.milestones(repo, perPage).page()),
  repoRead('repos.collaborators', 'Page<Collaborator>', (p, _, { repo }) => p.repos.collaborators(repo, perPage).page()),
  repoRead('repos.contributors', 'Page<Contributor>', (p, _, { repo }) => p.repos.contributors(repo, perPage).page()),
  repoRead('repos.contributorStats', 'ContributorStats[]', (p, _, { repo }) => p.repos.contributorStats(repo)),
  repoRead('repos.templates', 'RepoTemplate[]', (p, _, { repo }) => p.repos.templates(repo)),
  operation('repos.permissionFor', { returns: 'RepoRole', auth: true, fields: fields('login'), args: ({ value }) => `repo, ${value('login')}`, run: (p, input, { repo }) => p.repos.permissionFor(repo, input.login) }),
  repoRead('repos.assignableUsers', 'Page<Actor>', (p, _, { repo }) => p.repos.assignableUsers(repo, perPage).page()),
  repoRead('repos.events', 'Page<ForgeEvent>', (p, _, { repo }) => p.repos.events(repo, perPage).page()),
  operation('repos.reviewerCandidates', { returns: 'Page<Actor>', uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => 'thread, { perPage: 5 }', run: (p, _, { thread }) => p.repos.reviewerCandidates(thread, perPage).page() }),
  operation('repos.createLabel', { returns: 'Label', fields: fields('labelName', 'colour'), args: ({ value }) => `repo, { name: ${value('labelName')}, colour: ${value('colour')} }`, run: (p, input, { repo }) => p.repos.createLabel(repo, { name: input.labelName, colour: input.colour }) }),
  operation('repos.addCollaborator', { returns: 'AddCollaboratorResult', fields: fields('login', 'role'), args: ({ value }) => `repo, ${value('login')}, ${value('role')}`, run: (p, input, { repo }) => p.repos.addCollaborator(repo, input.login, input.role as RepoRole) }),

  // Organisation teams
  operation('orgs.teams', { returns: 'Page<Team>', uses: 'none', fields: fields('owner'), args: ({ origin, value }) => `{ ${origin}, owner: ${value('owner')}, name: '', kind: 'namespace' }, { perPage: 5 }`, run: (p, input, { origin }) => p.orgs.teams({ ...origin, owner: input.owner, name: '', kind: 'namespace' }, perPage).page() }),
  operation('orgs.block', { uses: 'none', fields: fields('owner', 'login'), args: ({ origin, value }) => `{ ${origin}, owner: ${value('owner')}, name: '', kind: 'namespace' }, ${value('login')}`, run: (p, input, { origin }) => p.orgs.block({ ...origin, owner: input.owner, name: '', kind: 'namespace' }, input.login) }),
  operation('orgs.unblock', { uses: 'none', fields: fields('owner', 'login'), args: ({ origin, value }) => `{ ${origin}, owner: ${value('owner')}, name: '', kind: 'namespace' }, ${value('login')}`, run: (p, input, { origin }) => p.orgs.unblock({ ...origin, owner: input.owner, name: '', kind: 'namespace' }, input.login) }),
  operation('orgs.teamMembers', { returns: 'Page<Actor>', uses: 'none', fields: fields('owner', 'team'), args: ({ origin, value }) => `{ ${origin}, org: { ${origin}, owner: ${value('owner')}, name: '', kind: 'namespace' }, slug: ${value('team')} }, { perPage: 5 }`, run: (p, input, { origin }) => p.orgs.teamMembers({ ...origin, org: { ...origin, owner: input.owner, name: '', kind: 'namespace' }, slug: input.team }, perPage).page() }),

  // Threads
  threadRead('threads.get', 'Thread', (p, _, { thread }) => p.threads.get(thread)),
  operation('threads.getMany', { returns: 'GetManyResult[]', uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => '[thread]', run: (p, _, { thread }) => p.threads.getMany([thread]) }),
  operation('threads.list', { returns: 'Page<Thread>', fields: fields('kind', 'state'), kind: threadKind, args: ({ value }) => `repo, { kind: ${value('kind')}, state: ${value('state')}, perPage: 5 }`, run: (p, input, { repo }) => p.threads.list(repo, { kind: input.kind as 'issue' | 'pull_request', state: input.state as 'open' | 'closed' | 'merged' | 'all', perPage: 5 }).page() }),
  threadRead('threads.closingIssues', 'Page<Thread>', (p, _, { thread }) => p.threads.closingIssues(thread, perPage).page()),
  threadRead('threads.closingPullRequests', 'Page<Thread>', (p, _, { thread }) => p.threads.closingPullRequests(thread, perPage).page()),
  threadRead('threads.events', 'Page<ForgeEvent>', (p, _, { thread }) => p.threads.events(thread, perPage).page()),
  threadRead('threads.comments', 'Page<Comment>', (p, _, { thread }) => p.threads.comments(thread, perPage).page()),
  threadRead('threads.reactions', 'Page<Reaction>', (p, _, { thread }) => p.threads.reactions(thread, perPage).page()),
  operation('threads.subscription', { returns: 'SubscriptionState', uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => 'thread', run: (p, _, { thread }) => p.threads.subscription(thread) }),
  operation('threads.checks', { returns: 'Page<Check>', uses: 'thread', fields: fields('kind', 'number'), kind: threadKind, args: () => 'thread', run: (p, _, { thread }) => p.threads.checks(thread) }),
  threadRead('threads.reviews', 'Page<Review>', (p, _, { thread }) => p.threads.reviews(thread, perPage).page()),
  threadRead('threads.files', 'Page<ChangedFile>', (p, _, { thread }) => p.threads.files(thread, perPage).page()),
  threadRead('threads.commits', 'Page<Commit>', (p, _, { thread }) => p.threads.commits(thread, perPage).page()),
  operation('threads.create', {
    returns: 'Thread',
    fields: input => input.kind === 'pull_request' ? ['kind', 'title', 'body', 'head', 'base'] : ['kind', 'title', 'body', 'labels'],
    kind: threadKind,
    args: ({ value, list, input }) => `repo, {\n  kind: ${value('kind')},\n  title: ${value('title')},\n  body: ${value('body')},\n${input.kind === 'pull_request' ? `  head: ${value('head')},\n  base: ${value('base')},` : `  labels: ${list('labels')},`}\n}`,
    run: (p, input, { repo }) => input.kind === 'pull_request'
      ? p.threads.create(repo, { kind: 'pull_request', title: input.title, body: input.body, head: input.head, base: input.base })
      : p.threads.create(repo, { kind: 'issue', title: input.title, body: input.body, labels: listOf(input.labels) }),
  }),
  threadWrite('threads.update', 'Thread', ['title', 'body'], ({ value }) => `thread, { title: ${value('title')}, body: ${value('body')} }`, (p, input, { thread }) => p.threads.update(thread, { title: input.title, body: input.body })),
  threadWrite('threads.createComment', 'Comment', ['body'], ({ value }) => `thread, ${value('body')}`, (p, input, { thread }) => p.threads.createComment(thread, input.body)),
  threadWrite('threads.updateComment', 'Comment', ['commentId', 'body'], ({ origin, value }) => `{ ${origin}, thread, id: ${value('commentId')} }, ${value('body')}`, (p, input, { origin, thread }) => p.threads.updateComment({ ...origin, thread, id: input.commentId }, input.body)),
  threadWrite('threads.deleteComment', 'void', ['commentId'], ({ origin, value }) => `{ ${origin}, thread, id: ${value('commentId')} }`, (p, input, { origin, thread }) => p.threads.deleteComment({ ...origin, thread, id: input.commentId })),
  threadWrite('threads.hideComment', 'void', ['commentId', 'hideReason'], ({ origin, value }) => `{ ${origin}, thread, id: ${value('commentId')} }, ${value('hideReason')}`, (p, input, { origin, thread }) => p.threads.hideComment({ ...origin, thread, id: input.commentId }, input.hideReason as HideCommentReason)),
  threadWrite('threads.unhideComment', 'void', ['commentId'], ({ origin, value }) => `{ ${origin}, thread, id: ${value('commentId')} }`, (p, input, { origin, thread }) => p.threads.unhideComment({ ...origin, thread, id: input.commentId })),
  threadWrite('threads.close', 'Thread', ['closeReason'], ({ value }) => `thread, { reason: ${value('closeReason')} }`, (p, input, { thread }) => p.threads.close(thread, { reason: input.closeReason as CloseReason })),
  threadWrite('threads.reopen', 'Thread', [], () => 'thread', (p, _, { thread }) => p.threads.reopen(thread)),
  threadWrite('threads.lock', 'void', ['lockReason'], ({ value }) => `thread, { reason: ${value('lockReason')} }`, (p, input, { thread }) => p.threads.lock(thread, { reason: input.lockReason as LockReason })),
  threadWrite('threads.unlock', 'void', [], () => 'thread', (p, _, { thread }) => p.threads.unlock(thread)),
  threadWrite('threads.merge', 'MergeResult', ['method'], ({ value }) => `thread, { method: ${value('method')} }`, (p, input, { thread }) => p.threads.merge(thread, { method: input.method as MergeMethod })),
  threadWrite('threads.updateBranch', 'UpdateBranchResult', ['updateMethod'], ({ value }) => `thread, { method: ${value('updateMethod')} }`, (p, input, { thread }) => p.threads.updateBranch(thread, { method: input.updateMethod as UpdateBranchMethod })),
  threadWrite('threads.approve', 'Review', ['body'], ({ value }) => `thread, ${value('body')}`, (p, input, { thread }) => p.threads.approve(thread, input.body)),
  threadWrite('threads.createReview', 'Review', ['reviewEvent', 'body'], ({ value }) => `thread, { event: ${value('reviewEvent')}, body: ${value('body')} }`, (p, input, { thread }) => p.threads.createReview(thread, { event: input.reviewEvent as ReviewEvent, body: input.body })),
  threadWrite('threads.submitReview', 'Review', ['reviewId', 'reviewEvent', 'body'], ({ origin, value }) => `{ ${origin}, thread, id: ${value('reviewId')} }, ${value('reviewEvent')}, ${value('body')}`, (p, input, { origin, thread }) => p.threads.submitReview({ ...origin, thread, id: input.reviewId }, input.reviewEvent as ReviewEvent, input.body)),
  threadWrite('threads.replyToReviewComment', 'ReviewComment', ['commentId', 'reviewThread', 'body'], ({ origin, value }) => `thread, {\n  ref: { ${origin}, thread, id: ${value('commentId')} },\n  thread: { id: ${value('reviewThread')}, resolved: false },\n}, ${value('body')}`, (p, input, { origin, thread }) => p.threads.replyToReviewComment(thread, { ref: { ...origin, thread: { ...thread, number: thread.number ?? '' }, id: input.commentId }, thread: { id: input.reviewThread, resolved: false } }, input.body)),
  threadWrite('threads.resolveReviewThread', 'void', ['reviewThread'], ({ value }) => `thread, ${value('reviewThread')}`, (p, input, { thread }) => p.threads.resolveReviewThread(thread, input.reviewThread)),
  threadWrite('threads.unresolveReviewThread', 'void', ['reviewThread'], ({ value }) => `thread, ${value('reviewThread')}`, (p, input, { thread }) => p.threads.unresolveReviewThread(thread, input.reviewThread)),
  threadWrite('threads.requestReview', 'void', ['reviewers'], ({ list }) => `thread, ${list('reviewers')}`, (p, input, { thread }) => p.threads.requestReview(thread, listOf(input.reviewers))),
  threadWrite('threads.setAssignees', 'Actor[]', ['assignees'], ({ list }) => `thread, ${list('assignees')}`, (p, input, { thread }) => p.threads.setAssignees(thread, listOf(input.assignees))),
  threadWrite('threads.addLabels', 'Label[]', ['labels'], ({ list }) => `thread, ${list('labels')}`, (p, input, { thread }) => p.threads.addLabels(thread, listOf(input.labels))),
  threadWrite('threads.removeLabels', 'Label[]', ['labels'], ({ list }) => `thread, ${list('labels')}`, (p, input, { thread }) => p.threads.removeLabels(thread, listOf(input.labels))),
  threadWrite('threads.setLabels', 'Label[]', ['labels'], ({ list }) => `thread, ${list('labels')}`, (p, input, { thread }) => p.threads.setLabels(thread, listOf(input.labels))),
  threadWrite('threads.setMilestone', 'Milestone | undefined', ['milestone'], ({ value }) => `thread, ${value('milestone')}`, (p, input, { thread }) => p.threads.setMilestone(thread, input.milestone)),
  threadWrite('threads.react', 'void', ['reaction'], ({ value }) => `thread, ${value('reaction')}`, (p, input, { thread }) => p.threads.react(thread, input.reaction as ReactionContent)),
  threadWrite('threads.unreact', 'void', ['reaction'], ({ value }) => `thread, ${value('reaction')}`, (p, input, { thread }) => p.threads.unreact(thread, input.reaction as ReactionContent)),
  threadWrite('threads.subscribe', 'void', [], () => 'thread', (p, _, { thread }) => p.threads.subscribe(thread)),
  threadWrite('threads.unsubscribe', 'void', [], () => 'thread', (p, _, { thread }) => p.threads.unsubscribe(thread)),
  threadWrite('threads.markDuplicate', 'void', ['canonical'], ({ origin, value, input }) => `thread, { ${origin}, repo, kind: '${input.kind}', number: ${value('canonical')} }`, (p, input, { origin, thread }) => p.threads.markDuplicate(thread, { ...origin, repo: thread.repo, kind: input.kind as ThreadKind, number: input.canonical })),
  threadWrite('threads.transfer', 'ResolvedThreadRef', ['targetOwner', 'targetName'], ({ origin, value }) => `thread, { ${origin}, owner: ${value('targetOwner')}, name: ${value('targetName')} }`, (p, input, { origin, thread }) => p.threads.transfer(thread, { ...origin, owner: input.targetOwner, name: input.targetName })),

  // Releases
  repoRead('releases.list', 'Page<Release>', (p, _, { repo }) => p.releases.list(repo, perPage).page()),
  operation('releases.get', { returns: 'Release', fields: fields('releaseId'), args: repoChild('repo', 'releaseId'), run: (p, input, { origin, repo }) => p.releases.get({ ...origin, repo, id: input.releaseId }) }),
  operation('releases.getByTag', { returns: 'Release', fields: fields('tag'), args: ({ value }) => `repo, ${value('tag')}`, run: (p, input, { repo }) => p.releases.getByTag(repo, input.tag) }),
  repoRead('releases.latest', 'Release | undefined', (p, _, { repo }) => p.releases.latest(repo)),
  operation('releases.downloadAsset', { returns: 'ReadableStream<Uint8Array>', fields: fields('releaseId'), args: ({ origin, value }) => `{ ${origin}, repo, release: { ${origin}, repo, id: ${value('releaseId')} }, id: '1' }` }),

  // Contents
  operation('contents.getFile', { returns: 'FileContent', fields: fields('path', 'ref'), args: ({ value, input }) => `repo, ${value('path')}, { ${input.ref ? `ref: ${value('ref')}, ` : ''}as: 'text' }`, run: (p, input, { repo }) => p.contents.getFile(repo, input.path, { ref: input.ref || undefined, as: 'text' }) }),
  operation('contents.tree', { returns: 'Page<TreeEntry>', fields: fields('ref'), args: ({ value, input }) => `repo, { ${input.ref ? `ref: ${value('ref')}, ` : ''}perPage: 5 }`, run: (p, input, { repo }) => p.contents.tree(repo, { ref: input.ref || undefined, perPage: 5 }).page() }),
  repoRead('contents.branches', 'Page<Branch>', (p, _, { repo }) => p.contents.branches(repo, perPage).page()),
  repoRead('contents.tags', 'Page<Tag>', (p, _, { repo }) => p.contents.tags(repo, perPage).page()),
  operation('contents.resolveRef', { returns: 'string', fields: fields('head'), args: ({ value }) => `repo, ${value('head')}`, run: (p, input, { repo }) => p.contents.resolveRef(repo, input.head) }),
  repoRead('commits.list', 'Page<Commit>', (p, _, { repo }) => p.commits.list(repo, perPage).page()),
  operation('commits.get', { returns: 'Commit', fields: fields('sha'), args: ({ value }) => `{ forge: repo.forge, instance: repo.instance, repo, sha: ${value('sha')} }`, run: (p, input, { repo }) => p.commits.get({ forge: repo.forge, instance: repo.instance, repo, sha: input.sha }) }),
  operation('contents.compare', { returns: 'Comparison', fields: fields('base', 'sha'), args: ({ value }) => `repo, ${value('base')}, ${value('sha')}`, run: (p, input, { repo }) => p.contents.compare(repo, input.base, input.sha) }),
  operation('contents.commitFiles', { returns: 'Commit', fields: fields('branch', 'message', 'path', 'content'), args: ({ value }) => `repo, {\n  branch: ${value('branch')},\n  message: ${value('message')},\n  changes: [{ path: ${value('path')}, content: ${value('content')} }],\n}`, run: (p, input, { repo }) => p.contents.commitFiles(repo, { branch: input.branch, message: input.message, changes: [{ path: input.path, content: input.content }] }) }),

  // Checks and CI
  operation('checks.list', { returns: 'Page<Check>', fields: fields('sha'), args: ({ value }) => `repo, ${value('sha')}`, run: (p, input, { repo }) => p.checks.list(repo, input.sha) }),
  operation('checks.report', { returns: 'Check', fields: fields('sha', 'checkName', 'checkState'), args: ({ value }) => `repo, ${value('sha')}, { name: ${value('checkName')}, state: ${value('checkState')} }`, run: (p, input, { repo }) => p.checks.report(repo, input.sha, { name: input.checkName, state: input.checkState as Exclude<CheckState, 'unknown'> }) }),
  operation('checks.rerun', { fields: fields('checkId'), args: ({ origin, value }) => `{ ${origin}, repo, id: ${value('checkId')}, type: 'check_run' }`, run: (p, input, { origin, repo }) => p.checks.rerun({ ...origin, repo, id: input.checkId, type: 'check_run' }) }),
  repoRead('ci.runs', 'Page<CiRun>', (p, _, { repo }) => p.ci.runs(repo, perPage).page()),
  operation('ci.getRun', { returns: 'CiRun', fields: fields('runId'), args: repoChild('repo', 'runId'), run: (p, input, { origin, repo }) => p.ci.getRun({ ...origin, repo, id: input.runId }) }),
  operation('ci.jobs', { returns: 'Page<CiJob>', fields: fields('runId'), args: context => `${repoChild('repo', 'runId')(context)}, { perPage: 5 }`, run: (p, input, { origin, repo }) => p.ci.jobs({ ...origin, repo, id: input.runId }, perPage).page() }),
  operation('ci.log', { returns: 'ReadableStream<Uint8Array>', fields: fields('runId'), args: ({ origin, value }) => `{ ${origin}, repo, run: { ${origin}, repo, id: ${value('runId')} }, id: '1' }` }),
  operation('securityAlerts.list', { returns: 'Page<SecurityAlert>', auth: true, args: () => 'repo, { perPage: 5 }', run: (p, _, { repo }) => p.securityAlerts.list(repo, perPage).page() }),

  // Notifications
  operation('notifications.list', { returns: 'Page<Notification>', uses: 'none', args: () => '{ perPage: 5 }', run: p => p.notifications.list(perPage).page() }),
  operation('notifications.unreadCount', { returns: 'number', uses: 'none', args: () => '', run: p => p.notifications.unreadCount() }),
  operation('notifications.markRead', { uses: 'none', fields: fields('notificationId'), args: ({ origin, value }) => `{ ${origin}, id: ${value('notificationId')} }`, run: (p, input, { origin }) => p.notifications.markRead({ ...origin, id: input.notificationId }) }),
  operation('notifications.markDone', { uses: 'none', fields: fields('notificationId'), args: ({ origin, value }) => `{ ${origin}, id: ${value('notificationId')} }`, run: (p, input, { origin }) => p.notifications.markDone({ ...origin, id: input.notificationId }) }),
  operation('notifications.unsubscribe', { uses: 'none', fields: fields('notificationId'), args: ({ origin, value }) => `{ ${origin}, id: ${value('notificationId')} }`, run: (p, input, { origin }) => p.notifications.unsubscribe({ ...origin, id: input.notificationId }) }),
  operation('notifications.markAllRead', { args: () => '{ repo }', run: (p, _, { repo }) => p.notifications.markAllRead({ repo }) }),
  operation('notifications.markAllDone', { args: () => '{ repo }', run: (p, _, { repo }) => p.notifications.markAllDone({ repo }) }),

  // Webhooks
  operation('webhooks.list', { returns: 'Page<Webhook>', args: () => 'repo, { perPage: 5 }', run: (p, _, { repo }) => p.webhooks.list(repo, perPage).page() }),
  operation('webhooks.deliveries', { returns: 'Page<WebhookDeliveryRecord>', fields: fields('webhookId'), args: context => `${repoChild('target', 'webhookId')(context)}, { perPage: 5 }`, run: (p, input, { origin, repo }) => p.webhooks.deliveries({ ...origin, target: repo, id: input.webhookId }, perPage).page() }),
  operation('webhooks.create', { returns: 'Webhook', fields: fields('webhookUrl', 'secret'), args: ({ value }) => `repo, { url: ${value('webhookUrl')}, secret: ${value('secret')}, events: ['comment', 'state_change'] }`, run: (p, input, { repo }) => p.webhooks.create(repo, { url: input.webhookUrl, secret: input.secret, events: ['comment', 'state_change'] as EventKind[] }) }),
  operation('webhooks.update', { returns: 'Webhook', fields: fields('webhookId', 'webhookUrl'), args: context => `${repoChild('target', 'webhookId')(context)}, { url: ${context.value('webhookUrl')} }`, run: (p, input, { origin, repo }) => p.webhooks.update({ ...origin, target: repo, id: input.webhookId }, { url: input.webhookUrl }) }),
  operation('webhooks.delete', { fields: fields('webhookId'), args: repoChild('target', 'webhookId'), run: (p, input, { origin, repo }) => p.webhooks.delete({ ...origin, target: repo, id: input.webhookId }) }),
  operation('webhooks.rotateSecret', { returns: 'Webhook', fields: fields('webhookId', 'secret'), args: context => `${repoChild('target', 'webhookId')(context)}, ${context.value('secret')}`, run: (p, input, { origin, repo }) => p.webhooks.rotateSecret({ ...origin, target: repo, id: input.webhookId }, input.secret) }),
  operation('webhooks.redeliver', { fields: fields('webhookId', 'deliveryId'), args: context => `{ ${context.origin}, hook: ${repoChild('target', 'webhookId')(context)}, id: ${context.value('deliveryId')} }`, run: (p, input, { origin, repo }) => p.webhooks.redeliver({ ...origin, hook: { ...origin, target: repo, id: input.webhookId }, id: input.deliveryId }) }),

  // Accounts and search
  operation('users.get', { returns: 'User', uses: 'none', fields: fields('login'), args: ({ value }) => value('login'), run: (p, input) => p.users.get(input.login) }),
  operation('users.me', { returns: 'User', uses: 'none', args: () => '', run: p => p.users.me() }),
  operation('users.block', { uses: 'none', fields: fields('login'), args: ({ value }) => value('login'), run: (p, input) => p.users.block(input.login) }),
  operation('users.unblock', { uses: 'none', fields: fields('login'), args: ({ value }) => value('login'), run: (p, input) => p.users.unblock(input.login) }),
  operation('users.sponsorable', { returns: 'boolean', uses: 'none', fields: fields('login'), args: ({ value }) => value('login'), run: (p, input) => p.users.sponsorable(input.login) }),
  operation('users.events', { returns: 'Page<ForgeEvent>', uses: 'none', fields: fields('login'), args: ({ value }) => `${value('login')}, { perPage: 5 }`, run: (p, input) => p.users.events(input.login, perPage).page() }),
  operation('search.threads', { returns: 'Page<Thread>', fields: fields('query'), args: ({ value }) => `{ repo, text: ${value('query')}, perPage: 5 }`, run: (p, input, { repo }) => p.search.threads({ repo, text: input.query, perPage: 5 }).page() }),
  operation('search.repos', { returns: 'Page<Repo>', uses: 'none', fields: fields('query'), args: ({ value }) => `{ text: ${value('query')}, perPage: 5 }`, run: (p, input) => p.search.repos({ text: input.query, perPage: 5 }).page() }),
  operation('search.commits', { returns: 'Page<Commit>', fields: fields('query'), args: ({ value }) => `{ repo, text: ${value('query')}, perPage: 5 }`, run: (p, input, { repo }) => p.search.commits({ repo, text: input.query, perPage: 5 }).page() }),
]

/** The explorer picker's groups, in order: each namespace of the operations above, with its title. */
export const EXPLORER_NAMESPACE_TITLES: Record<string, string> = {
  threads: 'Issues and pull requests',
  repos: 'Repositories',
  orgs: 'Organisation teams',
  contents: 'Contents',
  commits: 'Commits',
  releases: 'Releases',
  checks: 'Checks',
  ci: 'CI',
  securityAlerts: 'Security alerts',
  notifications: 'Notifications',
  webhooks: 'Webhooks',
  users: 'Accounts',
  search: 'Search',
}

/** Whether the explorer has an operation for `verb`. */
export function explorable(verb: string): boolean {
  return EXPLORER_OPERATIONS.some(operation => operation.verb === verb)
}

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

// Private-use characters, which `literal()` escapes in the text, delimit the form values in the code.
const START = '\uE000'
const SEPARATOR = '\uE001'
const END = '\uE002'

function literal(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\\\'')
    .replace(/[\uE000-\uE002]/g, char => `\\u${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `'${escaped}'`
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
    else if (char === close && --depth === 0 && index > start + 1) {
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

/**
 * The code that makes the same call, and where the form values appear in it. `auth` is the credential the code
 * reads from the environment, or `true` for the forge's default when the call needs one.
 */
export function explorerCode(operation: ExplorerOperation, forge: ExplorerForge, input: ExplorerInput, auth: boolean | ExplorerCredential = operation.auth): ExplorerCode {
  const context: CodeContext = {
    input,
    origin: '...origin',
    value: field => mark(field, literal(input[field])),
    list: field => mark(field, `[${listOf(input[field]).map(literal).join(', ')}]`),
  }
  const args = operation.args(context)
  // A boolean means "the forge's default credential", for a call that needs one, or a forge with no anonymous reads.
  const credential = typeof auth === 'boolean' ? (auth || forge.signedIn ? forge.credentials[0] : undefined) : auth

  const symbol = (id: string, name: string) => mark(`@${id}`, name)
  const factory = symbol(`factory:${forge.factory}`, forge.factory)
  const factoryOptions = [
    ...Object.entries(forge.options?.(input) ?? {}).map(([key, value]) => `${key}: ${literal(value)}`),
    ...credential ? [`auth: ${authCode(credential)}`] : [],
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
  const [namespace, method] = operation.verb.split('.') as [string, string]
  const call = `await forge.${namespace}.${symbol(`method:${operation.verb}`, method)}(${args})${operation.page ? '.page()' : ''}`

  const marked = [
    `import { ${factory} } from 'forges/${forge.module}'`,
    wrap(`const ${symbol('const:forge:ForgeProvider', 'forge')} = ${factory}(${factoryOptions.length ? `{ ${factoryOptions.join(', ')} }` : ''})`),
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
