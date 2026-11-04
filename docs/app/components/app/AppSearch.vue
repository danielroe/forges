<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content'

const props = defineProps<{
  navigation?: ContentNavigationItem[]
}>()

const { forced: forcedColorMode } = useDocusColorMode()
const { open } = useContentSearch()
const { search, status: searchStatus, init } = useSearchCollection('docs', {
  immediate: false,
  ignoredTags: ['style'],
})

// The search modal and its index load the first time the search opens.
const rendered = ref(false)

watch(open, (value) => {
  if (!value) {
    return
  }
  rendered.value = true
  if (searchStatus.value === 'idle') {
    init()
  }
})

defineShortcuts({
  meta_k: () => {
    if (!rendered.value) {
      open.value = true
    }
  },
})

const links = computed(() => props.navigation?.filter(item => item.children?.length).map(item => ({
  label: item.title,
  icon: item.icon,
  to: item.children![0]!.path,
})))
</script>

<template>
  <LazyUContentSearch
    v-if="rendered"
    :search="search"
    :search-status="searchStatus"
    :links="links"
    :navigation="navigation"
    :color-mode="!forcedColorMode"
  />
</template>
