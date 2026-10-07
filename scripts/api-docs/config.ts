import type { PageConfig, SectionConfig } from './pages.ts'

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

/**
 * Members that the pages leave out. Most objects carry `raw` or `payload`, the
 * forge's own data, and a `...Raw` field beside each normalised value, so the data
 * model page says so once.
 */
export const HIDDEN_MEMBERS = /^(?:raw|payload)$|Raw$/

const OPERATIONS = 'An operation that the forge lacks rejects with {@link UnsupportedOperationError}. Check `provider.can(verb)` first, as described under {@link ForgeProvider}.'

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
  { title: 'Reactions', names: [/^React/, 'reactionContent', 'REACTION_CONTENTS'] },
  { title: 'Reviews', names: [/^Review/, 'PullBranches', 'ThreadStack'] },
  { title: 'Checks and CI', names: [/^(?:Check|Ci)/] },
  { title: 'Files and commits', names: [/^(?:Commit|File|Tree|Branch|Tag|ChangedFile|Comparison)/] },
  { title: 'Releases', names: [/^Release/] },
  { title: 'Security alerts', names: [/^Security/] },
  { title: 'Webhooks', names: [/^Webhook/] },
  { title: 'Notifications and events', names: [/^(?:Notification|BulkNotification|ForgeEvent|Event|PushCommit|SourceKind)/] },
  { title: 'Dates', names: ['reviveDates', 'DATE_FIELDS'] },
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
    description: 'Create providers for GitHub, GitLab, Bitbucket and every other supported forge, combine them in a registry, or create them from environment variables.',
    intro: 'Each forge has a factory such as `github()`, and a `Lite` variant such as `githubLite()` that leaves out webhook ingestion for bundles that never receive a delivery. Pass the factories to `createForges()`, or call `create()` on one for a single provider.',
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
    description: 'The properties and methods that every provider has, the namespaces that group its operations, and how to ask what a forge supports.',
    intro: 'See [Capabilities](/concepts/capabilities) for what each level means, and the [capability matrix](/reference/capability-matrix) for every forge at a glance.',
    sections: [
      { title: 'Namespaces', namespaceTable: true },
      { title: 'Properties', members: { of: 'ForgeProvider', kind: 'property', withoutNamespaces: true } },
      { title: 'Methods', members: { of: 'ForgeProvider', kind: 'method' } },
      { title: 'Check support', names: ['supports', 'supportOf'] },
      { title: 'Capability types', names: ['ForgeVerb', 'ForgeCapabilities', 'Support', 'PerKind', 'AlertSupport', 'VerbScopes'] },
    ],
  },
  {
    slug: 'threads',
    title: 'Issues and pull requests',
    description: 'Read, create, comment on, review and merge issues and pull requests.',
    intro: `Issues, pull requests and the other discussion kinds are threads. ${OPERATIONS}`,
    sections: [{ namespaces: ['threads'] }],
  },
  {
    slug: 'repositories',
    title: 'Repositories',
    description: 'Repositories, their files and commits, releases, accounts, app installations and search.',
    intro: OPERATIONS,
    sections: [{ namespaces: ['repos', 'contents', 'releases', 'users', 'installations', 'search'] }],
  },
  {
    slug: 'notifications',
    title: 'Notifications, webhooks and CI',
    description: 'Notifications, event sources and webhooks, commit checks, CI runs and security alerts.',
    intro: OPERATIONS,
    sections: [{ namespaces: ['notifications', 'sources', 'webhooks', 'checks', 'ci', 'securityAlerts'] }],
  },
  {
    slug: 'data-model',
    title: 'Data model',
    description: 'The types of the repositories, threads, reviews, checks, events and other objects that providers return, and the helpers for their keys.',
    intro: 'Every provider returns the same shapes whatever the forge. See [Data model](/concepts/data-model) for how they fit together.\n\nMost objects also carry `raw`, which is the forge\'s own representation of the object, unchanged. A normalised value often has a `Raw` twin that holds the forge\'s own value, such as `stateRaw` beside `state`. Events carry the unchanged delivery as `payload`. These fields are not listed below.',
    sections: DATA_MODEL_SECTIONS,
  },
  {
    slug: 'requests',
    title: 'Requests and pagination',
    description: 'Page through lists, collect warnings, read rate limits, send raw requests, and turn web URLs into refs.',
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
    description: 'Every error class that forges throws.',
    intro: 'All errors extend [`ForgeError`](#forgeerror). Errors from a request carry `forge`, `instance`, `url` and `method`. A class has the properties of the classes it extends. See [Handle errors and rate limits](/guides/errors).',
    sections: [{ source: /^src\/errors\.ts$/ }],
  },
  {
    slug: 'testing',
    title: 'Testing',
    description: 'Test code that uses forges with an in-memory fake provider or recorded fixtures.',
    intro: 'See [Test your code](/guides/testing) for a walkthrough.',
    sections: [
      { title: 'Fake provider', intro: 'Import from `forges/fake`.', entry: 'forges/fake', names: [/./] },
      { title: 'Fixtures', intro: 'Import from `forges/testing`.', entry: 'forges/testing', names: [/./] },
    ],
  },
  {
    slug: 'kit',
    title: 'Provider kit',
    description: 'The building blocks for writing a provider, from `forges/kit`.',
    intro: 'Import from `forges/kit`. Code that only uses providers imports from `forges` instead. See [Write a provider](/contributing/write-a-provider).',
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
