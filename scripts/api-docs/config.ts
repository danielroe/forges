import type { PageConfig, PagesOptions, SectionConfig } from './pages.ts'
import type { ApiMember, ApiSymbol } from './types.ts'

/**
 * Entry points to document as `specifier: path`. The first owns the symbols
 * that several export. `forges/schema` is described by hand on the JSON Schemas page.
 */
export const ENTRIES: Record<string, string> = {
  'forges': 'src/index.ts',
  'forges/env': 'src/env.ts',
  'forges/fake': 'src/fake/index.ts',
  'forges/kit': 'src/kit.ts',
  'forges/testing': 'src/testing/index.ts',
}

/** Where the reference pages go, under the content directory. */
export const REFERENCE_DIRECTORY = '5.reference'

/** Directories that hold generated pages. A run removes the generated pages in them before it writes new ones. */
export const GENERATED_DIRECTORIES = [REFERENCE_DIRECTORY, '7.contributing']

const FORGE_DATA_RE = /^(?:raw|payload)$|Raw$/

/**
 * Members that the pages leave out. The objects in the data model carry `raw` or
 * `payload`, the forge's own data, and a `...Raw` field beside each normalised
 * value, so the data model page says so once. Options, methods and errors are not
 * data: `CloseOptions.reasonRaw` and `Fetcher.raw()` are documented like any other.
 */
export const HIDDEN_MEMBERS: NonNullable<PagesOptions['hiddenMembers']> = (symbol, member) =>
  isForgeData(symbol, member) || isCapabilityEntry(symbol, member)

function isForgeData(symbol: ApiSymbol, member: ApiMember): boolean {
  return symbol.source === 'src/model.ts' && member.kind === 'property' && symbol.kind === 'interface' && !/(?:Options|Input|Query)$/.test(symbol.name) && FORGE_DATA_RE.test(member.name.split('.').at(-1)!)
}

/** The capability matrix lists the entries of `ForgeCapabilities`, so its page lists only the groups. */
function isCapabilityEntry(symbol: ApiSymbol, member: ApiMember): boolean {
  return symbol.name === 'ForgeCapabilities' && member.name.includes('.')
}

const OPERATIONS = 'For an operation that the forge lacks, see [Unsupported operations](/reference/provider#unsupported-operations).'

function forge(title: string, directory: string, names: RegExp[] = []) {
  return {
    title,
    source: new RegExp(`^src/${directory}/`),
    names,
  }
}

const DATA_MODEL_SECTIONS: SectionConfig[] = [
  { title: 'Forges and refs', names: ['ForgeKind', 'KnownForgeKind', 'ForgeInstance', 'ForgeOrigin', 'ThreadKind', 'RepoRef', 'ThreadRef', 'ResolvedThreadRef', 'CommentRef', 'NotificationRef', 'repoKey', 'parseRepoKey', 'repoSlug', 'threadKey', 'parseThreadKey', 'threadSlug', 'notificationKey', 'parseNotificationKey', 'notificationThread', 'isNamespaceRef', 'isResolvedThread', 'normaliseRepoName', 'namesAreCaseInsensitive'] },
  { title: 'Accounts and repositories', names: [/^(?:Actor|User|Collaborator|Repo|Installation)/, 'TextLimits'] },
  { title: 'Threads and comments', names: [/^(?:Thread|SubscriptionState|SubscribeOptions|SubscriptionItem|Close|Upsert|Comment|Milestone|Label|GetMany|SearchQuery|Merge|ApproveAndMerge)/, 'commentMarker', 'hasCommentMarker'] },
  { title: 'Reactions', names: [/^React/, 'REACTION_CONTENTS'] },
  { title: 'Reviews', names: [/^Review/, 'PullBranches', 'ThreadStack'] },
  { title: 'Checks and CI', names: [/^(?:Check|Ci)/] },
  { title: 'Files and commits', names: [/^(?:Commit|File|Tree|Branch|Tag|ChangedFile|Comparison)/] },
  { title: 'Releases', names: [/^Release/] },
  { title: 'Security alerts', names: [/^Security/] },
  { title: 'Webhooks', names: [/^Webhook/] },
  { title: 'Notifications and events', names: [/^(?:Notification|BulkNotification|ForgeEvent|Event|PushCommit|SourceKind)/] },
  { title: 'Dates', names: ['reviveDates', 'DATE_FIELDS'] },
]

export const OVERVIEW_INTRO = '`forges` is one client for every forge. You create a provider for each forge that you use, call the same operations on all of them, such as `provider.threads.merge()`, and get the same objects back.'

export const OVERVIEW_OUTRO = 'To add a forge, see [Write a provider](/contributing/write-a-provider) and the [provider kit](/contributing/provider-kit).'

/** The pages that people write, in the order the overview describes them. */
export const OVERVIEW_PAGES = [
  { title: 'Capability matrix', url: '/reference/capability-matrix', overview: 'Which operations each forge supports.' },
  { title: 'Events reference', url: '/reference/events', overview: 'Which event kinds and actions each forge delivers through webhooks.' },
  { title: 'Environment variables', url: '/reference/environment-variables', overview: 'The variables that `providersFromEnv()` and `forgesFromEnv()` read.' },
  { title: 'JSON Schemas', url: '/reference/json-schemas', overview: 'A JSON Schema for each public type.' },
]

/**
 * The reference, page by page, in sidebar order. A symbol lands on the first
 * page that selects it. Symbols that no page selects go to a last page, and a
 * test fails until they are placed here.
 */
export const PAGES: PageConfig[] = [
  {
    slug: 'providers',
    title: 'Providers',
    icon: 'i-lucide-plug',
    description: 'Create providers and combine them in a registry.',
    overview: 'Create a provider with the factory of your forge, such as `github()`. Combine providers with `createForges()`, or create them from environment variables with `forgesFromEnv()`.',
    intro: 'Each forge has a factory such as `github()`, and a `Lite` variant such as `githubLite()` that leaves out webhook ingestion. Pass the factories to `createForges()`, or call `create()` on one for a single provider.',
    sections: [
      { title: 'Options and authentication', names: ['ForgeOptionsBase', 'TokenAuth', 'BasicAuth', 'AppAuth', 'AnonymousAuth', 'AuthKind'] },
      forge('GitHub', 'github'),
      forge('GitLab', 'gitlab'),
      forge('Bitbucket', 'bitbucket'),
      forge('Forgejo', 'forgejo'),
      forge('Gitea', 'gitea'),
      forge('Gitee', 'gitee'),
      forge('Azure DevOps', 'azure-devops'),
      forge('Cursor Origin', 'cursor-origin'),
      forge('pushin.eu', 'pushin'),
      forge('Tangled', 'tangled'),
      { title: 'Forges registry', intro: 'A registry routes each ref to the provider it belongs to.', names: ['createForges', 'ForgeProviderFactory', 'ProviderFactoryFunction'] },
      { title: 'Registry methods', members: { of: 'Forges' } },
      { title: 'Create from the environment', intro: 'Import from `forges/env`. The variable names are listed under [Environment variables](/reference/environment-variables).', entry: 'forges/env', names: [/./] },
    ],
  },
  {
    slug: 'provider',
    title: 'Provider and capabilities',
    icon: 'i-lucide-sliders-horizontal',
    description: 'What every provider has, and how to check what a forge supports.',
    overview: 'Every provider has the same properties and namespaces. Use `can()` and `support()` to check what a forge supports before you call an operation.',
    intro: 'See [Capabilities](/concepts/capabilities) for what each level means, and the [capability matrix](/reference/capability-matrix) for every forge.',
    sections: [
      { title: 'Namespaces', namespaceTable: true },
      { title: 'Properties', members: { of: 'ForgeProvider', kind: 'property', withoutNamespaces: true } },
      { title: 'Methods', members: { of: 'ForgeProvider', kind: 'method' } },
      { title: 'Unsupported operations', intro: 'A method for an operation that the forge lacks rejects with {@link UnsupportedOperationError}, or with {@link ReadOnlyError} on a read-only provider. Call `provider.can(verb)` first, or `provider.support(verb)` for the level of support.' },
      { title: 'Check support', names: ['supports', 'supportOf'] },
      { title: 'Capability types', names: ['ForgeVerb', 'ForgeCapabilities', 'Support', 'PerKind', 'AlertSupport', 'VerbScopes'] },
    ],
  },
  {
    slug: 'threads',
    title: 'Issues and pull requests',
    icon: 'i-lucide-git-pull-request',
    description: 'Read, create, review and merge issues and pull requests.',
    overview: 'The methods of `provider.threads`: read, create and update issues and pull requests, then comment, label, review and merge them.',
    intro: `Issues, pull requests and the other discussion kinds are threads. ${OPERATIONS}`,
    sections: [{ namespaces: ['threads'] }],
  },
  {
    slug: 'repositories',
    title: 'Repositories',
    icon: 'i-lucide-folder-git-2',
    description: 'Repositories, files, releases, accounts and search.',
    overview: 'The `repos`, `contents`, `releases`, `users`, `installations` and `search` namespaces: repositories, their files, commits and releases, accounts, app installations and search.',
    intro: OPERATIONS,
    sections: [{ namespaces: ['repos', 'contents', 'releases', 'users', 'installations', 'search'] }],
  },
  {
    slug: 'notifications',
    title: 'Notifications, webhooks and CI',
    icon: 'i-lucide-bell',
    description: 'Notifications, webhooks, checks, CI runs and security alerts.',
    overview: 'The `notifications`, `sources`, `webhooks`, `checks`, `ci` and `securityAlerts` namespaces.',
    intro: OPERATIONS,
    sections: [{ namespaces: ['notifications', 'sources', 'webhooks', 'checks', 'ci', 'securityAlerts'] }],
  },
  {
    slug: 'data-model',
    title: 'Data model',
    icon: 'i-lucide-database',
    description: 'The objects that providers return, and the helpers for their keys.',
    overview: 'The objects that methods take and return, grouped by topic. Look here when a signature names a type.',
    intro: 'Every provider returns these shapes, whatever the forge. See [Data model](/concepts/data-model) for how they fit together.\n\nMost objects also carry `raw`, which is the forge\'s own representation of the object, unchanged. A normalised value often has a `Raw` twin that holds the forge\'s own value, such as `stateRaw` beside `state`. Events carry the unchanged delivery as `payload`. These fields are not listed below.',
    sections: DATA_MODEL_SECTIONS,
  },
  {
    slug: 'requests',
    title: 'Requests and pagination',
    icon: 'i-lucide-arrow-left-right',
    description: 'Pages, raw requests, rate limits and URLs.',
    overview: 'Pages and cursors for lists, `request()` for endpoints that the model does not cover, and the helpers that turn web URLs into refs.',
    intro: 'See [Page through results](/guides/pagination) for a walkthrough.',
    sections: [
      { title: 'Pagination', names: ['Page', 'PageOptions', 'ListOptions', 'Cursor', 'ForgeIterable', 'ForgeWarning', 'ForgeWarningCode', 'RateLimit'] },
      { title: 'Raw requests', names: ['ForgeRequest', 'ForgeRequestOptions', 'ForgeRawRequestOptions', 'ForgeResponse', 'RawResponse', 'FetchLike'] },
      { title: 'URLs and references', source: /^src\/web\.ts$/ },
    ],
  },
  {
    slug: 'errors',
    title: 'Errors',
    icon: 'i-lucide-circle-alert',
    description: 'Every error class that forges throws.',
    overview: 'The error classes that forges throws, with their properties. All of them extend `ForgeError`.',
    intro: 'All errors extend [`ForgeError`](#forgeerror). Errors from a request carry `forge`, `instance`, `url` and `method`. A class has the properties of the classes it extends. See [Handle errors and rate limits](/guides/errors).',
    sections: [{ source: /^src\/errors\.ts$/ }],
  },
  {
    slug: 'testing',
    title: 'Testing',
    icon: 'i-lucide-flask-conical',
    description: 'An in-memory fake provider and recorded fixtures.',
    overview: '`fake()` creates an in-memory provider, and `fixtureFetch()` replays recorded requests.',
    intro: 'See [Test your code](/guides/testing) for a walkthrough.',
    sections: [
      { title: 'Fake provider', intro: 'Import from `forges/fake`.', entry: 'forges/fake', names: [/./] },
      { title: 'Fixtures', intro: 'Import from `forges/testing`.', entry: 'forges/testing', names: [/./] },
    ],
  },
  {
    slug: 'provider-kit',
    location: { directory: '7.contributing', basePath: '/contributing', file: '5.provider-kit.md' },
    title: 'Provider kit',
    icon: 'i-lucide-puzzle',
    description: 'The building blocks of a provider, from `forges/kit`.',
    intro: 'Import from `forges/kit`. Code that only uses providers imports from `forges` instead. See [Write a provider](/contributing/write-a-provider) for how they fit together.',
    sections: [
      { title: 'Define a provider', entry: 'forges/kit', source: /^src\/define\.ts$/ },
      { title: 'Capability table', entry: 'forges/kit', source: /^src\/capability-table\.ts$/ },
      { title: 'Requests', entry: 'forges/kit', source: /^src\/fetch\.ts$/ },
      { title: 'Webhooks and events', entry: 'forges/kit', source: /^src\/(?:webhooks|events)\.ts$/ },
      { title: 'Cryptography', entry: 'forges/kit', source: /^src\/crypto\.ts$/ },
      { title: 'Helpers', entry: 'forges/kit', names: [/./] },
    ],
  },
]
