import type { Comment, ForgeEvent, ForgeProvider, RepoRole, ThreadRef } from 'forges'
import { isResolvedThread } from 'forges'

const WRITE_ROLES = new Set<RepoRole>(['admin', 'maintain', 'write'])

export interface LabelBotOptions {
  /** Titles matching this get the label and the comment. */
  titlePattern: RegExp
  label: string
  /** Body of the comment posted on a match. */
  comment: string
  /** Comment command that closes the thread. Defaults to `/close`. */
  closeCommand?: string
}

export type ActionKind
  = | 'labelled'
    | 'commented'
    | 'closed'
    | 'ignored'
    | 'unsupported'
    | 'refused'

export interface Action {
  kind: ActionKind
  /** Why the action was taken or skipped, for the delivery response and the log. */
  reason: string
  thread?: string
}

/**
 * Forge-native event names for a thread being opened. `ForgeEvent.kind` is
 * `state_change` for open, close and reopen alike, so the raw name is the only
 * way to tell them apart.
 */
const OPENED = /\.(?:opened|open)$/

function isOpened(event: ForgeEvent): boolean {
  return event.kind === 'state_change' && OPENED.test(event.kindRaw ?? '')
}

function describe(ref: ThreadRef): string {
  return `${ref.repo.owner}/${ref.repo.name}#${ref.number ?? '?'}`
}

async function latestCommentBy(
  provider: ForgeProvider,
  ref: ThreadRef,
  login: string | undefined,
): Promise<Comment | undefined> {
  let latest: Comment | undefined
  for await (const comment of provider.threads.comments(ref)) {
    if (login && comment.author?.login !== login) {
      continue
    }
    latest = comment
  }
  return latest
}

export function createLabelBot(options: LabelBotOptions) {
  const closeCommand = options.closeCommand ?? '/close'

  async function onOpened(provider: ForgeProvider, ref: ThreadRef): Promise<Action[]> {
    const kind = ref.kind
    if (kind === 'other') {
      return [{ kind: 'ignored', reason: 'subject has no shared kind', thread: describe(ref) }]
    }

    const thread = await provider.threads.get(ref)
    if (!options.titlePattern.test(thread.title)) {
      return [{ kind: 'ignored', reason: 'title does not match', thread: describe(ref) }]
    }

    const actions: Action[] = []

    if (provider.can('threads.addLabels', kind)) {
      await provider.threads.addLabels(ref, [options.label])
      actions.push({ kind: 'labelled', reason: options.label, thread: describe(ref) })
    }
    else {
      actions.push({ kind: 'unsupported', reason: `${provider.forge} cannot add labels to a ${kind}`, thread: describe(ref) })
    }

    if (provider.can('threads.upsertComment', kind)) {
      await provider.threads.upsertComment(ref, { key: 'label-bot', body: provider.normaliseMarkdown(options.comment) })
      actions.push({ kind: 'commented', reason: 'matched title', thread: describe(ref) })
    }
    else {
      actions.push({ kind: 'unsupported', reason: `${provider.forge} cannot comment on a ${kind}`, thread: describe(ref) })
    }

    return actions
  }

  async function onComment(provider: ForgeProvider, event: ForgeEvent, ref: ThreadRef): Promise<Action[]> {
    const kind = ref.kind
    if (kind === 'other') {
      return [{ kind: 'ignored', reason: 'subject has no shared kind', thread: describe(ref) }]
    }

    const comment = await latestCommentBy(provider, ref, event.actor?.login)
    if (!comment?.body.includes(closeCommand)) {
      return [{ kind: 'ignored', reason: 'no command in the latest comment', thread: describe(ref) }]
    }

    const login = comment.author?.login ?? event.actor?.login
    if (!login) {
      return [{ kind: 'refused', reason: 'comment has no author', thread: describe(ref) }]
    }

    if (!provider.can('repos.permissionFor')) {
      return [{ kind: 'unsupported', reason: `cannot check collaborators on ${provider.forge}`, thread: describe(ref) }]
    }
    if (!WRITE_ROLES.has(await provider.repos.permissionFor(ref.repo, login))) {
      return [{ kind: 'refused', reason: `${login} cannot write to the repository`, thread: describe(ref) }]
    }

    if (!provider.can('threads.close', kind)) {
      return [{ kind: 'unsupported', reason: `${provider.forge} cannot close a ${kind}`, thread: describe(ref) }]
    }

    await provider.threads.close(ref)
    return [{ kind: 'closed', reason: `requested by ${login}`, thread: describe(ref) }]
  }

  /** Runs one already-ingested event. */
  async function handle(provider: ForgeProvider, event: ForgeEvent): Promise<Action[]> {
    const ref = event.thread
    if (!ref || !isResolvedThread(ref)) {
      return [{ kind: 'ignored', reason: 'event has no addressable thread' }]
    }
    if (isOpened(event)) {
      return onOpened(provider, ref)
    }
    if (event.kind === 'comment') {
      return onComment(provider, event, ref)
    }
    return [{ kind: 'ignored', reason: `nothing to do for ${event.kind}`, thread: describe(ref) }]
  }

  /** Verifies and ingests a delivery, then runs every event in it. */
  async function ingest(provider: ForgeProvider, delivery: { headers: Headers | Record<string, string>, body: string }): Promise<Action[]> {
    const events = await provider.webhooks.ingest(delivery)
    const actions: Action[] = []
    for (const event of events) {
      actions.push(...await handle(provider, event))
    }
    return actions
  }

  return { handle, ingest }
}
