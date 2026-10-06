<script setup lang="ts">
defineProps<{
  entry: {
    name: string
    id: string
    extends: string
    description: Array<{ text: string, code?: boolean, link?: string }>
    fields: Array<{
      name: string
      optional: boolean
      type: string
      values?: string[]
      description?: Array<{ text: string, code?: boolean, link?: string }>
    }>
    children: string[]
  }
  depth: number
}>()
</script>

<template>
  <article
    :id="entry.id"
    class="error-card rounded-lg border border-default bg-default px-4 py-2.5 transition-colors"
    :class="{ 'bg-elevated/40': depth === 0 }"
  >
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <component
        :is="`h${Math.min(depth + 2, 6)}`"
        class="flex items-center gap-2 font-mono text-sm font-medium text-highlighted"
      >
        <span
          class="size-1.5 shrink-0 bg-primary"
          aria-hidden="true"
        />
        <a
          :href="`#${entry.id}`"
          class="hover:text-primary"
        >{{ entry.name }}</a>
      </component>
      <span class="font-mono text-xs text-muted">
        extends
        <a
          v-if="depth > 0"
          :href="`#${entry.extends.toLowerCase()}`"
          class="text-toned hover:text-primary"
        >{{ entry.extends }}</a>
        <span
          v-else
          class="text-toned"
        >{{ entry.extends }}</span>
      </span>
      <span
        v-if="entry.children.length"
        class="ml-auto font-mono text-xs text-muted tabular-nums"
      >
        {{ entry.children.length }} {{ entry.children.length === 1 ? 'subclass' : 'subclasses' }}
      </span>
    </div>

    <p class="mt-1.5 text-sm text-toned">
      <ErrorReferenceText :segments="entry.description" />
    </p>

    <ul
      v-if="entry.fields.length"
      class="mt-2.5 flex flex-wrap gap-x-3 gap-y-1.5"
      :aria-label="`Fields of ${entry.name}`"
    >
      <li
        v-for="field of entry.fields"
        :key="field.name"
        class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
        :class="{ 'basis-full': field.values || field.description }"
      >
        <code class="rounded border border-default bg-elevated/60 px-1.5 py-0.5 font-mono"><span class="text-highlighted">{{ field.name }}</span><span class="text-muted">{{ field.optional ? '?:' : ':' }}</span> <span class="text-toned">{{ field.type }}</span></code>
        <span
          v-if="field.values"
          class="inline-flex flex-wrap items-baseline gap-x-1 gap-y-1 font-mono"
        >
          <span class="sr-only">One of</span>
          <template
            v-for="(value, index) of field.values"
            :key="value"
          >
            <span
              v-if="index"
              class="text-muted"
              aria-hidden="true"
            >|</span>
            <code class="rounded bg-elevated px-1 py-px text-[11px] text-toned">{{ value }}</code>
          </template>
        </span>
        <span
          v-if="field.description"
          class="basis-full text-muted sm:basis-auto"
        >
          <ErrorReferenceText :segments="field.description" />
        </span>
      </li>
    </ul>
  </article>
</template>
