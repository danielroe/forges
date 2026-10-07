<script setup lang="ts">
defineProps<{
  title: string
  /** A contributing guide with more detail. */
  to?: string
}>()
</script>

<template>
  <details class="group my-8 rounded-lg border border-dashed border-accented bg-elevated/30">
    <summary class="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
      <UIcon
        name="i-lucide-git-pull-request"
        class="size-4 shrink-0 text-muted"
      />
      <span class="min-w-0 flex-1">
        <span class="block text-sm font-medium text-highlighted">{{ title }}</span>
        <span class="block text-xs text-muted">For contributors to forges. You don't need this to use the provider.</span>
      </span>
      <UIcon
        name="i-lucide-chevron-down"
        class="size-4 shrink-0 text-muted transition group-open:rotate-180"
      />
    </summary>
    <div class="border-t border-dashed border-accented px-4 pb-4 [&>*:last-child]:mb-0">
      <slot />
      <NuxtLink
        v-if="to"
        :to="to"
        class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        Read the contributing guide
        <UIcon
          name="i-lucide-arrow-right"
          class="size-3"
        />
      </NuxtLink>
    </div>
  </details>
</template>
