<script setup lang="ts">
import providers from '#capabilities'

type Support = 'yes' | 'experimental' | 'emulated' | 'no'

const rows = ['writes.merge', 'notifications.list', 'releases.list', 'checks.list', 'search.threads', 'webhooks.create', 'ci.runs'].map(capability => ({
  capability,
  levels: providers.map(({ capabilities }): Support => {
    const value = capability.split('.').reduce<unknown>((entry, key) => (entry as Record<string, unknown>)[key], capabilities)
    return value === true ? 'yes' : value || 'no'
  }),
}))

const labels: Record<Support, string> = {
  yes: 'Native and verified',
  experimental: 'Experimental',
  emulated: 'Emulated',
  no: 'Not available',
}

const legend: Support[] = ['yes', 'experimental', 'no']
</script>

<template>
  <div>
    <div class="overflow-x-auto">
      <!-- Fixed column widths -->
      <div
        class="mx-auto grid w-max items-center gap-y-1.5 pr-16"
        :style="{ gridTemplateColumns: `11rem repeat(${providers.length}, 2.25rem)` }"
      >
        <div />
        <div
          v-for="{ name } of providers"
          :key="name"
          class="relative h-24"
        >
          <span class="absolute bottom-0 left-1/2 origin-bottom-left -rotate-45 whitespace-nowrap font-mono text-xs text-muted">{{ name }}</span>
        </div>

        <template
          v-for="row of rows"
          :key="row.capability"
        >
          <div class="font-mono text-xs text-highlighted">
            {{ row.capability }}
          </div>
          <div
            v-for="(level, index) of row.levels"
            :key="index"
            class="flex justify-center"
          >
            <span
              class="cell"
              role="img"
              :data-level="level"
              :title="`${providers[index]!.name}: ${labels[level]}`"
              :aria-label="`${providers[index]!.name}: ${labels[level]}`"
            />
          </div>
        </template>
      </div>
    </div>

    <ul class="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-muted">
      <li
        v-for="level of legend"
        :key="level"
        class="inline-flex items-center gap-2"
      >
        <span
          class="cell"
          :data-level="level"
        />
        {{ labels[level] }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.cell {
  display: inline-block;
  width: 1.125rem;
  height: 1.125rem;
}

.cell[data-level='yes'] {
  background: var(--ui-primary);
}

.cell[data-level='experimental'] {
  background: repeating-linear-gradient(135deg, var(--ui-primary) 0 2px, transparent 2px 4px);
  outline: 1px solid color-mix(in oklab, var(--ui-primary) 55%, transparent);
  outline-offset: -1px;
}

.cell[data-level='emulated'] {
  background: color-mix(in oklab, var(--ui-primary) 45%, transparent);
}

.cell[data-level='no'] {
  background: var(--ui-bg-accented);
  opacity: 0.55;
}
</style>
