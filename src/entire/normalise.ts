import type { Actor, Branch, ChangedFile, Collaborator, Comment, Commit, CommitSignature, ForgeOrigin, Repo, RepoRef, RepoRole, ResolvedThreadRef, Review, ReviewComment, ReviewState, ReviewThread, Thread, TreeEntry } from '../model.ts'
import type { EntireApproval, EntireAuthor, EntireBranch, EntireChange, EntireCollaborator, EntireCommit, EntireCompareFile, EntireCoreRepo, EntireDiscussion, EntireIdentity, EntireMessage, EntirePerson, EntireProjectTrail, EntireRepo, EntireReviewComment, EntireSignature, EntireTreeEntry } from './types.ts'
import { namespaceRef } from '../model.ts'
import { toDate, toFileStatus } from '../utils.ts'

export const FORGE = 'entire'

export function projectRef(origin: ForgeOrigin, project: string): RepoRef {
  return namespaceRef(origin, project)
}

export function toRepoRef(origin: ForgeOrigin, project: string, name: string, id?: string): RepoRef {
  return { forge: origin.forge, instance: origin.instance, owner: project, name, ...id ? { externalId: id } : {} }
}

function primaryHandle(identity: EntireIdentity | undefined): string | undefined {
  const handles = identity?.handles ?? []
  return (handles.find(handle => handle.is_primary) ?? handles[0])?.handle
}

/** An account from the identity Entire attaches to people, automations and agents. */
export function identityActor(origin: ForgeOrigin, identity: EntireIdentity | undefined, login?: string): Actor | undefined {
  const name = login ?? identity?.username ?? primaryHandle(identity) ?? identity?.automation?.slug ?? identity?.display_name ?? undefined
  if (!name) {
    return undefined
  }
  return {
    forge: origin.forge,
    instance: origin.instance,
    login: name,
    id: identity?.account_id ?? name,
    ...identity?.display_name ? { name: identity.display_name } : {},
    ...identity?.avatar_url ? { avatarUrl: identity.avatar_url } : {},
    ...identity?.kind && identity.kind !== 'account' ? { typeRaw: identity.kind } : {},
    isBotHint: identity?.kind === 'automation' || identity?.kind === 'agent' || Boolean(identity?.automation),
  }
}

export function personActor(origin: ForgeOrigin, person: EntirePerson | EntireAuthor | undefined): Actor | undefined {
  if (!person) {
    return undefined
  }
  const actor = identityActor(origin, person.identity, person.login)
  const id = 'accountId' in person ? person.accountId : 'id' in person ? person.id : undefined
  return actor && id ? { ...actor, id } : actor
}

export function toRepo(origin: ForgeOrigin, raw: EntireRepo): Repo {
  const [project = '', name = raw.name] = raw.full_name.split('/')
  return {
    ref: toRepoRef(origin, project, name, raw.id),
    ...raw.description ? { description: raw.description } : {},
    ...raw.default_branch ? { defaultBranch: raw.default_branch } : {},
    visibility: raw.private ? 'private' : 'public',
    isFork: false,
    isArchived: raw.archived,
    topics: [],
    ...raw.updated_at ? { updatedAt: toDate(raw.updated_at) } : {},
    ...raw.language ? { language: raw.language } : {},
    ...raw.stargazers_count !== undefined ? { stars: raw.stargazers_count } : {},
    ...raw.open_pr_count !== undefined ? { openPullCount: raw.open_pr_count } : {},
    ...raw.permission ? { permissions: permissionsOf(raw.permission) } : {},
    raw,
  }
}

/** A repository as the control plane lists it, or `undefined` for a GitHub mirror. `project` names its project where `raw` does not. */
export function toCoreRepo(origin: ForgeOrigin, raw: EntireCoreRepo, project?: string): Repo | undefined {
  if (raw.provider && raw.provider !== 'entire') {
    return undefined
  }
  const [owner = project ?? raw.org ?? '', name = raw.name] = (raw.full_name ?? '').split('/')
  const permission = raw.permission ?? (raw.capabilities?.canManage ? 'admin' : raw.capabilities?.canPush ? 'write' : raw.capabilities?.canPull ? 'read' : undefined)
  return {
    ref: toRepoRef(origin, owner, name, raw.id),
    visibility: raw.visibility === 'public' ? 'public' : 'private',
    isFork: false,
    isArchived: false,
    topics: [],
    ...raw.lastPushedAt ? { pushedAt: toDate(raw.lastPushedAt) } : {},
    ...permission ? { permissions: permissionsOf(permission) } : {},
    raw,
  }
}

export function toRole(raw: string | undefined): RepoRole {
  switch (raw) {
    case 'owner':
    case 'admin':
      return 'admin'
    case 'maintain':
    case 'maintainer':
      return 'maintain'
    case 'write':
    case 'writer':
      return 'write'
    case 'triage':
      return 'triage'
    case 'read':
    case 'reader':
      return 'read'
    default:
      return 'none'
  }
}

function permissionsOf(raw: string): Repo['permissions'] {
  const role = toRole(raw)
  const rank = ['none', 'read', 'triage', 'write', 'maintain', 'admin'].indexOf(role)
  return { admin: rank >= 5, maintain: rank >= 4, push: rank >= 3, triage: rank >= 2, pull: rank >= 1 }
}

export function toCollaborator(origin: ForgeOrigin, raw: EntireCollaborator): Collaborator {
  return {
    actor: { forge: origin.forge, instance: origin.instance, login: raw.username, id: raw.accountId, isBotHint: false },
    role: toRole(raw.role),
    roleRaw: raw.role,
    raw,
  }
}

export function toBranch(raw: EntireBranch, defaultBranch?: string): Branch {
  return { name: raw.name, sha: raw.commitSHA, ...defaultBranch ? { isDefault: raw.name === defaultBranch } : {}, raw }
}

function toSignature(raw: EntireSignature | undefined): CommitSignature | undefined {
  return raw ? { ...raw.name ? { name: raw.name } : {}, ...raw.email ? { email: raw.email } : {}, ...raw.date ? { date: toDate(raw.date) } : {} } : undefined
}

export function toCommit(origin: ForgeOrigin, repo: RepoRef, raw: EntireCommit, files?: ChangedFile[], detail?: unknown): Commit {
  return {
    ref: { forge: origin.forge, instance: origin.instance, repo, sha: raw.sha },
    sha: raw.sha,
    message: raw.message.replace(/\n$/, ''),
    author: toSignature(raw.author),
    committer: toSignature(raw.committer),
    parents: raw.parents,
    ...raw.stats ? { stats: { additions: raw.stats.additions, deletions: raw.stats.deletions, total: raw.stats.additions + raw.stats.deletions } } : {},
    ...files ? { files } : {},
    raw: detail === undefined ? raw : { commit: raw, detail },
  }
}

export function toChangedFile(raw: EntireCompareFile): ChangedFile {
  return {
    path: raw.path,
    ...raw.oldPath && raw.oldPath !== raw.path ? { previousPath: raw.oldPath } : {},
    status: toFileStatus(raw.status),
    statusRaw: raw.status,
    ...raw.additions !== undefined ? { additions: raw.additions } : {},
    ...raw.deletions !== undefined ? { deletions: raw.deletions } : {},
    ...raw.binary ? { isBinary: true } : {},
  }
}

export function toTreeEntry(raw: EntireTreeEntry, parent: string): TreeEntry {
  const path = parent && !raw.path.startsWith(`${parent}/`) ? `${parent}/${raw.path}` : raw.path
  return {
    path,
    type: raw.type === 'tree' ? 'directory' : raw.type === 'commit' ? 'submodule' : raw.mode === '120000' ? 'symlink' : 'file',
    sha: raw.sha,
    ...raw.type === 'blob' && raw.size !== undefined ? { size: raw.size } : {},
    mode: raw.mode,
  }
}

export function issueRef(origin: ForgeOrigin, project: string, number: number | string): ResolvedThreadRef {
  return { forge: origin.forge, instance: origin.instance, repo: projectRef(origin, project), kind: 'issue', number: String(number) }
}

export function pullRef(repo: RepoRef, number: number | string): ResolvedThreadRef {
  return { forge: repo.forge, instance: repo.instance, repo, kind: 'pull_request', number: String(number) }
}

/** A project trail, read as an issue. */
export function toIssue(origin: ForgeOrigin, project: string, raw: EntireProjectTrail): Thread {
  return {
    ref: { ...issueRef(origin, project, raw.number), externalId: raw.id },
    kind: 'issue',
    title: raw.title,
    ...raw.body ? { body: raw.body } : {},
    state: raw.status === 'closed' ? 'closed' : 'open',
    stateRaw: raw.status,
    isDraft: false,
    author: personActor(origin, raw.author),
    assignees: (raw.assigneeProfiles ?? []).flatMap(person => personActor(origin, person) ?? []),
    reviewers: [],
    labels: [],
    ...raw.url ? { url: raw.url } : {},
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.metadataUpdatedAt),
    ...raw.closedAt ? { closedAt: toDate(raw.closedAt) } : {},
    lastActivityAt: toDate(raw.lastActivityAt),
    ...raw.type ? { issueType: { id: raw.type, name: raw.type, raw: raw.type } } : {},
    raw,
  }
}

function reviewerState(raw: string | undefined): ReviewState {
  switch (raw) {
    case 'approved':
      return 'approved'
    case 'changes_requested':
      return 'changes_requested'
    case 'requested':
    case 'pending':
      return 'pending'
    case 'dismissed':
      return 'dismissed'
    default:
      return 'unknown'
  }
}

/** A change, the branch of one repository on a trail, read as a pull request. */
export function toPull(repo: RepoRef, raw: EntireChange): Thread {
  const origin = { forge: repo.forge, instance: repo.instance }
  const state = raw.status === 'merged' ? 'merged' : raw.status === 'closed' ? 'closed' : raw.status === 'open' ? 'open' : 'unknown'
  return {
    ref: { ...pullRef(repo, raw.number), externalId: raw.id },
    kind: 'pull_request',
    title: raw.title,
    ...raw.body_document?.text_snapshot ? { body: raw.body_document.text_snapshot } : {},
    state,
    stateRaw: raw.status,
    isDraft: raw.ready_for_review === false,
    author: personActor(origin, raw.author),
    assignees: (raw.assignee_identities ?? []).flatMap(assignee => identityActor(origin, assignee.identity, assignee.login) ?? []),
    reviewers: (raw.reviewers ?? []).flatMap((reviewer) => {
      const actor = identityActor(origin, reviewer.identity, reviewer.login)
      return actor ? [{ actor, state: reviewerState(reviewer.state), ...reviewer.state ? { stateRaw: reviewer.state } : {} }] : []
    }),
    labels: [],
    ...raw.url ? { url: raw.url } : {},
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    ...raw.merged_at ? { mergedAt: toDate(raw.merged_at), closedAt: toDate(raw.merged_at) } : {},
    lastActivityAt: toDate(raw.last_activity_at),
    ...raw.comment_count !== undefined ? { commentCount: raw.comment_count } : {},
    branches: {
      head: { ref: raw.branch || raw.original_branch || '', ...raw.head_sha ? { sha: raw.head_sha } : {}, repo },
      base: { ref: raw.base, ...raw.base_sha ? { sha: raw.base_sha } : {} },
    },
    raw,
  }
}

/** Every message of a discussion, replies after the message they answer. */
export function flattenMessages(messages: EntireMessage[] = []): EntireMessage[] {
  return messages.flatMap(message => [message, ...flattenMessages(message.replies)])
}

export function toComment(thread: ResolvedThreadRef, discussion: EntireDiscussion, raw: EntireMessage): Comment {
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id: raw.id },
    body: raw.body,
    author: identityActor(thread, raw.identity, raw.author),
    createdAt: toDate(raw.created_at),
    ...raw.updated_at ? { updatedAt: toDate(raw.updated_at) } : {},
    thread: { id: discussion.id, resolved: discussion.resolved },
    raw,
  }
}

function findingAuthor(thread: ResolvedThreadRef, raw: EntireReviewComment): Actor | undefined {
  const actor = identityActor(thread, raw.actor_identity?.kind === 'unknown' ? undefined : raw.actor_identity, undefined)
  return actor ?? (raw.actor_display_name ? { forge: thread.forge, instance: thread.instance, login: raw.actor_display_name, id: raw.actor_id ?? raw.actor_display_name, isBotHint: false } : undefined)
}

function anchor(raw: EntireReviewComment): Pick<ReviewComment, 'path' | 'line' | 'side'> {
  const { file_path, end_line, start_line } = raw.location
  const line = end_line ?? start_line
  return {
    ...file_path ? { path: file_path } : {},
    ...line ? { line, side: 'right' as const } : {},
  }
}

/** A finding: a review comment an agent or a person left on a change. */
export function toFinding(thread: ResolvedThreadRef, raw: EntireReviewComment, resolved = raw.status !== 'open'): ReviewComment {
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id: raw.id },
    body: raw.body ?? '',
    author: findingAuthor(thread, raw),
    ...anchor(raw),
    ...raw.discussion_id ? { thread: { id: raw.discussion_id, resolved } } : {},
    createdAt: toDate(raw.created_at),
    raw,
  }
}

/** A finding and the discussion under it, read as a review conversation. */
export function toReviewThread(thread: ResolvedThreadRef, discussion: EntireDiscussion & { review_comment: EntireReviewComment }): ReviewThread {
  const finding = discussion.review_comment
  const resolved = discussion.resolved || finding.status !== 'open'
  const { start_line, end_line } = finding.location
  const replies = flattenMessages(discussion.messages).map((message): ReviewComment => ({
    ref: { forge: thread.forge, instance: thread.instance, thread, id: message.id },
    body: message.body,
    author: identityActor(thread, message.identity, message.author),
    ...anchor(finding),
    inReplyTo: finding.id,
    thread: { id: discussion.id, resolved },
    createdAt: toDate(message.created_at),
    raw: message,
  }))
  return {
    id: discussion.id,
    resolved,
    outdated: finding.stale_outcome === 'stale',
    ...anchor(finding),
    ...start_line && end_line && start_line !== end_line ? { startLine: start_line } : {},
    comments: [toFinding(thread, finding, resolved), ...replies],
    raw: discussion,
  }
}

export function approvalState(raw: string): ReviewState {
  return raw === 'approved' || raw === 'approve' ? 'approved' : raw === 'changes_requested' || raw === 'request_changes' ? 'changes_requested' : raw === 'dismissed' ? 'dismissed' : 'unknown'
}

export function toApproval(thread: ResolvedThreadRef, raw: EntireApproval): Review {
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id: raw.id },
    author: { forge: thread.forge, instance: thread.instance, login: raw.author, id: raw.author, isBotHint: false },
    state: approvalState(raw.event),
    stateRaw: raw.event,
    ...raw.body ? { body: raw.body } : {},
    submittedAt: toDate(raw.created_at),
    comments: false,
    raw,
  }
}

/** The findings of one code review, as a review that comments. */
export function toCodeReview(thread: ResolvedThreadRef, id: string, findings: EntireReviewComment[]): Review {
  const [first] = findings
  return {
    ref: { forge: thread.forge, instance: thread.instance, thread, id },
    author: first ? findingAuthor(thread, first) : undefined,
    state: 'commented',
    stateRaw: 'review',
    submittedAt: first ? toDate(first.created_at) : undefined,
    comments: findings.map(finding => toFinding(thread, finding)),
    raw: findings,
  }
}
