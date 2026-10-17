/**
 * One row of the capability table: the `ForgeProvider` verbs it covers, where
 * they are declared on `ProviderSpec`, and the key their support lands on in
 * `ForgeCapabilities`. `capabilitiesOf()`, `can()` and the capability matrix
 * derive from the table.
 */
export interface CapabilityEntry {
  /** The first verb the row covers, or the name of a trait such as `limits`, dot-separated. */
  capability: string
  /** Where the verb is declared on `ProviderSpec`, dot-separated. */
  spec?: string
  /** Verbs on `ForgeProvider` this capability covers. Each has its own key on `ForgeCapabilities`, apart from a page that shares its listing's key. */
  verbs?: readonly string[]
  /** Support is declared per thread kind. */
  perKind?: boolean
  /** The capability is computed by core rather than read from a declared verb. */
  derived?: 'experimental' | 'webhook' | 'threadEvents' | 'getComment' | 'getReview' | 'ciJob' | 'subscriptionSet' | 'approve' | 'alertKinds' | 'eventKinds' | 'authKinds' | 'limits'
  /** The verbs change state, so `readOnly` and anonymous providers reject them. */
  write?: boolean
  /** The verbs need an account, so anonymous providers reject them. */
  account?: boolean
}

/**
 * Rows omit what follows from the rest. `verbs` defaults to the capability,
 * plus its page for a `listing` (`repos.labels` also covers
 * `repos.labelsPage`). `spec` defaults to the capability, or its page for a
 * `listing`, unless the row is `derived`. Traits have no verbs.
 */
const TABLE = [
  { capability: 'experimental', derived: 'experimental', verbs: [] },
  { capability: 'sources.subscribe' },
  { capability: 'repos.get' },
  { capability: 'users.get' },
  { capability: 'users.me', account: true },
  { capability: 'users.sponsorable', account: true },
  { capability: 'users.events', listing: true },
  { capability: 'users.block', write: true, account: true, spec: 'users.blocking', verbs: ['users.block', 'users.unblock'] },
  { capability: 'repos.list', account: true, listing: true },
  { capability: 'repos.byOwner', listing: true },
  { capability: 'repos.labels', listing: true },
  { capability: 'repos.createLabel', write: true },
  { capability: 'repos.milestones', listing: true },
  { capability: 'repos.collaborators', listing: true },
  { capability: 'repos.contributors', listing: true },
  { capability: 'repos.contributorStats' },
  { capability: 'repos.templates' },
  { capability: 'repos.permissionFor' },
  { capability: 'repos.addCollaborator', write: true },
  { capability: 'repos.assignableUsers', listing: true },
  { capability: 'repos.reviewerCandidates', listing: true },
  { capability: 'repos.events', listing: true },
  { capability: 'orgs.teams', listing: true },
  { capability: 'orgs.teamMembers', listing: true, account: true },
  { capability: 'orgs.block', write: true, spec: 'orgs.blocking', verbs: ['orgs.block', 'orgs.unblock'] },
  { capability: 'threads.get', perKind: true },
  { capability: 'threads.list', listing: true, perKind: true },
  { capability: 'threads.getMany' },
  { capability: 'threads.closingIssues', listing: true },
  { capability: 'threads.closingPullRequests', listing: true },
  { capability: 'threads.events', listing: true, spec: 'threads.eventsPage', derived: 'threadEvents' },
  { capability: 'threads.comments', listing: true, perKind: true },
  { capability: 'threads.getComment', spec: 'threads.getComment', derived: 'getComment', perKind: true },
  { capability: 'threads.createComment', write: true, perKind: true },
  { capability: 'threads.updateComment', write: true, perKind: true },
  { capability: 'threads.deleteComment', write: true, perKind: true },
  { capability: 'threads.hideComment', write: true, spec: 'threads.hiding', perKind: true, verbs: ['threads.hideComment', 'threads.unhideComment'] },
  { capability: 'threads.reactions', listing: true, perKind: true },
  { capability: 'threads.react', write: true, spec: 'threads.reactions', perKind: true, verbs: ['threads.react', 'threads.unreact'] },
  { capability: 'threads.create', write: true, perKind: true },
  { capability: 'threads.update', write: true, perKind: true },
  { capability: 'threads.close', write: true, perKind: true },
  { capability: 'threads.reopen', write: true, perKind: true },
  { capability: 'threads.lock', write: true, spec: 'threads.locking', perKind: true, verbs: ['threads.lock', 'threads.unlock'] },
  { capability: 'threads.setLabels', write: true, perKind: true },
  { capability: 'threads.addLabels', write: true, perKind: true },
  { capability: 'threads.removeLabels', write: true, perKind: true },
  { capability: 'threads.setMilestone', write: true, perKind: true },
  { capability: 'threads.setAssignees', write: true, perKind: true },
  { capability: 'threads.requestReview', write: true, perKind: true },
  { capability: 'threads.merge', write: true },
  { capability: 'threads.updateBranch', write: true },
  { capability: 'threads.transfer', write: true },
  { capability: 'threads.markDuplicate', write: true },
  { capability: 'threads.subscription', account: true, spec: 'threads.subscriptions', perKind: true },
  { capability: 'threads.subscribe', write: true, derived: 'subscriptionSet', verbs: ['threads.subscribe', 'threads.unsubscribe'] },
  { capability: 'threads.checks', perKind: true },
  { capability: 'threads.files', listing: true },
  { capability: 'threads.commits', listing: true },
  { capability: 'threads.reviews', listing: true },
  { capability: 'threads.getReview', spec: 'threads.getReview', derived: 'getReview' },
  { capability: 'threads.createReview', write: true },
  { capability: 'threads.submitReview', write: true },
  { capability: 'threads.approve', write: true, spec: 'threads.approve', derived: 'approve' },
  { capability: 'threads.replyToReviewComment', write: true },
  { capability: 'threads.resolveReviewThread', write: true, spec: 'threads.reviewThreads', verbs: ['threads.resolveReviewThread', 'threads.unresolveReviewThread'] },
  { capability: 'notifications.list', account: true, listing: true },
  { capability: 'notifications.markRead', account: true, write: true },
  { capability: 'notifications.markDone', account: true, write: true },
  { capability: 'notifications.unsubscribe', account: true, write: true },
  { capability: 'notifications.markAllRead', account: true, write: true },
  { capability: 'notifications.markAllDone', account: true, write: true },
  { capability: 'notifications.unreadCount', account: true },
  { capability: 'installations.list', account: true, spec: 'installations', verbs: ['installations.list', 'installations.listPage', 'installations.get', 'installations.token', 'installations.repos', 'installations.reposPage', 'installations.provider', 'installations.providers'] },
  { capability: 'checks.list' },
  { capability: 'checks.get' },
  { capability: 'checks.report', write: true },
  { capability: 'checks.rerun', write: true },
  { capability: 'ci.runs', listing: true },
  { capability: 'ci.getRun' },
  { capability: 'ci.jobs', listing: true },
  { capability: 'ci.getJob', spec: 'ci.getJob', derived: 'ciJob' },
  { capability: 'ci.log' },
  { capability: 'contents.getFile' },
  { capability: 'contents.tree', listing: true },
  { capability: 'contents.branches', listing: true },
  { capability: 'contents.tags', listing: true },
  { capability: 'contents.resolveRef' },
  { capability: 'contents.commits', listing: true },
  { capability: 'contents.getCommit' },
  { capability: 'contents.compare' },
  { capability: 'contents.commitFiles', write: true },
  { capability: 'releases.list', listing: true },
  { capability: 'releases.get' },
  { capability: 'releases.latest' },
  { capability: 'releases.getByTag' },
  { capability: 'releases.downloadAsset' },
  { capability: 'releases.create', write: true },
  { capability: 'releases.update', write: true },
  { capability: 'webhooks.ingest', derived: 'webhook', verbs: ['webhooks.verify', 'webhooks.ingest'] },
  { capability: 'webhooks.list', account: true, listing: true },
  { capability: 'webhooks.create', write: true },
  { capability: 'webhooks.update', write: true },
  { capability: 'webhooks.delete', write: true },
  { capability: 'webhooks.rotateSecret', write: true },
  { capability: 'webhooks.deliveries', account: true, listing: true },
  { capability: 'webhooks.redeliver', write: true },
  { capability: 'search.threads', listing: true },
  { capability: 'search.repos', listing: true },
  { capability: 'search.commits', listing: true },
  { capability: 'search.code', listing: true },
  { capability: 'securityAlerts.list', listing: true, derived: 'alertKinds' },
  { capability: 'eventKinds', derived: 'eventKinds', verbs: [] },
  { capability: 'authKinds', derived: 'authKinds', verbs: [] },
  { capability: 'limits', derived: 'limits', verbs: [] },
] as const

type DefaultPath<R> = R extends { capability: infer C extends string }
  ? R extends { listing: true } ? `${C}Page` : C
  : never

type SpecOf<R> = R extends { spec: infer S extends string }
  ? S
  : R extends { derived: string } ? never : DefaultPath<R>

type WithIterable<S> = S extends `${infer Iterable}Page` ? Iterable | S : S

type VerbsOf<R> = R extends { verbs: readonly (infer V extends string)[] } ? V : WithIterable<DefaultPath<R>>

/** A provider verb, named by its path on `ForgeProvider`. */
export type ForgeVerb = VerbsOf<(typeof TABLE)[number]>

/** Every `ProviderSpec` path the table declares. */
export type TableSpecPath = SpecOf<(typeof TABLE)[number]>

/** A table row: a listing also covers its `Page` verb, which is where it is declared. */
interface TableRow extends CapabilityEntry {
  listing?: boolean
}

/**
 * Every capability with the verbs it covers and the flags that gate it, in the order the capability matrix lists them.
 */
export const CAPABILITY_TABLE: readonly CapabilityEntry[] = (TABLE as readonly TableRow[]).map(({ listing, ...row }) => {
  const path = listing ? `${row.capability}Page` : row.capability
  const spec = row.spec ?? (row.derived ? undefined : path)
  const verbs = row.verbs ?? (listing ? [row.capability, path] : [row.capability])
  return { ...row, ...spec ? { spec } : {}, verbs }
})

/** The key on `ForgeCapabilities` that holds the support of `verb`: the verb's own path, or its listing's for a page. */
export function capabilityKey(entry: CapabilityEntry, verb: string): string {
  return verb.endsWith('Page') && entry.verbs?.includes(verb.slice(0, -4)) ? verb.slice(0, -4) : verb
}
