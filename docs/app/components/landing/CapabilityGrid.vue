<script setup lang="ts">
import { groups, providers } from '#capabilities'

const featured = ['writes.merge', 'notifications.list', 'releases.list', 'checks.list', 'search.threads', 'webhooks.create', 'ci.runs']
const rows = groups.flatMap(group => group.rows).filter(row => featured.includes(row.capability))
</script>

<template>
  <div>
    <div
      class="relative overflow-x-auto"
      role="region"
      aria-label="Capability support"
    >
      <table class="mx-auto w-max border-separate border-spacing-y-1.5 pr-16 text-left">
        <caption class="sr-only">
          Support for selected capabilities, by forge
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              class="w-44"
            >
              <span class="sr-only">Capability</span>
            </th>
            <th
              v-for="{ name } of providers"
              :key="name"
              scope="col"
              class="relative h-24 w-9 p-0 font-normal"
            >
              <span class="absolute bottom-0 left-1/2 origin-bottom-left -rotate-45 whitespace-nowrap font-mono text-xs text-muted">{{ name }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row of rows"
            :key="row.capability"
          >
            <th
              scope="row"
              class="font-mono text-xs font-normal text-highlighted"
            >
              {{ row.capability }}
            </th>
            <td
              v-for="(cell, index) of row.cells"
              :key="index"
              class="p-0"
            >
              <span class="flex justify-center">
                <CapabilityCell :level="cell.level" />
              </span>
              <span class="sr-only">{{ shortSupportLabels[cell.level] }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <CapabilityLegend
      :levels="['native', 'experimental', 'none']"
      class="mt-6 [&>ul]:justify-center"
    />
  </div>
</template>
