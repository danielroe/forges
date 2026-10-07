<script setup lang="ts">
import { groups, providers } from '#capabilities'

const props = defineProps<{
  provider: string
}>()

const index = providers.findIndex(({ slug }) => slug === props.provider)
const provider = providers[index]
if (!provider) {
  throw new Error(`Unknown provider: ${props.provider}`)
}

const total = Object.values(provider.summary).reduce((sum, count) => sum + count, 0)
const sources = groups.find(group => group.name === 'sources')!.rows.map(row => ({
  name: row.capability.slice('sources.'.length),
  level: row.cells[index]!.level,
}))
const statement = `import { ${provider.factories.join(', ')} } from '${provider.import}'`

const { copied, copy, message } = useCopyToClipboard(() => statement)
</script>

<template>
  <div class="not-prose my-6 overflow-hidden rounded-lg border border-default">
    <div class="flex items-center gap-3 border-b border-default bg-elevated/40 py-2 pr-2 pl-4">
      <UIcon
        :name="provider.icon"
        class="size-5 shrink-0 text-highlighted"
      />
      <code class="min-w-0 flex-1 font-mono sm:truncate text-[13px] text-toned"><span class="text-muted">import</span> { <span class="text-highlighted">{{ provider.factories.join(', ') }}</span> } <span class="text-muted">from</span> '{{ provider.import }}'</code>
      <UBadge
        v-if="provider.experimental"
        label="Experimental"
        color="neutral"
        variant="outline"
        size="sm"
        class="shrink-0"
      />
      <UButton
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        :aria-label="copied ? 'Copied' : 'Copy import statement'"
        color="neutral"
        variant="ghost"
        size="sm"
        class="shrink-0"
        @click="copy"
      />
      <span
        class="sr-only"
        aria-live="polite"
      >{{ message }}</span>
    </div>

    <dl class="grid gap-px bg-(--ui-border) text-xs sm:grid-cols-2 lg:grid-cols-4">
      <div class="bg-default p-4">
        <dt class="text-muted">
          Factories
        </dt>
        <dd class="mt-2 space-y-1.5">
          <NuxtLink
            v-for="factory of provider.factories"
            :key="factory"
            :to="factory.endsWith('Lite') ? '/concepts/providers#lite-factories' : '/concepts/providers#factories'"
            class="flex items-baseline justify-between gap-2 hover:text-primary"
          >
            <code class="font-mono text-highlighted">{{ factory }}()</code>
            <span class="text-muted">{{ factory.endsWith('Lite') ? 'No webhooks' : 'Full' }}</span>
          </NuxtLink>
        </dd>
      </div>

      <div class="bg-default p-4">
        <dt class="text-muted">
          Auth
        </dt>
        <dd class="mt-2 flex flex-wrap gap-1">
          <UBadge
            v-for="auth of provider.auth"
            :key="auth"
            :label="auth"
            color="neutral"
            variant="subtle"
            size="sm"
            class="font-mono"
          />
        </dd>
      </div>

      <div class="bg-default p-4">
        <dt class="text-muted">
          Event sources
        </dt>
        <dd class="mt-2 space-y-1.5">
          <span
            v-for="source of sources"
            :key="source.name"
            class="flex items-center gap-2"
          >
            <CapabilityCell
              :level="source.level"
              class="[--capability-cell-size:0.625rem]"
            />
            <span
              class="font-mono"
              :class="source.level === 'none' ? 'text-muted' : 'text-highlighted'"
            >{{ source.name }}</span>
            <span class="sr-only">{{ shortSupportLabels[source.level].toLowerCase() }}</span>
          </span>
        </dd>
      </div>

      <div class="bg-default p-4">
        <dt class="text-muted">
          Capabilities
        </dt>
        <dd class="mt-2">
          <a
            href="#capabilities"
            class="group block"
          >
            <span class="text-muted">
              <span class="text-2xl font-semibold text-highlighted tabular-nums group-hover:text-primary">{{ provider.summary.native }}</span>
              / {{ total }} native
            </span>
            <span
              class="mt-2 flex h-1.5 gap-px overflow-hidden bg-elevated"
              aria-hidden="true"
            >
              <span
                v-for="level of supportLevels"
                :key="level"
                class="capability-swatch"
                :data-level="level"
                :style="{ width: `${provider.summary[level] / total * 100}%` }"
              />
            </span>
          </a>
        </dd>
      </div>
    </dl>
  </div>
</template>
