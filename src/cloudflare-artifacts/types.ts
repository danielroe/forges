/** The v4 envelope around every JSON response. */
export interface ArtifactsEnvelope<T> {
  result: T
  success: boolean
  /** Repository and namespace listings page by cursor; it is absent on the last page. */
  result_info?: { cursor?: string }
}

export interface ArtifactsNamespace {
  namespace: string
}

export interface ArtifactsRepository {
  id: string
  name: string
  description: string | null
  default_branch: string
  created_at?: string
  updated_at?: string
  last_push_at?: string | null
  /** `git:<url>` for an import, `artifacts:<namespace>/<name>` for a fork, `null` otherwise. */
  source?: string | null
  read_only?: boolean
  remote: string
  status?: string
}

export interface ArtifactsIdentity {
  name: string
  email: string
}

export interface ArtifactsCommit {
  hash: string
  treeHash: string
  message: string
  author: ArtifactsIdentity
  committer: ArtifactsIdentity
  parents: string[]
  /** Unix seconds. */
  authoredAt: number
  committedAt: number
}

export interface ArtifactsTreeEntry {
  name: string
  mode: string
  hash: string
  type: 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink'
}
