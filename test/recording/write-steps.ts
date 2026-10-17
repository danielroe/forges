import type { Actor, Comment, CommentRef, Commit, CommitComment, Milestone, Notification, Release, RepoRef, Review, ReviewComment, Thread, ThreadRef, Webhook, WebhookDeliveryRecord } from '../../src/model.ts'
import type { ForgeProvider, ForgeVerb } from '../../src/provider.ts'
import type { RecordingManifest } from './steps.ts'
import { createHash } from 'node:crypto'
import { BranchMovedError, ForbiddenError, ForgeApiError, ForgeError, NotFoundError } from '../../src/errors.ts'
import { upsertComment } from '../../src/helpers.ts'
import { notificationThread } from '../../src/model.ts'

/** What a write recording created before its steps ran, and the names its steps write. */
export interface WriteRun {
  /** Unique per run; the branches, label and titles the run creates carry it. */
  id: string
  /** The scratch repository's default branch. */
  base: string
  /** Branches made from `base` before the steps ran, each with one commit adding the matching `files` entry. */
  branches: [string, string, string]
  files: [string, string, string]
  /** The reviewer's account, from `FIXTURE_<FORGE>_REVIEWER`, where the forge cannot say who signed in. */
  reviewer?: string
  /** A discussion in the scratch repository, from `FIXTURE_<FORGE>_SCRATCH_DISCUSSION`; discussions cannot be created through forges. */
  discussion?: string
  /** A pull request in the scratch repository, from `FIXTURE_<FORGE>_SCRATCH_PULL`, for forges that cannot open one. */
  pull?: string
  /** Where set, each thread the run opens has a title that ends with a suffix derived from it, for forges that refuse similar titles. */
  salt?: string
  /** An account outside the scratch repository's owner that the block steps block and unblock, from `FIXTURE_<FORGE>_BLOCKED_USER`. */
  blocked?: string
}

/** A write recording: the read manifest, the scratch repository every write goes to, and the run. */
export interface WriteManifest extends RecordingManifest {
  scratch: RepoRef
  run: WriteRun
  /** The reviewer's account, where it signs in apart from the author, as a second Tangled bot does. */
  reviewerAccount?: string
  reviewerPds?: string
}

/** The prefix of every label a write recording creates, so a later run can find leftovers. */
export const FIXTURE_LABEL = 'forges-fixture-'

/** The label a write recording creates and puts on its threads. */
export function fixtureLabel(run: WriteRun): string {
  return `${FIXTURE_LABEL}${run.id}`
}

/** The prefix of every tag a write recording releases, so a later run can find leftovers. */
export const FIXTURE_TAG = 'forges-fixture-'

/** The tag a write recording releases, with `suffix` for a second release. */
export function fixtureTag(run: WriteRun, suffix?: string): string {
  return `${FIXTURE_TAG}${run.id}${suffix ? `-${suffix}` : ''}`
}

/** The branch that the `commit files` steps create and commit to. */
export function filesBranch(run: WriteRun): string {
  return `forges-fixtures/${run.id}-files`
}

function filesPath(run: WriteRun, name: string): string {
  return `${filesBranch(run)}/${name}`
}

/** Values earlier write steps created, for later steps to use. */
export interface WriteContext {
  author?: Actor
  /** The first commit of the `commit files` steps. */
  filesCommit?: Commit
  reviewer?: Actor
  issue?: Thread
  discussion?: Thread
  duplicate?: Thread
  pulls: Thread[]
  comments: Partial<Record<WriteKind, Comment>>
  commitComment?: CommitComment
  milestone?: Milestone
  review?: Review
  /** The first comment of a review the run left, to read back on its own. */
  reviewComment?: CommentRef
  reviewThread?: string
  draft?: Release
  release?: Release
  webhook?: Webhook
  delivery?: WebhookDeliveryRecord
  notification?: Notification
  /** Waits before polling again; a replay passes one that returns at once. */
  wait: (ms: number) => Promise<void>
}

export interface WriteStep {
  name: string
  verb: ForgeVerb
  kind?: WriteKind
  /** Run with the reviewer's credentials rather than the author's. */
  as?: 'reviewer'
  /** Whether the step applies, beyond the provider supporting its verb. */
  when?: (provider: ForgeProvider, manifest: WriteManifest) => boolean
  run: (provider: ForgeProvider, manifest: WriteManifest, context: WriteContext) => Promise<unknown>
}

/** The prefix of every title a write recording gives an issue or a pull request, so a later run can find leftovers. */
export const FIXTURE_TITLE = 'forges fixture'

/** The title of an issue or pull request that a write recording opens. */
export function fixtureTitle(run: WriteRun, label: string): string {
  const title = `${FIXTURE_TITLE} ${run.id}: ${label}`
  return run.salt ? `${title} ${createHash('sha512').update(`${run.salt}:${label}`).digest('base64url').slice(0, 64)}` : title
}

/** Where the webhook steps point the hook they create. */
export const FIXTURE_HOOK_URL = 'https://example.com/hook'

/** The secrets the webhook steps sign deliveries with. They are dummies and never come from the environment. */
const HOOK_SECRETS = ['forges-fixture-secret', 'forges-fixture-secret-rotated'] as const

/** The dummy secret recorded webhook deliveries are signed with. */
export const FIXTURE_HOOK_SECRET = HOOK_SECRETS[0]

const page = { perPage: 3 }

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not found by an earlier step`)
  }
  return value
}

function label(manifest: WriteManifest): string {
  return fixtureLabel(manifest.run)
}

type WriteKind = 'issue' | 'pull_request' | 'discussion'

const blocks = (_provider: ForgeProvider, manifest: WriteManifest) => manifest.run.blocked !== undefined

function ownerOf(manifest: WriteManifest): RepoRef {
  return { forge: manifest.scratch.forge, instance: manifest.scratch.instance, owner: manifest.scratch.owner, name: '', kind: 'namespace' }
}

function threadOf(context: WriteContext, kind: WriteKind): ThreadRef {
  const thread = kind === 'issue' ? context.issue : kind === 'discussion' ? context.discussion : context.pulls[0]
  return need(thread, `the ${kind.replace('_', ' ')}`).ref
}

/** The thread a state change goes to; for pulls, the third, which no step merges. */
function stateRef(context: WriteContext, kind: WriteKind): ThreadRef {
  return kind === 'pull_request' ? need(context.pulls[2], 'the third pull request').ref : threadOf(context, kind)
}

function updatesEverything(kind: WriteKind): (provider: ForgeProvider) => boolean {
  return provider => (['threads.close', 'threads.reopen', 'threads.setLabels', 'threads.setAssignees'] as const).every(verb => provider.can(verb, kind))
}

/** Comment, react, label, assign, subscribe and edit steps, the same for an issue and a pull request. */
function threadWrites(kind: WriteKind): WriteStep[] {
  const prefix = kind === 'pull_request' ? 'pull' : kind
  const ref = (context: WriteContext) => threadOf(context, kind)
  return [
    { name: `${prefix} comment`, verb: 'threads.createComment', kind, run: async (provider, manifest, context) => {
      context.comments[kind] = await provider.threads.createComment(ref(context), `A comment from run ${manifest.run.id}.`)
      return context.comments[kind]
    } },
    { name: `${prefix} edit comment`, verb: 'threads.updateComment', kind, run: (provider, manifest, context) => provider.threads.updateComment(need(context.comments[kind], 'a comment').ref, `An edited comment from run ${manifest.run.id}.`) },
    { name: `${prefix} hide comment`, verb: 'threads.hideComment', kind, run: (provider, _manifest, context) => provider.threads.hideComment(need(context.comments[kind], 'a comment').ref, 'outdated') },
    { name: `${prefix} unhide comment`, verb: 'threads.unhideComment', kind, run: (provider, _manifest, context) => provider.threads.unhideComment(need(context.comments[kind], 'a comment').ref) },
    { name: `${prefix} get comment`, verb: 'threads.getComment', kind, run: async (provider, _manifest, context) => {
      // Comments read through an index, such as Constellation, appear late.
      for (let attempt = 1; ; attempt++) {
        try {
          return await provider.threads.getComment(need(context.comments[kind], 'a comment').ref)
        }
        catch (error) {
          if (!(error instanceof NotFoundError) || attempt === 6) {
            throw error
          }
        }
        await context.wait(5_000)
      }
    } },
    { name: `${prefix} upsert comment`, verb: 'threads.updateComment', kind, run: (provider, manifest, context) => upsertComment(provider, ref(context), { key: 'forges-fixture', body: `An upserted comment from run ${manifest.run.id}.` }) },
    { name: `${prefix} delete comment`, verb: 'threads.deleteComment', kind, run: (provider, _manifest, context) => provider.threads.deleteComment(need(context.comments[kind], 'a comment').ref) },
    { name: `${prefix} react`, verb: 'threads.react', kind, run: (provider, _manifest, context) => provider.threads.react(ref(context), '+1') },
    { name: `${prefix} unreact`, verb: 'threads.unreact', kind, run: (provider, _manifest, context) => provider.threads.unreact(ref(context), '+1') },
    { name: `${prefix} set labels`, verb: 'threads.setLabels', kind, run: (provider, manifest, context) => provider.threads.setLabels(ref(context), [label(manifest)]) },
    { name: `${prefix} remove labels`, verb: 'threads.removeLabels', kind, run: (provider, manifest, context) => provider.threads.removeLabels(ref(context), [label(manifest)]) },
    { name: `${prefix} add labels`, verb: 'threads.addLabels', kind, run: (provider, manifest, context) => provider.threads.addLabels(ref(context), [label(manifest)]) },
    { name: `${prefix} set milestone`, verb: 'threads.setMilestone', kind, run: (provider, _manifest, context) => provider.threads.setMilestone(ref(context), need(context.milestone, 'an open milestone')) },
    { name: `${prefix} clear milestone`, verb: 'threads.setMilestone', kind, run: (provider, _manifest, context) => provider.threads.setMilestone(ref(context), undefined) },
    { name: `${prefix} assign`, verb: 'threads.setAssignees', kind, run: (provider, _manifest, context) => provider.threads.setAssignees(ref(context), [need(context.author, 'the author')]) },
    { name: `${prefix} unsubscribe`, verb: 'threads.unsubscribe', kind, run: (provider, _manifest, context) => provider.threads.unsubscribe(ref(context)) },
    { name: `${prefix} subscribe`, verb: 'threads.subscribe', kind, run: (provider, _manifest, context) => provider.threads.subscribe(ref(context)) },
    { name: `${prefix} update`, verb: 'threads.update', kind, run: (provider, manifest, context) => provider.threads.update(ref(context), { title: `${FIXTURE_TITLE} ${manifest.run.id}: ${prefix}, edited`, body: `Edited by run ${manifest.run.id}.` }) },
    { name: `${prefix} update to closed`, verb: 'threads.update', kind, when: updatesEverything(kind), run: (provider, manifest, context) => provider.threads.update(stateRef(context, kind), { state: 'closed', labels: [label(manifest)], assignees: [need(context.author, 'the author')] }) },
    { name: `${prefix} update to open`, verb: 'threads.update', kind, when: updatesEverything(kind), run: (provider, _manifest, context) => provider.threads.update(stateRef(context, kind), { state: 'open', labels: [], assignees: [] }) },
    { name: `${prefix} lock`, verb: 'threads.lock', kind, run: (provider, _manifest, context) => provider.threads.lock(ref(context), { reason: 'resolved' }) },
    { name: `${prefix} unlock`, verb: 'threads.unlock', kind, run: (provider, _manifest, context) => provider.threads.unlock(ref(context)) },
  ]
}

/** Comments on the first pull request's head commit. */
function commitWrites(): WriteStep[] {
  return [
    { name: 'commit comment', verb: 'commits.createComment', run: async (provider, manifest, context) => {
      const pull = need(context.pulls[0], 'the pull request')
      const repo = pull.ref.repo
      context.commitComment = await provider.commits.createComment({ forge: repo.forge, instance: repo.instance, repo, sha: need(pull.branches?.head.sha, 'the pull head sha') }, `A commit comment from run ${manifest.run.id}.`)
      return context.commitComment
    } },
    { name: 'commit edit comment', verb: 'commits.updateComment', run: (provider, manifest, context) => provider.commits.updateComment(need(context.commitComment, 'a commit comment').ref, `An edited commit comment from run ${manifest.run.id}.`) },
    { name: 'commit hide comment', verb: 'commits.hideComment', run: (provider, _manifest, context) => provider.commits.hideComment(need(context.commitComment, 'a commit comment').ref, 'outdated') },
    { name: 'commit unhide comment', verb: 'commits.unhideComment', run: (provider, _manifest, context) => provider.commits.unhideComment(need(context.commitComment, 'a commit comment').ref) },
    { name: 'commit get comment', verb: 'commits.getComment', run: (provider, _manifest, context) => provider.commits.getComment(need(context.commitComment, 'a commit comment').ref) },
    { name: 'commit delete comment', verb: 'commits.deleteComment', run: (provider, _manifest, context) => provider.commits.deleteComment(need(context.commitComment, 'a commit comment').ref) },
  ]
}

/**
 * Every write a write recording covers, in the order it runs, against the
 * scratch repository. Each step only touches what earlier steps of the same
 * run created, so leftovers from other runs never change a recording.
 */
export const WRITE_STEPS: WriteStep[] = [
  { name: 'author', verb: 'users.me', run: async (provider, _manifest, context) => {
    const me = await provider.users.me()
    context.author = me
    return me
  } },
  { name: 'reviewer', verb: 'users.me', as: 'reviewer', run: async (provider, _manifest, context) => {
    const me = await provider.users.me()
    context.reviewer = me
    return me
  } },
  { name: 'create label', verb: 'repos.createLabel', run: (provider, manifest) => provider.repos.createLabel(manifest.scratch, { name: label(manifest), colour: '0e8a16', description: `Created by run ${manifest.run.id}` }) },
  { name: 'milestones', verb: 'repos.milestones', run: async (provider, manifest, context) => {
    const result = await provider.repos.milestones(manifest.scratch, page).page()
    context.milestone = result.items.find(milestone => milestone.state === 'open')
    return result
  } },
  { name: 'add collaborator', verb: 'repos.addCollaborator', run: (provider, manifest, context) => provider.repos.addCollaborator(manifest.collaborators ?? manifest.scratch, need(context.reviewer, 'the reviewer'), 'write') },

  { name: 'commit files to a new branch', verb: 'contents.commitFiles', run: async (provider, manifest, context) => {
    context.filesCommit = await provider.contents.commitFiles(manifest.scratch, {
      branch: filesBranch(manifest.run),
      createFrom: manifest.run.base,
      message: `test: add files from run ${manifest.run.id}`,
      changes: [
        { path: filesPath(manifest.run, 'text.md'), content: 'Written by forges.\n' },
        { path: filesPath(manifest.run, 'bytes.bin'), content: new Uint8Array([0, 1, 2, 254, 255]) },
      ],
    })
    return context.filesCommit
  } },
  { name: 'commit files', verb: 'contents.commitFiles', run: (provider, manifest, context) => provider.contents.commitFiles(manifest.scratch, {
    branch: filesBranch(manifest.run),
    expectedHead: need(context.filesCommit, 'a commit of files').sha,
    message: `test: change files from run ${manifest.run.id}\n\nUpdates one file and deletes another.`,
    changes: [
      { path: filesPath(manifest.run, 'text.md'), content: 'Changed by forges.\n' },
      { path: filesPath(manifest.run, 'bytes.bin'), content: null },
    ],
  }) },
  { name: 'commit files as an author', verb: 'contents.commitFiles', run: (provider, manifest) => provider.contents.commitFiles(manifest.scratch, {
    branch: filesBranch(manifest.run),
    message: `test: add a file from run ${manifest.run.id}`,
    author: { name: 'forges fixtures', email: 'fixtures@forges.link' },
    changes: [
      { path: filesPath(manifest.run, 'text.md'), content: 'Changed again by forges.\n' },
      { path: filesPath(manifest.run, 'author.md'), content: 'Written by an author.\n' },
    ],
  }) },
  { name: 'commit files to a moved branch', verb: 'contents.commitFiles', run: async (provider, manifest, context) => {
    try {
      await provider.contents.commitFiles(manifest.scratch, {
        branch: filesBranch(manifest.run),
        expectedHead: need(context.filesCommit, 'a commit of files').sha,
        message: `test: change a file from run ${manifest.run.id}`,
        changes: [{ path: filesPath(manifest.run, 'text.md'), content: 'Not written.\n' }],
      })
    }
    catch (error) {
      if (error instanceof BranchMovedError) {
        return { name: error.name, status: error.status }
      }
      throw error
    }
    throw new Error('The forge committed to a branch that had moved')
  } },
  { name: 'commit files as an author to a moved branch', verb: 'contents.commitFiles', run: async (provider, manifest, context) => {
    try {
      await provider.contents.commitFiles(manifest.scratch, {
        branch: filesBranch(manifest.run),
        expectedHead: need(context.filesCommit, 'a commit of files').sha,
        message: `test: change a file from run ${manifest.run.id}`,
        author: { name: 'forges fixtures', email: 'fixtures@forges.link' },
        changes: [{ path: filesPath(manifest.run, 'text.md'), content: 'Not written.\n' }],
      })
    }
    catch (error) {
      if (error instanceof BranchMovedError) {
        return { name: error.name, status: error.status }
      }
      throw error
    }
    throw new Error('The forge committed to a branch that had moved')
  } },
  { name: 'commit files deleting a missing file', verb: 'contents.commitFiles', run: async (provider, manifest) => {
    try {
      await provider.contents.commitFiles(manifest.scratch, {
        branch: filesBranch(manifest.run),
        message: `test: delete a missing file from run ${manifest.run.id}`,
        changes: [{ path: filesPath(manifest.run, 'missing.md'), content: null }],
      })
    }
    catch (error) {
      if (error instanceof NotFoundError) {
        return { name: error.name }
      }
      throw error
    }
    throw new Error('The forge deleted a file that does not exist')
  } },
  { name: 'commit files creating an existing branch', verb: 'contents.commitFiles', run: async (provider, manifest) => {
    try {
      await provider.contents.commitFiles(manifest.scratch, {
        branch: filesBranch(manifest.run),
        createFrom: manifest.run.base,
        message: `test: recreate a branch from run ${manifest.run.id}`,
        changes: [{ path: filesPath(manifest.run, 'text.md'), content: 'Not written.\n' }],
      })
    }
    catch (error) {
      if (error instanceof ForgeApiError) {
        return { name: error.name }
      }
      throw error
    }
    throw new Error('The forge committed to a branch that already existed')
  } },

  { name: 'create issue', verb: 'threads.create', kind: 'issue', run: async (provider, manifest, context) => {
    context.issue = await provider.threads.create(manifest.scratch, { kind: 'issue', title: fixtureTitle(manifest.run, 'issue'), body: `Opened by run ${manifest.run.id}.` })
    context.author ??= context.issue.author
    return context.issue
  } },
  ...threadWrites('issue'),
  { name: 'create labelled issue', verb: 'threads.create', kind: 'issue', when: provider => provider.can('threads.setLabels', 'issue') && provider.can('threads.setAssignees', 'issue'), run: (provider, manifest, context) => provider.threads.create(manifest.scratch, {
    kind: 'issue',
    title: fixtureTitle(manifest.run, 'labelled issue'),
    body: `Opened by run ${manifest.run.id}.`,
    labels: [label(manifest)],
    assignees: [need(context.author, 'the author')],
  }) },
  { name: 'create duplicate issue', verb: 'threads.create', kind: 'issue', run: async (provider, manifest, context) => {
    context.duplicate = await provider.threads.create(manifest.scratch, { kind: 'issue', title: fixtureTitle(manifest.run, 'duplicate'), body: `Opened by run ${manifest.run.id}.` })
    return context.duplicate
  } },
  { name: 'mark duplicate', verb: 'threads.markDuplicate', kind: 'issue', run: (provider, _manifest, context) => provider.threads.markDuplicate(need(context.duplicate, 'the duplicate issue').ref, threadOf(context, 'issue')) },
  { name: 'transfer issue', verb: 'threads.transfer', kind: 'issue', run: (provider, manifest, context) => provider.threads.transfer(need(context.duplicate, 'the duplicate issue').ref, need(manifest.transfer, 'manifest.transfer')) },
  { name: 'issue close', verb: 'threads.close', kind: 'issue', run: (provider, _manifest, context) => provider.threads.close(threadOf(context, 'issue'), { reason: 'completed' }) },
  { name: 'issue reopen', verb: 'threads.reopen', kind: 'issue', run: (provider, _manifest, context) => provider.threads.reopen(threadOf(context, 'issue')) },

  ...([0, 1, 2] as const).map((index): WriteStep => ({
    name: ['create pull', 'create second pull', 'create third pull'][index]!,
    verb: 'threads.create',
    kind: 'pull_request',
    run: async (provider, manifest, context) => {
      const pull = await provider.threads.create(manifest.scratch, {
        kind: 'pull_request',
        title: fixtureTitle(manifest.run, `pull ${index + 1}`),
        body: `Opened by run ${manifest.run.id}.`,
        head: manifest.run.branches[index],
        base: manifest.run.base,
      })
      context.pulls[index] = pull
      return pull
    },
  })),
  { name: 'existing pull', verb: 'threads.get', kind: 'pull_request', when: provider => !provider.can('threads.create', 'pull_request'), run: async (provider, manifest, context) => {
    const pull = await provider.threads.get({ forge: manifest.scratch.forge, instance: manifest.scratch.instance, repo: manifest.scratch, kind: 'pull_request', number: need(manifest.run.pull, 'manifest.run.pull') })
    context.pulls = [pull, pull, pull]
    return pull
  } },
  ...threadWrites('pull_request'),
  { name: 'discussion', verb: 'threads.get', kind: 'discussion', when: (_provider, manifest) => manifest.run.discussion !== undefined, run: async (provider, manifest, context) => {
    context.discussion = await provider.threads.get({ forge: manifest.scratch.forge, instance: manifest.scratch.instance, repo: manifest.scratch, kind: 'discussion', number: need(manifest.run.discussion, 'manifest.run.discussion') })
    return context.discussion
  } },
  ...threadWrites('discussion'),
  { name: 'discussion close', verb: 'threads.close', kind: 'discussion', run: (provider, _manifest, context) => provider.threads.close(threadOf(context, 'discussion'), { reason: 'completed' }) },
  { name: 'discussion reopen', verb: 'threads.reopen', kind: 'discussion', run: (provider, _manifest, context) => provider.threads.reopen(threadOf(context, 'discussion')) },
  ...commitWrites(),
  { name: 'request review', verb: 'threads.requestReview', kind: 'pull_request', run: (provider, manifest, context) => provider.threads.requestReview(threadOf(context, 'pull_request'), [need(context.reviewer ?? manifest.run.reviewer, 'the reviewer')]) },
  { name: 'pending review', verb: 'threads.createReview', kind: 'pull_request', as: 'reviewer', run: async (provider, manifest, context) => {
    // Where reviews cannot be left pending, they are only approvals, so the third pull request takes one.
    context.review = provider.can('threads.submitReview')
      ? await provider.threads.createReview(threadOf(context, 'pull_request'), {
          body: `A review from run ${manifest.run.id}.`,
          comments: [{ path: manifest.run.files[0], line: 1, side: 'right', body: `A line comment from run ${manifest.run.id}.` }],
        })
      : await provider.threads.createReview(need(context.pulls[2], 'the third pull request').ref, { event: 'approve' })
    return context.review
  } },
  { name: 'comment review', verb: 'threads.createReview', kind: 'pull_request', as: 'reviewer', when: provider => !provider.can('threads.submitReview'), run: async (provider, manifest, context) => {
    const review = await provider.threads.createReview(threadOf(context, 'pull_request'), { event: 'comment', body: `A review comment from run ${manifest.run.id}.` })
    context.reviewComment = review.comments ? review.comments[0]?.ref : undefined
    return review
  } },
  { name: 'submit review', verb: 'threads.submitReview', kind: 'pull_request', as: 'reviewer', run: async (provider, manifest, context) => {
    context.review = await provider.threads.submitReview(need(context.review, 'a pending review').ref, 'comment', `A submitted review from run ${manifest.run.id}.`)
    return context.review
  } },
  { name: 'get review', verb: 'threads.getReview', kind: 'pull_request', run: async (provider, _manifest, context) => {
    const review = await provider.threads.getReview(need(context.review, 'a review').ref)
    context.reviewComment ??= review.comments ? review.comments[0]?.ref : undefined
    return review
  } },
  { name: 'get review comment', verb: 'threads.getComment', kind: 'pull_request', run: (provider, _manifest, context) => provider.threads.getComment(need(context.reviewComment, 'a review comment')) },
  { name: 'reply to review comment', verb: 'threads.replyToReviewComment', kind: 'pull_request', run: async (provider, manifest, context) => {
    const pull = threadOf(context, 'pull_request')
    const reviews = await provider.threads.reviews(pull).page()
    let comment: ReviewComment | undefined = reviews.items.flatMap(review => review.comments || []).find(item => item.ref)
    const comments = comment ? undefined : await provider.threads.comments(pull).page()
    comment ??= comments?.items.find(item => item.thread)
    const reply = await provider.threads.replyToReviewComment(pull, need(comment, 'a review comment'), `A reply from run ${manifest.run.id}.`)
    return { reviews, comments, reply }
  } },
  { name: 'resolve review thread', verb: 'threads.resolveReviewThread', kind: 'pull_request', run: async (provider, _manifest, context) => {
    const pull = threadOf(context, 'pull_request')
    const reviews = await provider.threads.reviews(pull).page()
    let id = reviews.items.flatMap(review => review.comments || []).find(comment => comment.thread)?.thread?.id
    const comments = id ? undefined : await provider.threads.comments(pull).page()
    id ??= comments?.items.find(comment => comment.thread)?.thread?.id
    context.reviewThread = need(id, 'a review thread')
    await provider.threads.resolveReviewThread(pull, context.reviewThread)
    return { reviews, comments, id }
  } },
  { name: 'unresolve review thread', verb: 'threads.unresolveReviewThread', kind: 'pull_request', run: (provider, _manifest, context) => provider.threads.unresolveReviewThread(threadOf(context, 'pull_request'), need(context.reviewThread, 'a resolved review thread')) },
  { name: 'report check', verb: 'checks.report', run: (provider, manifest, context) => provider.checks.report(manifest.scratch, need(context.pulls[0]?.branches?.head.sha, 'the pull head sha'), { name: 'forges fixture', state: 'success', description: `Reported by run ${manifest.run.id}` }) },
  { name: 'rerun check', verb: 'checks.rerun', as: 'reviewer', run: async (provider, manifest) => {
    const head = await provider.contents.resolveRef(manifest.scratch, manifest.run.base)
    const checks = await provider.checks.list(manifest.scratch, head)
    const candidates = checks.items.flatMap(item => item.ref && item.state !== 'pending' ? [item.ref] : [])
    // Some CI checks cannot be re-run, such as GitHub's CodeQL default setup, so the step tries each finished one.
    for (const check of candidates) {
      try {
        await provider.checks.rerun(check)
        return { head, check }
      }
      catch (error) {
        if (!(error instanceof ForgeError) || check === candidates.at(-1)) {
          throw error
        }
      }
    }
    throw new Error('No finished CI check on the base branch')
  } },
  { name: 'approve', verb: 'threads.approve', kind: 'pull_request', as: 'reviewer', run: (provider, _manifest, context) => provider.threads.approve(threadOf(context, 'pull_request')) },
  // Tangled applies a pull's commits onto its target branch, so it only rebases.
  { name: 'merge', verb: 'threads.merge', kind: 'pull_request', run: (provider, manifest, context) => provider.threads.merge(threadOf(context, 'pull_request'), { method: provider.forge === 'tangled' ? 'rebase' : 'merge', title: `Merge run ${manifest.run.id}`, message: `Merged by run ${manifest.run.id}` }) },
  { name: 'pull close', verb: 'threads.close', kind: 'pull_request', run: (provider, _manifest, context) => provider.threads.close(need(context.pulls[2], 'the third pull request').ref) },
  { name: 'pull reopen', verb: 'threads.reopen', kind: 'pull_request', run: (provider, _manifest, context) => provider.threads.reopen(need(context.pulls[2], 'the third pull request').ref) },
  // After the reopen, as GitHub refuses to reopen a pull request whose branch moved while it was closed.
  { name: 'pull update branch by rebase', verb: 'threads.updateBranch', kind: 'pull_request', run: (provider, _manifest, context) => {
    const pull = need(context.pulls[2], 'the third pull request')
    return provider.threads.updateBranch(pull.ref, { method: 'rebase', sha: need(pull.branches?.head.sha, 'the third pull head sha') })
  } },
  { name: 'pull update branch', verb: 'threads.updateBranch', kind: 'pull_request', when: provider => provider.forge !== 'gitlab', run: (provider, _manifest, context) => provider.threads.updateBranch(need(context.pulls[2], 'the third pull request').ref) },

  { name: 'block for organization', verb: 'orgs.block', when: blocks, run: (provider, manifest) => provider.orgs.block(ownerOf(manifest), need(manifest.run.blocked, 'manifest.run.blocked')) },
  { name: 'unblock for organization', verb: 'orgs.unblock', when: blocks, run: (provider, manifest) => provider.orgs.unblock(ownerOf(manifest), need(manifest.run.blocked, 'manifest.run.blocked')) },
  { name: 'block for author', verb: 'users.block', when: blocks, run: (provider, manifest) => provider.users.block(need(manifest.run.blocked, 'manifest.run.blocked')) },
  { name: 'unblock for author', verb: 'users.unblock', when: blocks, run: (provider, manifest) => provider.users.unblock(need(manifest.run.blocked, 'manifest.run.blocked')) },

  // GitLab has no draft releases or prereleases.
  { name: 'create draft release', verb: 'releases.create', when: provider => provider.forge !== 'gitlab', run: async (provider, manifest, context) => {
    context.draft = await provider.releases.create(manifest.scratch, { tag: fixtureTag(manifest.run, 'draft'), target: manifest.run.base, name: `${FIXTURE_TITLE} ${manifest.run.id}: draft`, body: `Drafted by run ${manifest.run.id}.`, draft: true, prerelease: true })
    return context.draft
  } },
  { name: 'publish release', verb: 'releases.update', when: provider => provider.forge !== 'gitlab', run: (provider, manifest, context) => provider.releases.update(need(context.draft, 'a draft release').ref, { body: `Published by run ${manifest.run.id}.`, draft: false, prerelease: false }) },
  { name: 'create release', verb: 'releases.create', run: async (provider, manifest, context) => {
    context.release = await provider.releases.create(manifest.scratch, { tag: fixtureTag(manifest.run), target: manifest.run.base, name: `${FIXTURE_TITLE} ${manifest.run.id}: release`, body: `Released by run ${manifest.run.id}.` })
    return context.release
  } },
  { name: 'update release', verb: 'releases.update', run: (provider, manifest, context) => provider.releases.update(need(context.release, 'a release').ref, { name: `${FIXTURE_TITLE} ${manifest.run.id}: release, edited`, body: `Edited by run ${manifest.run.id}.` }) },
  { name: 'retag immutable release', verb: 'releases.update', when: provider => provider.forge === 'github', run: async (provider, manifest, context) => {
    const release = need(context.release, 'a release')
    if (!release.immutable) {
      throw new Error('The scratch repository does not make releases immutable')
    }
    try {
      await provider.releases.update(release.ref, { tag: fixtureTag(manifest.run, 'retagged') })
    }
    catch (error) {
      if (error instanceof ForbiddenError && error.reason === 'immutable_release') {
        return { name: error.name, status: error.status, reason: error.reason, reasonRaw: error.reasonRaw }
      }
      throw error
    }
    throw new Error('The forge retagged an immutable release')
  } },

  { name: 'create webhook', verb: 'webhooks.create', run: async (provider, manifest, context) => {
    context.webhook = await provider.webhooks.create(manifest.scratch, { url: FIXTURE_HOOK_URL, events: ['comment'], secret: HOOK_SECRETS[0], contentType: 'json' })
    return context.webhook
  } },
  { name: 'update webhook', verb: 'webhooks.update', run: (provider, _manifest, context) => provider.webhooks.update(need(context.webhook, 'a webhook').ref, { events: ['comment', 'push'] }) },
  { name: 'rotate webhook secret', verb: 'webhooks.rotateSecret', run: (provider, _manifest, context) => provider.webhooks.rotateSecret(need(context.webhook, 'a webhook').ref, HOOK_SECRETS[1]) },
  { name: 'new webhook deliveries', verb: 'webhooks.deliveries', run: async (provider, _manifest, context) => {
    for (let attempt = 1; ; attempt++) {
      const result = await provider.webhooks.deliveries(need(context.webhook, 'a webhook').ref, page).page()
      if (result.items.length || attempt === 5) {
        context.delivery = result.items[0]
        return result
      }
      await context.wait(3_000)
    }
  } },
  { name: 'redeliver', verb: 'webhooks.redeliver', run: (provider, _manifest, context) => provider.webhooks.redeliver(need(context.delivery, 'a delivery').ref) },
  { name: 'delete webhook', verb: 'webhooks.delete', run: (provider, _manifest, context) => provider.webhooks.delete(need(context.webhook, 'a webhook').ref) },

  { name: 'mention author', verb: 'threads.createComment', kind: 'issue', as: 'reviewer', run: async (provider, manifest, context) => {
    const { login } = need(context.author, 'the author')
    // Azure DevOps logins are email addresses, which a recording must not keep.
    if (login.includes('@')) {
      throw new Error('The author login is an email address')
    }
    return provider.threads.createComment(threadOf(context, 'issue'), `@${login} a mention from run ${manifest.run.id}.`)
  } },
  { name: 'author notifications', verb: 'notifications.list', run: async (provider, manifest, context) => {
    for (let attempt = 1; ; attempt++) {
      const result = await provider.notifications.list({ all: true, perPage: 50 }).page()
      context.notification = result.items.find((item) => {
        const thread = notificationThread(item)
        return thread && `${thread.repo.owner}/${thread.repo.name}`.toLowerCase() === `${manifest.scratch.owner}/${manifest.scratch.name}`.toLowerCase()
      })
      if (context.notification || attempt === 6) {
        return result
      }
      await context.wait(10_000)
    }
  } },
  { name: 'mark notification read', verb: 'notifications.markRead', run: (provider, _manifest, context) => provider.notifications.markRead(need(context.notification, 'a scratch notification').ref) },
  { name: 'unsubscribe notification', verb: 'notifications.unsubscribe', run: (provider, _manifest, context) => provider.notifications.unsubscribe(need(context.notification, 'a scratch notification').ref, { thread: notificationThread(context.notification!) }) },
  { name: 'mark notification done', verb: 'notifications.markDone', run: (provider, _manifest, context) => provider.notifications.markDone(need(context.notification, 'a scratch notification').ref, { thread: notificationThread(context.notification!) }) },
  { name: 'mark all read', verb: 'notifications.markAllRead', run: (provider, manifest) => provider.notifications.markAllRead({ repo: manifest.scratch }) },
  { name: 'mark all done', verb: 'notifications.markAllDone', run: provider => provider.notifications.markAllDone() },
]
