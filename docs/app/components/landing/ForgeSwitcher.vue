<script setup lang="ts">
import { providers } from '#capabilities'
import examples, { initial } from '#landing-examples'

const tabs = examples.map(example => ({
  ...example,
  value: example.name,
  label: example.name,
  icon: example.slug === 'unified' ? 'i-lucide-layers' : providers.find(provider => provider.slug === example.slug)!.icon,
  text: example.slug === 'unified' ? 'unified' : undefined,
}))

const selected = ref(tabs[0]!.name)

/** The explorer, with the selected example's forge already picked. */
const explorerLink = computed(() => {
  const slug = tabs.find(tab => tab.name === selected.value)!.slug
  return `/getting-started/explorer?verb=threads.get${slug === 'unified' ? '' : `&forge=${slug}`}`
})
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
        <TabSwitcher
          v-model="selected"
          :items="tabs"
          label="Code examples"
        />
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
