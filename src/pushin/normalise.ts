import type { Actor, Collaborator, Comment, ForgeOrigin, Label, Notification, NotificationReason, Release, ReleaseRef, Repo, RepoPermissions, RepoRef, RepoRole, ResolvedThreadRef, Review, ReviewComment, Team, Thread } from '../model.ts'
import type { PushinCollaborator, PushinComment, PushinLabel, PushinNotification, PushinRelease, PushinRepository, PushinReview, PushinReviewComment, PushinTeam, PushinThread, PushinUser } from './types.ts'
import { reviewState } from '../events.ts'
import { toDate } from '../utils.ts'

export const FORGE = 'pushin'

export function toActor(origin: ForgeOrigin, user: PushinUser | undefined | null): Actor | undefined {
  if (!user) {
    return undefined
  }
  return {
    ...origin,
    login: user.login,
    id: String(user.id ?? user.login),
    name: user.name ?? undefined,
    avatarUrl: user.avatar_url,
    url: user.html_url,
    typeRaw: user.type,
    isBotHint: user.type === 'Bot',
  }
}

export function toRepoRef(origin: ForgeOrigin, raw: PushinRepository): RepoRef {
  const [owner, name] = raw.full_name.split('/')
  return {
    ...origin,
    owner: raw.owner?.login ?? owner ?? '',
    name: raw.name ?? name ?? '',
    externalId: raw.node_id ?? String(raw.id),
  }
}

export function toRepo(origin: ForgeOrigin, raw: PushinRepository): Repo {
  const visibility = raw.visibility === 'private' || raw.private ? 'private' : 'public'
  return {
    ref: toRepoRef(origin, raw),
    description: raw.description ?? undefined,
    defaultBranch: raw.default_branch,
    visibility,
    visibilityRaw: raw.visibility,
    isFork: false,
    isArchived: false,
    topics: raw.topics ?? [],
    url: raw.html_url,
    cloneUrls: raw.clone_url ? { https: raw.clone_url } : undefined,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    owner: toActor(origin, raw.owner),
    homepage: raw.homepage || undefined,
    stars: raw.stargazers_count,
    forks: raw.forks_count,
    watchers: raw.watchers_count,
    permissions: toPermissions(raw.permissions),
    raw,
  }
}

export function toLabel(raw: PushinLabel): Label {
  return {
    name: raw.name,
    colour: raw.color && /^[0-9a-f]{6}$/i.test(raw.color) ? raw.color : undefined,
    description: raw.description ?? undefined,
  }
}

type RawPermissions = PushinRepository['permissions']

function toPermissions(raw: RawPermissions): RepoPermissions | undefined {
  return raw && {
    admin: raw.admin ?? false,
    maintain: raw.maintain ?? false,
    push: raw.push ?? false,
    triage: raw.triage ?? false,
    pull: raw.pull ?? false,
  }
}

export function toRole(raw: PushinCollaborator): RepoRole {
  const permissions = raw.permissions ?? {}
  if (permissions.admin) {
    return 'admin'
  }
  if (permissions.maintain) {
    return 'maintain'
  }
  if (permissions.push) {
    return 'write'
  }
  if (permissions.triage) {
    return 'triage'
  }
  return permissions.pull ? 'read' : 'none'
}

export function toPermissionRole(raw: string): RepoRole {
  return raw === 'admin' || raw === 'write' || raw === 'read' ? raw : 'none'
}

export function toCollaborator(origin: ForgeOrigin, raw: PushinCollaborator): Collaborator {
  return {
    actor: toActor(origin, raw)!,
    role: toRole(raw),
    roleRaw: raw.role_name,
    permissions: toPermissions(raw.permissions),
    raw,
  }
}

export function toComment(thread: ResolvedThreadRef, raw: PushinComment): Comment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(raw.id) },
    body: raw.body,
    author: toActor({ forge: FORGE, instance: thread.instance }, raw.user),
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    raw,
  }
}

const REASONS: Record<string, NotificationReason> = {
  assign: 'assigned',
  review_requested: 'review_requested',
  mention: 'mention',
  author: 'author',
  comment: 'comment',
  subscribed: 'subscribed',
  state_change: 'state_change',
  manual: 'manual',
}

export function toNotification(origin: ForgeOrigin, raw: PushinNotification): Notification {
  const repo = toRepoRef(origin, raw.repository)
  const kind = raw.subject.type === 'Issue' ? 'issue' : raw.subject.type === 'PullRequest' ? 'pull_request' : undefined
  const number = /\/(\d+)\/?$/.exec(raw.subject.url)?.[1]
  return {
    ref: { ...origin, id: String(raw.id) },
    subject: kind && number
      ? { type: 'thread', thread: { ...origin, repo, kind, number } }
      : { type: 'other', typeRaw: raw.subject.type, repo, url: raw.subject.url },
    subjectTypeRaw: raw.subject.type,
    reason: REASONS[raw.reason] ?? 'unknown',
    reasonRaw: raw.reason,
    unread: raw.unread,
    title: raw.subject.title,
    subjectState: 'unknown',
    updatedAt: toDate(raw.updated_at) ?? new Date(0),
    lastReadAt: toDate(raw.last_read_at),
    url: raw.html_url ?? raw.subject.url,
    raw,
  }
}

export function toThread(ref: ResolvedThreadRef, raw: PushinThread): Thread {
  const origin = { forge: FORGE, instance: ref.instance }
  const kind = raw.pull_request ? 'pull_request' : ref.kind
  const merged = kind === 'pull_request' && (raw.merged || raw.merged_at || raw.pull_request?.merged_at || raw.state === 'merged')
  const state = merged ? 'merged' : raw.state === 'closed' ? 'closed' : 'open'
  return {
    ref: { ...ref, kind, externalId: raw.node_id ?? String(raw.id) },
    kind,
    title: raw.title,
    body: raw.body ?? undefined,
    state,
    stateRaw: merged ? 'merged' : raw.state,
    isDraft: kind === 'pull_request' && (raw.draft ?? false),
    author: toActor(origin, raw.user),
    assignees: (raw.assignees ?? []).flatMap(user => toActor(origin, user) ?? []),
    reviewers: [],
    labels: (raw.labels ?? []).map(toLabel),
    url: raw.html_url,
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    closedAt: toDate(raw.closed_at ?? raw.merged_at ?? raw.pull_request?.merged_at),
    mergedAt: kind === 'pull_request' ? toDate(raw.merged_at ?? raw.pull_request?.merged_at) : undefined,
    lastActivityAt: toDate(raw.updated_at),
    locked: raw.locked,
    commentCount: raw.comments,
    branches: kind === 'pull_request' && (raw.head || raw.base)
      ? { head: { ref: raw.head?.ref ?? '', sha: raw.head?.sha ?? undefined }, base: { ref: raw.base?.ref ?? '' } }
      : undefined,
    raw,
  }
}

export function toRelease(repo: RepoRef, raw: PushinRelease): Release {
  const ref: ReleaseRef = { forge: FORGE, instance: repo.instance, repo, id: String(raw.id), tag: raw.tag_name }
  return {
    ref,
    name: raw.name ?? undefined,
    tag: raw.tag_name,
    author: toActor({ forge: FORGE, instance: ref.instance }, raw.author),
    body: raw.body ?? undefined,
    url: raw.html_url,
    isDraft: raw.draft,
    isPrerelease: raw.prerelease,
    createdAt: toDate(raw.created_at),
    publishedAt: toDate(raw.published_at),
    immutable: raw.immutable,
    assets: raw.assets.flatMap(asset => asset.browser_download_url
      ? [{
          ref: { forge: FORGE, instance: repo.instance, repo, release: ref, id: String(asset.id) },
          name: asset.name,
          url: asset.browser_download_url,
          contentType: asset.content_type,
          downloadCount: asset.download_count,
          size: asset.size,
        }]
      : []),
    raw,
  }
}

export function toTeam(org: RepoRef, raw: PushinTeam): Team {
  return {
    ref: { forge: FORGE, instance: org.instance, org, id: String(raw.id), slug: raw.slug },
    name: raw.name,
    raw,
  }
}

export function toReviewComment(thread: ResolvedThreadRef, raw: PushinReviewComment): ReviewComment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(raw.id) },
    body: raw.body,
    author: toActor({ forge: FORGE, instance: thread.instance }, raw.user),
    path: raw.path ?? undefined,
    line: raw.line ?? undefined,
    side: raw.side === 'LEFT' ? 'left' : raw.side === 'RIGHT' ? 'right' : undefined,
    inReplyTo: raw.in_reply_to_id === null ? undefined : String(raw.in_reply_to_id),
    thread: { id: String(raw.in_reply_to_id ?? raw.id), resolved: raw.resolved },
    createdAt: toDate(raw.created_at),
    url: raw.html_url,
    raw,
  }
}

export function toReview(thread: ResolvedThreadRef, raw: PushinReview, comments: ReviewComment[]): Review {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: String(raw.id) },
    author: toActor({ forge: FORGE, instance: thread.instance }, raw.user),
    state: reviewState(raw.state),
    stateRaw: raw.state,
    body: raw.body || undefined,
    submittedAt: toDate(raw.submitted_at),
    comments,
    url: raw.html_url,
    raw,
  }
}
