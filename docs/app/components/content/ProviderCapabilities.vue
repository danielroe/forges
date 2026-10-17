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

const total = applicableTotal(provider)
/** The bar shows what a forge does with the capabilities that apply to it, so it leaves out `not_applicable`. */
const barLevels = supportLevels.filter(level => level !== 'not_applicable')
const view = useCredentialView()
const anonymous = computed({
  get: () => view.value === 'anonymous',
  set: (value) => {
    view.value = value ? 'anonymous' : undefined
  },
})
const credential = computed(() => provider.credentials?.find(({ id }) => id === view.value))
const views = provider.credentials && [
  { label: 'Any credential', value: 'any' },
  ...provider.credentials.map(({ id, label }) => ({ label, value: id })),
  { label: 'Without credentials', value: 'anonymous' },
]
const selectedView = computed({
  get: () => anonymous.value ? 'anonymous' : credential.value?.id ?? 'any',
  set: (value: string) => {
    view.value = value === 'any' ? undefined : value
  },
})
const usual = provider.credentials?.filter(({ usual }) => usual).map(({ id }) => id) ?? []
const viewText = computed(() => anonymous.value ? ' without credentials' : credential.value ? ` with ${credentialNames([credential.value.id], provider)}` : '')
const summary = computed(() => summaryFor(provider, view.value))

const sections = computed(() => groups.map(group => ({
  name: group.name,
  rows: group.rows.map(row => ({
    capability: row.capability,
    name: row.capability.includes('.') ? row.capability.slice(group.name.length + 1) : row.capability,
    cell: cellsFor(row, view.value)[index]!,
  })),
})))
const available = computed(() => sections.value.filter(section => section.rows.some(row => isAvailable(row.cell.level))))
const unavailable = computed(() => sections.value.filter(section => !available.value.includes(section)))

const columns = computed(() => {
  const heights = available.value.map(section => section.rows.length + 2)
  const half = heights.reduce((sum, height) => sum + height, 0) / 2
  let split = 0
  for (let height = 0; split < heights.length && height + heights[split]! / 2 < half; split++) {
    height += heights[split]!
  }
  return [{ sections: available.value.slice(0, split) }, { sections: available.value.slice(split) }]
})

const limits = provider.limits ? Object.entries(provider.limits).map(([key, length]) => ({ key: key.replace('Length', ''), length: length.toLocaleString('en') })) : []
</script>

<template>
  <div class="not-prose my-6">
    <div class="rounded-lg border border-default p-4 sm:p-5">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <p class="text-sm text-muted">
          <span class="text-3xl font-semibold text-highlighted tabular-nums">{{ summary.native }}</span>
          of {{ total }} capabilities native and verified{{ viewText }}
        </p>
        <USwitch
          v-if="!views"
          v-model="anonymous"
          label="Without credentials"
          size="sm"
        />
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
        v-if="views"
        class="mt-4"
      >
        <UTabs
          v-model="selectedView"
          :items="views"
          :content="false"
          size="xs"
          variant="pill"
          aria-label="Credential"
          class="w-full overflow-x-auto"
        />
        <p
          v-if="credential"
          class="mt-2 text-xs text-muted"
          v-html="stepHtml(`${credential.description}.`)"
        />
        <p
          v-else-if="!anonymous"
          class="mt-2 inline-flex flex-wrap items-center gap-1.5 text-xs text-muted"
        >
          <span>Unmarked rows work with {{ credentialNames(usual, provider) }}. Rows marked</span>
          <CapabilityCell
            level="native"
            :credentials="['']"
            class="[--capability-cell-size:0.625rem]"
          />
          <span>name the credentials that have them.</span>
        </p>
      </div>

      <div
        class="mt-4 flex h-2 gap-px overflow-hidden bg-elevated"
        role="img"
        :aria-label="supportLevels.map(level => `${summary[level]} ${supportLabels[level].toLowerCase()}`).join(', ')"
      >
        <span
          v-for="level of barLevels"
          :key="level"
          class="capability-swatch"
          :data-level="level"
          :style="{ width: `${summary[level] / total * 100}%` }"
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
          <span class="font-mono text-toned tabular-nums">{{ summary[level] }}</span>
        </li>
      </ul>

      <CapabilityLegend
        :levels="[]"
        :credentials="!!provider.credentials && !view"
        explain
        class="mt-3 [--capability-cell-size:0.625rem]"
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
              {{ section.rows.filter(row => isAvailable(row.cell.level)).length }}/{{ section.rows.length }}
            </span>
          </header>
          <ul class="divide-y divide-default/60">
            <li
              v-for="row of section.rows"
              :key="row.capability"
              class="flex items-center justify-between gap-3 px-4 py-1.5 text-xs"
            >
              <span class="min-w-0">
                <span
                  class="block font-mono"
                  :class="isAvailable(row.cell.level) ? 'text-highlighted' : 'text-muted'"
                >{{ row.name }}</span>
                <span
                  v-if="row.cell.credentials"
                  class="mt-0.5 flex items-center gap-1 text-[11px] text-muted"
                >
                  <UIcon
                    name="i-lucide-key-round"
                    class="size-3 shrink-0"
                  />
                  Only with {{ credentialNames(row.cell.credentials, provider) }}
                </span>
              </span>
              <span
                v-if="row.cell.kinds && isAvailable(row.cell.level)"
                class="flex flex-wrap justify-end gap-x-2.5 gap-y-1"
              >
                <span
                  v-for="kind of row.cell.kinds.filter(kind => isAvailable(kind.level))"
                  :key="kind.kind"
                  class="inline-flex items-center gap-1.5 font-mono text-[11px] text-toned"
                >
                  <CapabilityCell
                    :level="kind.level"
                    :credentials="row.cell.credentials"
                    class="[--capability-cell-size:0.625rem]"
                  />
                  {{ kind.label }}
                  <span class="sr-only">({{ supportLabels[kind.level].toLowerCase() }})</span>
                </span>
              </span>
              <span
                v-else
                class="inline-flex items-center gap-1.5"
                :class="isAvailable(row.cell.level) ? 'text-toned' : 'text-muted'"
              >
                <CapabilityCell
                  :level="row.cell.level"
                  :credentials="row.cell.credentials"
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
