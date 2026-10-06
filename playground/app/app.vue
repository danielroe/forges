<script setup lang="ts">
interface Summary {
  providers: Array<{
    key: string
    forge: string
    instance: string
    capabilities: Record<string, unknown> & { experimental?: true, sources: Record<string, unknown>, notifications: Record<string, unknown>, writes: Record<string, unknown> }
    latest?: { type: 'notifications' | 'threads' | 'none', repo?: string, items: Array<{ key: string, title: string, reason?: string, state?: string, updatedAt?: string, raw: unknown }>, warnings: Array<{ code: string, message: string }> }
    repo?: string
    errors: Array<{ name: string, message: string }>
    checks?: { title: string, summary?: { state: string, total?: number, failed?: number }, items: Array<{ name: string, state: string, url?: string, raw: unknown }> }
    release?: { tag: string, name?: string, publishedAt?: string, url?: string, assets?: Array<{ name: string }> }
    alerts?: { items: Array<{ ref: { id: string }, kind: string, severity: string, title: string, url?: string }>, warnings: Array<{ code: string, message: string }> }
    webhooks: Array<{ kind: string, summary?: string, occurredAt: string, raw?: unknown }>
    subscribe: boolean
  }>
  skipped: Array<{ kind: string, suffix: string, reason: string }>
}

const showRaw = ref(false)
const { data, refresh, status } = await useFetch<Summary>('/api/summary', { query: computed(() => ({ raw: showRaw.value ? '1' : undefined })) })

const live = reactive<Record<string, Array<{ cursor: string, kind: string, summary?: string }>>>({})
const sources: EventSource[] = []

onMounted(() => {
  for (const provider of data.value?.providers ?? []) {
    if (!provider.subscribe) {
      continue
    }
    const source = new EventSource(`/api/live/${provider.forge}`)
    live[provider.key] = []
    source.addEventListener('event', (message) => {
      const { cursor, event } = JSON.parse(message.data) as { cursor: string, event: { kind: string, summary?: string } }
      live[provider.key] = [{ cursor, kind: event.kind, summary: event.summary }, ...live[provider.key]!].slice(0, 20)
    })
    sources.push(source)
  }
})
onBeforeUnmount(() => sources.forEach(source => source.close()))

function supported(record: Record<string, unknown>): string[] {
  return Object.entries(record).filter(([, value]) => value && (typeof value !== 'object' || Object.values(value).some(Boolean))).map(([name]) => name)
}
</script>

<template>
  <main>
    <header>
      <h1>forges</h1>
      <label><input v-model="showRaw" type="checkbox"> show raw payloads</label>
      <button :disabled="status === 'pending'" @click="refresh()">
        refresh
      </button>
    </header>

    <section v-if="!data?.providers.length" class="empty">
      <h2>No providers configured</h2>
      <p>Configure providers with the <code>FORGES_*</code> environment variables that <code>providersFromEnv()</code> from <code>forges/env</code> reads, then restart. For example:</p>
      <pre>FORGES_GITHUB_TOKEN=ghp_...
FORGES_GITLAB_TOKEN=glpat-...
FORGES_FORGEJO_TOKEN=...            # Codeberg by default
FORGES_TANGLED_ENABLED=1            # anonymous reads and the live feed
FORGES_TANGLED_DEMO_REPO=did:plc:.../repo   # threads to show where there are no notifications</pre>
    </section>

    <p v-for="entry in data?.skipped" :key="`${entry.kind}${entry.suffix}`" class="warning">
      Skipped {{ entry.kind }}{{ entry.suffix ? ` (${entry.suffix})` : '' }}: {{ entry.reason }}
    </p>

    <article v-for="provider in data?.providers" :key="provider.key">
      <h2>
        {{ provider.forge }} <small>{{ provider.instance }}</small>
        <span v-if="provider.capabilities.experimental" class="tag">experimental</span>
      </h2>
      <p class="capabilities">
        <strong>sources</strong> {{ supported(provider.capabilities.sources).join(', ') || 'none' }} ·
        <strong>notifications</strong> {{ supported(provider.capabilities.notifications).join(', ') || 'none' }} ·
        <strong>writes</strong> {{ supported(provider.capabilities.writes).join(', ') || 'none' }}
      </p>

      <p v-for="error in provider.errors" :key="error.name + error.message" class="warning">
        {{ error.name }}: {{ error.message }}
      </p>
      <template v-if="provider.latest && provider.latest.type !== 'none'">
        <h3>{{ provider.latest.type === 'notifications' ? 'Latest notifications' : `Latest threads in ${provider.latest.repo}` }}</h3>
        <ul>
          <li v-for="item in provider.latest.items" :key="item.key">
            {{ item.title }} <small>{{ item.reason ?? item.state }} · {{ item.updatedAt }}</small>
            <pre v-if="showRaw">{{ item.raw }}</pre>
          </li>
          <li v-if="!provider.latest.items.length">
            Nothing yet.
          </li>
        </ul>
        <p v-for="warning in provider.latest.warnings" :key="warning.code + warning.message" class="warning">
          {{ warning.code }}: {{ warning.message }}
        </p>
      </template>

      <template v-if="provider.checks">
        <h3>Checks on "{{ provider.checks.title }}" <small v-if="provider.checks.summary">{{ provider.checks.summary.state }}{{ provider.checks.summary.total === undefined ? '' : ` · ${provider.checks.summary.failed} of ${provider.checks.summary.total} failed` }}</small></h3>
        <ul>
          <li v-for="check in provider.checks.items" :key="check.name">
            <a v-if="check.url" :href="check.url">{{ check.name }}</a><span v-else>{{ check.name }}</span> <small>{{ check.state }}</small>
            <pre v-if="showRaw">{{ check.raw }}</pre>
          </li>
        </ul>
      </template>

      <template v-if="provider.release">
        <h3>Latest release</h3>
        <p>
          <a :href="provider.release.url">{{ provider.release.name ?? provider.release.tag }}</a>
          <small>{{ provider.release.tag }} · {{ provider.release.publishedAt }} · {{ provider.release.assets?.length ?? 0 }} assets</small>
        </p>
      </template>

      <template v-if="provider.alerts">
        <h3>Open security alerts</h3>
        <ul>
          <li v-for="alert in provider.alerts.items" :key="alert.kind + alert.ref.id">
            <a :href="alert.url">{{ alert.title }}</a> <small>{{ alert.kind }} · {{ alert.severity }}</small>
          </li>
          <li v-if="!provider.alerts.items.length">
            None.
          </li>
        </ul>
        <p v-for="warning in provider.alerts.warnings" :key="warning.code + warning.message" class="warning">
          {{ warning.code }}: {{ warning.message }}
        </p>
      </template>

      <template v-if="provider.subscribe">
        <h3>Live feed</h3>
        <ul>
          <li v-for="item in live[provider.key]" :key="item.cursor">
            {{ item.kind }} <small>{{ item.summary }}</small>
          </li>
          <li v-if="!live[provider.key]?.length">
            Waiting for events…
          </li>
        </ul>
      </template>

      <h3>Webhooks <small>POST /api/webhooks/{{ provider.forge }}</small></h3>
      <ul>
        <li v-for="(event, index) in provider.webhooks" :key="index">
          {{ event.kind }} <small>{{ event.summary }} · {{ event.occurredAt }}</small>
        </li>
        <li v-if="!provider.webhooks.length">
          None received.
        </li>
      </ul>
    </article>
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 56rem; padding: 1rem; line-height: 1.4 }
header { display: flex; gap: 1rem; align-items: center }
header h1 { margin-right: auto }
article { border-top: 1px solid #ddd; padding: 0.5rem 0 }
small, .capabilities { color: #666 }
.tag { background: #fde68a; border-radius: 0.25rem; font-size: 0.75rem; padding: 0 0.25rem }
.warning { color: #a16207 }
pre { background: #f5f5f5; overflow: auto; padding: 0.5rem }
</style>
