<script setup lang="ts">
defineProps<{
  level: string
  kinds?: Array<{ kind: string, label: string, level: string }>
}>()
</script>

<template>
  <span
    v-if="kinds"
    class="capability-cell capability-kinds"
    aria-hidden="true"
  >
    <span
      v-for="kind of kinds"
      :key="kind.kind"
      class="capability-swatch"
      :data-level="kind.level"
    />
  </span>
  <span
    v-else
    class="capability-cell capability-swatch"
    :data-level="level"
    aria-hidden="true"
  />
</template>
