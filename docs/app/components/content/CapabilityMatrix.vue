<script setup lang="ts">
import type { CapabilityRow, SupportCell } from '#capabilities'
import { groups, providers } from '#capabilities'

const route = useRoute()
const filter = ref('')
const differing = ref(false)
const hoveredColumn = ref<number>()
const highlighted = computed(() => providers.findIndex(({ slug }) => slug === route.query.forge))

const rows = new Map(groups.flatMap(group => group.rows.map(row => [row.capability, row])))
const total = rows.size
const headerHeight = rotatedHeaderHeight(providers.map(provider => provider.name.length + (provider.experimental ? 2 : 0)))

function signature(cell: SupportCell) {
  return cell.kinds ? cell.kinds.map(kind => kind.level).join() : cell.level
}

const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  return groups
    .map(group => ({
      ...group,
      rows: group.rows.filter(row =>
        (!needle || row.capability.toLowerCase().includes(needle) || row.verbs.some(verb => verb.toLowerCase().includes(needle)))
        && (!differing.value || new Set(row.cells.map(signature)).size > 1)),
    }))
    .filter(group => group.rows.length)
})

const TIP_HALF_WIDTH = 128
const wrapper = useTemplateRef('wrapper')
const tip = ref<{ row: CapabilityRow, column: number, x: number, y: number }>()

function inspect(event: PointerEvent) {
  const target = (event.target as HTMLElement).closest<HTMLTableCellElement>('td, th')
  const column = target && target.cellIndex > 0 && target.colSpan === 1 ? target.cellIndex - 1 : undefined
  hoveredColumn.value = column
  const capability = target?.parentElement?.dataset.capability
  const row = capability ? rows.get(capability) : undefined
  if (!target || !row || column === undefined || !wrapper.value) {
    tip.value = undefined
    return
  }
  const box = target.getBoundingClientRect()
  const origin = wrapper.value.getBoundingClientRect()
  const x = Math.min(Math.max(box.left + box.width / 2 - origin.left, TIP_HALF_WIDTH), origin.width - TIP_HALF_WIDTH)
  tip.value = { row, column, x, y: box.top - origin.top }
}

function leave() {
  hoveredColumn.value = undefined
  tip.value = undefined
}

const status = computed(() => `${visible.value.reduce((count, group) => count + group.rows.length, 0)} of ${total} capabilities shown`)

function limits(values?: Record<string, number>) {
  return values ? Object.entries(values).map(([key, length]) => `${key.replace('Length', '')} ${length.toLocaleString('en')}`) : []
}
</script>

<template>
  <div class="not-prose my-8">
    <div class="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3">
      <UInput
        v-model="filter"
        icon="i-lucide-search"
        placeholder="Filter capabilities or verbs"
        aria-label="Filter capabilities or verbs"
        class="w-full sm:w-72"
        :ui="{ base: 'font-mono text-xs' }"
      />
      <USwitch
        v-model="differing"
        label="Only rows that differ"
        size="sm"
      />
      <p
        class="sr-only"
        role="status"
      >
        {{ status }}
      </p>
    </div>

    <CapabilityLegend
      kinds
      explain
      class="mb-2"
    >
      <li class="inline-flex items-center gap-2">
        <span
          class="capability-swatch size-2"
          data-level="experimental"
        />
        Experimental provider
      </li>
      <template #explain>
        <dt class="flex items-center gap-2 font-medium text-highlighted">
          <span
            class="capability-swatch ml-0.5 size-2"
            data-level="experimental"
          />
          Experimental provider
        </dt>
        <dd class="text-muted max-sm:mb-1.5">
          The whole provider is experimental: its tests use hand-written fixtures only, or the forge's API is unstable.
        </dd>
      </template>
    </CapabilityLegend>

    <div
      ref="wrapper"
      class="relative"
      @pointerover="inspect"
      @pointerleave="leave"
    >
      <div class="relative">
        <table
          role="table"
          class="capability-matrix interlaced-matrix w-full border-separate border-spacing-0 pr-12 lg:w-max lg:pr-16"
          :style="{ '--matrix-columns': providers.length }"
        >
          <caption class="sr-only">
            Support for each capability, by forge
          </caption>
          <colgroup>
            <col class="w-44 lg:w-56">
            <col
              v-for="(provider, index) of providers"
              :key="provider.slug"
              class="w-12 transition-colors"
              :class="{ 'bg-primary/8': index === hoveredColumn || index === highlighted }"
            >
          </colgroup>
          <thead
            role="rowgroup"
            class="sticky top-(--ui-header-height) z-10 bg-default"
          >
            <tr role="row">
              <th
                scope="col"
                role="columnheader"
              >
                <span class="sr-only">Capability</span>
              </th>
              <th
                v-for="(provider, index) of providers"
                :key="provider.slug"
                scope="col"
                role="columnheader"
                class="p-0 align-bottom"
              >
                <NuxtLink
                  :to="provider.to"
                  class="group relative flex flex-col items-center justify-end gap-2 pb-2 font-mono text-[11px] text-muted transition hover:text-highlighted lg:text-xs"
                  :class="{ 'text-highlighted': index === hoveredColumn || index === highlighted }"
                  :style="{ height: headerHeight }"
                >
                  <span class="absolute bottom-9 left-1/2 flex origin-bottom-left -rotate-45 items-center gap-1.5 whitespace-nowrap">
                    {{ provider.name }}
                    <span
                      v-if="provider.experimental"
                      class="capability-swatch size-2"
                      data-level="experimental"
                    />
                    <span
                      v-if="provider.experimental"
                      class="sr-only"
                    >(experimental provider)</span>
                  </span>
                  <UIcon
                    :name="provider.icon"
                    class="size-4"
                  />
                </NuxtLink>
              </th>
            </tr>
          </thead>

          <tbody
            v-for="group of visible"
            :key="group.name"
            role="rowgroup"
          >
            <tr role="row">
              <th
                :colspan="providers.length + 1"
                scope="rowgroup"
                role="rowheader"
                class="pt-6 pb-2 text-left"
              >
                <span class="flex items-center gap-2 font-mono text-xs font-medium text-highlighted">
                  <span class="size-1.5 bg-primary" />
                  {{ group.name }}
                  <span class="font-normal text-muted">{{ group.rows.length }}</span>
                </span>
              </th>
            </tr>
            <tr
              v-for="row of group.rows"
              :key="row.capability"
              :data-capability="row.capability"
              role="row"
            >
              <th
                scope="row"
                role="rowheader"
                class="pr-4 text-left font-mono text-xs font-normal whitespace-nowrap text-default"
              >
                <template v-if="row.capability.includes('.')">
                  <span class="text-muted">{{ group.name }}.</span>{{ row.capability.slice(group.name.length + 1) }}
                </template>
                <template v-else>
                  {{ row.capability }}
                </template>
                <span class="sr-only"> {{ describeRow(row) }}</span>
              </th>
              <td
                v-for="(cell, index) of row.cells"
                :key="index"
                role="cell"
              >
                <CapabilityCell v-bind="cell" /><span class="sr-only">{{ describeCell(cell) }}</span>
              </td>
            </tr>
          </tbody>

          <tbody
            v-if="!visible.length"
            role="rowgroup"
          >
            <tr role="row">
              <td
                role="cell"
                :colspan="providers.length + 1"
                class="py-10 text-center text-sm text-muted"
              >
                No capability matches “{{ filter }}”.
              </td>
            </tr>
          </tbody>

          <tfoot role="rowgroup">
            <tr role="row">
              <th
                scope="row"
                role="rowheader"
                class="pt-6 text-left align-bottom text-xs font-normal max-lg:pb-3 lg:pb-6"
              >
                <span class="block font-mono text-highlighted">Coverage</span>
                <span class="block text-muted">Native and verified, of {{ total }}</span>
              </th>
              <td
                v-for="provider of providers"
                :key="provider.slug"
                role="cell"
                class="text-center align-bottom lg:pt-6"
              >
                <span
                  class="mx-auto flex h-16 w-2.5 flex-col-reverse bg-elevated"
                  aria-hidden="true"
                >
                  <span
                    v-for="level of (['native', 'experimental', 'emulated'] as const)"
                    :key="level"
                    class="capability-swatch block w-full"
                    :data-level="level"
                    :style="{ height: `${provider.summary[level] / total * 100}%` }"
                  />
                </span>
                <span class="mt-1.5 block font-mono text-[11px] text-muted tabular-nums">{{ provider.summary.native }}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div
        v-if="tip"
        class="pointer-events-none absolute z-20 w-64 -translate-x-1/2 -translate-y-full rounded-md border border-default bg-default p-3 text-xs shadow-lg"
        :style="{ left: `${tip.x}px`, top: `${tip.y - 8}px` }"
        aria-hidden="true"
      >
        <div class="flex items-center gap-2 text-highlighted">
          <UIcon
            :name="providers[tip.column]!.icon"
            class="size-3.5"
          />
          <span class="font-medium">{{ providers[tip.column]!.name }}</span>
        </div>
        <div class="mt-1 font-mono text-muted">
          {{ tip.row.capability }}
        </div>

        <ul
          v-if="tip.row.cells[tip.column]!.kinds"
          class="mt-3 space-y-1.5"
        >
          <li
            v-for="kind of tip.row.cells[tip.column]!.kinds"
            :key="kind.kind"
            class="flex items-center gap-2"
          >
            <CapabilityCell
              :level="kind.level"
              class="[--capability-cell-size:0.75rem]"
            />
            <span class="w-20 font-mono text-toned">{{ kind.label }}</span>
            <span class="text-muted">{{ supportLabels[kind.level] }}</span>
          </li>
        </ul>
        <div
          v-else
          class="mt-3 flex items-center gap-2"
        >
          <CapabilityCell
            :level="tip.row.cells[tip.column]!.level"
            class="[--capability-cell-size:0.75rem]"
          />
          <span class="text-default">{{ supportLabels[tip.row.cells[tip.column]!.level] }}</span>
        </div>

        <div
          v-if="tip.row.verbs.length || tip.row.write || tip.row.account"
          class="mt-3 border-t border-default pt-2 text-muted"
        >
          <div
            v-if="tip.row.verbs.length"
            class="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px]"
          >
            <span
              v-for="verb of tip.row.verbs"
              :key="verb"
            >{{ verb }}()</span>
          </div>
          <div
            v-if="tip.row.write || tip.row.account"
            class="mt-1.5 flex gap-3"
          >
            <span
              v-if="tip.row.write"
              class="inline-flex items-center gap-1"
            >
              <UIcon
                name="i-lucide-pencil"
                class="size-3"
              />
              Changes state
            </span>
            <span
              v-if="tip.row.account"
              class="inline-flex items-center gap-1"
            >
              <UIcon
                name="i-lucide-user"
                class="size-3"
              />
              Needs an account
            </span>
          </div>
        </div>
      </div>
    </div>

    <h3 class="mt-14 mb-4 text-lg font-semibold text-highlighted">
      Authentication and limits
    </h3>
    <div
      class="overflow-x-auto rounded-md border border-default"
      tabindex="0"
      role="region"
      aria-label="Authentication and limits"
    >
      <table class="w-full text-left text-sm">
        <thead class="bg-elevated/50 text-xs text-muted">
          <tr>
            <th
              scope="col"
              class="px-4 py-2.5 font-medium"
            >
              Forge
            </th>
            <th
              scope="col"
              class="px-4 py-2.5 font-medium"
            >
              Auth
            </th>
            <th
              scope="col"
              class="px-4 py-2.5 font-medium"
            >
              Event kinds
            </th>
            <th
              scope="col"
              class="px-4 py-2.5 font-medium"
            >
              Text limits
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="provider of providers"
            :key="provider.slug"
            class="border-t border-default"
          >
            <th
              scope="row"
              class="px-4 py-2.5 font-normal whitespace-nowrap"
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
            <td class="px-4 py-2.5">
              <span class="flex flex-wrap gap-1">
                <UBadge
                  v-for="auth of provider.auth"
                  :key="auth"
                  :label="auth"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  class="font-mono"
                />
              </span>
            </td>
            <td class="px-4 py-2.5 font-mono text-xs text-muted">
              {{ provider.eventKinds }}
            </td>
            <td class="px-4 py-2.5 font-mono text-xs text-muted">
              <template v-if="provider.limits">
                <span
                  v-for="limit of limits(provider.limits)"
                  :key="limit"
                  class="block whitespace-nowrap"
                >{{ limit }}</span>
              </template>
              <span
                v-else
                class="text-muted"
              >Unknown</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <dl class="mt-3 grid gap-x-3 gap-y-1 text-xs text-muted sm:grid-cols-[auto_1fr]">
      <template
        v-for="(description, kind) of eventKindDescriptions"
        :key="kind"
      >
        <dt class="font-mono text-toned">
          {{ kind }}
        </dt>
        <dd class="max-sm:mb-1.5">
          {{ description }}
        </dd>
      </template>
    </dl>
  </div>
</template>

<style>
.capability-matrix tr[data-capability] > * {
  border-top: 1px solid color-mix(in oklab, var(--ui-border) 60%, transparent);
  padding-block: 0.25rem;
}

.capability-matrix tr[data-capability] > td {
  text-align: center;
}

.capability-matrix tr[data-capability]:hover > * {
  background: var(--ui-bg-elevated);
}

.capability-matrix td > .capability-cell {
  vertical-align: middle;
}

@media (width < 64rem) {
  .capability-matrix tr[data-capability] > th {
    padding-top: 0.5rem;
  }

  .capability-matrix tr[data-capability] > td {
    border-top: 0;
    padding-block: 0.125rem 0.5rem;
  }
}
</style>
