<script setup lang="ts">
defineProps<{
  level: 'native' | 'experimental' | 'emulated' | 'none'
}>()
</script>

<template>
  <span class="inline-flex items-center gap-2 whitespace-nowrap">
    <CapabilityCell
      :level="level"
      class="[--capability-cell-size:0.875rem]"
    />
    <slot />
  </span>
</template>
