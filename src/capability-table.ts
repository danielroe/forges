/**
 * One row of the capability table: where a capability is declared on `ProviderSpec`,
 * where it lands on `ForgeCapabilities`, and which `ForgeProvider` verbs it covers.
 * `capabilitiesOf()`, `supports()` and the capability matrix derive from the table.
 */
export interface CapabilityEntry {
  /** Where the support lands on `ForgeCapabilities`, dot-separated. */
  capability: string
  /** Where the verb is declared on `ProviderSpec`, dot-separated. */
  spec?: string
  /** Verbs on `ForgeProvider` this capability covers. */
  verbs?: readonly string[]
  /** Support is declared per thread kind. */
  perKind?: boolean
  /** The capability is computed by core rather than read from a declared verb. */
  derived?: 'experimental' | 'poll' | 'webhook' | 'upsertComment' | 'subscriptionSet' | 'approve' | 'approveAndMerge' | 'alertKinds' | 'eventKinds' | 'auth' | 'limits'
  /** The entry adds verbs and a declaration to a capability another entry produces. */
  alias?: boolean
  /** The verbs change state, so `readOnly` and anonymous providers reject them. */
  write?: boolean
  /** The verbs need an account, so anonymous providers reject them. */
  account?: boolean
}

/**
 * Rows omit what follows from the rest: `spec` defaults to `capability` for a
 * declared verb, and `verbs` to the `spec` path, plus its iterable when the
 * path names a page (`repos.labelsPage` also covers `repos.labels`).
 */
const TABLE = [
  { capability: 'experimental', derived: 'experimental' },
  { capability: 'sources.poll', derived: 'poll' },
  { capability: 'sources.webhook', derived: 'webhook', verbs: ['webhooks.verify', 'webhooks.ingest'] },
  { capability: 'sources.subscribe' },
  { capability: 'repos.get' },
  { capability: 'users.get' },
  { capability: 'repos.list', account: true, spec: 'repos.listPage' },
  { capability: 'repos.labels', spec: 'repos.labelsPage' },
  { capability: 'repos.createLabel', write: true },
  { capability: 'repos.milestones', spec: 'repos.milestonesPage' },
  { capability: 'repos.collaborators', spec: 'repos.collaboratorsPage' },
  { capability: 'repos.permissionFor' },
  { capability: 'repos.addCollaborator', write: true },
  { capability: 'repos.assignableUsers', spec: 'repos.assignableUsersPage' },
  { capability: 'repos.reviewerCandidates', spec: 'repos.reviewerCandidatesPage' },
  { capability: 'threads.get', perKind: true },
  { capability: 'threads.get', spec: 'threads.eventsPage', alias: true },
  { capability: 'threads.list', spec: 'threads.listPage', perKind: true },
  { capability: 'threads.getMany' },
  { capability: 'comments.list', spec: 'threads.commentsPage', perKind: true },
  { capability: 'comments.edit', write: true, spec: 'threads.editComment', perKind: true },
  { capability: 'comments.delete', write: true, spec: 'threads.deleteComment', perKind: true },
  { capability: 'reactions.list', spec: 'threads.reactionsPage', perKind: true },
  { capability: 'notifications.list', account: true, spec: 'notifications.listPage' },
  { capability: 'notifications.markRead', account: true, write: true },
  { capability: 'notifications.markDone', account: true, write: true },
  { capability: 'notifications.unsubscribe', account: true, write: true },
  { capability: 'notifications.markAllRead', account: true, write: true },
  { capability: 'notifications.markAllDone', account: true, write: true },
  { capability: 'notifications.unreadCount', account: true },
  { capability: 'writes.comment', write: true, spec: 'threads.comment', perKind: true },
  { capability: 'writes.upsertComment', write: true, derived: 'upsertComment', verbs: ['threads.upsertComment'] },
  { capability: 'writes.close', write: true, spec: 'threads.close', perKind: true },
  { capability: 'writes.reopen', write: true, spec: 'threads.reopen', perKind: true },
  { capability: 'writes.create', write: true, spec: 'threads.create', perKind: true },
  { capability: 'writes.update', write: true, spec: 'threads.update', perKind: true },
  { capability: 'writes.setLabels', write: true, spec: 'threads.setLabels', perKind: true },
  { capability: 'writes.addLabels', write: true, spec: 'threads.addLabels', perKind: true },
  { capability: 'writes.removeLabels', write: true, spec: 'threads.removeLabels', perKind: true },
  { capability: 'writes.setMilestone', write: true, spec: 'threads.setMilestone', perKind: true },
  { capability: 'writes.react', write: true, spec: 'threads.reactions', perKind: true, verbs: ['threads.react', 'threads.unreact'] },
  { capability: 'writes.setAssignees', write: true, spec: 'threads.setAssignees', perKind: true },
  { capability: 'writes.requestReview', write: true, spec: 'threads.requestReview', perKind: true },
  { capability: 'writes.merge', write: true, spec: 'threads.merge' },
  { capability: 'writes.approveAndMerge', write: true, derived: 'approveAndMerge', verbs: ['threads.approveAndMerge'] },
  { capability: 'writes.transfer', write: true, spec: 'threads.transfer' },
  { capability: 'writes.markDuplicate', write: true, spec: 'threads.markDuplicate' },
  { capability: 'subscriptions.get', account: true, spec: 'threads.subscriptions', perKind: true, verbs: ['threads.subscription'] },
  { capability: 'subscriptions.set', write: true, derived: 'subscriptionSet', verbs: ['threads.subscribe', 'threads.unsubscribe'] },
  { capability: 'installations', account: true, verbs: ['installations.list', 'installations.listPage', 'installations.get', 'installations.token', 'installations.repos', 'installations.reposPage', 'installations.provider', 'installations.providers'] },
  { capability: 'checks.thread', spec: 'threads.checks', perKind: true },
  { capability: 'checks.list' },
  { capability: 'checks.report', write: true },
  { capability: 'checks.rerun', write: true },
  { capability: 'ci.runs', spec: 'ci.runsPage' },
  { capability: 'ci.run' },
  { capability: 'ci.jobs', spec: 'ci.jobsPage' },
  { capability: 'ci.log' },
  { capability: 'contents.file' },
  { capability: 'contents.tree', spec: 'contents.treePage' },
  { capability: 'contents.branches', spec: 'contents.branchesPage' },
  { capability: 'contents.tags', spec: 'contents.tagsPage' },
  { capability: 'contents.resolveRef' },
  { capability: 'contents.commits', spec: 'contents.commitsPage' },
  { capability: 'contents.commit' },
  { capability: 'contents.compare' },
  { capability: 'contents.threadFiles', spec: 'threads.filesPage' },
  { capability: 'contents.threadCommits', spec: 'threads.commitsPage' },
  { capability: 'reviews.list', spec: 'threads.reviewsPage' },
  { capability: 'reviews.create', write: true, spec: 'threads.createReview' },
  { capability: 'reviews.submit', write: true, spec: 'threads.submitReview' },
  { capability: 'reviews.approve', write: true, spec: 'threads.approve', derived: 'approve' },
  { capability: 'reviews.resolveThread', write: true, spec: 'threads.reviewThreads', verbs: ['threads.resolveReviewThread', 'threads.unresolveReviewThread'] },
  { capability: 'releases.list', spec: 'releases.listPage' },
  { capability: 'releases.get' },
  { capability: 'releases.latest' },
  { capability: 'releases.getByTag' },
  { capability: 'releases.downloadAsset' },
  { capability: 'webhooks.list', account: true, spec: 'webhooks.listPage' },
  { capability: 'webhooks.create', write: true },
  { capability: 'webhooks.update', write: true },
  { capability: 'webhooks.delete', write: true },
  { capability: 'webhooks.rotateSecret', write: true },
  { capability: 'webhooks.deliveries', account: true, spec: 'webhooks.deliveriesPage' },
  { capability: 'webhooks.redeliver', write: true },
  { capability: 'search.threads', spec: 'search.threadsPage' },
  { capability: 'search.repos', spec: 'search.reposPage' },
  { capability: 'search.commits', spec: 'search.commitsPage' },
  { capability: 'securityAlerts', derived: 'alertKinds', verbs: ['securityAlerts.list', 'securityAlerts.listPage'] },
  { capability: 'eventKinds', derived: 'eventKinds' },
  { capability: 'auth', derived: 'auth' },
  { capability: 'limits', derived: 'limits' },
] as const

type SpecOf<R> = R extends { spec: infer S extends string } ? S : R extends { derived: string } ? never : R extends { capability: infer C extends string } ? C : never

type WithIterable<S> = S extends `${infer Iterable}Page` ? Iterable | S : S

type VerbsOf<R> = R extends { verbs: readonly (infer V extends string)[] } ? V : WithIterable<SpecOf<R>>

/** A provider verb, named by its path on `ForgeProvider`. */
export type ForgeVerb = VerbsOf<(typeof TABLE)[number]>

/** Every `ProviderSpec` path the table declares. */
export type TableSpecPath = SpecOf<(typeof TABLE)[number]>

export const CAPABILITY_TABLE: readonly CapabilityEntry[] = (TABLE as readonly CapabilityEntry[]).map((row) => {
  const spec = row.spec ?? (row.derived ? undefined : row.capability)
  const verbs = row.verbs ?? (spec?.endsWith('Page') ? [spec.slice(0, -4), spec] : spec ? [spec] : undefined)
  return { ...row, ...spec ? { spec } : {}, ...verbs ? { verbs } : {} }
})
