<script setup lang="ts">
import { providers } from '#capabilities'
import examples, { initial } from '#landing-examples'

const tabs = examples.map(example => ({
  ...example,
  icon: example.slug === 'unified' ? 'i-lucide-layers' : providers.find(provider => provider.slug === example.slug)!.icon,
}))

const selected = ref(tabs[0]!.name)
const shown = shallowRef({ name: tabs[0]!.name, ...initial })

watch(selected, async (name) => {
  try {
    const example = await tabs.find(tab => tab.name === name)!.load()
    if (selected.value === name) {
      shown.value = { name, ...example }
    }
  }
  catch {
    if (selected.value === name) {
      selected.value = shown.value.name
    }
  }
})
</script>

<template>
  <LandingCode
    :html="shown.html"
    :label="`${shown.name} example`"
  >
    <template #header>
      <div class="flex items-center justify-between gap-4">
        <div
          class="flex min-w-0 items-center gap-1 overflow-x-auto"
          role="group"
          aria-label="Code examples"
        >
          <button
            v-for="tab of tabs"
            :key="tab.name"
            type="button"
            :aria-label="tab.name"
            :title="tab.name"
            :aria-pressed="selected === tab.name"
            class="forge-tab relative flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-2 px-3 font-mono text-xs"
            :class="selected === tab.name ? 'text-highlighted' : 'text-muted hover:text-highlighted'"
            @click="selected = tab.name"
          >
            <UIcon
              :name="tab.icon"
              class="size-4"
              aria-hidden="true"
            />
            <span v-if="tab.name === 'Unified'">unified</span>
          </button>
        </div>
        <span class="hidden shrink-0 font-mono text-xs text-muted sm:block">TypeScript</span>
      </div>
    </template>
  </LandingCode>
</template>

<style scoped>
.forge-tab[aria-pressed='true'] {
  box-shadow: inset 0 -1px 0 var(--ui-primary);
}

.forge-tab:focus-visible {
  outline-offset: -2px;
}
</style>
