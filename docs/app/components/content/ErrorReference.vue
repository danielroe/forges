<script setup lang="ts">
import { errors } from '#error-reference'

const filter = ref('')
const root = errors[0]!
const parents = new Map(errors.map(entry => [entry.name, entry.extends]))

const haystacks = errors.map(entry => ({
  name: entry.name,
  text: [
    entry.name,
    ...entry.description.map(segment => segment.text),
    ...entry.fields.flatMap(field => [field.name, field.type, ...field.values ?? []]),
  ].join(' ').toLowerCase(),
}))

const matches = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  return haystacks.filter(({ text }) => !needle || text.includes(needle)).map(({ name }) => name)
})

const visible = computed(() => {
  const names = new Set<string>()
  for (const match of matches.value) {
    for (let name: string | undefined = match; name && parents.has(name) && !names.has(name); name = parents.get(name)) {
      names.add(name)
    }
  }
  return names
})
</script>

<template>
  <div class="not-prose my-8">
    <div class="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3">
      <UInput
        v-model="filter"
        icon="i-lucide-search"
        placeholder="Filter classes or fields"
        aria-label="Filter error classes or fields"
        class="w-full sm:w-72"
        :ui="{ base: 'font-mono text-xs' }"
      />
      <p
        class="font-mono text-xs text-muted tabular-nums"
        aria-live="polite"
      >
        <template v-if="filter.trim()">
          {{ matches.length }} of {{ errors.length }} classes
        </template>
        <template v-else>
          {{ errors.length }} classes
        </template>
      </p>
    </div>

    <template v-if="visible.size">
      <ErrorReferenceCard
        :entry="root"
        :depth="0"
      />
      <ErrorReferenceTree
        :names="root.children"
        :depth="1"
        :visible="visible"
      />
    </template>
    <p
      v-else
      class="rounded-lg border border-dashed border-default py-10 text-center text-sm text-muted"
    >
      No error class matches “{{ filter }}”.
    </p>
  </div>
</template>

<style>
.error-card {
  scroll-margin-top: calc(var(--ui-header-height) + 1.5rem);
}

.error-card:target {
  border-color: var(--ui-primary);
  box-shadow: 0 0 0 1px var(--ui-primary);
}

.error-tree > li {
  position: relative;
  padding-top: 0.5rem;
  padding-left: 1.5rem;
}

.error-tree > li::before,
.error-tree > li::after {
  content: '';
  position: absolute;
  left: 0.625rem;
  background: var(--ui-border-accented);
}

.error-tree > li::before {
  top: 0;
  bottom: 0;
  width: 1px;
}

.error-tree > li:last-child::before {
  bottom: auto;
  height: 1.75rem;
}

.error-tree > li::after {
  top: 1.75rem;
  width: 0.875rem;
  height: 1px;
}
</style>
