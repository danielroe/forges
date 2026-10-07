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
  derived?: 'experimental' | 'poll' | 'webhook' | 'upsertComment' | 'subscriptionSet' | 'approve' | 'approveAndMerge' | 'alertKinds' | 'eventKinds' | 'authKinds' | 'limits'
  /** The entry adds verbs and a declaration to a capability another entry produces. */
  alias?: boolean
  /** The verbs change state, so `readOnly` and anonymous providers reject them. */
  write?: boolean
  /** The verbs need an account, so anonymous providers reject them. */
  account?: boolean
}

/**
 * Rows omit what follows from the rest. `spec` defaults to the capability's
 * path, with `writes.*` declared on `threads.*` and a `listing` declared as its
 * page. `verbs` defaults to the `spec` path, plus its iterable when the path
 * names a page (`repos.labelsPage` also covers `repos.labels`). An explicit
 * `spec` marks a capability grouped apart from its verbs.
 */
const TABLE = [
  { capability: 'experimental', derived: 'experimental' },
  { capability: 'sources.poll', derived: 'poll' },
  { capability: 'sources.webhook', derived: 'webhook', verbs: ['webhooks.verify', 'webhooks.ingest'] },
  { capability: 'sources.subscribe' },
  { capability: 'repos.get' },
  { capability: 'users.get' },
  { capability: 'repos.list', account: true, listing: true },
  { capability: 'repos.labels', listing: true },
  { capability: 'repos.createLabel', write: true },
  { capability: 'repos.milestones', listing: true },
  { capability: 'repos.collaborators', listing: true },
  { capability: 'repos.permissionFor' },
  { capability: 'repos.addCollaborator', write: true },
  { capability: 'repos.assignableUsers', listing: true },
  { capability: 'repos.reviewerCandidates', listing: true },
  { capability: 'threads.get', perKind: true },
  { capability: 'threads.get', spec: 'threads.eventsPage', alias: true },
  { capability: 'threads.list', listing: true, perKind: true },
  { capability: 'threads.getMany' },
  { capability: 'comments.list', spec: 'threads.commentsPage', perKind: true },
  { capability: 'comments.edit', write: true, spec: 'threads.editComment', perKind: true },
  { capability: 'comments.delete', write: true, spec: 'threads.deleteComment', perKind: true },
  { capability: 'reactions.list', spec: 'threads.reactionsPage', perKind: true },
  { capability: 'notifications.list', account: true, listing: true },
  { capability: 'notifications.markRead', account: true, write: true },
  { capability: 'notifications.markDone', account: true, write: true },
  { capability: 'notifications.unsubscribe', account: true, write: true },
  { capability: 'notifications.markAllRead', account: true, write: true },
  { capability: 'notifications.markAllDone', account: true, write: true },
  { capability: 'notifications.unreadCount', account: true },
  { capability: 'writes.comment', write: true, perKind: true },
  { capability: 'writes.upsertComment', write: true, derived: 'upsertComment', verbs: ['threads.upsertComment'] },
  { capability: 'writes.close', write: true, perKind: true },
  { capability: 'writes.reopen', write: true, perKind: true },
  { capability: 'writes.create', write: true, perKind: true },
  { capability: 'writes.update', write: true, perKind: true },
  { capability: 'writes.setLabels', write: true, perKind: true },
  { capability: 'writes.addLabels', write: true, perKind: true },
  { capability: 'writes.removeLabels', write: true, perKind: true },
  { capability: 'writes.setMilestone', write: true, perKind: true },
  { capability: 'writes.react', write: true, spec: 'threads.reactions', perKind: true, verbs: ['threads.react', 'threads.unreact'] },
  { capability: 'writes.setAssignees', write: true, perKind: true },
  { capability: 'writes.requestReview', write: true, perKind: true },
  { capability: 'writes.merge', write: true },
  { capability: 'writes.approveAndMerge', write: true, derived: 'approveAndMerge', verbs: ['threads.approveAndMerge'] },
  { capability: 'writes.transfer', write: true },
  { capability: 'writes.markDuplicate', write: true },
  { capability: 'subscriptions.get', account: true, spec: 'threads.subscriptions', perKind: true, verbs: ['threads.subscription'] },
  { capability: 'subscriptions.set', write: true, derived: 'subscriptionSet', verbs: ['threads.subscribe', 'threads.unsubscribe'] },
  { capability: 'installations', account: true, verbs: ['installations.list', 'installations.listPage', 'installations.get', 'installations.token', 'installations.repos', 'installations.reposPage', 'installations.provider', 'installations.providers'] },
  { capability: 'checks.thread', spec: 'threads.checks', perKind: true },
  { capability: 'checks.list' },
  { capability: 'checks.report', write: true },
  { capability: 'checks.rerun', write: true },
  { capability: 'ci.runs', listing: true },
  { capability: 'ci.run' },
  { capability: 'ci.jobs', listing: true },
  { capability: 'ci.log' },
  { capability: 'contents.file' },
  { capability: 'contents.tree', listing: true },
  { capability: 'contents.branches', listing: true },
  { capability: 'contents.tags', listing: true },
  { capability: 'contents.resolveRef' },
  { capability: 'contents.commits', listing: true },
  { capability: 'contents.commit' },
  { capability: 'contents.compare' },
  { capability: 'contents.threadFiles', spec: 'threads.filesPage' },
  { capability: 'contents.threadCommits', spec: 'threads.commitsPage' },
  { capability: 'reviews.list', spec: 'threads.reviewsPage' },
  { capability: 'reviews.create', write: true, spec: 'threads.createReview' },
  { capability: 'reviews.submit', write: true, spec: 'threads.submitReview' },
  { capability: 'reviews.approve', write: true, spec: 'threads.approve', derived: 'approve' },
  { capability: 'reviews.resolveThread', write: true, spec: 'threads.reviewThreads', verbs: ['threads.resolveReviewThread', 'threads.unresolveReviewThread'] },
  { capability: 'releases.list', listing: true },
  { capability: 'releases.get' },
  { capability: 'releases.latest' },
  { capability: 'releases.getByTag' },
  { capability: 'releases.downloadAsset' },
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
  { capability: 'securityAlerts', derived: 'alertKinds', verbs: ['securityAlerts.list', 'securityAlerts.listPage'] },
  { capability: 'eventKinds', derived: 'eventKinds' },
  { capability: 'authKinds', derived: 'authKinds' },
  { capability: 'limits', derived: 'limits' },
] as const

type DefaultSpec<C> = C extends `writes.${infer Name}` ? `threads.${Name}` : C

type SpecOf<R> = R extends { spec: infer S extends string }
  ? S
  : R extends { derived: string }
    ? never
    : R extends { capability: infer C extends string }
      ? R extends { listing: true } ? `${DefaultSpec<C>}Page` : DefaultSpec<C>
      : never

type WithIterable<S> = S extends `${infer Iterable}Page` ? Iterable | S : S

type VerbsOf<R> = R extends { verbs: readonly (infer V extends string)[] } ? V : WithIterable<SpecOf<R>>

/** A provider verb, named by its path on `ForgeProvider`. */
export type ForgeVerb = VerbsOf<(typeof TABLE)[number]>

/** Every `ProviderSpec` path the table declares. */
export type TableSpecPath = SpecOf<(typeof TABLE)[number]>

/** A table row: a listing is declared as its `Page` verb, which also yields the iterable. */
interface TableRow extends CapabilityEntry {
  listing?: boolean
}

export const CAPABILITY_TABLE: readonly CapabilityEntry[] = (TABLE as readonly TableRow[]).map(({ listing, ...row }) => {
  const spec = row.spec ?? (row.derived ? undefined : defaultSpec(row.capability, listing))
  const verbs = row.verbs ?? (spec?.endsWith('Page') ? [spec.slice(0, -4), spec] : spec ? [spec] : undefined)
  return { ...row, ...spec ? { spec } : {}, ...verbs ? { verbs } : {} }
})

function defaultSpec(capability: string, listing: boolean | undefined): string {
  const path = capability.startsWith('writes.') ? `threads.${capability.slice('writes.'.length)}` : capability
  return listing ? `${path}Page` : path
}
