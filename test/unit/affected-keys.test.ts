import type { CommitCommentRef, CommitRef, EventDetail, ForgeEvent, Notification, NotificationSubject, ReleaseRef, RepoRef, ResolvedCommentRef, ResolvedThreadRef, ThreadRef } from '../../src/index.ts'
import type { ForgeEventInput } from '../../src/model.ts'
import { describe, expect, it } from 'vitest'
import { translateAzureWebhook } from '../../src/azure-devops/events.ts'
import { toPullComment as toAzurePullComment, toWorkItemComment, toWorkItemEvents } from '../../src/azure-devops/normalise.ts'
import { translateBitbucketWebhook } from '../../src/bitbucket/events.ts'
import { toComment as toBitbucketComment } from '../../src/bitbucket/normalise.ts'
import { translateOriginWebhook } from '../../src/cursor-origin/events.ts'
import { toComment as toOriginComment } from '../../src/cursor-origin/normalise.ts'
import { completeEvent } from '../../src/events.ts'
import { translateGiteeWebhook } from '../../src/gitee/events.ts'
import { toComment as toGiteeComment } from '../../src/gitee/normalise.ts'
import { translateGitHubWebhook } from '../../src/github/events.ts'
import { toDiscussionComment } from '../../src/github/graphql.ts'
import { toEvent as toGitHubEvent } from '../../src/github/normalise.ts'
import { affectedKeys, commentKey, commitCommentKey, commitKey, parseCommentKey, parseCommitCommentKey, parseCommitKey, parseReleaseKey, parseThreadKey, releaseKey, repoKey, threadKey } from '../../src/index.ts'
import { payloadFixture } from '../utils/fixtures.ts'

const origin = { forge: 'github', instance: 'github.com' } as const
const repo: RepoRef = { ...origin, owner: 'acme', name: 'widgets', externalId: '1' }
const other: RepoRef = { ...origin, owner: 'acme', name: 'gadgets', externalId: '2' }
const pull: ResolvedThreadRef = { ...origin, repo, kind: 'pull_request', number: '42' }
const issue: ResolvedThreadRef = { ...origin, repo: other, kind: 'issue', number: '7' }
const comment: ResolvedCommentRef = { ...origin, thread: pull, id: '900' }
const release: ReleaseRef = { ...origin, repo, id: '31', tag: 'v1.0.0' }
const commit: CommitRef = { ...origin, repo, sha: 'a'.repeat(40) }
const commitComment: CommitCommentRef = { ...origin, commit, id: '901' }
const pathOf = (owner: string, name: string) => repoKey({ ...origin, owner, name })

function event(detail: EventDetail | undefined, fields: Partial<ForgeEvent> = {}): ForgeEvent {
  return { ...origin, id: 'e1', kind: 'other', action: 'other', summary: '', occurredAt: new Date(0), source: 'webhook', payload: {}, repo, detail, ...fields }
}

function notification(subject: NotificationSubject): Notification {
  return { ref: { ...origin, id: 'n1' }, subject, reason: 'subscribed', unread: true, title: '', subjectState: 'unknown', updatedAt: new Date(0), raw: {} }
}

describe('comment and release keys', () => {
  it('builds a comment key on the thread key', () => {
    expect(commentKey(comment)).toBe(`${threadKey(pull)}#comment/900`)
    expect(commentKey(comment)).toBe('github:github.com/@1#pull_request/42#comment/900')
  })

  it('starts thread, commit, comment and release keys with the repository key and `#`', () => {
    for (const key of [threadKey(pull), commitKey(commit), commentKey(comment), commitCommentKey(commitComment), releaseKey(release)]) {
      expect(key.startsWith(`${repoKey(repo)}#`)).toBe(true)
    }
  })

  it('round-trips comment keys', () => {
    const nested: RepoRef = { forge: 'gitlab', instance: 'git.example.com', owner: 'acme/platform/web', name: 'widgets' }
    const tangledRepo: RepoRef = { forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:abc', name: 'core' }
    const refs: ResolvedCommentRef[] = [
      { forge: 'gitlab', instance: 'git.example.com', thread: { forge: 'gitlab', instance: 'git.example.com', repo: nested, kind: 'pull_request', number: '23' }, id: '1201' },
      { forge: 'tangled', instance: 'tangled.org', thread: { forge: 'tangled', instance: 'tangled.org', repo: tangledRepo, kind: 'issue', number: 'at://did:plc:abc/sh.tangled.repo.issue/3k' }, id: 'at://did:plc:xyz/sh.tangled.repo.issue.comment/3m#c' },
    ]

    for (const ref of refs) {
      expect(parseCommentKey(commentKey(ref))).toEqual(ref)
    }
    expect(parseCommentKey(commentKey(comment))).toEqual({ ...comment, thread: { ...pull, repo: { ...origin, owner: '', name: '', externalId: '1' } } })
  })

  it('reads neither a thread key as a comment key nor a comment key as a thread key', () => {
    expect(parseCommentKey(threadKey(pull))).toBeUndefined()
    expect(parseCommentKey(`${threadKey(pull)}#comment/`)).toBeUndefined()
    expect(parseCommentKey(`${threadKey(pull)}#review/1`)).toBeUndefined()
    expect(parseThreadKey(commentKey(comment))).toBeUndefined()
  })

  it('round-trips commit and commit comment keys', () => {
    const nested: CommitRef = { forge: 'gitlab', instance: 'gitlab.com', repo: { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform', name: 'widgets' }, sha: 'b'.repeat(40) }

    expect(commitKey(nested)).toBe(`gitlab:gitlab.com/acme/platform/widgets#commit/${nested.sha}`)
    expect(parseCommitKey(commitKey(nested))).toEqual(nested)
    expect(parseCommitCommentKey(commitCommentKey({ forge: 'gitlab', instance: 'gitlab.com', commit: nested, id: '7' }))).toEqual({ forge: 'gitlab', instance: 'gitlab.com', commit: nested, id: '7' })
    expect(parseCommitKey(threadKey(pull))).toBeUndefined()
    expect(parseThreadKey(commitKey(nested))).toBeUndefined()
    expect(parseCommentKey(commitCommentKey(commitComment))).toBeUndefined()
    expect(parseCommitCommentKey(commentKey(comment))).toBeUndefined()
  })

  it('round-trips release keys', () => {
    const nested: ReleaseRef = { forge: 'gitlab', instance: 'gitlab.com', repo: { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform', name: 'widgets' }, id: 'pkg@1.0.0#rc' }

    expect(releaseKey(release)).toBe('github:github.com/@1#release/31')
    expect(parseReleaseKey(releaseKey(nested))).toEqual(nested)
    expect(parseReleaseKey(threadKey(pull))).toBeUndefined()
    expect(parseThreadKey(releaseKey(nested))).toBeUndefined()
  })
})

describe('affectedKeys', () => {
  it.each([
    ['comment', { type: 'comment', comment, body: 'Thanks' }],
    ['review_comment', { type: 'review_comment', comment, path: 'a.ts', line: 3 }],
  ] as const)('keys the thread and the comment of a %s', (_, detail) => {
    expect(affectedKeys(event(detail, { thread: pull }))).toEqual({
      repos: [repoKey(repo)],
      threads: [threadKey(pull)],
      commits: [],
      comments: [commentKey(comment)],
      commitComments: [],
      releases: [],
      notifications: [],
      unresolved: [],
    })
  })

  it('keys the commit and the comment of a comment on a commit', () => {
    expect(affectedKeys(event({ type: 'comment', comment: commitComment }, { commit }))).toEqual({
      repos: [repoKey(repo)],
      threads: [],
      commits: [commitKey(commit)],
      comments: [],
      commitComments: [commitCommentKey(commitComment)],
      releases: [],
      notifications: [],
      unresolved: [],
    })
  })

  it.each<[string, EventDetail | undefined]>([
    ['review', { type: 'review', state: 'approved' }],
    ['label', { type: 'label', label: 'bug' }],
    ['assignment', { type: 'assignment' }],
    ['state_change', { type: 'state_change', state: 'merged' }],
    ['no detail', undefined],
  ])('keys the thread and its repository for %s', (_, detail) => {
    expect(affectedKeys(event(detail, { thread: pull }))).toMatchObject({ repos: [repoKey(repo)], threads: [threadKey(pull)], comments: [] })
  })

  it.each<[string, EventDetail]>([
    ['push', { type: 'push', ref: 'refs/heads/main', forced: false, commits: [] }],
    ['ref', { type: 'ref', ref: 'refs/tags/v1', refType: 'tag' }],
    ['repo_archived', { type: 'repo_archived', archived: true }],
    ['membership', { type: 'membership', actionRaw: 'added' }],
  ])('keys only the repository for %s', (_, detail) => {
    expect(affectedKeys(event(detail))).toMatchObject({ repos: [repoKey(repo)], threads: [], comments: [], unresolved: [] })
  })

  it('keys the old and new paths of a renamed repository beside its id', () => {
    expect(affectedKeys(event({ type: 'repo_renamed', from: 'old-widgets', to: 'widgets' })).repos).toEqual([repoKey(repo), pathOf('acme', 'widgets'), pathOf('acme', 'old-widgets')])

    const project: RepoRef = { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform', name: 'widgets', externalId: '9' }
    const renamed = event({ type: 'repo_renamed', from: 'acme/platform/old', to: 'acme/platform/widgets' }, { forge: 'gitlab', instance: 'gitlab.com', repo: project })
    expect(affectedKeys(renamed).repos).toEqual(['gitlab:gitlab.com/@9', 'gitlab:gitlab.com/acme/platform/widgets', 'gitlab:gitlab.com/acme/platform/old'])
  })

  it('keys the old owner of a transferred repository', () => {
    expect(affectedKeys(event({ type: 'repo_transferred', fromOwner: 'Former', toOwner: 'acme' })).repos).toEqual([repoKey(repo), pathOf('acme', 'widgets'), pathOf('former', 'widgets')])
    expect(affectedKeys(event({ type: 'repo_transferred' })).repos).toEqual([repoKey(repo), pathOf('acme', 'widgets')])
  })

  it('keys the repositories an installation added and removed', () => {
    const installed = event({ type: 'installation', actionRaw: 'added', added: [repo], removed: [other] }, { repo: undefined })
    expect(affectedKeys(installed).repos).toEqual([repoKey(repo), repoKey(other)])
  })

  it('keys a published release and its repository', () => {
    expect(affectedKeys(event({ type: 'release', release }))).toMatchObject({ repos: [repoKey(repo)], releases: [releaseKey(release)] })
  })

  it('keys only the repository of a release that names no release id', () => {
    expect(affectedKeys(event({ type: 'release', tag: 'v1.2.0' }))).toMatchObject({ repos: [repoKey(repo)], releases: [] })
  })

  it('keys the repository that was forked and the new fork', () => {
    expect(affectedKeys(event({ type: 'fork', fork: other })).repos).toEqual([repoKey(repo), repoKey(other)])
  })

  it('keys the thread that referenced this one, or the repository of the commit', () => {
    expect(affectedKeys(event({ type: 'referenced', from: issue, fromRepo: other }, { thread: pull }))).toMatchObject({ repos: [repoKey(repo), repoKey(other)], threads: [threadKey(pull), threadKey(issue)] })
    expect(affectedKeys(event({ type: 'referenced', from: { ...origin, repo: other, sha: 'abc' } }, { thread: pull }))).toMatchObject({ repos: [repoKey(repo), repoKey(other)], threads: [threadKey(pull)] })
    expect(affectedKeys(event({ type: 'referenced', text: 'see #42' }, { thread: pull }))).toMatchObject({ threads: [threadKey(pull)] })
  })

  it('returns a thread without a number as unresolved, once', () => {
    const tangledRepo: RepoRef = { forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:abc', name: 'core' }
    const thread: ThreadRef = { forge: 'tangled', instance: 'tangled.org', repo: tangledRepo, kind: 'pull_request', displayNumber: '3' }
    const keys = affectedKeys(event({ type: 'comment', comment: { forge: 'tangled', instance: 'tangled.org', thread: { ...thread }, id: 'at://c' } }, { forge: 'tangled', instance: 'tangled.org', repo: tangledRepo, thread }))

    expect(keys).toEqual({ repos: [repoKey(tangledRepo)], threads: [], commits: [], comments: [], commitComments: [], releases: [], notifications: [], unresolved: [thread] })
  })

  it.each<[string, NotificationSubject, Partial<ReturnType<typeof affectedKeys>>]>([
    ['thread', { type: 'thread', thread: pull }, { repos: [repoKey(repo)], threads: [threadKey(pull)] }],
    ['commit', { type: 'commit', commit }, { repos: [repoKey(repo)], commits: [commitKey(commit)] }],
    ['repo', { type: 'repo', repo }, { repos: [repoKey(repo)] }],
    ['release', { type: 'release', release }, { repos: [repoKey(repo)], releases: [releaseKey(release)] }],
    ['security_alert', { type: 'security_alert', alert: { ...origin, repo, id: '3', kind: 'dependency' } }, { repos: [repoKey(repo)] }],
    ['other', { type: 'other', typeRaw: 'CheckSuite', repo }, { repos: [repoKey(repo)] }],
    ['actor', { type: 'actor', actor: { ...origin, login: 'ada', id: '3', isBotHint: false } }, { repos: [] }],
  ])('keys a notification and its %s subject', (_, subject, expected) => {
    expect(affectedKeys(notification(subject))).toEqual({ repos: [], threads: [], commits: [], comments: [], commitComments: [], releases: [], unresolved: [], ...expected, notifications: ['github:github.com:notification/n1'] })
  })

  it('keys the latest comment that a notification links', () => {
    const latestComment = { ...origin, thread: pull, id: '770001' }
    expect(affectedKeys({ ...notification({ type: 'thread', thread: pull }), latestComment }).comments).toEqual([commentKey(latestComment)])
    expect(affectedKeys({ ...notification({ type: 'commit', commit }), latestComment: commitComment }).commitComments).toEqual([commitCommentKey(commitComment)])
  })

  it('returns a discussion notification without a number as unresolved', () => {
    const discussion: ThreadRef = { ...origin, repo, kind: 'discussion', typeRaw: 'Discussion' }
    expect(affectedKeys(notification({ type: 'thread', thread: discussion }))).toMatchObject({ repos: [repoKey(repo)], threads: [], unresolved: [discussion] })
  })

  it('keys a comment alike whether it was polled or delivered by webhook', () => {
    const [delivered] = translateGitHubWebhook('github.com', {
      headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'delivery-1' },
      body: JSON.stringify({ action: 'created', repository: { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme', id: 2 } }, issue: { number: 42, pull_request: {} }, comment: { id: 900, body: 'Thanks' } }),
    })
    const polled = completeEvent(toGitHubEvent('github.com', pull, { event: 'commented', id: 900, node_id: 'IC_900', body: 'Thanks' }))

    expect(delivered!.id).not.toBe(polled.id)
    expect(affectedKeys(completeEvent(delivered!)).comments).toEqual([commentKey(comment)])
    expect(affectedKeys(polled).comments).toEqual([commentKey(comment)])
  })
})

describe('delivered comment keys', () => {
  const delivered = (event: ForgeEventInput | undefined) => affectedKeys(completeEvent(event!)).comments
  const listed = (ref: ResolvedCommentRef) => [commentKey(ref)]
  const threadOf = (event: ForgeEventInput | undefined) => event!.thread as ResolvedThreadRef

  it('keys a Bitbucket comment as the comment listing does', () => {
    const body = payloadFixture('bitbucket', 'webhooks/pullrequest-comment-created')
    const [event] = translateBitbucketWebhook('bitbucket.org', { headers: { 'x-event-key': 'pullrequest:comment_created' }, body })

    expect(delivered(event)).toEqual(listed(toBitbucketComment(threadOf(event), JSON.parse(body).comment).ref))
  })

  it.each([['pullrequest:comment_updated', 'edited'], ['pullrequest:comment_deleted', 'deleted']])('reads %s as a comment that was %s', (key, action) => {
    const body = payloadFixture('bitbucket', 'webhooks/pullrequest-comment-created')
    const [event] = translateBitbucketWebhook('bitbucket.org', { headers: { 'x-event-key': key }, body })

    expect(completeEvent(event!)).toMatchObject({ kind: 'comment', action })
    expect(delivered(event)).toEqual(listed(toBitbucketComment(threadOf(event), JSON.parse(body).comment).ref))
  })

  it('keys a Gitee comment as the comment listing does', () => {
    const body = payloadFixture('gitee', 'webhooks/note-on-pull-request')
    const [event] = translateGiteeWebhook('gitee.com', { headers: { 'x-gitee-event': 'Note Hook' }, body })

    expect(delivered(event)).toEqual(listed(toGiteeComment(threadOf(event), JSON.parse(body).comment).ref))
  })

  it('keys a Cursor Origin comment as the comment listing does', () => {
    const body = payloadFixture('cursor-origin', 'webhooks/pull-request-comment-created')
    const [event] = translateOriginWebhook('origin.cursor.com', { headers: {}, body })

    expect(delivered(event)).toEqual(listed(toOriginComment(threadOf(event), JSON.parse(body).event.payload.comment).ref))
  })

  it('keys an Azure DevOps comment as the comment listing does, where the delivery links its thread', () => {
    const payload = JSON.parse(payloadFixture('azure-devops', 'webhooks/pull-request-comment'))
    const linked = structuredClone(payload)
    linked.resource.comment._links = { self: { href: 'https://dev.azure.com/acme/_apis/git/repositories/r1/pullRequests/9/threads/5/comments/2' } }
    const [event] = translateAzureWebhook('dev.azure.com', 'acme', { headers: {}, body: JSON.stringify(linked) })
    const [unlinked] = translateAzureWebhook('dev.azure.com', 'acme', { headers: {}, body: JSON.stringify(payload) })

    expect(delivered(event)).toEqual(listed(toAzurePullComment(threadOf(event), { id: 5, comments: [] }, linked.resource.comment).ref))
    expect(delivered(unlinked)).toEqual([])
  })

  it('keys an Azure DevOps work item comment as the comment listing does', () => {
    const thread = { forge: 'azure-devops', instance: 'dev.azure.com', repo: { forge: 'azure-devops', instance: 'dev.azure.com', owner: 'acme', name: 'Widgets' }, kind: 'issue', number: '12' } as const
    const comment = { id: 3, workItemId: 12, text: 'Seen on staging', createdDate: '2026-09-20T09:00:00Z' }

    expect(delivered(toWorkItemEvents(thread, [], [comment])[0])).toEqual(listed(toWorkItemComment(thread, comment).ref))
  })

  it('keys a GitHub discussion comment as the comment listing does', () => {
    const comment = { id: 7001, node_id: 'DC_kwDOAAABCDE', body: 'Same here', created_at: '2026-09-20T09:00:00Z' }
    const [event] = translateGitHubWebhook('github.com', { headers: { 'x-github-event': 'discussion_comment', 'x-github-delivery': 'id' }, body: JSON.stringify({ action: 'created', repository: { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme', id: 2 } }, discussion: { number: 6 }, comment }) })

    expect(delivered(event)).toEqual(listed(toDiscussionComment(threadOf(event), { id: comment.node_id }).ref))
  })
})
