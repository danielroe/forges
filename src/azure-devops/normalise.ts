import type { Actor, Branch, ChangedFile, Check, CheckState, Comment, Commit, ForgeEventInput, Repo, RepoRef, ResolvedThreadRef, ReviewState, Tag, Thread, ThreadRef, TreeEntry } from '../model.ts'
import type { AzureChange, AzureComment, AzureCommit, AzureIdentity, AzureItem, AzurePolicyEvaluation, AzurePullRequest, AzureRef, AzureRepository, AzureReviewer, AzureStatus, AzureThread, AzureWorkItem, AzureWorkItemComment, AzureWorkItemUpdate } from './types.ts'
import { toDate } from '../utils.ts'

export const FORGE = 'azure-devops' as const

export function toActor(instance: string, identity: AzureIdentity | undefined | null): Actor | undefined {
  if (!identity) {
    return undefined
  }
  const login = identity.uniqueName ?? identity.displayName ?? identity.id
  return {
    forge: FORGE,
    instance,
    login,
    id: identity.id,
    name: identity.displayName,
    avatarUrl: identity.imageUrl,
    typeRaw: identity.isContainer ? 'group' : 'user',
    isBotHint: /Build Service|Project Collection Build Service/.test(identity.displayName ?? '') || /^Build\\/.test(identity.uniqueName ?? ''),
  }
}

/** Repositories live in a project in an organization; the owner is `org/project`. */
export function toRepoRef(instance: string, organization: string, repo: AzureRepository): RepoRef {
  return { forge: FORGE, instance, owner: `${organization}/${repo.project.name}`, name: repo.name, externalId: repo.id }
}

/** Work items belong to a project rather than a repository. */
export function projectRef(instance: string, organization: string, project: string): RepoRef {
  return { forge: FORGE, instance, owner: `${organization}/${project}`, name: '', kind: 'namespace' }
}

export function toRepo(instance: string, organization: string, raw: AzureRepository): Repo {
  return {
    ref: toRepoRef(instance, organization, raw),
    defaultBranch: raw.defaultBranch?.replace(/^refs\/heads\//, ''),
    visibility: 'private',
    isFork: raw.isFork ?? false,
    isArchived: raw.isDisabled ?? false,
    parent: raw.parentRepository?.project ? toRepoRef(instance, organization, { ...raw.parentRepository, project: raw.parentRepository.project }) : undefined,
    topics: [],
    url: raw.webUrl,
    cloneUrls: { https: raw.remoteUrl, ssh: raw.sshUrl },
    raw,
  }
}

const VOTES: Record<number, ReviewState> = { 10: 'approved', 5: 'approved', 0: 'pending', [-5]: 'changes_requested', [-10]: 'changes_requested' }

function toReviewer(instance: string, raw: AzureReviewer) {
  return { actor: toActor(instance, raw)!, state: VOTES[raw.vote] ?? 'unknown', stateRaw: `vote:${raw.vote}`, ...raw.isContainer ? { isTeam: true } : {} }
}

const branch = (ref: string) => ref.replace(/^refs\/heads\//, '')

export function toPullThread(ref: ResolvedThreadRef, raw: AzurePullRequest): Thread {
  const instance = ref.instance
  const state = raw.status === 'active' ? 'open' : raw.status === 'completed' ? 'merged' : raw.status === 'abandoned' ? 'closed' : 'unknown'
  return {
    ref: { ...ref, kind: 'pull_request', number: String(raw.pullRequestId), externalId: raw.artifactId },
    kind: 'pull_request',
    title: raw.title,
    body: raw.description || undefined,
    state,
    stateRaw: raw.status,
    isDraft: raw.isDraft ?? false,
    author: toActor(instance, raw.createdBy),
    assignees: [],
    reviewers: (raw.reviewers ?? []).map(reviewer => toReviewer(instance, reviewer)),
    labels: (raw.labels ?? []).filter(label => label.active !== false).map(label => ({ name: label.name })),
    url: raw._links?.web?.href,
    createdAt: toDate(raw.creationDate),
    closedAt: toDate(raw.closedDate),
    lastActivityAt: toDate(raw.closedDate ?? raw.creationDate),
    branches: {
      head: { ref: branch(raw.sourceRefName), sha: raw.lastMergeSourceCommit?.commitId },
      base: { ref: branch(raw.targetRefName), sha: raw.lastMergeTargetCommit?.commitId },
      mergeCommitSha: raw.status === 'completed' ? raw.lastMergeCommit?.commitId : undefined,
    },
    raw,
  }
}

const field = <T>(item: AzureWorkItem, name: string) => item.fields[name] as T | undefined

/** State categories `Completed` and `Removed` are closed; every other category is open. */
export function toWorkItemThread(ref: ResolvedThreadRef, raw: AzureWorkItem, category: string | undefined): Thread {
  const instance = ref.instance
  const assignee = field<AzureIdentity>(raw, 'System.AssignedTo')
  const tags = field<string>(raw, 'System.Tags')
  const state = category === undefined ? 'unknown' : category === 'Completed' || category === 'Removed' ? 'closed' : 'open'
  return {
    ref: { ...ref, kind: 'issue', number: String(raw.id), typeRaw: field<string>(raw, 'System.WorkItemType') },
    kind: 'issue',
    title: field<string>(raw, 'System.Title') ?? '',
    body: field<string>(raw, 'System.Description'),
    state,
    stateRaw: field<string>(raw, 'System.State'),
    stateReason: field<string>(raw, 'System.Reason'),
    isDraft: false,
    author: toActor(instance, field<AzureIdentity>(raw, 'System.CreatedBy')),
    assignees: assignee ? [toActor(instance, assignee)!] : [],
    reviewers: [],
    labels: (tags ?? '').split(';').map(tag => tag.trim()).filter(Boolean).map(name => ({ name })),
    url: raw._links?.html?.href,
    createdAt: toDate(field<string>(raw, 'System.CreatedDate')),
    updatedAt: toDate(field<string>(raw, 'System.ChangedDate')),
    closedAt: toDate(field<string>(raw, 'Microsoft.VSTS.Common.ClosedDate')),
    lastActivityAt: toDate(field<string>(raw, 'System.ChangedDate')),
    commentCount: field<number>(raw, 'System.CommentCount'),
    raw,
  }
}

/** Conversation threads have no file anchor and carry text comments; system threads record votes and updates. */
export function isConversationThread(thread: AzureThread): boolean {
  return !thread.threadContext?.filePath && thread.comments.some(comment => comment.commentType !== 'system')
}

/** Pull request comment ids are unique within a thread only, so a comment id is `<thread>/<comment>`. */
export function commentId(thread: AzureThread, comment: AzureComment): string {
  return `${thread.id}/${comment.id}`
}

export function toPullComment(ref: ThreadRef, thread: AzureThread, raw: AzureComment): Comment {
  return {
    ref: { forge: FORGE, instance: ref.instance, thread: ref, id: commentId(thread, raw) },
    body: raw.content ?? '',
    author: toActor(ref.instance, raw.author),
    createdAt: toDate(raw.publishedDate),
    updatedAt: toDate(raw.lastUpdatedDate),
    ...thread.status && { thread: { id: String(thread.id), resolved: thread.status !== 'active' && thread.status !== 'pending' } },
    raw,
  }
}

export function toThreadEvents(ref: ThreadRef, thread: AzureThread): ForgeEventInput[] {
  return thread.comments.filter(comment => !comment.isDeleted).map((comment) => {
    const actor = toActor(ref.instance, comment.author)
    const system = comment.commentType === 'system'
    const vote = thread.properties?.CodeReviewThreadType?.$value === 'VoteUpdate'
    const kind: ForgeEventInput['kind'] = vote ? 'review' : system ? 'other' : thread.threadContext?.filePath ? 'review_comment' : 'comment'
    return {
      forge: FORGE,
      instance: ref.instance,
      id: commentId(thread, comment),
      kind,
      kindRaw: (thread.properties?.CodeReviewThreadType?.$value as string | undefined) ?? comment.commentType,
      summary: `${actor?.login ?? 'someone'} ${system ? comment.content ?? 'updated the pull request' : 'commented'}`,
      occurredAt: toDate(comment.publishedDate) ?? new Date(0),
      actor,
      repo: ref.repo,
      thread: ref,
      source: 'poll' as const,
      payload: comment,
    }
  })
}

export function toWorkItemComment(ref: ThreadRef, raw: AzureWorkItemComment): Comment {
  return {
    ref: { forge: FORGE, instance: ref.instance, thread: ref, id: String(raw.id) },
    body: raw.text,
    author: toActor(ref.instance, raw.createdBy),
    createdAt: toDate(raw.createdDate),
    updatedAt: toDate(raw.modifiedDate),
    raw,
  }
}

export function toWorkItemEvents(ref: ThreadRef, updates: AzureWorkItemUpdate[], comments: AzureWorkItemComment[]): ForgeEventInput[] {
  const events: ForgeEventInput[] = updates.flatMap((update) => {
    const fields = update.fields ?? {}
    const actor = toActor(ref.instance, update.revisedBy)
    const kind: ForgeEventInput['kind'] | undefined = fields['System.State'] ? 'state_change' : fields['System.AssignedTo'] ? 'assignment' : fields['System.Tags'] ? 'label' : undefined
    if (!kind || update.id === 1) {
      return []
    }
    return [{
      forge: FORGE,
      instance: ref.instance,
      id: `update:${update.id}`,
      kind,
      kindRaw: Object.keys(fields).join(','),
      summary: `${actor?.login ?? 'someone'} changed ${kind === 'state_change' ? `state to ${String(fields['System.State']?.newValue)}` : kind === 'assignment' ? 'the assignee' : 'the tags'}`,
      occurredAt: toDate(update.revisedDate) ?? new Date(0),
      actor,
      repo: ref.repo,
      thread: ref,
      source: 'poll' as const,
      payload: update,
    }]
  })
  for (const comment of comments) {
    const actor = toActor(ref.instance, comment.createdBy)
    events.push({ forge: FORGE, instance: ref.instance, id: `comment:${comment.id}`, kind: 'comment', kindRaw: 'comment', summary: `${actor?.login ?? 'someone'} commented`, occurredAt: toDate(comment.createdDate) ?? new Date(0), actor, repo: ref.repo, thread: ref, source: 'poll', payload: comment })
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
}

const STATUS_STATES: Record<AzureStatus['state'], CheckState> = { notSet: 'unknown', pending: 'pending', succeeded: 'success', failed: 'failure', error: 'failure', notApplicable: 'neutral' }

export function toStatusCheck(repo: RepoRef, raw: AzureStatus): Check {
  const state = STATUS_STATES[raw.state] ?? 'unknown'
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: String(raw.id), type: 'status' },
    name: raw.context.genre ? `${raw.context.genre}/${raw.context.name}` : raw.context.name,
    state,
    stateRaw: raw.state,
    url: raw.targetUrl,
    startedAt: toDate(raw.creationDate),
    completedAt: state === 'pending' ? undefined : toDate(raw.updatedDate),
    raw,
  }
}

const POLICY_STATES: Record<AzurePolicyEvaluation['status'], CheckState> = { queued: 'pending', running: 'pending', approved: 'success', rejected: 'failure', broken: 'failure', notApplicable: 'neutral' }

/** Branch policy evaluations: required reviewers, builds, linked work items and the like. Optional policies that fail are neutral. */
export function toPolicyCheck(repo: RepoRef, raw: AzurePolicyEvaluation): Check {
  const blocking = raw.configuration?.isBlocking !== false
  const state = POLICY_STATES[raw.status] ?? 'unknown'
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, id: raw.evaluationId, type: 'policy' },
    name: raw.configuration?.settings?.displayName ?? raw.configuration?.type?.displayName ?? 'Policy',
    state: state === 'failure' && !blocking ? 'neutral' : state,
    stateRaw: raw.status,
    startedAt: toDate(raw.startedDate),
    completedAt: toDate(raw.completedDate),
    raw,
  }
}

/** Azure names a change `add`, `edit`, `delete`, `rename` or a comma-joined combination. */
export function toChangedFile(raw: AzureChange): ChangedFile {
  const path = raw.item?.path?.replace(/^\//, '') ?? ''
  const types = raw.changeType?.split(',').map(type => type.trim().toLowerCase()) ?? []
  const status = types.includes('delete')
    ? 'removed'
    : types.includes('rename')
      ? 'renamed'
      : types.includes('add') ? 'added' : types.includes('edit') ? 'modified' : 'changed'
  return {
    path,
    previousPath: raw.sourceServerItem?.replace(/^\//, ''),
    status,
    statusRaw: raw.changeType,
    sha: raw.item?.objectId,
  }
}

export function toCommit(repo: RepoRef, raw: AzureCommit, files?: ChangedFile[]): Commit {
  const counts = raw.changeCounts
  return {
    ref: { forge: FORGE, instance: repo.instance, repo, sha: raw.commitId },
    sha: raw.commitId,
    message: raw.comment ?? '',
    author: { name: raw.author?.name, email: raw.author?.email, date: toDate(raw.author?.date) },
    committer: { name: raw.committer?.name, email: raw.committer?.email, date: toDate(raw.committer?.date) },
    parents: raw.parents ?? [],
    url: raw.remoteUrl,
    ...counts ? { stats: { additions: counts.Add ?? 0, deletions: counts.Delete ?? 0 } } : {},
    ...files ? { files } : {},
    raw,
  }
}

export function toBranch(raw: AzureRef): Branch {
  return { name: raw.name.replace(/^refs\/heads\//, ''), sha: raw.objectId ?? '', url: raw.url, raw }
}

export function toTag(raw: AzureRef): Tag {
  return { name: raw.name.replace(/^refs\/tags\//, ''), sha: raw.peeledObjectId ?? raw.objectId ?? '', url: raw.url, raw }
}

export function toTreeEntry(raw: AzureItem): TreeEntry {
  return {
    path: raw.path.replace(/^\//, ''),
    type: raw.isFolder || raw.gitObjectType === 'tree' ? 'directory' : raw.gitObjectType === 'commit' ? 'submodule' : 'file',
    sha: raw.objectId,
    size: raw.size,
  }
}
