import type { RepoRef, ThreadRef } from '../../src/model.ts'
import type { ForgeProvider } from '../../src/provider.ts'
import { FIXTURE_LABEL } from './write-steps.ts'

/** The title of the issue `--seed` keeps in the scratch repository. It does not start with `FIXTURE_TITLE`, so clean-up leaves it alone. */
export const SEED_TITLE = 'forges seed: issue'

const SEED_PULL_TITLE = 'forges seed: pull'

/** A label `--seed` keeps in the scratch repository, which applies to issues and pull requests alike. */
export const SEED_LABEL = 'forges-seed'

const COMMENTS = ['A seeded comment.', 'Another seeded comment, with a reaction.']

const REVIEWER_COMMENT = 'A seeded comment from the reviewer.'

/**
 * Leaves `thread` with the seeded comments, `labels`, the account as its
 * assignee and reactions on it and its first comment, writing only what is
 * missing.
 */
async function seedThread(provider: ForgeProvider, thread: ThreadRef, labels: string[]): Promise<void> {
  const me = await provider.users.me()
  const comments = (await provider.threads.commentsPage(thread)).items
  for (const body of COMMENTS) {
    if (!comments.some(comment => comment.body === body)) {
      comments.push(await provider.threads.comment(thread, body))
    }
  }
  if (provider.can('threads.setLabels', thread.kind)) {
    await provider.threads.setLabels(thread, labels)
  }
  if (provider.can('threads.setAssignees', thread.kind)) {
    await provider.threads.setAssignees(thread, [me])
  }
  if (provider.can('threads.react', thread.kind)) {
    await provider.threads.react(thread, 'rocket')
    await provider.threads.react(thread, '+1')
    await provider.threads.react(comments.find(comment => comment.body === COMMENTS[1])!.ref, 'heart')
  }
}

/**
 * Keeps an issue in `scratch`, and `pull` where given, in a known state for
 * read recordings: comments, labels, an assignee and reactions. Only the
 * issue also carries one of the repository's existing labels, which some
 * forges scope to issues. Where `reviewer` is given, it comments on and
 * reacts to the issue. Run after `--writes`, which changes the labels and
 * assignees of `pull`.
 */
export async function seedScratch(provider: ForgeProvider, scratch: RepoRef, pull?: ThreadRef, reviewer?: ForgeProvider): Promise<{ issue: ThreadRef, pull?: ThreadRef }> {
  const names = (await provider.repos.labelsPage(scratch)).items.map(label => label.name)
  if (!names.includes(SEED_LABEL)) {
    await provider.repos.createLabel(scratch, { name: SEED_LABEL, colour: '8b5cf6' })
  }
  const other = names.find(name => !name.startsWith(FIXTURE_LABEL) && name !== SEED_LABEL)
  let issue = (await provider.threads.listPage(scratch, { kind: 'issue', state: 'all' })).items.find(thread => thread.title === SEED_TITLE)
  if (!issue) {
    issue = await provider.threads.create(scratch, { kind: 'issue', title: SEED_TITLE, body: 'An issue that read recordings read.' })
    await provider.threads.close(issue.ref)
    await provider.threads.reopen(issue.ref)
  }
  else if (issue.state !== 'open') {
    await provider.threads.reopen(issue.ref)
  }
  await seedThread(provider, issue.ref, other ? [other, SEED_LABEL] : [SEED_LABEL])
  if (pull) {
    const { title } = await provider.threads.get(pull)
    if (title !== SEED_PULL_TITLE) {
      await provider.threads.update(pull, { title: SEED_PULL_TITLE })
    }
    await seedThread(provider, pull, [SEED_LABEL])
  }
  if (reviewer) {
    const comments = (await reviewer.threads.commentsPage(issue.ref)).items
    if (!comments.some(comment => comment.body === REVIEWER_COMMENT)) {
      await reviewer.threads.comment(issue.ref, REVIEWER_COMMENT)
    }
    if (reviewer.can('threads.react', 'issue')) {
      await reviewer.threads.react(issue.ref, 'eyes')
    }
  }
  return { issue: issue.ref, pull }
}
