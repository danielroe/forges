<script setup lang="ts">
import { groups, providers } from '#capabilities'

const total = groups.reduce((sum, group) => sum + group.rows.length, 0)

const supported = (provider: (typeof providers)[number]) => total - provider.summary.none

const sorted = [...providers].sort((a, b) => supported(b) - supported(a) || b.summary.native - a.summary.native)
</script>

<template>
  <ul class="not-prose my-6 grid gap-4 sm:grid-cols-2">
    <li
      v-for="provider of sorted"
      :key="provider.slug"
      class="min-w-0"
    >
      <NuxtLink
        :to="provider.to"
        class="group flex h-full flex-col rounded-lg border border-default p-4 transition hover:border-accented hover:bg-elevated/40"
      >
        <span class="flex items-center gap-3">
          <UIcon
            :name="provider.icon"
            class="size-5 text-highlighted"
          />
          <span class="font-semibold text-highlighted">{{ provider.title }}</span>
          <UBadge
            v-if="provider.experimental"
            label="Experimental"
            color="neutral"
            variant="outline"
            size="sm"
            class="ml-auto"
          />
        </span>
        <code class="mt-3 truncate font-mono text-xs text-toned"><span class="text-muted">import</span> { {{ provider.factories.join(', ') }} } <span class="text-muted">from</span> '{{ provider.import }}'</code>
        <span class="mt-3 line-clamp-2 text-sm text-muted">{{ provider.description }}</span>
        <span class="mt-auto flex items-center gap-3 pt-4">
          <span
            class="flex h-1.5 flex-1 gap-px overflow-hidden bg-elevated"
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
          <span class="font-mono text-xs text-muted tabular-nums">
            {{ provider.summary.native }}/{{ total }}
            <span class="sr-only">capabilities native and verified</span>
          </span>
        </span>
      </NuxtLink>
    </li>
  </ul>
</template>
