<script setup lang="ts">
import { groups, providers } from '#capabilities'

const featured = ['writes.merge', 'notifications.list', 'releases.list', 'checks.list', 'search.threads', 'webhooks.create', 'ci.runs']
const rows = groups.flatMap(group => group.rows).filter(row => featured.includes(row.capability))
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
            v-for="(cell, index) of row.cells"
            :key="index"
            class="flex justify-center"
          >
            <span
              role="img"
              class="inline-flex"
              :title="`${providers[index]!.name}: ${supportLabels[cell.level]}`"
              :aria-label="`${providers[index]!.name}: ${supportLabels[cell.level]}`"
            >
              <CapabilityCell :level="cell.level" />
            </span>
          </div>
        </template>
      </div>
    </div>

    <CapabilityLegend
      :levels="['native', 'experimental', 'none']"
      class="mt-6 [&>ul]:justify-center"
    />
  </div>
</template>
