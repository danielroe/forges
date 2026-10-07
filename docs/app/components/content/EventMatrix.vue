<script setup lang="ts">
import { providers as docsProviders } from '#capabilities'
import { kinds, providers, withoutWebhooks } from '#events'

const columns = providers.map(provider => ({ ...provider, ...docsProviders.find(({ slug }) => slug === provider.slug)! }))
const heuristic = columns.filter(provider => provider.eventKinds === 'heuristic')
const declaredKinds = kinds.filter(row => row.cells.some(cell => cell.declared))
const undeclaredKinds = kinds.filter(row => !declaredKinds.includes(row))
const headerHeight = rotatedHeaderHeight(columns.map(provider => provider.name.length + (provider.eventKinds === 'heuristic' ? 2 : 0)))
const totals = columns.map((_, index) => declaredKinds.filter(row => row.cells[index]!.declared).length)

type Row = (typeof kinds)[number]
type Cell = Row['cells'][number]

function squares(row: Row, cell: Cell) {
  if (row.actions.length < 2 || !cell.actions.length) {
    return undefined
  }
  return row.actions.map(action => ({ kind: action, label: action, level: cell.actions.includes(action) ? 'native' : 'none' }))
}

function grid(count: number) {
  return { gridTemplateColumns: `repeat(${count <= 3 ? count : Math.ceil(count / 2)}, 1fr)` }
}

function describe(cell: Cell) {
  const support = cell.declared ? cell.actions.join(', ') || 'Any action' : 'Not declared'
  return cell.subscribe.length ? `${support}. Subscribes to ${cell.subscribe.join(', ')}.` : support
}

const TIP_HALF_WIDTH = 128
const wrapper = useTemplateRef('wrapper')
const hoveredColumn = ref<number>()
const tip = ref<{ row: Row, column: number, x: number, y: number }>()

function inspect(event: PointerEvent) {
  const target = (event.target as HTMLElement).closest<HTMLTableCellElement>('td, th')
  const column = target && target.cellIndex > 0 && target.colSpan === 1 ? target.cellIndex - 1 : undefined
  hoveredColumn.value = column
  const kind = target?.parentElement?.dataset.kind
  const row = kind ? kinds.find(row => row.kind === kind) : undefined
  if (!target || target.tagName !== 'TD' || !row || column === undefined || !wrapper.value) {
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
</script>

<template>
  <div class="not-prose my-8">
    <ul class="mb-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
      <li class="inline-flex items-center gap-2">
        <CapabilityCell level="native" />
        Declared in <code class="font-mono text-toned">webhooks.events</code>
      </li>
      <li class="inline-flex items-center gap-2">
        <CapabilityCell level="none" />
        Not declared
      </li>
      <li class="inline-flex items-center gap-2">
        <span
          class="capability-cell capability-kinds"
          :style="grid(3)"
          aria-hidden="true"
        >
          <span
            v-for="(level, index) of ['native', 'native', 'none']"
            :key="index"
            class="capability-swatch"
            :data-level="level"
          />
        </span>
        One square per action
      </li>
      <li
        v-if="heuristic.length"
        class="inline-flex items-center gap-2"
      >
        <UIcon
          name="i-lucide-text-search"
          class="size-3.5 text-toned"
        />
        Heuristic event kinds
      </li>
      <li class="inline-flex items-center gap-2">
        <UIcon
          name="i-lucide-refresh-cw"
          class="size-3.5 text-toned"
        />
        Also polls
      </li>
      <li class="inline-flex items-center gap-2">
        <UIcon
          name="i-lucide-radio"
          class="size-3.5 text-toned"
        />
        Also subscribes
      </li>
    </ul>

    <div
      ref="wrapper"
      class="relative"
      @pointerover="inspect"
      @pointerleave="leave"
    >
      <div class="relative">
        <table
          role="table"
          class="event-matrix interlaced-matrix w-full border-separate border-spacing-0 pr-12 lg:w-max lg:pr-16"
          :style="{ '--matrix-columns': columns.length }"
        >
          <caption class="sr-only">
            Webhook event kinds and actions, by forge
          </caption>
          <colgroup>
            <col class="w-36 lg:w-44">
            <col
              v-for="(provider, index) of columns"
              :key="provider.slug"
              class="w-12 transition-colors"
              :class="{ 'bg-primary/8': index === hoveredColumn }"
            >
          </colgroup>
          <thead
            role="rowgroup"
            class="sticky top-(--ui-header-height) z-10 sticky-matrix-head"
          >
            <tr role="row">
              <th
                scope="col"
                role="columnheader"
              >
                <span class="sr-only">Kind</span>
              </th>
              <th
                v-for="(provider, index) of columns"
                :key="provider.slug"
                scope="col"
                role="columnheader"
                class="p-0 align-bottom"
              >
                <NuxtLink
                  :to="provider.to"
                  class="group relative flex flex-col items-center justify-end gap-2 pb-2 font-mono text-[11px] text-muted transition hover:text-highlighted lg:text-xs"
                  :class="{ 'text-highlighted': index === hoveredColumn }"
                  :style="{ height: headerHeight }"
                >
                  <span class="absolute bottom-9 left-1/2 flex origin-bottom-left -rotate-45 items-center gap-1.5 whitespace-nowrap">
                    {{ provider.name }}
                    <UIcon
                      v-if="provider.eventKinds === 'heuristic'"
                      name="i-lucide-text-search"
                      class="size-3"
                    />
                    <span
                      v-if="provider.eventKinds === 'heuristic'"
                      class="sr-only"
                    >(heuristic event kinds)</span>
                  </span>
                  <UIcon
                    :name="provider.icon"
                    class="size-4"
                  />
                </NuxtLink>
              </th>
            </tr>
          </thead>

          <tbody role="rowgroup">
            <tr
              v-for="row of declaredKinds"
              :key="row.kind"
              :data-kind="row.kind"
              role="row"
            >
              <th
                scope="row"
                role="rowheader"
                class="pr-4 text-left font-mono text-xs font-normal whitespace-nowrap"
              >
                <a
                  :href="`#kind-${row.kind}`"
                  class="text-default hover:text-primary"
                >{{ row.kind }}</a>
              </th>
              <td
                v-for="(cell, index) of row.cells"
                :key="index"
                role="cell"
              >
                <CapabilityCell
                  v-if="squares(row, cell)"
                  level="native"
                  :kinds="squares(row, cell)"
                  :style="grid(row.actions.length)"
                />
                <CapabilityCell
                  v-else
                  :level="cell.declared ? 'native' : 'none'"
                /><span class="sr-only">{{ describe(cell) }}</span>
              </td>
            </tr>
          </tbody>

          <tfoot role="rowgroup">
            <tr role="row">
              <th
                scope="row"
                role="rowheader"
                class="pt-4 text-left text-xs font-normal max-lg:pb-1"
              >
                <span class="block font-mono text-highlighted">Kinds</span>
                <span class="block text-muted">Declared, of {{ declaredKinds.length }}</span>
              </th>
              <td
                v-for="(total, index) of totals"
                :key="index"
                role="cell"
                class="text-center lg:pt-4 font-mono text-[11px] text-muted tabular-nums"
              >
                {{ total }}
              </td>
            </tr>
            <tr role="row">
              <th
                scope="row"
                role="rowheader"
                class="pt-3 text-left text-xs font-normal max-lg:pb-1 lg:pb-4"
              >
                <span class="block font-mono text-highlighted">Other sources</span>
                <span class="block text-muted">Poll, subscribe</span>
              </th>
              <td
                v-for="provider of columns"
                :key="provider.slug"
                role="cell"
                class="pb-4 text-center align-top lg:pt-3"
              >
                <span class="inline-flex flex-col items-center gap-1 text-toned">
                  <UIcon
                    v-if="provider.poll"
                    name="i-lucide-refresh-cw"
                    class="size-3.5"
                  />
                  <span
                    v-if="provider.poll"
                    class="sr-only"
                  >Poll</span>
                  <UIcon
                    v-if="provider.subscribe"
                    name="i-lucide-radio"
                    class="size-3.5"
                  />
                  <span
                    v-if="provider.subscribe"
                    class="sr-only"
                  >Subscribe</span>
                  <span
                    v-if="!provider.poll && !provider.subscribe"
                    class="text-muted"
                  >
                    <span aria-hidden="true">·</span>
                    <span class="sr-only">Webhooks only</span>
                  </span>
                </span>
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
            :name="columns[tip.column]!.icon"
            class="size-3.5"
          />
          <span class="font-medium">{{ columns[tip.column]!.name }}</span>
        </div>
        <div class="mt-1 font-mono text-muted">
          {{ tip.row.kind }}
        </div>

        <ul
          v-if="tip.row.cells[tip.column]!.actions.length"
          class="mt-3 space-y-1.5"
        >
          <li
            v-for="action of tip.row.actions"
            :key="action"
            class="flex items-center gap-2"
          >
            <CapabilityCell
              :level="tip.row.cells[tip.column]!.actions.includes(action) ? 'native' : 'none'"
              class="[--capability-cell-size:0.75rem]"
            />
            <span
              class="font-mono"
              :class="tip.row.cells[tip.column]!.actions.includes(action) ? 'text-toned' : 'text-muted line-through'"
            >{{ action }}</span>
          </li>
        </ul>
        <div
          v-else
          class="mt-3 flex items-center gap-2"
        >
          <CapabilityCell
            :level="tip.row.cells[tip.column]!.declared ? 'native' : 'none'"
            class="[--capability-cell-size:0.75rem]"
          />
          <span class="text-default">{{ tip.row.cells[tip.column]!.declared ? 'Declared without an action' : 'Not declared' }}</span>
        </div>

        <div
          v-if="tip.row.cells[tip.column]!.subscribe.length"
          class="mt-3 border-t border-default pt-2 text-muted"
        >
          <div>Subscribes to</div>
          <div class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-toned">
            <span
              v-for="name of tip.row.cells[tip.column]!.subscribe"
              :key="name"
            >{{ name }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-6 grid gap-3 text-sm sm:grid-cols-2">
      <div
        v-if="undeclaredKinds.length"
        class="rounded-lg border border-default p-4"
      >
        <p class="flex items-center gap-2 font-mono text-xs font-medium text-highlighted">
          <span class="size-1.5 bg-primary" />
          Not in any webhook list
        </p>
        <p class="mt-2 flex flex-wrap gap-1.5">
          <a
            v-for="row of undeclaredKinds"
            :key="row.kind"
            :href="`#kind-${row.kind}`"
            class="rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-toned hover:text-primary"
          >{{ row.kind }}</a>
        </p>
        <p
          v-if="withoutWebhooks.length"
          class="mt-3 text-xs text-muted"
        >
          {{ withoutWebhooks.join(', ') }} {{ withoutWebhooks.length > 1 ? 'receive' : 'receives' }} no webhooks and {{ withoutWebhooks.length > 1 ? 'are' : 'is' }} not shown.
        </p>
      </div>
      <div
        v-for="provider of heuristic"
        :key="provider.slug"
        class="rounded-lg border border-default p-4"
      >
        <p class="flex items-center gap-2 text-xs font-medium text-highlighted">
          <UIcon
            name="i-lucide-text-search"
            class="size-3.5"
          />
          {{ provider.name }} reports <code class="font-mono">eventKinds: 'heuristic'</code>
        </p>
        <p class="mt-2 text-xs text-muted">
          Some kinds come from free text rather than a field the forge sets, so <code class="font-mono text-toned">kind</code> can be <code class="font-mono text-toned">other</code> for wording the provider doesn't recognise. <code class="font-mono text-toned">kindRaw</code> and <code class="font-mono text-toned">payload</code> stay exact.
        </p>
        <p class="mt-2 text-xs text-muted">
          The other forges report <code class="font-mono text-toned">eventKinds: 'native'</code>: the forge itself says what kind of change each event is.
        </p>
      </div>
    </div>
  </div>
</template>

<style>
.event-matrix tbody tr > * {
  border-top: 1px solid color-mix(in oklab, var(--ui-border) 60%, transparent);
  padding-block: 0.375rem;
}

.event-matrix tbody td {
  text-align: center;
}

.event-matrix tbody tr:hover > * {
  background: var(--ui-bg-elevated);
}

.event-matrix td > .capability-cell {
  vertical-align: middle;
}

@media (width < 64rem) {
  .event-matrix tbody th {
    padding-block: 0.5rem 0;
  }

  .event-matrix tbody td {
    border-top: 0;
    padding-block: 0.125rem 0.5rem;
  }
}
</style>
