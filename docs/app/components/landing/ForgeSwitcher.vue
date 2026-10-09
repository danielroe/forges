<script setup lang="ts">
import { providers } from '#capabilities'
import examples, { initial } from '#landing-examples'

const tabs = examples.map(example => ({
  ...example,
  icon: example.slug === 'unified' ? 'i-lucide-layers' : providers.find(provider => provider.slug === example.slug)!.icon,
}))

const selected = ref(tabs[0]!.name)

/** The explorer, with the selected example's forge already picked. */
const explorerLink = computed(() => {
  const slug = tabs.find(tab => tab.name === selected.value)!.slug
  return `/getting-started/explorer?verb=threads.get${slug === 'unified' ? '' : `&forge=${slug}`}`
})
const radios = useRadioGroup(selected, () => tabs.map(tab => tab.name))
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
          role="radiogroup"
          aria-label="Code examples"
          @keydown="radios.onKeydown"
        >
          <button
            v-for="tab of tabs"
            :key="tab.name"
            type="button"
            :aria-label="tab.name"
            :title="tab.name"
            role="radio"
            :aria-checked="selected === tab.name"
            :tabindex="radios.tabindex(tab.name)"
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
        <ULink
          :to="explorerLink"
          class="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted transition hover:text-highlighted"
        >
          <UIcon
            name="i-lucide-play"
            class="size-3.5 text-primary"
            aria-hidden="true"
          />
          try it
        </ULink>
      </div>
    </template>
  </LandingCode>
</template>

<style scoped>
.forge-tab[aria-checked='true'] {
  box-shadow: inset 0 -1px 0 var(--ui-primary);
}

.forge-tab:focus-visible {
  outline-offset: -2px;
}
</style>
