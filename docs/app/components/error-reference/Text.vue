<script setup lang="ts">
defineProps<{
  segments: Array<{ text: string, code?: boolean, link?: string }>
}>()
</script>

<template>
  <template
    v-for="(segment, index) of segments"
    :key="index"
  >
    <a
      v-if="segment.link"
      :href="`#${segment.link.toLowerCase()}`"
      class="font-mono text-[0.9em] text-highlighted underline decoration-accented underline-offset-3 hover:text-primary hover:decoration-primary"
    >{{ segment.text }}</a>
    <code
      v-else-if="segment.code"
      class="rounded bg-elevated px-1 py-px font-mono text-[0.9em] text-highlighted"
    >{{ segment.text }}</code>
    <template v-else>
      {{ segment.text }}
    </template>
  </template>
</template>
