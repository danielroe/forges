import type {
  ForgeIterable,
  ForgeProvider,
  Forges,
  ForgeWarning,
  Notification,
  NotificationRef,
  RepoRef,
  Thread,
  ThreadRef,
} from 'forges'
import { isResolvedThread, notificationKey, notificationThread, threadKey } from 'forges'

export interface InboxRow {
  /** Identity of the row, as accepted by `--done`. */
  key: string
  at: Date
  forge: string
  instance: string
  repo: string
  /** Thread kind, or the notification subject type when the subject is not a thread. */
  kind: string
  title: string
  reason: string
  provider: ForgeProvider
  /** Absent for rows derived from a thread listing rather than a notification. */
  notification?: NotificationRef
  /** The thread the row concerns, where there is one. */
  thread?: ThreadRef
}

export interface InboxResult {
  rows: InboxRow[]
  warnings: ForgeWarning[]
}

export interface InboxOptions {
  /**
   * Repositories to list recent threads from, for providers that cannot list
   * notifications. Matched to a provider by `forge` and `instance`.
   */
  repos?: readonly RepoRef[]
  /** Rows per provider. Defaults to 20. */
  limit?: number
  since?: Date
}

function repoName(repo: RepoRef): string {
  return repo.name ? `${repo.owner}/${repo.name}` : repo.owner
}

function rowFromNotification(provider: ForgeProvider, notification: Notification): InboxRow {
  const thread = notificationThread(notification)
  const subject = notification.subject
  const repo = thread?.repo
    ?? (subject.type === 'repo' ? subject.repo : undefined)
    ?? (subject.type === 'release' ? subject.release.repo : undefined)
    ?? (subject.type === 'security_alert' ? subject.alert.repo : undefined)
    ?? (subject.type === 'other' ? subject.repo : undefined)

  return {
    key: notificationKey(notification.ref),
    at: notification.updatedAt,
    forge: provider.forge,
    instance: provider.instance,
    repo: repo ? repoName(repo) : '-',
    kind: thread ? thread.kind : subject.type,
    title: notification.title,
    reason: notification.reason,
    provider,
    notification: notification.ref,
    thread,
  }
}

function rowFromThread(provider: ForgeProvider, thread: Thread): InboxRow {
  return {
    key: isResolvedThread(thread.ref) ? threadKey(thread.ref) : `${repoName(thread.ref.repo)}#?`,
    at: thread.lastActivityAt ?? thread.updatedAt ?? thread.createdAt ?? new Date(0),
    forge: provider.forge,
    instance: provider.instance,
    repo: repoName(thread.ref.repo),
    kind: thread.kind,
    title: thread.title,
    reason: thread.state,
    provider,
    thread: thread.ref,
  }
}

async function take<T>(iterable: ForgeIterable<T>, limit: number): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) {
    items.push(item)
    if (items.length >= limit) {
      break
    }
  }
  return items
}

/** Reads every provider's notifications, or its recent threads where it has none. */
export async function collectInbox(forges: Forges, options: InboxOptions = {}): Promise<InboxResult> {
  const limit = options.limit ?? 20
  const rows: InboxRow[] = []
  const warnings: ForgeWarning[] = []

  for (const provider of forges.providers) {
    if (provider.can('notifications.list')) {
      const iterable = provider.notifications.list({ since: options.since })
      for (const notification of await take(iterable, limit)) {
        rows.push(rowFromNotification(provider, notification))
      }
      warnings.push(...iterable.warnings)
      continue
    }

    const repos = (options.repos ?? []).filter(
      repo => repo.forge === provider.forge && repo.instance === provider.instance,
    )
    if (repos.length === 0) {
      warnings.push({
        code: 'no_notifications_source',
        message: `${provider.forge} (${provider.instance}) cannot list notifications and no repository was configured for it`,
        subject: `${provider.forge}/${provider.instance}`,
      })
      continue
    }
    for (const repo of repos) {
      const iterable = provider.threads.list(repo, { state: 'open' })
      for (const thread of await take(iterable, limit)) {
        rows.push(rowFromThread(provider, thread))
      }
      warnings.push(...iterable.warnings)
    }
  }

  rows.sort((a, b) => b.at.getTime() - a.at.getTime())
  return { rows, warnings }
}

export function formatRow(row: InboxRow): string {
  return [
    row.at.toISOString().slice(0, 16).replace('T', ' '),
    row.forge,
    row.repo,
    row.kind,
    row.reason,
    row.title,
  ].join('  ')
}

export interface MarkDoneResult {
  key: string
  /** `markDone` where the forge has it, `markRead` where it only has that. */
  verb: 'markDone' | 'markRead'
  forge: string
}

/** Marks the notification behind an inbox key done, falling back to read-only forges. */
export async function markDone(forges: Forges, key: string, options: InboxOptions = {}): Promise<MarkDoneResult> {
  const { rows } = await collectInbox(forges, options)
  const row = rows.find(candidate => candidate.key === key)
  if (!row || !row.notification) {
    throw new Error(`No notification in the inbox with key ${key}`)
  }

  const { provider } = row
  const notifications = provider.notifications
  if (!notifications) {
    throw new Error(`${provider.forge} has no notification writes`)
  }

  if (provider.can('notifications.markDone') && notifications.markDone) {
    await notifications.markDone(row.notification, { thread: row.thread })
    return { key, verb: 'markDone', forge: provider.forge }
  }
  if (provider.can('notifications.markRead') && notifications.markRead) {
    await notifications.markRead(row.notification)
    return { key, verb: 'markRead', forge: provider.forge }
  }
  throw new Error(`${provider.forge} supports neither markDone nor markRead`)
}
