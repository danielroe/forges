export interface AzureIdentity {
  id: string
  displayName?: string
  uniqueName?: string
  imageUrl?: string
  url?: string
  isContainer?: boolean
  descriptor?: string
}

/** A team of a project, as `GET /_apis/projects/{project}/teams` reports it. */
export interface AzureTeam {
  id: string
  name: string
  description?: string
  url?: string
  identityUrl?: string
  projectId?: string
  projectName?: string
}

/** One member of a team, as `GET /_apis/projects/{project}/teams/{team}/members` reports them. */
export interface AzureTeamMember {
  isTeamAdmin?: boolean
  identity: AzureIdentity
}

export interface AzureReviewer extends AzureIdentity {
  /** 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected. */
  vote: number
  isRequired?: boolean
  hasDeclined?: boolean
}

export interface AzureProjectRef {
  id: string
  name: string
  visibility?: 'private' | 'public'
}

export interface AzureRepository {
  id: string
  name: string
  defaultBranch?: string
  isDisabled?: boolean
  isFork?: boolean
  project: AzureProjectRef
  remoteUrl?: string
  sshUrl?: string
  webUrl?: string
  parentRepository?: { id: string, name: string, project?: AzureProjectRef }
}

export interface AzurePullRequest {
  pullRequestId: number
  artifactId?: string
  status: 'notSet' | 'active' | 'abandoned' | 'completed'
  title: string
  description?: string
  isDraft?: boolean
  createdBy?: AzureIdentity
  creationDate?: string
  closedDate?: string
  closedBy?: AzureIdentity
  sourceRefName: string
  targetRefName: string
  mergeStatus?: string
  lastMergeSourceCommit?: { commitId: string }
  lastMergeTargetCommit?: { commitId: string }
  lastMergeCommit?: { commitId: string }
  reviewers?: AzureReviewer[]
  labels?: Array<{ id?: string, name: string, active?: boolean }>
  repository: AzureRepository
  autoCompleteSetBy?: AzureIdentity
  _links?: { web?: { href: string } }
}

export interface AzureComment {
  id: number
  parentCommentId?: number
  author?: AzureIdentity
  content?: string
  commentType?: 'unknown' | 'text' | 'codeChange' | 'system'
  publishedDate?: string
  lastUpdatedDate?: string
  isDeleted?: boolean
}

export interface AzureThread {
  id: number
  publishedDate?: string
  lastUpdatedDate?: string
  status?: string
  isDeleted?: boolean
  comments: AzureComment[]
  threadContext?: { filePath?: string } | null
  properties?: Record<string, { $type?: string, $value?: unknown }>
}

export interface AzureStatus {
  id: number
  state: 'notSet' | 'pending' | 'succeeded' | 'failed' | 'error' | 'notApplicable'
  description?: string
  context: { name: string, genre?: string }
  targetUrl?: string
  creationDate?: string
  updatedDate?: string
}

export interface AzurePolicyEvaluation {
  evaluationId: string
  status: 'queued' | 'running' | 'approved' | 'rejected' | 'notApplicable' | 'broken'
  startedDate?: string
  completedDate?: string
  configuration?: { isBlocking?: boolean, isEnabled?: boolean, type?: { displayName?: string }, settings?: { displayName?: string } }
}

export interface AzureWorkItem {
  id: number
  rev?: number
  fields: Record<string, unknown>
  url?: string
  _links?: { html?: { href: string } }
}

export interface AzureWorkItemComment {
  id: number
  workItemId: number
  text: string
  createdBy?: AzureIdentity
  createdDate?: string
  modifiedDate?: string
  isDeleted?: boolean
}

export interface AzureWorkItemUpdate {
  id: number
  revisedBy?: AzureIdentity
  revisedDate?: string
  fields?: Record<string, { oldValue?: unknown, newValue?: unknown }>
}

export interface AzureServiceHookEvent {
  id: string
  eventType: string
  publisherId?: string
  message?: { text?: string }
  resource: Record<string, unknown>
  resourceContainers?: { project?: { id: string }, account?: { id: string, baseUrl?: string }, collection?: { id: string, baseUrl?: string } }
  createdDate?: string
}

export interface AzureItem {
  objectId?: string
  commitId?: string
  path: string
  gitObjectType?: string
  isFolder?: boolean
  size?: number
  url?: string
  content?: string
}

export interface AzureRef {
  name: string
  objectId?: string
  peeledObjectId?: string
  url?: string
}

export interface AzureChange {
  item?: { path?: string, gitObjectType?: string, isFolder?: boolean, objectId?: string, originalPath?: string }
  changeType?: string
  sourceServerItem?: string
}

export interface AzureCommit {
  commitId: string
  comment?: string
  author?: { name?: string, email?: string, date?: string }
  committer?: { name?: string, email?: string, date?: string }
  parents?: string[]
  changeCounts?: { Add?: number, Edit?: number, Delete?: number }
  remoteUrl?: string
  changes?: AzureChange[]
}

export interface AzureCommitDiffs {
  aheadCount?: number
  behindCount?: number
  commonCommit?: string
  changes?: AzureChange[]
}
