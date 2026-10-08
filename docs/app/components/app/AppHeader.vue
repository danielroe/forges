<script setup lang="ts">
const route = useRoute()
const { localePath } = useDocusI18n()
const { forced: forcedColorMode } = useDocusColorMode()
const links = useHeaderLinks()
const isLandingPage = computed(() => route.path === localePath('/'))
const hasScrolled = ref(false)
const hidden = computed(() => isLandingPage.value && !hasScrolled.value)

function updateScroll() {
  hasScrolled.value = window.scrollY > 160
}

onMounted(() => {
  updateScroll()
  window.addEventListener('scroll', updateScroll, { passive: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', updateScroll)
})
</script>

<template>
  <LazyAppHeaderContent
    hydrate-on-idle
    :inert="hidden"
    :class="{ 'landing-header': isLandingPage, 'landing-header-hidden': hidden }"
  />
  <div
    v-if="isLandingPage"
    class="landing-actions pointer-events-none fixed inset-x-0 top-0 z-50"
    :class="{ 'landing-actions-hidden': !hidden }"
    :inert="!hidden"
  >
    <UContainer class="flex h-(--ui-header-height) items-center justify-end gap-1.5">
      <UContentSearchButton
        :collapsed="true"
        variant="ghost"
        class="pointer-events-auto"
        :ui="{ base: 'bg-transparent hover:bg-elevated/60 ring-0 backdrop-blur-none' }"
      />
      <ClientOnly v-if="!forcedColorMode">
        <UColorModeButton class="pointer-events-auto" />
        <template #fallback>
          <div class="size-8" />
        </template>
      </ClientOnly>
      <UButton
        v-for="link of links"
        :key="link.to"
        v-bind="{ color: 'neutral', variant: 'ghost', ...link }"
        class="pointer-events-auto"
      />
    </UContainer>
  </div>
</template>

<style>
.landing-header,
.landing-actions {
  transition: opacity 200ms ease, transform 200ms ease, visibility 200ms;
}

.landing-header {
  position: fixed;
  inset: 0 0 auto;
}

.landing-header-hidden,
.landing-actions-hidden {
  visibility: hidden;
  opacity: 0;
}

.landing-header-hidden {
  transform: translateY(-100%);
}

@media (prefers-reduced-motion: reduce) {
  .landing-header,
  .landing-actions {
    transition: none;
  }
}
</style>
