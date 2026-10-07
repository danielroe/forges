<script setup lang="ts">
import { groups, providers } from '#capabilities'
import { anonymousStep, credentialSteps, envStep, forgeSteps, requirements, tasks } from '#credentials'

type Level = 'native' | 'experimental' | 'emulated' | 'none'

interface Option {
  id: string
  label: string
  fields: string[]
  optional: Array<{ field: string, unlocks: string[] }>
  unavailable: string[]
  anonymous?: boolean
}

const rows = new Map(groups.flatMap(group => group.rows.map(row => [row.capability, row])))
const taskGroups = [...new Set(tasks.map(task => task.group))].map(name => ({ name, tasks: tasks.filter(task => task.group === name) }))

const id = useId()
const slug = ref('github')
const selected = ref<string[]>(['threads'])
const chosen = ref<string>()

const index = computed(() => providers.findIndex(provider => provider.slug === slug.value))
const provider = computed(() => providers[index.value]!)
const forge = computed(() => requirements.find(forge => forge.slug === slug.value)!)

function cellOf(capability: string) {
  return rows.get(capability)!.cells[index.value]!
}

function taskLevel(capabilities: string[]): Level {
  const levels = capabilities.map(capability => cellOf(capability).level)
  if (levels.every(level => level === 'none')) {
    return 'none'
  }
  return (['experimental', 'emulated'] as const).find(level => levels.includes(level)) ?? 'native'
}

const selectedTasks = computed(() => tasks.filter(task => selected.value.includes(task.id)))
const capabilities = computed(() => selectedTasks.value.flatMap(task => task.capabilities))

const options = computed<Option[]>(() => [
  ...forge.value.credentials.map(set => ({ id: set.fields[0]!.toLowerCase(), label: credentialLabel(set.fields), ...set })),
  ...forge.value.anonymous.with.includes('ENABLED')
    ? [{ id: 'anonymous', label: 'Anonymous', fields: [], optional: [], unavailable: forge.value.anonymous.unavailable, anonymous: true }]
    : [],
])

function gaps(option: Option) {
  return capabilities.value.filter(capability => option.unavailable.includes(capability))
}

const option = computed(() => {
  const chosenOption = options.value.find(option => option.id === chosen.value)
  if (chosenOption) {
    return chosenOption
  }
  const anonymous = options.value.find(option => option.anonymous)
  if (forge.value.anonymous.default && anonymous && !gaps(anonymous).length) {
    return anonymous
  }
  return options.value.find(option => !option.anonymous && !gaps(option).length) ?? options.value[0]!
})

function placeholder(field: string) {
  if (field === 'PRIVATE_KEY') {
    return '"-----BEGIN PRIVATE KEY-----\\n..."'
  }
  return field === 'PDS' || field.endsWith('_URL') ? 'https://...' : '...'
}

const lines = computed(() => {
  const current = option.value
  const writes = capabilities.value.some(capability => rows.get(capability)?.write)
  const entries: Array<{ field: string, value: string, optional?: boolean }> = [
    ...forge.value.required.map(field => ({ field, value: placeholder(field) })),
    ...current.fields.map(field => ({ field, value: placeholder(field) })),
    ...current.optional.map(({ field, unlocks }) => ({ field, value: placeholder(field), optional: !unlocks.some(capability => capabilities.value.includes(capability)) })),
    ...current.anonymous ? [{ field: 'ENABLED', value: '1' }] : [],
    ...[...new Set(selectedTasks.value.flatMap(task => task.fields ?? []))].map(field => ({ field, value: '...' })),
    ...!current.anonymous && selectedTasks.value.length && !writes ? [{ field: 'READ_ONLY', value: '1' }] : [],
  ]
  return entries.map(entry => ({ ...entry, name: `FORGES_${forge.value.kind}_${entry.field}` }))
})

const dotenv = computed(() => lines.value.map(line => `${line.optional ? '# ' : ''}${line.name}=${line.value}`).join('\n'))

const scopes = computed(() => mergeScopes(selectedTasks.value.flatMap(task => forge.value.scopes[task.id] ?? [])))
const app = computed(() => option.value.fields.includes('APP_ID'))

const support = computed(() => selectedTasks.value
  .map(task => ({
    ...task,
    levels: taskLevel(task.capabilities) === 'none'
      ? [{ level: 'none' as Level, capabilities: [] }]
      : (['experimental', 'emulated', 'none'] as const)
          .map(level => ({ level, capabilities: task.capabilities.filter(capability => cellOf(capability).level === level) }))
          .filter(entry => entry.capabilities.length),
  }))
  .filter(task => task.levels.length))
const missing = computed(() => gaps(option.value))
const alternatives = computed(() => options.value.filter(other => other !== option.value && !other.anonymous && !gaps(other).length))

const steps = computed(() => [
  ...option.value.anonymous
    ? [anonymousStep]
    : credentialSteps[slug.value]?.[option.value.fields.join('+')] ?? [],
  ...forgeSteps[slug.value] ? [forgeSteps[slug.value]!] : [],
  envStep,
])

const route = useRoute()
const ready = ref(false)

watch(slug, () => {
  chosen.value = undefined
})

watch([slug, selected, chosen], () => {
  if (!ready.value) {
    return
  }
  const url = new URL(window.location.href)
  url.searchParams.set('forge', slug.value)
  url.searchParams.set('tasks', selected.value.join(','))
  if (chosen.value) {
    url.searchParams.set('auth', chosen.value)
  }
  else {
    url.searchParams.delete('auth')
  }
  // `router.replace()` would scroll back to the URL's hash on every change.
  window.history.replaceState(window.history.state, '', url)
}, { deep: true })

onMounted(async () => {
  const { forge: forgeQuery, tasks: tasksQuery, auth } = route.query
  if (typeof forgeQuery === 'string' && providers.some(provider => provider.slug === forgeQuery)) {
    slug.value = forgeQuery
  }
  if (typeof tasksQuery === 'string') {
    selected.value = tasksQuery.split(',').filter(task => tasks.some(({ id }) => id === task))
  }
  await nextTick()
  if (typeof auth === 'string') {
    chosen.value = auth
  }
  await nextTick()
  ready.value = true
})

const { copied, copy, message: copyMessage } = useCopyToClipboard(() => `${dotenv.value}\n`)
</script>

<template>
  <div class="not-prose my-6 rounded-lg border border-default">
    <div class="grid gap-5 p-4 sm:p-5">
      <fieldset>
        <legend class="mb-2.5 flex items-center gap-2 font-mono text-xs font-medium text-highlighted">
          <span class="size-1.5 bg-primary" />
          Forge
        </legend>
        <div class="flex flex-wrap gap-1.5">
          <label
            v-for="item of providers"
            :key="item.slug"
            class="inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary"
            :class="item.slug === slug ? 'border-primary bg-primary/10 text-highlighted' : 'border-default text-muted hover:border-accented hover:text-highlighted'"
          >
            <input
              v-model="slug"
              type="radio"
              :name="`${id}-forge`"
              :value="item.slug"
              class="sr-only"
            >
            <UIcon
              :name="item.icon"
              class="size-4"
            />
            {{ item.name }}
            <UIcon
              v-if="item.slug === slug"
              name="i-lucide-check"
              class="size-3.5"
            />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend class="mb-2.5 flex items-center gap-2 font-mono text-xs font-medium text-highlighted">
          <span class="size-1.5 bg-primary" />
          What you want to do
        </legend>
        <div class="grid gap-3">
          <div
            v-for="(group, position) of taskGroups"
            :key="group.name"
            role="group"
            :aria-labelledby="`${id}-group-${position}`"
            class="grid gap-1.5 sm:grid-cols-[6.5rem_1fr]"
          >
            <span
              :id="`${id}-group-${position}`"
              class="pt-1 text-xs text-muted"
            >{{ group.name }}</span>
            <div class="flex flex-wrap gap-1.5">
              <label
                v-for="task of group.tasks"
                :key="task.id"
                class="inline-flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-xs transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary"
                :class="selected.includes(task.id) ? 'border-primary bg-primary/10 text-highlighted' : 'border-default text-default hover:border-accented hover:text-highlighted'"
              >
                <input
                  v-model="selected"
                  type="checkbox"
                  :value="task.id"
                  class="sr-only"
                >
                <span
                  class="flex size-3.5 items-center justify-center rounded-sm border"
                  :class="selected.includes(task.id) ? 'border-primary bg-primary text-inverted' : 'border-accented'"
                  aria-hidden="true"
                >
                  <UIcon
                    v-if="selected.includes(task.id)"
                    name="i-lucide-check"
                    class="size-3"
                  />
                </span>
                <span :class="{ 'text-muted line-through decoration-1': taskLevel(task.capabilities) === 'none' }">{{ task.label }}</span>
                <CapabilityCell
                  v-if="taskLevel(task.capabilities) !== 'native'"
                  :level="taskLevel(task.capabilities)"
                  class="[--capability-cell-size:0.5rem]"
                />
                <span
                  v-if="taskLevel(task.capabilities) !== 'native'"
                  class="sr-only"
                >({{ shortSupportLabels[taskLevel(task.capabilities)].toLowerCase() }} on {{ provider.name }})</span>
              </label>
            </div>
          </div>
        </div>
      </fieldset>
    </div>

    <div class="grid border-t border-default md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:divide-x md:divide-default max-md:divide-y max-md:divide-default">
      <div class="grid grid-cols-1 content-start gap-6 p-4 sm:p-5">
        <section :aria-labelledby="`${id}-variables`">
          <header class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <h3
              :id="`${id}-variables`"
              class="flex items-center gap-2 font-mono text-xs font-medium text-highlighted"
            >
              <span class="size-1.5 bg-primary" />
              Variables
            </h3>
            <fieldset
              v-if="options.length > 1"
              class="flex flex-wrap gap-1"
            >
              <legend class="sr-only">
                Credential
              </legend>
              <label
                v-for="item of options"
                :key="item.id"
                class="inline-flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-xs transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary"
                :class="item === option ? 'bg-elevated text-highlighted' : 'text-muted hover:text-highlighted'"
              >
                <input
                  type="radio"
                  :name="`${id}-auth`"
                  :value="item.id"
                  :checked="item === option"
                  class="sr-only"
                  @change="chosen = item.id"
                >
                {{ item.label }}
                <UIcon
                  v-if="item === option"
                  name="i-lucide-check"
                  class="size-3"
                />
                <UIcon
                  v-if="gaps(item).length"
                  name="i-lucide-triangle-alert"
                  class="size-3 text-warning"
                />
                <span
                  v-if="gaps(item).length"
                  class="sr-only"
                >(misses some tasks)</span>
              </label>
            </fieldset>
          </header>
          <div class="relative">
            <pre
              tabindex="0"
              role="region"
              aria-label="Environment variables"
              class="overflow-x-auto rounded-md border border-default bg-elevated/40 py-3 pr-12 pl-3 font-mono text-xs leading-6"
            ><code><span
              v-for="line of lines"
              :key="line.field"
              class="block whitespace-pre"
              :class="{ 'text-muted': line.optional }"
            ><template v-if="line.optional"># </template><span :class="line.optional ? '' : 'text-highlighted'">{{ line.name }}</span><span class="text-muted">=</span><span :class="line.optional ? '' : 'text-primary'">{{ line.value }}</span></span></code></pre>
            <UButton
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              color="neutral"
              variant="ghost"
              size="xs"
              class="absolute top-2 right-2"
              :aria-label="copied ? 'Copied' : 'Copy .env'"
              @click="copy"
            />
            <span
              class="sr-only"
              aria-live="polite"
            >{{ copyMessage }}</span>
          </div>
          <p
            v-if="lines.some(line => line.optional)"
            class="mt-2 text-xs text-muted"
          >
            Commented lines are optional for these tasks.
          </p>
        </section>

        <section :aria-labelledby="`${id}-steps`">
          <h3
            :id="`${id}-steps`"
            class="mb-2.5 flex items-center gap-2 font-mono text-xs font-medium text-highlighted"
          >
            <span class="size-1.5 bg-primary" />
            Get started
          </h3>
          <ol class="grid gap-2.5 text-sm text-default">
            <li
              v-for="(step, position) of steps"
              :key="step.text"
              class="flex gap-3"
            >
              <span
                class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm bg-elevated font-mono text-[11px] text-toned tabular-nums"
                aria-hidden="true"
              >{{ position + 1 }}</span>
              <span>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <span
                  class="credentials-step"
                  v-html="stepHtml(step.text)"
                />
                <span
                  v-if="!step.verified"
                  class="ml-1.5 inline-block rounded-sm border border-dashed border-accented px-1 align-[0.0625rem] font-mono text-[10px] leading-4 text-muted"
                  title="Not yet checked against the forge's documentation"
                >unverified<span class="sr-only">: not yet checked against the forge's documentation</span></span>
              </span>
            </li>
          </ol>
        </section>
      </div>

      <div class="grid grid-cols-1 content-start gap-6 p-4 sm:p-5">
        <section :aria-labelledby="`${id}-scopes`">
          <h3
            :id="`${id}-scopes`"
            class="mb-2.5 flex items-center gap-2 font-mono text-xs font-medium text-highlighted"
          >
            <span class="size-1.5 bg-primary" />
            Scopes
          </h3>
          <p
            v-if="option.anonymous"
            class="text-sm text-muted"
          >
            None. An anonymous provider sends no credentials.
          </p>
          <p
            v-else-if="!selectedTasks.length"
            class="text-sm text-muted"
          >
            Pick a task to see the scopes it needs.
          </p>
          <div
            v-else
            class="grid gap-4"
          >
            <div v-if="scopes.token.length && !app">
              <h4 class="mb-1.5 text-xs text-muted">
                Token scopes
              </h4>
              <ul class="flex flex-wrap gap-1.5">
                <li
                  v-for="scope of scopes.token"
                  :key="scope"
                >
                  <CredentialsField>{{ scope }}</CredentialsField>
                </li>
              </ul>
            </div>
            <table
              v-if="scopes.permissions.length"
              class="w-full text-left text-xs"
            >
              <caption class="mb-1.5 text-left text-xs text-muted">
                {{ app ? 'App permissions' : 'Fine-grained permissions' }}
              </caption>
              <thead class="sr-only">
                <tr>
                  <th scope="col">
                    Permission
                  </th>
                  <th scope="col">
                    Access
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default/60 border-y border-default/60">
                <tr
                  v-for="[name, access] of scopes.permissions"
                  :key="name"
                >
                  <th
                    scope="row"
                    class="py-1.5 font-mono font-normal text-highlighted"
                  >
                    {{ name }}
                  </th>
                  <td class="py-1.5 text-right">
                    <span
                      class="inline-flex items-center gap-1.5 font-mono"
                      :class="access === 'read' ? 'text-muted' : 'text-highlighted'"
                    >
                      <span
                        v-for="level of 3"
                        :key="level"
                        class="size-1.5"
                        :class="level <= ['read', 'write', 'admin'].indexOf(access) + 1 ? 'bg-primary' : 'bg-accented'"
                        aria-hidden="true"
                      />
                      {{ access }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <ul
              v-if="scopes.notes.length"
              class="grid gap-1.5 text-xs text-muted"
            >
              <li
                v-for="note of scopes.notes"
                :key="note"
                class="flex gap-2"
              >
                <UIcon
                  name="i-lucide-info"
                  class="mt-px size-3.5 shrink-0"
                />
                {{ note }}
              </li>
            </ul>
            <p
              v-if="!scopes.permissions.length && !scopes.notes.length && (app || !scopes.token.length)"
              class="text-sm text-muted"
            >
              No scopes listed for these tasks.
            </p>
          </div>
        </section>

        <section :aria-labelledby="`${id}-support`">
          <h3
            :id="`${id}-support`"
            class="mb-2.5 flex items-center gap-2 font-mono text-xs font-medium text-highlighted"
          >
            <span class="size-1.5 bg-primary" />
            Support on {{ provider.name }}
          </h3>
          <div class="grid gap-3 text-xs">
            <p
              v-if="provider.experimental"
              class="flex items-center gap-2 text-default"
            >
              <span
                class="capability-swatch size-2.5 shrink-0"
                data-level="experimental"
                aria-hidden="true"
              />
              {{ provider.name }} is an experimental provider.
            </p>
            <div
              v-if="missing.length"
              class="rounded-md border border-warning/40 bg-warning/5 p-3 text-default"
            >
              <p class="flex items-center gap-2 font-medium">
                <UIcon
                  name="i-lucide-triangle-alert"
                  class="size-3.5 shrink-0 text-warning"
                />
                Not available {{ option.anonymous ? 'anonymously' : `with ${option.label.toLowerCase()} credentials` }}
              </p>
              <p class="mt-1.5 flex flex-wrap gap-1">
                <CredentialsField
                  v-for="capability of missing"
                  :key="capability"
                >
                  {{ capability }}
                </CredentialsField>
              </p>
              <p
                v-if="alternatives.length"
                class="mt-2 text-muted"
              >
                Use
                <template
                  v-for="(alternative, position) of alternatives"
                  :key="alternative.id"
                >
                  <template v-if="position">
                    or
                  </template>
                  <button
                    type="button"
                    class="text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                    @click="chosen = alternative.id"
                  >
                    {{ alternative.label.toLowerCase() }} credentials
                  </button>
                </template>
                instead.
              </p>
            </div>
            <ul
              v-if="support.length"
              class="divide-y divide-default/60 border-y border-default/60"
            >
              <li
                v-for="item of support"
                :key="item.id"
                class="grid gap-1.5 py-2"
              >
                <span class="font-medium text-highlighted">{{ item.label }}</span>
                <ul class="grid gap-1.5">
                  <li
                    v-for="entry of item.levels"
                    :key="entry.level"
                    class="flex items-start gap-2"
                  >
                    <span
                      class="inline-flex w-24 shrink-0 items-center gap-1.5"
                      :class="entry.level === 'none' ? 'text-muted' : 'text-toned'"
                    >
                      <CapabilityCell
                        :level="entry.level"
                        class="[--capability-cell-size:0.625rem]"
                      />
                      {{ shortSupportLabels[entry.level] }}
                    </span>
                    <span
                      v-if="entry.capabilities.length"
                      class="flex min-w-0 flex-wrap gap-1"
                    >
                      <CredentialsField
                        v-for="capability of entry.capabilities"
                        :key="capability"
                      >
                        {{ capability }}
                      </CredentialsField>
                    </span>
                  </li>
                </ul>
              </li>
            </ul>
            <p
              v-else-if="selectedTasks.length"
              class="flex items-center gap-2 text-default"
            >
              <CapabilityCell
                level="native"
                class="[--capability-cell-size:0.625rem]"
              />
              Every capability these tasks use is native on {{ provider.name }}.
            </p>
            <NuxtLink
              :to="{ path: '/reference/capability-matrix', query: { forge: slug } }"
              class="inline-flex items-center gap-1 text-muted hover:text-highlighted"
            >
              Compare forges
              <UIcon
                name="i-lucide-arrow-right"
                class="size-3"
              />
            </NuxtLink>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style>
.credentials-step code {
  border-radius: calc(var(--ui-radius) * 0.75);
  background: var(--ui-bg-elevated);
  padding: 0.0625rem 0.3125rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--ui-text-highlighted);
}

.credentials-step a {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.credentials-step strong {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
</style>
