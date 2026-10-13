import type { ChangedFile, Commit, CommitSignature, ForgeOrigin, Repo, RepoRef, TreeEntryType } from '../model.ts'
import type { ArtifactsCommit, ArtifactsIdentity, ArtifactsRepository, ArtifactsTreeEntry } from './types.ts'
import { toDate } from '../utils.ts'

export const FORGE = 'cloudflare-artifacts'

const FORK_SOURCE = 'artifacts:'

export function toRepoRef(origin: ForgeOrigin, namespace: string, raw: ArtifactsRepository): RepoRef {
  return { ...origin, owner: namespace, name: raw.name, externalId: raw.id }
}

/** A fork names its parent as `artifacts:<namespace>/<name>`. An import is no fork. */
function parentOf(origin: ForgeOrigin, source: string | null | undefined): RepoRef | undefined {
  const [owner, name] = source?.startsWith(FORK_SOURCE) ? source.slice(FORK_SOURCE.length).split('/') : []
  return owner && name ? { ...origin, owner, name } : undefined
}

export function toRepo(origin: ForgeOrigin, namespace: string, raw: ArtifactsRepository): Repo {
  const parent = parentOf(origin, raw.source)
  return {
    ref: toRepoRef(origin, namespace, raw),
    description: raw.description ?? undefined,
    defaultBranch: raw.default_branch,
    /** Even a clone takes a repository token, so nothing on Artifacts is public. */
    visibility: 'private',
    isFork: Boolean(parent),
    isArchived: false,
    parent,
    topics: [],
    cloneUrls: { https: raw.remote },
    createdAt: toDate(raw.created_at),
    updatedAt: toDate(raw.updated_at),
    pushedAt: toDate(raw.last_push_at),
    raw,
  }
}

function signature(identity: ArtifactsIdentity, seconds: number): CommitSignature {
  return { name: identity.name, email: identity.email, date: toDate(seconds * 1000) }
}

export function toCommit(origin: ForgeOrigin, repo: RepoRef, raw: ArtifactsCommit, files?: ChangedFile[]): Commit {
  return {
    ref: { ...origin, repo, sha: raw.hash },
    sha: raw.hash,
    message: raw.message,
    author: signature(raw.author, raw.authoredAt),
    committer: signature(raw.committer, raw.committedAt),
    parents: raw.parents,
    ...files ? { files } : {},
    raw,
  }
}

export function toTreeType(entry: ArtifactsTreeEntry): TreeEntryType {
  return entry.type === 'tree' ? 'directory' : entry.type === 'symlink' ? 'symlink' : entry.type === 'gitlink' ? 'submodule' : 'file'
}
