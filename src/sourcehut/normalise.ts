import type {
  Actor,
  Branch,
  CheckState,
  CiJob,
  CiRun,
  CodeMatch,
  Collaborator,
  Comment,
  Commit,
  CommitSignature,
  ForgeEventInput,
  ForgeOrigin,
  Label,
  Release,
  ReleaseAsset,
  ReleaseRef,
  Repo,
  RepoRef,
  RepoRole,
  RepoVisibility,
  ResolvedThreadRef,
  Tag,
  Thread,
  ThreadRef,
  TreeEntry,
  TreeEntryType,
  User,
} from '../model.ts'
import type { ShAcl, ShArtifact, ShCommit, ShEmail, ShEntity, ShEvent, ShEventDetail, ShFileMatch, ShJob, ShPatchset, ShPatchsetStatus, ShReference, ShRepository, ShTask, ShTicket, ShTicketResolution, ShTreeEntry, ShUser, ShVisibility } from './types.ts'
import { eventTime } from '../events.ts'
import { toDate } from '../utils.ts'
import { serviceUrl } from './services.ts'

export const FORGE = 'sourcehut' as const

/** The login Sourcehut shows, `~user`; a mailbox keeps its address. */
export function loginOf(entity: ShEntity): string {
  return entity.canonicalName || entity.username || entity.email || String(entity.id)
}

/** The `username` a query takes: a login without the `~` prefix. */
export function usernameOf(owner: string): string {
  return owner.replace(/^~/, '')
}

export function toActor(origin: ForgeOrigin, entity: ShEntity): Actor {
  const login = loginOf(entity)
  return {
    ...origin,
    login,
    id: entity.id === undefined ? '' : String(entity.id),
    // `entity.url` is the account's own website, so link the profile page instead.
    url: entity.username ? `${serviceUrl(origin.instance, 'meta')}/${login}` : undefined,
    avatarUrl: entity.avatar ?? undefined,
    isBotHint: false,
  }
}

export function toUser(origin: ForgeOrigin, user: ShUser): User {
  return {
    ...toActor(origin, user),
    bio: user.bio ?? undefined,
    location: user.location ?? undefined,
    websiteUrl: user.url ?? undefined,
    createdAt: toDate(user.created),
    raw: user,
  }
}

/** `PUBLIC` and `UNLISTED` are both visible to anyone who knows the URL. */
export function toVisibility(raw: ShVisibility): RepoVisibility {
  return raw === 'PRIVATE' ? 'private' : 'public'
}

/** The branch name behind a `refs/heads/...` reference. */
export function branchOf(name: string | undefined): string | undefined {
  return name?.replace(/^refs\/heads\//, '') || undefined
}

/**
 * A repository ref keyed by `~owner/name`. Sourcehut's services give the same
 * repository different database ids, so a ref carries none and keys by path.
 */
export function repoRefOf(origin: ForgeOrigin, owner: string, name: string): RepoRef {
  return { ...origin, owner, name }
}

export function toRepo(origin: ForgeOrigin, repository: ShRepository): Repo {
  const owner = repository.owner.canonicalName
  const ref = repoRefOf(origin, owner, repository.name)
  return {
    ref,
    description: repository.description ?? undefined,
    defaultBranch: branchOf(repository.HEAD?.name),
    visibility: toVisibility(repository.visibility),
    visibilityRaw: repository.visibility,
    isFork: false,
    isArchived: false,
    topics: [],
    url: `${serviceUrl(origin.instance, 'git')}/${owner}/${repository.name}`,
    createdAt: toDate(repository.created),
    updatedAt: toDate(repository.updated),
    owner: toActor(origin, repository.owner),
    raw: repository,
  }
}

export function toLabel(label: { name: string, backgroundColor: string }): Label {
  return { name: label.name, colour: label.backgroundColor.replace(/^#/, '') }
}

function ticketStateReason(resolution: ShTicketResolution): string | undefined {
  switch (resolution) {
    case 'UNRESOLVED':
      return undefined
    case 'DUPLICATE':
      return 'duplicate'
    case 'WONT_FIX':
    case 'BY_DESIGN':
    case 'INVALID':
    case 'NOT_OUR_BUG':
      return 'not_planned'
    default:
      return 'completed'
  }
}

export function toTicketThread(origin: ForgeOrigin, ticket: ShTicket): Thread {
  const owner = ticket.tracker.owner.canonicalName
  const repo = repoRefOf(origin, owner, ticket.tracker.name)
  const ref: ResolvedThreadRef = { ...origin, repo, kind: 'issue', number: String(ticket.id), externalId: ticket.ref }
  return {
    ref,
    kind: 'issue',
    title: ticket.subject,
    body: ticket.body ?? undefined,
    state: ticket.status === 'RESOLVED' ? 'closed' : 'open',
    stateRaw: ticket.status,
    stateReason: ticketStateReason(ticket.resolution),
    isDraft: false,
    author: toActor(origin, ticket.submitter),
    assignees: ticket.assignees.map(assignee => toActor(origin, assignee)),
    reviewers: [],
    labels: ticket.labels.map(toLabel),
    url: `${serviceUrl(origin.instance, 'todo')}/${owner}/${ticket.tracker.name}/${ticket.id}`,
    createdAt: toDate(ticket.created),
    updatedAt: toDate(ticket.updated),
    lastActivityAt: toDate(ticket.updated),
    ...ticket.subscription ? { subscription: 'subscribed' as const } : {},
    raw: ticket,
  }
}

function patchsetState(status: ShPatchsetStatus): Thread['state'] {
  if (status === 'APPLIED') {
    return 'merged'
  }
  return status === 'SUPERSEDED' || status === 'REJECTED' ? 'closed' : 'open'
}

export function toPatchsetThread(origin: ForgeOrigin, patchset: ShPatchset): Thread {
  const list = patchset.list
  const owner = list.owner.canonicalName
  const repo = repoRefOf(origin, owner, list.name)
  const ref: ResolvedThreadRef = { ...origin, repo, kind: 'pull_request', number: String(patchset.id), displayNumber: String(patchset.id), externalId: `patchset:${patchset.id}` }
  return {
    ref,
    kind: 'pull_request',
    title: patchset.subject,
    body: patchset.coverLetter?.body ?? undefined,
    state: patchsetState(patchset.status),
    stateRaw: patchset.status,
    isDraft: false,
    author: toActor(origin, patchset.submitter),
    assignees: [],
    reviewers: [],
    labels: [],
    url: `${serviceUrl(origin.instance, 'lists')}/${owner}/${list.name}/patches/${patchset.id}`,
    createdAt: toDate(patchset.created),
    updatedAt: toDate(patchset.updated),
    raw: patchset,
  }
}

export function toEmailComment(thread: ResolvedThreadRef, email: ShEmail): Comment {
  const { owner, name } = thread.repo
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id: String(email.id) },
    body: email.body,
    author: toActor({ forge: thread.forge, instance: thread.instance }, email.sender),
    createdAt: toDate(email.received),
    // A mailing-list message is addressed by its `<messageID>` under the list, not by its row id.
    url: `${serviceUrl(thread.instance, 'lists')}/${owner}/${name}/${encodeURIComponent(`<${email.messageID}>`)}`,
    raw: email,
  }
}

export function toTicketComment(thread: ResolvedThreadRef, event: ShEvent, detail: ShEventDetail): Comment {
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id: String(event.id) },
    body: detail.text ?? '',
    author: detail.author ? toActor({ forge: thread.forge, instance: thread.instance }, detail.author) : undefined,
    createdAt: toDate(event.created),
    raw: { event, detail },
  }
}

function statusAction(detail: ShEventDetail): string {
  return detail.newStatus === 'RESOLVED' ? 'closed' : 'reopened'
}

/** One `ForgeEventInput` per change the Sourcehut event carries. */
export function toTicketEvents(thread: ThreadRef, event: ShEvent): ForgeEventInput[] {
  const origin = { forge: thread.forge, instance: thread.instance }
  const name = (entity: ShEntity | undefined) => entity ? loginOf(entity) : 'someone'
  const actor = (entity: ShEntity | undefined) => entity ? toActor(origin, entity) : undefined
  return event.changes.map((detail, index) => {
    const base = { ...origin, id: `${event.id}-${index}`, kindRaw: detail.eventType, repo: thread.repo, thread, source: 'poll' as const, ...eventTime(toDate(event.created), new Date(0)), payload: { event, detail } }
    switch (detail.eventType) {
      case 'CREATED':
        return { ...base, kind: 'state_change' as const, actionRaw: 'opened', summary: `${name(detail.author)} opened this`, actor: actor(detail.author), detail: { type: 'state_change' as const, state: 'open' as const } }
      case 'COMMENT':
        return { ...base, kind: 'comment' as const, actionRaw: 'created', summary: `${name(detail.author)} commented`, actor: actor(detail.author), detail: { type: 'comment' as const, comment: { ...origin, thread, id: String(event.id) }, body: detail.text } }
      case 'STATUS_CHANGE':
        return { ...base, kind: 'state_change' as const, actionRaw: statusAction(detail), summary: `${name(detail.editor)} ${statusAction(detail)} this`, actor: actor(detail.editor), detail: { type: 'state_change' as const, state: detail.newStatus === 'RESOLVED' ? 'closed' as const : 'open' as const, reason: detail.newResolution ? ticketStateReason(detail.newResolution) : undefined } }
      case 'LABEL_ADDED':
      case 'LABEL_REMOVED':
        return { ...base, kind: 'label' as const, actionRaw: detail.eventType === 'LABEL_ADDED' ? 'labelled' : 'unlabelled', summary: `${name(detail.labeler)} ${detail.eventType === 'LABEL_ADDED' ? 'added' : 'removed'} the ${detail.label?.name} label`, actor: actor(detail.labeler), detail: { type: 'label' as const, label: detail.label?.name ?? '' } }
      case 'ASSIGNED_USER':
      case 'UNASSIGNED_USER':
        return { ...base, kind: 'assignment' as const, actionRaw: detail.eventType === 'ASSIGNED_USER' ? 'assigned' : 'unassigned', summary: `${name(detail.assigner)} ${detail.eventType === 'ASSIGNED_USER' ? 'assigned' : 'unassigned'} ${name(detail.assignee)}`, actor: actor(detail.assigner), detail: { type: 'assignment' as const, assignee: actor(detail.assignee) } }
      case 'USER_MENTIONED':
        return { ...base, kind: 'mention' as const, actionRaw: 'created', summary: `${name(detail.author)} mentioned ${name(detail.mentioned)}`, actor: actor(detail.author) }
      case 'TICKET_MENTIONED':
        return { ...base, kind: 'referenced' as const, actionRaw: 'created', summary: `${name(detail.author)} referenced ${detail.mentioned?.subject ?? 'another ticket'}`, actor: actor(detail.author) }
      default:
        return { ...base, kind: 'other' as const, actionRaw: 'created', summary: detail.eventType, actor: actor(detail.author) }
    }
  })
}

export function toEmailEvent(thread: ThreadRef, email: ShEmail): ForgeEventInput {
  const origin = { forge: thread.forge, instance: thread.instance }
  return {
    ...origin,
    id: `email-${email.id}`,
    kind: 'comment',
    kindRaw: 'email',
    actionRaw: 'created',
    summary: `${loginOf(email.sender)} commented`,
    ...eventTime(toDate(email.received), new Date(0)),
    actor: toActor(origin, email.sender),
    repo: thread.repo,
    thread,
    source: 'poll',
    detail: { type: 'comment', comment: { ...origin, thread, id: String(email.id) }, body: email.body },
    payload: email,
  }
}

function signatureOf(signature: ShCommit['author']): CommitSignature {
  return { name: signature.name, email: signature.email, date: toDate(signature.time) }
}

export function toCommit(repo: RepoRef, commit: ShCommit): Commit {
  return {
    ref: { forge: repo.forge, instance: repo.instance, repo, sha: commit.id },
    sha: commit.id,
    message: commit.message,
    author: signatureOf(commit.author),
    committer: signatureOf(commit.committer),
    parents: commit.parents.map(parent => parent.id),
    raw: commit,
  }
}

const SYMLINK_MODE = 0o120000
const SUBMODULE_MODE = 0o160000

export function toTreeEntry(parent: string, entry: ShTreeEntry): TreeEntry {
  const path = parent ? `${parent}/${entry.name}` : entry.name
  const mode = entry.mode & 0o170000
  const type: TreeEntryType = mode === SYMLINK_MODE
    ? 'symlink'
    : mode === SUBMODULE_MODE
      ? 'submodule'
      : entry.object.type === 'TREE' ? 'directory' : 'file'
  return {
    path,
    type,
    sha: entry.id,
    size: entry.object.size ?? undefined,
    mode: entry.mode.toString(8),
  }
}

export function toBranch(ref: ShReference, defaultBranch: string | undefined): Branch {
  const name = ref.name.replace(/^refs\/heads\//, '')
  return { name, sha: ref.follow?.id ?? ref.target, isDefault: name === defaultBranch, raw: ref }
}

export function toTag(ref: ShReference): Tag {
  // An annotated tag's `follow` is the tag object; its `target` is the commit.
  return { name: ref.name.replace(/^refs\/tags\//, ''), sha: ref.follow?.target?.id ?? ref.follow?.id ?? ref.target, raw: ref }
}

export function toRelease(repo: RepoRef, tag: string, artifacts: ShArtifact[], publishedAt?: string): Release {
  const ref: ReleaseRef = { forge: repo.forge, instance: repo.instance, repo, id: tag, tag }
  return {
    ref,
    tag,
    name: tag,
    isDraft: false,
    isPrerelease: false,
    publishedAt: toDate(publishedAt),
    url: `${serviceUrl(repo.instance, 'git')}/${repo.owner}/${repo.name}/tree/${tag}`,
    assets: artifacts.map(artifact => toReleaseAsset(repo, ref, artifact)),
    raw: { tag, artifacts },
  }
}

export function toReleaseAsset(repo: RepoRef, release: ReleaseRef, artifact: ShArtifact): ReleaseAsset {
  return {
    // Sourcehut addresses an artifact by its checksum and filename, not its id.
    ref: { forge: repo.forge, instance: repo.instance, repo, release, id: `${artifact.checksum}/${artifact.filename}` },
    name: artifact.filename,
    url: artifact.url,
    size: artifact.size,
  }
}

export function toCollaborator(origin: ForgeOrigin, acl: ShAcl): Collaborator {
  const role: RepoRole = acl.mode === 'RW' ? 'write' : 'read'
  return { actor: toActor(origin, acl.entity), role, roleRaw: acl.mode, raw: acl }
}

export function toCodeMatch(repo: RepoRef, match: ShFileMatch): CodeMatch {
  return {
    repo,
    path: match.name,
    fragments: match.lines.map(line => ({ text: line.line, line: line.lineNo })),
    raw: match,
  }
}

export function jobState(status: ShJob['status']): CheckState {
  switch (status) {
    case 'SUCCESS':
      return 'success'
    case 'FAILED':
    case 'TIMEOUT':
    case 'CANCELLED':
      return 'failure'
    default:
      return 'pending'
  }
}

export function taskState(status: ShTask['status']): CheckState {
  switch (status) {
    case 'SUCCESS':
      return 'success'
    case 'FAILED':
      return 'failure'
    case 'SKIPPED':
      return 'neutral'
    default:
      return 'pending'
  }
}

export function toCiRun(origin: ForgeOrigin, repo: RepoRef, job: ShJob): CiRun {
  return {
    ref: { ...origin, repo, id: String(job.id) },
    name: job.note ?? `Job #${job.id}`,
    state: jobState(job.status),
    stateRaw: job.status,
    number: String(job.id),
    eventRaw: job.tags.join(', ') || undefined,
    url: `${serviceUrl(origin.instance, 'builds')}/${job.owner.canonicalName}/job/${job.id}`,
    actor: toActor(origin, job.owner),
    createdAt: toDate(job.created),
    startedAt: toDate(job.created),
    completedAt: jobState(job.status) === 'pending' ? undefined : toDate(job.updated),
    raw: job,
  }
}

export function toCiJob(origin: ForgeOrigin, repo: RepoRef, job: ShJob, task: ShTask): CiJob {
  return {
    ref: { ...origin, repo, id: String(task.id), run: { ...origin, repo, id: String(job.id) } },
    name: task.name,
    state: taskState(task.status),
    stateRaw: task.status,
    url: `${serviceUrl(origin.instance, 'builds')}/${job.owner.canonicalName}/job/${job.id}`,
    startedAt: toDate(task.created),
    completedAt: taskState(task.status) === 'pending' ? undefined : toDate(task.updated),
    raw: task,
  }
}
