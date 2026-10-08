<script setup lang="ts">
import { providers as allProviders, groups } from '#capabilities'

const props = defineProps<{
  /** Capability paths, separated by commas. */
  capabilities: string
  /** Provider slugs, separated by commas. */
  providers: string
}>()

const columns = props.providers.split(',').map((slug) => {
  const index = allProviders.findIndex(provider => provider.slug === slug.trim())
  if (index < 0) {
    throw new Error(`Unknown provider: ${slug}`)
  }
  return { index, provider: allProviders[index]! }
})

const rows = props.capabilities.split(',').map((capability) => {
  const row = groups.flatMap(group => group.rows).find(row => row.capability === capability.trim())
  if (!row) {
    throw new Error(`Unknown capability: ${capability}`)
  }
  return { capability: row.capability, cells: columns.map(({ index }) => row.cells[index]!) }
})
</script>

<template>
  <div
    class="not-prose my-6 overflow-x-auto rounded-lg border border-default"
    role="region"
    aria-label="Capability support"
  >
    <table
      role="table"
      class="interlaced-matrix w-full text-left text-xs"
      :style="{ '--matrix-columns': columns.length }"
    >
      <caption class="sr-only">
        Support for {{ rows.map(row => row.capability).join(', ') }}
      </caption>
      <thead
        role="rowgroup"
        class="bg-elevated/40 text-muted"
      >
        <tr role="row">
          <th
            scope="col"
            role="columnheader"
            class="px-4 py-2.5 font-normal max-lg:hidden"
          >
            <span class="sr-only">Capability</span>
          </th>
          <th
            v-for="{ provider } of columns"
            :key="provider.slug"
            scope="col"
            role="columnheader"
            class="px-2 py-2.5 font-normal lg:px-4"
          >
            <NuxtLink
              :to="provider.to"
              class="inline-flex items-center gap-2 text-highlighted hover:text-primary"
            >
              <UIcon
                :name="provider.icon"
                class="size-4 text-muted"
              />
              {{ provider.name }}
            </NuxtLink>
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        <tr
          v-for="row of rows"
          :key="row.capability"
          role="row"
          class="border-t border-default"
        >
          <th
            scope="row"
            role="rowheader"
            class="px-4 pt-2.5 font-mono font-normal whitespace-nowrap text-highlighted max-lg:px-2 lg:pb-2.5"
          >
            {{ row.capability }}
          </th>
          <td
            v-for="(cell, index) of row.cells"
            :key="index"
            role="cell"
            class="px-2 pt-1.5 pb-2.5 lg:px-4 lg:pt-2.5"
          >
            <span
              v-if="cell.kinds && cell.level !== 'none'"
              class="flex flex-wrap gap-x-2.5 gap-y-1"
            >
              <span
                v-for="kind of cell.kinds.filter(kind => kind.level !== 'none')"
                :key="kind.kind"
                class="inline-flex items-center gap-1.5 font-mono text-[11px] text-toned"
              >
                <CapabilityCell
                  :level="kind.level"
                  class="[--capability-cell-size:0.625rem]"
                />
                {{ kind.label }}
                <span class="sr-only">{{ shortSupportLabels[kind.level].toLowerCase() }}</span>
              </span>
            </span>
            <span
              v-else
              class="inline-flex items-center gap-2"
              :class="cell.level === 'none' ? 'text-muted' : 'text-toned'"
            >
              <CapabilityCell
                :level="cell.level"
                class="[--capability-cell-size:0.75rem]"
              />
              {{ shortSupportLabels[cell.level] }}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
