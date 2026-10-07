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

const sections = groups.map(group => ({
  name: group.name,
  rows: group.rows.map(row => ({
    capability: row.capability,
    name: row.capability.includes('.') ? row.capability.slice(group.name.length + 1) : row.capability,
    cell: row.cells[index]!,
  })),
}))
const available = sections.filter(section => section.rows.some(row => row.cell.level !== 'none'))
const unavailable = sections.filter(section => !available.includes(section))

const heights = available.map(section => section.rows.length + 2)
const half = heights.reduce((sum, height) => sum + height, 0) / 2
let split = 0
for (let height = 0; split < heights.length && height + heights[split]! / 2 < half; split++) {
  height += heights[split]!
}
const columns = [{ sections: available.slice(0, split) }, { sections: available.slice(split) }]

const limits = provider.limits ? Object.entries(provider.limits).map(([key, length]) => ({ key: key.replace('Length', ''), length: length.toLocaleString('en') })) : []
</script>

<template>
  <div class="not-prose my-6">
    <div class="rounded-lg border border-default p-4 sm:p-5">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <p class="text-sm text-muted">
          <span class="text-3xl font-semibold text-highlighted tabular-nums">{{ provider.summary.native }}</span>
          of {{ total }} capabilities native and verified
        </p>
        <UButton
          :to="{ path: '/reference/capability-matrix', query: { forge: provider.slug } }"
          variant="ghost"
          color="neutral"
          size="sm"
          trailing-icon="i-lucide-arrow-right"
        >
          Compare forges
        </UButton>
      </div>

      <div
        class="mt-4 flex h-2 gap-px overflow-hidden bg-elevated"
        role="img"
        :aria-label="supportLevels.map(level => `${provider!.summary[level]} ${supportLabels[level].toLowerCase()}`).join(', ')"
      >
        <span
          v-for="level of supportLevels"
          :key="level"
          class="capability-swatch"
          :data-level="level"
          :style="{ width: `${provider.summary[level] / total * 100}%` }"
        />
      </div>

      <ul class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <li
          v-for="level of supportLevels"
          :key="level"
          class="inline-flex items-center gap-2"
        >
          <CapabilityCell
            :level="level"
            class="[--capability-cell-size:0.625rem]"
          />
          {{ supportLabels[level] }}
          <span class="font-mono text-toned tabular-nums">{{ provider.summary[level] }}</span>
        </li>
      </ul>

      <CapabilityLegend
        :levels="[]"
        explain
        class="mt-3"
      />

      <dl class="mt-5 grid gap-4 border-t border-default pt-4 text-xs sm:grid-cols-3">
        <div>
          <dt class="text-muted">
            Auth
          </dt>
          <dd class="mt-1.5 flex flex-wrap gap-1">
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
        <div>
          <dt class="text-muted">
            Event kinds
          </dt>
          <dd class="mt-1.5 font-mono text-default">
            {{ provider.eventKinds }}
          </dd>
          <dd class="mt-1 text-muted">
            {{ eventKindDescriptions[provider.eventKinds] }}
          </dd>
        </div>
        <div>
          <dt class="text-muted">
            Text limits
          </dt>
          <dd class="mt-1.5 font-mono text-default">
            <template v-if="limits.length">
              <span
                v-for="limit of limits"
                :key="limit.key"
                class="block"
              ><span class="text-muted">{{ limit.key }}</span> {{ limit.length }}</span>
            </template>
            <span
              v-else
              class="text-muted"
            >Unknown</span>
          </dd>
        </div>
      </dl>
    </div>

    <div class="mt-6 grid items-start gap-4 sm:grid-cols-2">
      <div
        v-for="(column, columnIndex) of columns"
        :key="columnIndex"
        class="grid gap-4"
      >
        <section
          v-for="section of column.sections"
          :key="section.name"
          class="rounded-lg border border-default"
          :aria-label="section.name"
        >
          <header class="flex items-center justify-between border-b border-default px-4 py-2.5 font-mono text-xs">
            <span class="flex items-center gap-2 font-medium text-highlighted">
              <span class="size-1.5 bg-primary" />
              {{ section.name }}
            </span>
            <span class="text-muted tabular-nums">
              {{ section.rows.filter(row => row.cell.level !== 'none').length }}/{{ section.rows.length }}
            </span>
          </header>
          <ul class="divide-y divide-default/60">
            <li
              v-for="row of section.rows"
              :key="row.capability"
              class="flex items-center justify-between gap-3 px-4 py-1.5 text-xs"
            >
              <span
                class="font-mono"
                :class="row.cell.level === 'none' ? 'text-muted' : 'text-highlighted'"
              >{{ row.name }}</span>
              <span
                v-if="row.cell.kinds && row.cell.level !== 'none'"
                class="flex flex-wrap justify-end gap-x-2.5 gap-y-1"
              >
                <span
                  v-for="kind of row.cell.kinds.filter(kind => kind.level !== 'none')"
                  :key="kind.kind"
                  class="inline-flex items-center gap-1.5 font-mono text-[11px] text-toned"
                >
                  <CapabilityCell
                    :level="kind.level"
                    class="[--capability-cell-size:0.625rem]"
                  />
                  {{ kind.label }}
                  <span class="sr-only">({{ supportLabels[kind.level].toLowerCase() }})</span>
                </span>
              </span>
              <span
                v-else
                class="inline-flex items-center gap-1.5"
                :class="row.cell.level === 'none' ? 'text-muted' : 'text-toned'"
              >
                <CapabilityCell
                  :level="row.cell.level"
                  class="[--capability-cell-size:0.625rem]"
                />
                {{ shortSupportLabels[row.cell.level] }}
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <p
      v-if="unavailable.length"
      class="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
    >
      <span>Not available:</span>
      <code
        v-for="section of unavailable"
        :key="section.name"
        class="rounded bg-elevated px-1.5 py-0.5 font-mono text-muted"
      >{{ section.name }}</code>
    </p>
  </div>
</template>
