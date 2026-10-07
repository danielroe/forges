<script setup lang="ts">
const appConfig = useAppConfig()
</script>

<template>
  <span class="inline-flex items-center gap-2 leading-none text-highlighted">
    <img
      src="/logo/mark.svg"
      alt=""
      class="size-7 shrink-0"
      aria-hidden="true"
    >
    <span class="font-mono text-lg leading-none font-medium tracking-tight">{{ appConfig.header?.title }}</span>
  </span>
</template>
