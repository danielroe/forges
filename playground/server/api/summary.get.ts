import type { ForgeProvider, RepoRef } from 'forges'
import type { ErrorInfo } from '../utils/forges'
import { notificationKey, threadKey } from 'forges'
import { defineEventHandler, getQuery } from 'nuxt/server'
import { demoRepo, errorBody, redactRaw, skippedProviders, useForges, webhookEvents } from '../utils/forges'

const LATEST = 5

const NONE: { value?: undefined, error?: undefined } = {}

async function attempt<T>(run: () => Promise<T>): Promise<{ value?: T, error?: ErrorInfo }> {
  try {
    return { value: await run() }
  }
  catch (caught) {
    return { error: errorBody(caught).body.error }
  }
}

async function repoFor(provider: ForgeProvider): Promise<RepoRef | undefined> {
  const configured = demoRepo(provider)
  if (configured) {
    return { forge: provider.forge, instance: provider.instance, ...configured }
  }
  return provider.capabilities.repos.list ? (await provider.repos.listPage({ perPage: 1 })).items[0]?.ref : undefined
}

async function latest(provider: ForgeProvider, repo: RepoRef | undefined) {
  if (provider.can('notifications.list')) {
    const page = await provider.notifications.listPage({ perPage: LATEST })
    return {
      type: 'notifications' as const,
      items: page.items.slice(0, LATEST).map(item => ({ key: notificationKey(item.ref), title: item.title, reason: item.reason, updatedAt: item.updatedAt, raw: item.raw })),
      warnings: page.warnings ?? [],
    }
  }
  if (!repo) {
    return { type: 'none' as const, items: [], warnings: [] }
  }
  const page = await provider.threads.listPage(repo, { state: 'all', perPage: LATEST })
  return {
    type: 'threads' as const,
    repo: `${repo.owner}/${repo.name}`,
    items: page.items.slice(0, LATEST).map(thread => ({ key: thread.ref.number ? threadKey({ ...thread.ref, number: thread.ref.number }) : thread.title, title: thread.title, state: thread.state, updatedAt: thread.updatedAt, raw: thread.raw })),
    warnings: page.warnings ?? [],
  }
}

async function checks(provider: ForgeProvider, repo: RepoRef) {
  const { items: [pull] } = await provider.threads.listPage(repo, { kind: 'pull_request', state: 'open', perPage: 1 })
  if (!pull) {
    return undefined
  }
  const { items } = await provider.threads.checks(pull.ref)
  return {
    title: pull.title,
    summary: (await provider.threads.get(pull.ref)).checks,
    items: items.map(check => ({ name: check.name, state: check.state, url: check.url, raw: check.raw })),
  }
}

export default defineEventHandler(async (event) => {
  const showRaw = getQuery(event).raw === '1'
  const providers = await Promise.all(useForges().providers.map(async (provider) => {
    const key = `${provider.forge}/${provider.instance}`
    const repo = await repoFor(provider).catch(() => undefined)
    const [listing, checkResult, release, alerts] = await Promise.all([
      attempt(() => latest(provider, repo)),
      repo && provider.can('threads.checks', 'pull_request') ? attempt(() => checks(provider, repo)) : NONE,
      repo && provider.can('releases.latest') ? attempt(() => provider.releases.latest(repo)) : NONE,
      repo && provider.can('securityAlerts.list') ? attempt(() => provider.securityAlerts.listPage(repo, { state: 'open', perPage: LATEST })) : NONE,
    ])
    return {
      key,
      forge: provider.forge,
      instance: provider.instance,
      repo: repo ? `${repo.owner}/${repo.name}` : undefined,
      capabilities: provider.capabilities,
      latest: listing.value,
      checks: checkResult.value,
      release: release.value,
      alerts: alerts.value && { items: alerts.value.items.slice(0, LATEST), warnings: alerts.value.warnings ?? [] },
      errors: [listing.error, checkResult.error, release.error, alerts.error].filter(Boolean),
      webhooks: webhookEvents(key),
      subscribe: provider.can('sources.subscribe'),
    }
  }))
  const body = { providers, skipped: skippedProviders() }
  return showRaw ? body : redactRaw(body)
})
