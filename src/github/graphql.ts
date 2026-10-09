import type { Actor, ChecksSummary, Comment, ForgeEventInput, Milestone, ReactionContent, ResolvedThreadRef, Reviewer, SubscriptionState, Thread, ThreadRef } from '../model.ts'
import { toDate } from '../utils.ts'
import { FORGE } from './normalise.ts'

const ACTOR_FIELDS = `__typename login avatarUrl url ... on User { databaseId name } ... on Bot { databaseId }`

const USER_FIELDS = `__typename login avatarUrl url databaseId name`

const DISCUSSION_FIELDS = `id number title body closed stateReason url createdAt updatedAt closedAt locked
      author { ${ACTOR_FIELDS} }
      labels(first: 50) { nodes { name color description } }
      comments { totalCount }`

export const DISCUSSION_THREAD = `query DiscussionThread($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      ${DISCUSSION_FIELDS}
    }
  }
}`

export const DISCUSSIONS_LIST = `query DiscussionsList($owner: String!, $name: String!, $first: Int!, $after: String, $field: DiscussionOrderField!, $direction: OrderDirection!) {
  repository(owner: $owner, name: $name) {
    discussions(first: $first, after: $after, orderBy: { field: $field, direction: $direction }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${DISCUSSION_FIELDS}
      }
    }
  }
}`

export const UPDATE_DISCUSSION = `mutation UpdateDiscussion($id: ID!, $title: String, $body: String) {
  updateDiscussion(input: { discussionId: $id, title: $title, body: $body }) { discussion { ${DISCUSSION_FIELDS} } }
}`

const COMMENT_FIELDS = `id databaseId body createdAt updatedAt url author { ${ACTOR_FIELDS} }`

export const UPDATE_DISCUSSION_COMMENT = `mutation UpdateDiscussionComment($id: ID!, $body: String!) {
  updateDiscussionComment(input: { commentId: $id, body: $body }) { comment { ${COMMENT_FIELDS} } }
}`

export const DELETE_DISCUSSION_COMMENT = `mutation DeleteDiscussionComment($id: ID!) {
  deleteDiscussionComment(input: { id: $id }) { comment { id } }
}`

export const SUBSCRIPTION_STATE = `query SubscriptionState($owner: String!, $name: String!, $number: Int!, $discussion: Boolean!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) @skip(if: $discussion) {
      ... on Issue { id viewerSubscription }
      ... on PullRequest { id viewerSubscription }
    }
    discussion(number: $number) @include(if: $discussion) { id viewerSubscription }
  }
}`

export const UPDATE_SUBSCRIPTION = `mutation UpdateSubscription($id: ID!, $state: SubscriptionState!) {
  updateSubscription(input: { subscribableId: $id, state: $state }) { subscribable { viewerSubscription } }
}`

const ISSUE_FIELDS = `id number title body state stateReason createdAt updatedAt closedAt url locked
      author { ${ACTOR_FIELDS} }
      assignees(first: 20) { nodes { ${USER_FIELDS} } }
      labels(first: 50) { nodes { name color description } }
      comments { totalCount }
      participants(first: 20) { nodes { ${USER_FIELDS} } }
      milestone { number title state description dueOn url }
      viewerSubscription`

const PULL_FIELDS = `id number title body state isDraft createdAt updatedAt closedAt mergedAt url locked
      author { ${ACTOR_FIELDS} }
      assignees(first: 20) { nodes { ${USER_FIELDS} } }
      labels(first: 50) { nodes { name color description } }
      comments { totalCount }
      participants(first: 20) { nodes { ${USER_FIELDS} } }
      milestone { number title state description dueOn url }
      viewerSubscription
      headRefName headRefOid baseRefName baseRefOid
      headRepository { databaseId name owner { login } }
      mergeCommit { oid }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login databaseId avatarUrl url } ... on Bot { login databaseId avatarUrl url } ... on Team { slug databaseId name url } } } }`

/** One aliased query reading many issues, pull requests and discussions. */
export function threadsBatchQuery(refs: ResolvedThreadRef[]): { query: string, variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {}
  const declarations: string[] = []
  const fields = refs.map((ref, index) => {
    variables[`o${index}`] = ref.repo.owner
    variables[`n${index}`] = ref.repo.name
    variables[`k${index}`] = Number(ref.number)
    declarations.push(`$o${index}: String!`, `$n${index}: String!`, `$k${index}: Int!`)
    const body = ref.kind === 'discussion'
      ? `discussion(number: $k${index}) { ${DISCUSSION_FIELDS} }`
      : `issueOrPullRequest(number: $k${index}) { __typename ... on Issue { ${ISSUE_FIELDS} } ... on PullRequest { ${PULL_FIELDS} } }`
    return `t${index}: repository(owner: $o${index}, name: $n${index}) { ${body} }`
  })
  return { query: `query ThreadsBatch(${declarations.join(', ')}) {\n  ${fields.join('\n  ')}\n}`, variables }
}

export interface GraphQLLabel { name: string, color?: string, description?: string | null }

export interface GraphQLMilestone { number: number, title: string, state?: string, description?: string | null, dueOn?: string | null, url?: string }

/** A GraphQL milestone as the model holds it. */
export function toGraphQLMilestone(raw: GraphQLMilestone | null | undefined): Milestone | undefined {
  return raw
    ? {
        id: String(raw.number),
        title: raw.title,
        state: raw.state === 'CLOSED' ? 'closed' : 'open',
        description: raw.description ?? undefined,
        dueOn: toDate(raw.dueOn),
        url: raw.url,
        raw,
      }
    : undefined
}

export function toViewerSubscription(value: string | null | undefined): SubscriptionState | undefined {
  return value === 'SUBSCRIBED' ? 'subscribed' : value === 'IGNORED' ? 'ignored' : value === 'UNSUBSCRIBED' ? 'none' : undefined
}

export interface GraphQLIssueOrPull {
  __typename: 'Issue' | 'PullRequest'
  id: string
  number: number
  title: string
  body?: string
  state: string
  stateReason?: string | null
  isDraft?: boolean
  createdAt?: string
  updatedAt?: string
  closedAt?: string | null
  mergedAt?: string | null
  url?: string
  locked?: boolean
  author?: GraphQLActor | null
  assignees?: { nodes: GraphQLActor[] }
  labels?: { nodes: GraphQLLabel[] }
  comments?: { totalCount: number }
  participants?: { nodes: GraphQLActor[] }
  milestone?: GraphQLMilestone | null
  viewerSubscription?: string | null
  headRefName?: string
  headRefOid?: string
  baseRefName?: string
  baseRefOid?: string
  headRepository?: { databaseId?: number, name: string, owner: { login: string } } | null
  mergeCommit?: { oid: string } | null
  commits?: { nodes: Array<{ commit: { statusCheckRollup?: GraphQLStatusRollup | null } }> }
  reviewRequests?: { nodes: Array<{ requestedReviewer: (GraphQLActor & { slug?: string }) | null }> }
}

export interface GraphQLStatusRollup {
  state: string
  contexts: {
    totalCount: number
    checkRunCountsByState?: Array<{ state: string, count: number }>
    statusContextCountsByState?: Array<{ state: string, count: number }>
  }
}

const FAILED_RUNS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAILED_STATUSES = new Set(['FAILURE', 'ERROR'])

function toRollupSummary(rollup: GraphQLStatusRollup, url?: string): ChecksSummary {
  const failed = (rollup.contexts.checkRunCountsByState ?? []).filter(({ state }) => FAILED_RUNS.has(state)).reduce((sum, { count }) => sum + count, 0)
    + (rollup.contexts.statusContextCountsByState ?? []).filter(({ state }) => FAILED_STATUSES.has(state)).reduce((sum, { count }) => sum + count, 0)
  const state = rollup.state === 'SUCCESS' ? 'success' : rollup.state === 'FAILURE' || rollup.state === 'ERROR' ? 'failure' : rollup.state === 'PENDING' || rollup.state === 'EXPECTED' ? 'pending' : 'unknown'
  return { state, stateRaw: rollup.state.toLowerCase(), total: rollup.contexts.totalCount, failed, ...url ? { url: `${url}/checks` } : {} }
}

export type ThreadsBatchResult = Record<string, {
  issueOrPullRequest?: GraphQLIssueOrPull | null
  discussion?: GraphQLDiscussion | null
} | null>

export function toGraphQLThread(ref: ResolvedThreadRef, raw: GraphQLIssueOrPull): Thread {
  const instance = ref.instance
  const isPull = raw.__typename === 'PullRequest'
  const kind = isPull ? 'pull_request' : 'issue'
  const state = raw.state === 'MERGED' ? 'merged' : raw.state === 'OPEN' ? 'open' : raw.state === 'CLOSED' ? 'closed' : 'unknown'
  const reviewers: Reviewer[] = (raw.reviewRequests?.nodes ?? []).flatMap(({ requestedReviewer: reviewer }) => {
    if (!reviewer) {
      return []
    }
    const isTeam = reviewer.__typename === 'Team'
    const actor = isTeam
      ? { forge: FORGE, instance, login: reviewer.slug ?? '', id: String(reviewer.databaseId ?? reviewer.slug), name: reviewer.name, url: reviewer.url, typeRaw: 'Team', isBotHint: false }
      : toGraphQLActor(instance, reviewer)!
    return [{ actor, state: 'pending' as const, stateRaw: 'requested', ...isTeam ? { isTeam: true } : {} }]
  })
  return {
    ref: { ...ref, kind, externalId: raw.id },
    kind,
    title: raw.title,
    body: raw.body,
    state,
    stateRaw: raw.state.toLowerCase(),
    stateReason: raw.stateReason?.toLowerCase() ?? undefined,
    isDraft: raw.isDraft ?? false,
    author: toGraphQLActor(instance, raw.author),
    assignees: (raw.assignees?.nodes ?? []).flatMap(actor => toGraphQLActor(instance, actor) ?? []),
    participants: (raw.participants?.nodes ?? []).flatMap(actor => toGraphQLActor(instance, actor) ?? []),
    milestone: toGraphQLMilestone(raw.milestone),
    subscription: toViewerSubscription(raw.viewerSubscription),
    reviewers,
    labels: (raw.labels?.nodes ?? []).map(label => ({ name: label.name, colour: label.color, description: label.description ?? undefined })),
    url: raw.url,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    closedAt: toDate(raw.closedAt),
    lastActivityAt: toDate(raw.updatedAt),
    locked: raw.locked,
    commentCount: raw.comments?.totalCount,
    ...isPull && raw.commits?.nodes[0]?.commit.statusCheckRollup ? { checks: toRollupSummary(raw.commits.nodes[0].commit.statusCheckRollup, raw.url) } : {},
    branches: isPull && raw.headRefName && raw.baseRefName
      ? {
          head: {
            ref: raw.headRefName,
            sha: raw.headRefOid,
            repo: raw.headRepository
              ? { forge: FORGE, instance, owner: raw.headRepository.owner.login, name: raw.headRepository.name, externalId: raw.headRepository.databaseId === undefined ? undefined : String(raw.headRepository.databaseId) }
              : undefined,
          },
          base: { ref: raw.baseRefName, sha: raw.baseRefOid },
          mergeCommitSha: raw.mergeCommit?.oid,
        }
      : undefined,
    raw,
  }
}

/** Lists recent discussions in several repositories at once, for resolving notification subjects. */
export function recentDiscussionsQuery(repos: Array<{ owner: string, name: string }>): { query: string, variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {}
  const declarations: string[] = []
  const fields = repos.map((repo, index) => {
    variables[`o${index}`] = repo.owner
    variables[`n${index}`] = repo.name
    declarations.push(`$o${index}: String!`, `$n${index}: String!`)
    return `r${index}: repository(owner: $o${index}, name: $n${index}) { discussions(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { id number title updatedAt } } }`
  })
  return { query: `query RecentDiscussions(${declarations.join(', ')}) {\n  ${fields.join('\n  ')}\n}`, variables }
}

export type RecentDiscussionsResult = Record<string, { discussions: { nodes: Array<{ id: string, number: number, title: string, updatedAt?: string }> } } | null>

export const DISCUSSION_COMMENTS = `query DiscussionComments($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      comments(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id databaseId body createdAt url
          author { ${ACTOR_FIELDS} }
          replies(first: 50) { nodes { id databaseId body createdAt url author { ${ACTOR_FIELDS} } } }
        }
      }
    }
  }
}`

export const ADD_DISCUSSION_COMMENT = `mutation AddDiscussionComment($id: ID!, $body: String!) {
  addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { ${COMMENT_FIELDS} } }
}`

export const CLOSE_DISCUSSION = `mutation CloseDiscussion($id: ID!, $reason: DiscussionCloseReason) {
  closeDiscussion(input: { discussionId: $id, reason: $reason }) { discussion { id } }
}`

export const REOPEN_DISCUSSION = `mutation ReopenDiscussion($id: ID!) {
  reopenDiscussion(input: { discussionId: $id }) { discussion { id } }
}`

export interface GraphQLActor {
  __typename?: string
  login: string
  avatarUrl?: string
  url?: string
  databaseId?: number
  name?: string
}

export interface GraphQLDiscussion {
  id: string
  number: number
  title: string
  body?: string
  closed: boolean
  stateReason?: string | null
  url?: string
  createdAt?: string
  updatedAt?: string
  closedAt?: string | null
  locked?: boolean
  author?: GraphQLActor | null
  labels?: { nodes: Array<{ name: string, color?: string, description?: string | null }> }
  comments?: { totalCount: number }
}

export interface GraphQLComment {
  id: string
  databaseId?: number
  body?: string
  createdAt?: string
  updatedAt?: string
  url?: string
  author?: GraphQLActor | null
  replies?: { nodes: GraphQLComment[] }
}

export interface DiscussionThreadResult {
  repository: { discussion: GraphQLDiscussion | null } | null
}

export interface DiscussionCommentsResult {
  repository: {
    discussion: {
      comments: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: GraphQLComment[] }
    } | null
  } | null
}

export function toGraphQLActor(instance: string, actor: GraphQLActor | null | undefined): Actor | undefined {
  if (!actor) {
    return undefined
  }
  return {
    forge: FORGE,
    instance,
    login: actor.login,
    id: String(actor.databaseId ?? actor.login),
    name: actor.name,
    avatarUrl: actor.avatarUrl,
    url: actor.url,
    typeRaw: actor.__typename,
    isBotHint: actor.__typename === 'Bot' || actor.login.endsWith('[bot]'),
  }
}

export function toDiscussionThread(ref: ResolvedThreadRef, raw: GraphQLDiscussion): Thread {
  return {
    ref: { ...ref, externalId: raw.id },
    kind: 'discussion',
    title: raw.title,
    body: raw.body,
    state: raw.closed ? 'closed' : 'open',
    stateRaw: raw.closed ? 'closed' : 'open',
    stateReason: raw.stateReason?.toLowerCase(),
    isDraft: false,
    author: toGraphQLActor(ref.instance, raw.author),
    assignees: [],
    reviewers: [],
    lastActivityAt: toDate(raw.updatedAt),
    url: raw.url,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    closedAt: toDate(raw.closedAt),
    labels: (raw.labels?.nodes ?? []).map(label => ({
      name: label.name,
      colour: label.color,
      description: label.description ?? undefined,
    })),
    locked: raw.locked,
    commentCount: raw.comments?.totalCount,
    raw,
  }
}

export function toDiscussionCommentEvent(ref: ResolvedThreadRef, comment: GraphQLComment, isReply: boolean): ForgeEventInput {
  const actor = toGraphQLActor(ref.instance, comment.author)
  return {
    forge: FORGE,
    instance: ref.instance,
    id: comment.id,
    kind: 'comment',
    kindRaw: isReply ? 'DiscussionCommentReply' : 'DiscussionComment',
    summary: `${actor?.login ?? 'someone'} ${isReply ? 'replied' : 'commented'}`,
    occurredAt: toDate(comment.createdAt) ?? new Date(0),
    actor,
    repo: ref.repo,
    thread: ref,
    source: 'poll',
    payload: comment,
  }
}

export function toDiscussionComment(thread: ThreadRef, raw: GraphQLComment): Comment {
  return {
    ref: { forge: FORGE, instance: thread.instance, thread, id: raw.id },
    body: raw.body ?? '',
    author: toGraphQLActor(thread.instance, raw.author),
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    url: raw.url,
    raw,
  }
}

export const REPOSITORY_ID = `query RepositoryId($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id }
}`

export const TRANSFER_ISSUE = `mutation TransferIssue($issue: ID!, $repo: ID!) {
  transferIssue(input: { issueId: $issue, repositoryId: $repo }) { issue { id number } }
}`

export const MARK_DUPLICATE = `mutation MarkDuplicate($canonical: ID!, $duplicate: ID!) {
  closeIssue(input: { issueId: $duplicate, stateReason: DUPLICATE, duplicateIssueId: $canonical }) { issue { __typename } }
}`

export const NODE_REACTIONS = `query NodeReactions($id: ID!, $after: String) {
  node(id: $id) {
    ... on Reactable {
      reactions(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { content createdAt user { __typename login databaseId name avatarUrl url } }
      }
    }
  }
}`

export interface NodeReactionsResult {
  node: {
    reactions: {
      pageInfo: { hasNextPage: boolean, endCursor: string | null }
      nodes: Array<{ content: string, createdAt?: string, user?: GraphQLActor | null }>
    }
  } | null
}

export const ADD_REACTION = `mutation AddReaction($id: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $id, content: $content }) { reaction { content } }
}`

export const REMOVE_REACTION = `mutation RemoveReaction($id: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $id, content: $content }) { reaction { content } }
}`

/** The GraphQL `ReactionContent` enum, by the model's name for each reaction. */
export const REACTION_CONTENT: Record<ReactionContent, string> = {
  '+1': 'THUMBS_UP',
  '-1': 'THUMBS_DOWN',
  'laugh': 'LAUGH',
  'confused': 'CONFUSED',
  'heart': 'HEART',
  'hooray': 'HOORAY',
  'rocket': 'ROCKET',
  'eyes': 'EYES',
}

/** The model's name for each GraphQL `ReactionContent` value. */
export const GRAPHQL_REACTIONS: Record<string, string> = Object.fromEntries(
  Object.entries(REACTION_CONTENT).map(([content, graphql]) => [graphql, content]),
)

export const REVIEW_THREADS = `query ReviewThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved comments(first: 100) { nodes { databaseId } } }
      }
    }
  }
}`

export interface ReviewThreadsResult {
  repository: {
    pullRequest: {
      reviewThreads: { nodes: Array<{ id: string, isResolved: boolean, comments: { nodes: Array<{ databaseId: number | null }> } }> }
    } | null
  } | null
}

export const RESOLVE_REVIEW_THREAD = `mutation ResolveReviewThread($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
}`

export const UNRESOLVE_REVIEW_THREAD = `mutation UnresolveReviewThread($id: ID!) {
  unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
}`
