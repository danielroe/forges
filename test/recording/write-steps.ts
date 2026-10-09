import type { Actor, Comment, Milestone, Notification, RepoRef, Review, Thread, ThreadRef, Webhook, WebhookDeliveryRecord } from '../../src/model.ts'
import type { ForgeProvider, ForgeVerb } from '../../src/provider.ts'
import type { RecordingManifest } from './steps.ts'
import { ForgeError } from '../../src/errors.ts'
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
}

/** A write recording: the read manifest, the scratch repository every write goes to, and the run. */
export interface WriteManifest extends RecordingManifest {
  scratch: RepoRef
  run: WriteRun
}

/** The label a write recording creates and puts on its threads. */
export function fixtureLabel(run: WriteRun): string {
  return `forges-fixture-${run.id}`
}

/** Values earlier write steps created, for later steps to use. */
export interface WriteContext {
  author?: Actor
  reviewer?: Actor
  issue?: Thread
  discussion?: Thread
  duplicate?: Thread
  pulls: Thread[]
  comments: Partial<Record<WriteKind | 'commit', Comment>>
  milestone?: Milestone
  review?: Review
  webhook?: Webhook
  delivery?: WebhookDeliveryRecord
  notification?: Notification
  /** Waits before polling again; a replay passes one that returns at once. */
  wait: (ms: number) => Promise<void>
}

export interface WriteStep {
  name: string
  verb: ForgeVerb
  kind?: WriteKind | 'commit'
  /** Run with the reviewer's credentials rather than the author's. */
  as?: 'reviewer'
  /** Whether the step applies, beyond the provider supporting its verb. */
  when?: (provider: ForgeProvider, manifest: WriteManifest) => boolean
  run: (provider: ForgeProvider, manifest: WriteManifest, context: WriteContext) => Promise<unknown>
}

/** The prefix of every title a write recording gives an issue or a pull request, so a later run can find leftovers. */
export const FIXTURE_TITLE = 'forges fixture'

/** Where the webhook steps point the hook they create. */
export const FIXTURE_HOOK_URL = 'https://example.com/hook'

/** The secrets the webhook steps sign deliveries with. They are dummies and never come from the environment. */
const HOOK_SECRETS = ['forges-fixture-secret', 'forges-fixture-secret-rotated'] as const

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

function threadOf(context: WriteContext, kind: WriteKind): ThreadRef {
  const thread = kind === 'issue' ? context.issue : kind === 'discussion' ? context.discussion : context.pulls[0]
  return need(thread, `the ${kind.replace('_', ' ')}`).ref
}

/** Comment, react, label, assign, subscribe and edit steps, the same for an issue and a pull request. */
function threadWrites(kind: WriteKind): WriteStep[] {
  const prefix = kind === 'pull_request' ? 'pull' : kind
  const ref = (context: WriteContext) => threadOf(context, kind)
  return [
    { name: `${prefix} comment`, verb: 'threads.comment', kind, run: async (provider, manifest, context) => {
      context.comments[kind] = await provider.threads.comment(ref(context), `A comment from run ${manifest.run.id}.`)
      return context.comments[kind]
    } },
    { name: `${prefix} edit comment`, verb: 'threads.editComment', kind, run: (provider, manifest, context) => provider.threads.editComment(need(context.comments[kind], 'a comment').ref, `An edited comment from run ${manifest.run.id}.`) },
    { name: `${prefix} upsert comment`, verb: 'threads.upsertComment', kind, run: (provider, manifest, context) => provider.threads.upsertComment(ref(context), { key: 'forges-fixture', body: `An upserted comment from run ${manifest.run.id}.` }) },
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
  ]
}

/** Comments on the first pull request's head commit. */
function commitWrites(): WriteStep[] {
  const ref = (context: WriteContext): ThreadRef => {
    const pull = need(context.pulls[0], 'the pull request')
    return { forge: pull.ref.forge, instance: pull.ref.instance, repo: pull.ref.repo, kind: 'commit', number: need(pull.branches?.head.sha, 'the pull head sha') }
  }
  return [
    { name: 'commit comment', verb: 'threads.comment', kind: 'commit', run: async (provider, manifest, context) => {
      context.comments.commit = await provider.threads.comment(ref(context), `A commit comment from run ${manifest.run.id}.`)
      return context.comments.commit
    } },
    { name: 'commit edit comment', verb: 'threads.editComment', kind: 'commit', run: (provider, manifest, context) => provider.threads.editComment(need(context.comments.commit, 'a commit comment').ref, `An edited commit comment from run ${manifest.run.id}.`) },
    { name: 'commit upsert comment', verb: 'threads.upsertComment', kind: 'commit', run: (provider, manifest, context) => provider.threads.upsertComment(ref(context), { key: 'forges-fixture', body: `An upserted commit comment from run ${manifest.run.id}.` }) },
    { name: 'commit delete comment', verb: 'threads.deleteComment', kind: 'commit', run: (provider, _manifest, context) => provider.threads.deleteComment(need(context.comments.commit, 'a commit comment').ref) },
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
  { name: 'milestones', verb: 'repos.milestonesPage', run: async (provider, manifest, context) => {
    const result = await provider.repos.milestonesPage(manifest.scratch, page)
    context.milestone = result.items.find(milestone => milestone.state === 'open')
    return result
  } },
  { name: 'add collaborator', verb: 'repos.addCollaborator', run: (provider, manifest, context) => provider.repos.addCollaborator(manifest.scratch, need(context.reviewer, 'the reviewer'), 'write') },

  { name: 'create issue', verb: 'threads.create', kind: 'issue', run: async (provider, manifest, context) => {
    context.issue = await provider.threads.create(manifest.scratch, { kind: 'issue', title: `${FIXTURE_TITLE} ${manifest.run.id}: issue`, body: `Opened by run ${manifest.run.id}.` })
    context.author ??= context.issue.author
    return context.issue
  } },
  ...threadWrites('issue'),
  { name: 'create duplicate issue', verb: 'threads.create', kind: 'issue', run: async (provider, manifest, context) => {
    context.duplicate = await provider.threads.create(manifest.scratch, { kind: 'issue', title: `${FIXTURE_TITLE} ${manifest.run.id}: duplicate`, body: `Opened by run ${manifest.run.id}.` })
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
        title: `${FIXTURE_TITLE} ${manifest.run.id}: pull ${index + 1}`,
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
  { name: 'submit review', verb: 'threads.submitReview', kind: 'pull_request', as: 'reviewer', run: async (provider, manifest, context) => {
    context.review = await provider.threads.submitReview(need(context.review, 'a pending review').ref, 'comment', `A submitted review from run ${manifest.run.id}.`)
    return context.review
  } },
  { name: 'resolve review thread', verb: 'threads.resolveReviewThread', kind: 'pull_request', run: async (provider, _manifest, context) => {
    const reviews = await provider.threads.reviewsPage(threadOf(context, 'pull_request'))
    const id = need(reviews.items.flatMap(review => review.comments || []).find(comment => comment.thread)?.thread?.id, 'a review thread')
    await provider.threads.resolveReviewThread(threadOf(context, 'pull_request'), id)
    return { reviews, id }
  } },
  { name: 'unresolve review thread', verb: 'threads.unresolveReviewThread', kind: 'pull_request', run: async (provider, _manifest, context) => {
    const reviews = await provider.threads.reviewsPage(threadOf(context, 'pull_request'))
    const id = need(reviews.items.flatMap(review => review.comments || []).find(comment => comment.thread)?.thread?.id, 'a review thread')
    return provider.threads.unresolveReviewThread(threadOf(context, 'pull_request'), id)
  } },
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
  { name: 'merge', verb: 'threads.merge', kind: 'pull_request', run: (provider, manifest, context) => provider.threads.merge(threadOf(context, 'pull_request'), { method: 'merge', message: `Merged by run ${manifest.run.id}` }) },
  { name: 'pull close', verb: 'threads.close', kind: 'pull_request', run: (provider, _manifest, context) => provider.threads.close(need(context.pulls[2], 'the third pull request').ref) },
  { name: 'pull reopen', verb: 'threads.reopen', kind: 'pull_request', run: (provider, _manifest, context) => provider.threads.reopen(need(context.pulls[2], 'the third pull request').ref) },
  { name: 'approve and merge', verb: 'threads.approveAndMerge', kind: 'pull_request', as: 'reviewer', run: (provider, manifest, context) => provider.threads.approveAndMerge(need(context.pulls[1], 'the second pull request').ref, { method: 'merge', message: `Merged by run ${manifest.run.id}` }) },

  { name: 'create webhook', verb: 'webhooks.create', run: async (provider, manifest, context) => {
    context.webhook = await provider.webhooks.create(manifest.scratch, { url: FIXTURE_HOOK_URL, events: ['comment'], secret: HOOK_SECRETS[0], contentType: 'json' })
    return context.webhook
  } },
  { name: 'update webhook', verb: 'webhooks.update', run: (provider, _manifest, context) => provider.webhooks.update(need(context.webhook, 'a webhook').ref, { events: ['comment', 'push'] }) },
  { name: 'rotate webhook secret', verb: 'webhooks.rotateSecret', run: (provider, _manifest, context) => provider.webhooks.rotateSecret(need(context.webhook, 'a webhook').ref, HOOK_SECRETS[1]) },
  { name: 'new webhook deliveries', verb: 'webhooks.deliveriesPage', run: async (provider, _manifest, context) => {
    for (let attempt = 1; ; attempt++) {
      const result = await provider.webhooks.deliveriesPage(need(context.webhook, 'a webhook').ref, page)
      if (result.items.length || attempt === 5) {
        context.delivery = result.items[0]
        return result
      }
      await context.wait(3_000)
    }
  } },
  { name: 'redeliver', verb: 'webhooks.redeliver', run: (provider, _manifest, context) => provider.webhooks.redeliver(need(context.delivery, 'a delivery').ref) },
  { name: 'delete webhook', verb: 'webhooks.delete', run: (provider, _manifest, context) => provider.webhooks.delete(need(context.webhook, 'a webhook').ref) },

  { name: 'mention author', verb: 'threads.comment', kind: 'issue', as: 'reviewer', run: async (provider, manifest, context) => {
    const { login } = need(context.author, 'the author')
    // Azure DevOps logins are email addresses, which a recording must not keep.
    if (login.includes('@')) {
      throw new Error('The author login is an email address')
    }
    return provider.threads.comment(threadOf(context, 'issue'), `@${login} a mention from run ${manifest.run.id}.`)
  } },
  { name: 'author notifications', verb: 'notifications.listPage', run: async (provider, manifest, context) => {
    for (let attempt = 1; ; attempt++) {
      const result = await provider.notifications.listPage({ all: true, perPage: 50 })
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
