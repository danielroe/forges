<script setup lang="ts">
import { errors } from '#error-reference'

const props = defineProps<{
  names: string[]
  depth: number
  visible: Set<string>
}>()

const classes = new Map(errors.map(entry => [entry.name, entry]))
const shown = computed(() => props.names.filter(name => props.visible.has(name)).map(name => classes.get(name)!))
</script>

<template>
  <ul
    v-if="shown.length"
    class="error-tree"
  >
    <li
      v-for="entry of shown"
      :key="entry.name"
    >
      <ErrorReferenceCard
        :entry="entry"
        :depth="depth"
      />
      <ErrorReferenceTree
        v-if="entry.children.length"
        :names="entry.children"
        :depth="depth + 1"
        :visible="visible"
      />
    </li>
  </ul>
</template>
