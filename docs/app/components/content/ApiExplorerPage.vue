<script setup lang="ts">
import { EXPLORER_OPERATIONS } from '~~/shared/explorer'

const NAMESPACES: Record<string, string> = {
  threads: 'Issues and pull requests',
  repos: 'Repositories',
  contents: 'Contents',
  releases: 'Releases',
  checks: 'Checks',
  ci: 'CI',
  securityAlerts: 'Security alerts',
  notifications: 'Notifications',
  webhooks: 'Webhooks',
  users: 'Accounts',
  search: 'Search',
}
const DEFAULT = 'threads.get'

// Reads, which run here, come before the code-only writes in each group.
const groups = Object.entries(NAMESPACES).map(([namespace, title]) => [
  { type: 'label' as const, label: title, value: '' },
  ...EXPLORER_OPERATIONS
    .filter(operation => operation.verb.startsWith(`${namespace}.`))
    .sort((a, b) => Number(!a.run) - Number(!b.run))
    .map(operation => ({
      label: `${operation.method}()`,
      value: operation.verb,
      icon: operation.run ? 'i-lucide-play' : 'i-lucide-code',
    })),
])

const route = useRoute()
const verb = ref(DEFAULT)
/** Whether the query has been read. The explorer then mounts again, to read the forge and the form from it. */
const ready = ref(false)

// The query is read after hydration, so the prerendered page and the first client render agree.
onMounted(() => {
  const wanted = route.query.verb
  if (typeof wanted === 'string' && EXPLORER_OPERATIONS.some(operation => operation.verb === wanted)) {
    verb.value = wanted
  }
  ready.value = true
})
</script>

<template>
  <div class="not-prose my-6 flex flex-col gap-4">
    <UFormField
      label="Operation"
      size="sm"
      class="w-full sm:max-w-md"
    >
      <template #hint>
        <span class="flex items-center gap-3">
          <span class="flex items-center gap-1">
            <UIcon
              name="i-lucide-play"
              class="size-3.5"
              aria-hidden="true"
            />
            runs here
          </span>
          <span class="flex items-center gap-1">
            <UIcon
              name="i-lucide-code"
              class="size-3.5"
              aria-hidden="true"
            />
            code only
          </span>
        </span>
      </template>
      <USelectMenu
        v-model="verb"
        :items="groups"
        value-key="value"
        class="w-full font-mono"
        :search-input="{ placeholder: 'Search operations' }"
      />
    </UFormField>
    <ApiExplorer
      :key="`${verb}:${ready}`"
      :verb="verb"
      :permalink="ready"
      expanded
    />
  </div>
</template>
