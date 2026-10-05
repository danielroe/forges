import type { WebhookHandlers } from '../define.ts'
import type { EventKind, ForgeEventInput, RepoRef, ThreadRef, WebhookEventType } from '../model.ts'
import type { WebhookDelivery } from '../provider.ts'
import type { AzureDevOpsOptions } from './index.ts'
import type { AzureComment, AzureIdentity, AzurePullRequest, AzureRepository, AzureServiceHookEvent } from './types.ts'
import { bodyText, headerValue, timingSafeEqual } from '../crypto.ts'
import { toDate } from '../utils.ts'
import { refEvent } from '../webhooks.ts'
import { FORGE, projectRef, toActor, toRepoRef } from './normalise.ts'

/**
 * Service hooks carry no signature. A subscription can send basic
 * credentials, so `secret` is `username:password` and the delivery's
 * `Authorization: Basic` header must match it.
 */
export function verifyAzureBasicAuth(delivery: WebhookDelivery, secret: string | undefined): boolean {
  const key = delivery.secret ?? secret
  const header = headerValue(delivery.headers, 'authorization')
  if (!key || !header?.startsWith('Basic ')) {
    return false
  }
  return timingSafeEqual(header, `Basic ${btoa(key)}`)
}

const PULL_KINDS: Record<string, EventKind> = {
  'git.pullrequest.created': 'state_change',
  'git.pullrequest.merged': 'state_change',
  'git.pullrequest.updated': 'other',
  'ms.vss-code.git-pullrequest-comment-event': 'comment',
}

export function translateAzureWebhook(instance: string, organization: string, delivery: WebhookDelivery): ForgeEventInput[] {
  const event = JSON.parse(bodyText(delivery.body)) as AzureServiceHookEvent
  const resource = event.resource
  const pull = (resource.pullRequest ?? (event.eventType.startsWith('git.pullrequest') ? resource : undefined)) as AzurePullRequest | undefined
  const repository = (pull?.repository ?? resource.repository) as AzureRepository | undefined
  const repo: RepoRef | undefined = repository?.project ? toRepoRef(instance, organization, repository) : undefined
  const base = {
    forge: FORGE,
    instance,
    id: event.id,
    kindRaw: event.eventType,
    occurredAt: toDate(event.createdDate) ?? new Date(),
    repo,
    source: 'webhook' as const,
    payload: event,
  }
  if (pull && repo) {
    const thread: ThreadRef = { forge: FORGE, instance, repo, kind: 'pull_request', number: String(pull.pullRequestId) }
    const comment = resource.comment as AzureComment | undefined
    const actor = toActor(instance, comment?.author ?? pull.createdBy)
    return [{ ...base, kind: PULL_KINDS[event.eventType] ?? 'other', actor, thread, summary: event.message?.text ?? `${actor?.login ?? 'someone'} ${event.eventType}` }]
  }
  if (event.eventType.startsWith('workitem.')) {
    const fields = (resource.fields ?? (resource.revision as { fields?: Record<string, unknown> } | undefined)?.fields ?? {}) as Record<string, unknown>
    const id = String(resource.workItemId ?? resource.id)
    const project = fields['System.TeamProject'] as string | { newValue?: string } | undefined
    const projectName = typeof project === 'string' ? project : project?.newValue
    const thread: ThreadRef | undefined = projectName
      ? { forge: FORGE, instance, repo: projectRef(instance, organization, projectName), kind: 'issue', number: id }
      : undefined
    const kind: EventKind = event.eventType === 'workitem.commented' ? 'comment' : event.eventType === 'workitem.updated' ? 'other' : 'state_change'
    return [{ ...base, kind, thread, repo: thread?.repo, actor: toActor(instance, resource.revisedBy as AzureIdentity | undefined), summary: event.message?.text ?? event.eventType }]
  }
  if (event.eventType === 'git.push' && repo) {
    const updates = (resource.refUpdates ?? []) as Array<{ name: string, oldObjectId?: string, newObjectId?: string }>
    const commits = ((resource.commits ?? []) as Array<{ commitId: string, comment?: string, url?: string, author?: { name?: string } }>).map(commit => ({ sha: commit.commitId, message: commit.comment ?? '', author: commit.author?.name, url: commit.url }))
    const actor = toActor(instance, resource.pushedBy as AzureIdentity | undefined)
    const zero = /^0+$/
    return updates.map((update, index): ForgeEventInput => ({
      ...base,
      id: `${event.id}:${index}`,
      actor,
      ...refEvent(actor?.login ?? 'someone', {
        ref: update.name,
        before: update.oldObjectId,
        after: update.newObjectId,
        created: zero.test(update.oldObjectId ?? ''),
        deleted: zero.test(update.newObjectId ?? ''),
        commits,
      }),
    }))
  }
  if (event.eventType === 'git.repo.renamed' && repo) {
    return [{ ...base, kind: 'repo', action: 'renamed', detail: { type: 'repo_renamed', from: String((resource as { oldName?: string }).oldName ?? ''), to: repository!.name }, summary: event.message?.text ?? 'Repository renamed' }]
  }
  return [{ ...base, kind: 'other', summary: event.message?.text ?? event.eventType }]
}

const AZURE_WEBHOOK_EVENTS: WebhookEventType[] = [
  { kind: 'comment', action: 'created' },
  { kind: 'state_change', action: 'opened' },
  { kind: 'state_change', action: 'closed' },
  { kind: 'state_change', action: 'merged' },
  { kind: 'review', action: 'submitted' },
  { kind: 'push' },
]

export const azureDevOpsWebhooks: WebhookHandlers<AzureDevOpsOptions> = ({ options, instance }) => ({
  events: AZURE_WEBHOOK_EVENTS,
  verify: async delivery => verifyAzureBasicAuth(delivery, options.webhookSecret),
  translate: delivery => translateAzureWebhook(instance, options.organization, delivery),
})
