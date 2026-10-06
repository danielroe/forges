<script setup lang="ts">
import { providers as docsProviders } from '#capabilities'
import { kinds, providers } from '#events'

const columns = providers.map(provider => ({ ...provider, ...docsProviders.find(({ slug }) => slug === provider.slug)! }))

type Column = (typeof columns)[number]
type Cell = (typeof kinds)[number]['cells'][number]

function groupCells(cells: Cell[]) {
  const groups: Array<Cell & { key: string, providers: Column[] }> = []
  cells.forEach((cell, index) => {
    const provider = columns[index]!
    if (!cell.declared && !cell.subscribe.length) {
      return
    }
    const key = JSON.stringify([cell.declared, cell.actions, cell.subscribe, provider.subscriptions])
    const group = groups.find(group => group.key === key)
    if (group) {
      group.providers.push(provider)
    }
    else {
      groups.push({ ...cell, key, providers: [provider] })
    }
  })
  return groups
}

function subscribeNote(group: { providers: Column[] }) {
  return group.providers[0]!.subscriptions ? 'None' : 'Set up on the forge'
}

const cards = kinds.map(row => ({
  ...row,
  declared: row.cells.filter(cell => cell.declared).length,
  groups: groupCells(row.cells),
}))
</script>

<template>
  <div class="not-prose my-8 grid gap-4">
    <section
      v-for="card of cards"
      :id="`kind-${card.kind}`"
      :key="card.kind"
      class="scroll-mt-[calc(var(--ui-header-height)+1rem)] rounded-lg border border-default"
      :aria-labelledby="`kind-${card.kind}-title`"
    >
      <header class="flex items-center justify-between gap-3 border-b border-default px-4 py-2.5 font-mono text-xs">
        <h3
          :id="`kind-${card.kind}-title`"
          class="flex items-center gap-2 font-medium text-highlighted"
        >
          <span class="size-1.5 bg-primary" />
          {{ card.kind }}
        </h3>
        <span class="text-muted tabular-nums">
          {{ card.declared }}/{{ columns.length }}<span class="sr-only"> forges declare it</span>
        </span>
      </header>

      <div class="grid gap-x-6 gap-y-4 p-4 md:grid-cols-[13rem_1fr]">
        <div class="grid content-start gap-3">
          <dl
            v-for="shape of card.details"
            :key="shape.type"
            class="font-mono text-xs leading-5"
          >
            <dt class="text-muted">
              detail.type <span class="text-highlighted">'{{ shape.type }}'</span>
            </dt>
            <dd
              v-for="field of shape.fields"
              :key="field.name"
              class="pl-3"
            >
              <span class="text-default">{{ field.name }}</span><span
                v-if="field.optional"
                class="text-muted"
              >?</span><span class="text-muted">: {{ field.type }}</span>
            </dd>
            <dd
              v-if="!shape.fields.length"
              class="pl-3 text-muted"
            >
              No other fields
            </dd>
          </dl>
          <p
            v-if="!card.details.length"
            class="font-mono text-xs text-muted"
          >
            No <span class="text-default">detail</span>
          </p>
        </div>

        <div v-if="card.groups.length">
          <table class="w-full table-fixed text-left text-xs">
            <caption class="sr-only">
              Actions and native events for {{ card.kind }}, by forge
            </caption>
            <colgroup>
              <col class="w-32">
              <col>
              <col class="hidden w-[42%] sm:table-column">
            </colgroup>
            <thead class="text-muted">
              <tr>
                <th
                  scope="col"
                  class="pr-4 pb-1.5 font-medium"
                >
                  Forge
                </th>
                <th
                  scope="col"
                  class="pr-4 pb-1.5 font-medium"
                >
                  Actions
                </th>
                <th
                  scope="col"
                  class="hidden pb-1.5 font-medium sm:table-cell"
                >
                  Subscribes to
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="group of card.groups"
                :key="group.key"
                class="border-t border-default/60 align-top"
              >
                <th
                  scope="row"
                  class="py-1.5 pr-4 font-normal"
                >
                  <span class="grid gap-1">
                    <NuxtLink
                      v-for="provider of group.providers"
                      :key="provider.slug"
                      :to="provider.to"
                      class="inline-flex items-center gap-2 whitespace-nowrap text-highlighted hover:text-primary"
                    >
                      <UIcon
                        :name="provider.icon"
                        class="size-3.5 flex-none text-muted"
                      />
                      {{ provider.name }}
                      <UIcon
                        v-if="provider.eventKinds === 'heuristic'"
                        name="i-lucide-text-search"
                        class="size-3 flex-none text-muted"
                      />
                      <span
                        v-if="provider.eventKinds === 'heuristic'"
                        class="sr-only"
                      >(heuristic event kinds)</span>
                    </NuxtLink>
                  </span>
                </th>
                <td class="py-1.5 pr-4">
                  <span
                    v-if="group.actions.length"
                    class="flex flex-wrap gap-1"
                  >
                    <code
                      v-for="action of group.actions"
                      :key="action"
                      class="rounded bg-elevated px-1.5 font-mono text-[11px] leading-5 text-toned"
                    >{{ action }}</code>
                  </span>
                  <span
                    v-else-if="group.declared"
                    class="leading-5 text-toned"
                  >Any action</span>
                  <span
                    v-else
                    class="leading-5 text-muted"
                  >Not declared</span>
                  <span class="mt-1.5 flex flex-wrap gap-x-2.5 leading-5 sm:hidden">
                    <span class="text-muted">Subscribes to:</span>
                    <template v-if="group.subscribe.length">
                      <span
                        v-for="name of group.subscribe"
                        :key="name"
                        class="font-mono text-[11px] [overflow-wrap:anywhere] text-toned"
                      >{{ name }}</span>
                    </template>
                    <span
                      v-else
                      class="text-muted"
                    >{{ subscribeNote(group) }}</span>
                  </span>
                </td>
                <td class="hidden py-1.5 leading-5 sm:table-cell">
                  <span
                    v-if="group.subscribe.length"
                    class="flex flex-wrap gap-x-2.5 font-mono text-[11px] text-toned"
                  >
                    <span
                      v-for="name of group.subscribe"
                      :key="name"
                      class="[overflow-wrap:anywhere]"
                    >{{ name }}</span>
                  </span>
                  <span
                    v-else
                    class="text-muted"
                  >{{ subscribeNote(group) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-else
          class="text-xs text-muted"
        >
          No provider lists <code class="font-mono text-toned">{{ card.kind }}</code> in <code class="font-mono text-toned">webhooks.events</code>.
        </p>
      </div>
    </section>
  </div>
</template>
