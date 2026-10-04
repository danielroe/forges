import type { ProviderSpec } from '../define.ts'
import type { ForgeErrorContext } from '../errors.ts'
import type { Fetcher, RequestOptions } from '../fetch.ts'
import type { Actor, Notification, NotificationListOptions, NotificationSubject, Page, RepoRef } from '../model.ts'
import type { AtprotoClient } from './atproto.ts'
import type { IssueRecord, PullRecord } from './types.ts'
import { verb } from '../define.ts'
import { UnsupportedOperationError } from '../errors.ts'
import { toDate } from '../utils.ts'
import { parseAtUri } from './atproto.ts'
import { FORGE, toNotificationReason, toThreadRef } from './normalise.ts'

const NOTIFICATION_NSID = {
  list: 'org.tangled.temp.notification.listNotifications',
  updateSeen: 'org.tangled.temp.notification.updateSeen',
  markAllRead: 'org.tangled.temp.notification.markAllRead',
  unreadCount: 'org.tangled.temp.notification.getUnreadCount',
} as const

interface DeliberiNotification {
  uri: string
  read: boolean
  type: string
  category?: string
  actorDid: string
  repoDid?: string
  issueAt?: string
  pullAt?: string
  createdAt: string
}

interface NotificationDeps {
  instance: string
  context: ForgeErrorContext
  fetcher: Fetcher
  atproto: AtprotoClient
  pdsCall: <T>(nsid: string, init?: RequestOptions) => Promise<T>
  resolveRepo: (did: string) => Promise<RepoRef>
  actorFor: (did: string) => Promise<Actor>
}

/**
 * `org.tangled.temp.notification.*` is served by a separate service that
 * authenticates callers with atproto service-auth tokens minted by their
 * PDS for audience `did:web:<host>`.
 */
export function createTangledNotifications(url: string, { instance, context, fetcher, atproto, pdsCall, resolveRepo, actorFor }: NotificationDeps): NonNullable<ProviderSpec['notifications']> {
  const audience = `did:web:${new URL(url).host}`
  const titles = new Map<string, Promise<string | undefined>>()

  async function call<T>(nsid: string, init: RequestOptions = {}): Promise<T> {
    const { token } = await pdsCall<{ token: string }>('com.atproto.server.getServiceAuth', { query: { aud: audience, lxm: nsid } })
    const { data } = await fetcher.json<T>(`${url}/xrpc/${nsid}`, {
      ...init,
      headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${token}` },
    })
    return data
  }

  function titleOf(subject: string): Promise<string | undefined> {
    let title = titles.get(subject)
    if (!title) {
      title = atproto.getRecord<IssueRecord | PullRecord>(subject).then(({ value }) => value.title, () => undefined)
      titles.set(subject, title)
    }
    return title
  }

  async function toItem(item: DeliberiNotification): Promise<Notification> {
    const subject = item.issueAt ?? item.pullAt
    const parsed = subject ? parseAtUri(subject) : undefined
    const repo = item.repoDid
      ? await resolveRepo(item.repoDid).catch((): RepoRef => ({ forge: FORGE, instance, owner: item.repoDid!, name: '', externalId: item.repoDid }))
      : undefined
    let notificationSubject: NotificationSubject
    if (parsed && repo) {
      notificationSubject = { type: 'thread', thread: toThreadRef(instance, repo, parsed) }
    }
    else if (item.type === 'followed') {
      notificationSubject = { type: 'actor', actor: await actorFor(item.actorDid) }
    }
    else if (repo) {
      notificationSubject = { type: 'repo', repo }
    }
    else {
      notificationSubject = { type: 'other', typeRaw: item.type, id: item.uri }
    }
    return {
      ref: { forge: FORGE, instance, id: item.uri },
      subject: notificationSubject,
      subjectTypeRaw: item.type,
      reason: toNotificationReason(item.type),
      reasonRaw: item.type,
      unread: !item.read,
      title: (subject ? await titleOf(subject) : undefined) ?? item.type.replaceAll('_', ' '),
      subjectState: 'unknown',
      updatedAt: toDate(item.createdAt) ?? new Date(0),
      raw: item,
    }
  }

  async function page(listOptions: NotificationListOptions = {}): Promise<Page<Notification>> {
    const data = await call<{ notifications: DeliberiNotification[] }>(NOTIFICATION_NSID.list, {
      query: { read: listOptions.all ? 'all' : 'unread', limit: listOptions.perPage ?? 100 },
      signal: listOptions.signal,
    })
    const since = listOptions.since?.getTime()
    const items = await Promise.all(data.notifications
      .filter(item => since === undefined || (toDate(item.createdAt)?.getTime() ?? 0) >= since)
      .map(toItem))
    return { items }
  }

  return {
    listPage: verb('experimental', page),
    markRead: verb('experimental', async (ref) => {
      await call(NOTIFICATION_NSID.updateSeen, {
        method: 'POST',
        json: { uri: ref.id, read: true },
      })
    }),
    markAllRead: verb('experimental', async (bulk = {}) => {
      if (bulk.repo || bulk.before) {
        throw new UnsupportedOperationError('Tangled marks every notification read at once; repo and before filters are not supported', context)
      }
      await call(NOTIFICATION_NSID.markAllRead, { method: 'POST' })
    }),
    unreadCount: verb('experimental', async () => (await call<{ count: number }>(NOTIFICATION_NSID.unreadCount)).count),
  }
}
