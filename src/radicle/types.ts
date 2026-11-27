/** An identity as the node knows it: its DID, and the alias the node has for it, if any. */
export interface RadicleAuthor {
  id: string
  alias?: string
}

/** The `xyz.radicle.project` payload of a repository's identity document. */
export interface RadicleProject {
  name: string
  description?: string
  defaultBranch?: string
}

/** `GET /repos/{rid}` and each item of the repository listings. */
export interface RadicleRepository {
  rid: string
  payloads: {
    'xyz.radicle.project'?: {
      data: RadicleProject
      meta?: {
        head?: string
        issues?: RadicleIssueCounts
        patches?: RadiclePatchCounts
      }
    }
  }
  /** Counts of issues and patches, absent before httpd 0.28. */
  cobs?: {
    issues?: RadicleIssueCounts
    patches?: RadiclePatchCounts
  }
  /** The default branch as a full ref, such as `refs/heads/main`. */
  defaultBranch?: string
  delegates: RadicleAuthor[]
  threshold: number
  visibility: { type: 'public' | 'private' }
  seeding: number
  /** The canonical refs the delegates agreed on. */
  refs?: {
    refs?: Record<string, string>
    tags?: Record<string, { commit: string }>
  }
}

export interface RadicleIssueCounts {
  open: number
  closed: number
}

export interface RadiclePatchCounts {
  open: number
  draft: number
  archived: number
  merged: number
}

export interface RadicleReaction {
  emoji: string
  authors: RadicleAuthor[]
}

/** A comment on an issue or on a revision of a patch. */
export interface RadicleComment {
  id: string
  author: RadicleAuthor
  body: string
  edits: Array<{ author: RadicleAuthor, body: string, timestamp: number }>
  reactions: RadicleReaction[]
  /** Unix seconds. */
  timestamp: number
  replyTo: string | null
  resolved: boolean
  /** Patch comments only: where in the diff the comment sits. */
  location?: {
    commit: string
    path: string
    new?: RadicleRange
    old?: RadicleRange
  } | null
}

export type RadicleRange = { type: 'lines', range: { start: number, end: number } } | { type: 'chars', line: number, range: { start: number, end: number } }

export interface RadicleIssue {
  id: string
  author: RadicleAuthor
  title: string
  state: { status: 'open' } | { status: 'closed', reason: 'other' | 'solved' }
  assignees: RadicleAuthor[]
  /** The first comment is the issue's description. */
  discussion: RadicleComment[]
  labels: string[]
}

export interface RadicleReview {
  id: string
  author: RadicleAuthor
  verdict: 'accept' | 'reject' | null
  summary: string | null
  comments: RadicleComment[]
  timestamp: number
}

export interface RadicleRevision {
  id: string
  author: RadicleAuthor
  description: string
  base: string
  oid: string
  refs: string[]
  discussions: RadicleComment[]
  reactions: RadicleReaction[]
  timestamp: number
  reviews: RadicleReview[]
}

export interface RadiclePatch {
  id: string
  author: RadicleAuthor
  title: string
  state:
    | { status: 'draft' }
    | { status: 'open', conflicts?: unknown[] }
    | { status: 'archived' }
    | { status: 'merged', revision: string, commit: string }
  /** `delegates`: the patch asks to merge into the canonical default branch. */
  target: string
  labels: string[]
  merges: Array<{ author: RadicleAuthor, commit: string, timestamp: number, revision: string }>
  assignees: RadicleAuthor[]
  /** Oldest first. The first revision's description is the patch's description. */
  revisions: RadicleRevision[]
}

export interface RadicleCommit {
  id: string
  author: { name: string, email: string }
  summary: string
  description: string
  parents: string[]
  committer: { name: string, email: string, time: number }
}

export interface RadicleTreeEntry {
  path: string
  oid: string
  name: string
  kind: 'tree' | 'blob' | 'submodule'
}

export interface RadicleTree {
  entries: RadicleTreeEntry[]
  lastCommit: RadicleCommit
  name: string
  path: string
}

export interface RadicleBlob {
  binary: boolean
  name: string
  /** UTF-8 text, or base64 when the bytes are not UTF-8. */
  content: string
  path: string
  lastCommit: RadicleCommit
}

export type RadicleFileDiff
  = | { status: 'added', path: string, new: RadicleDiffFile, diff: RadicleDiffContent }
    | { status: 'deleted', path: string, old: RadicleDiffFile, diff: RadicleDiffContent }
    | { status: 'modified', path: string, old: RadicleDiffFile, new: RadicleDiffFile, diff: RadicleDiffContent }
    | { status: 'moved' | 'copied', oldPath: string, newPath: string, current?: RadicleDiffFile, old?: RadicleDiffFile, new?: RadicleDiffFile, diff?: RadicleDiffContent }

export interface RadicleDiffFile {
  oid: string
  mode: 'blob' | 'blobExecutable' | 'tree' | 'link' | 'commit'
}

export type RadicleDiffContent
  = | { type: 'binary' }
    | { type: 'empty' }
    | { type: 'plain', stats: { additions: number, deletions: number } }

export interface RadicleDiff {
  files: RadicleFileDiff[]
  stats: { filesChanged: number, insertions: number, deletions: number }
}

/** `GET /repos/{rid}/commits/{sha}`. */
export interface RadicleCommitDetail {
  commit: RadicleCommit
  diff: RadicleDiff
  branches: string[]
}

/** `GET /repos/{rid}/diff/{base}/{oid}`. */
export interface RadicleComparison {
  diff: RadicleDiff
  commits: RadicleCommit[]
}
