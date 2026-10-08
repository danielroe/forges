<script setup lang="ts">
const route = useRoute()
const { localePath } = useDocusI18n()
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
</template>

<style>
.landing-header {
  position: fixed;
  inset: 0 0 auto;
  transition: opacity 200ms ease, transform 200ms ease, visibility 200ms;
}

.landing-header-hidden {
  visibility: hidden;
  opacity: 0;
  transform: translateY(-100%);
}

@media (prefers-reduced-motion: reduce) {
  .landing-header {
    transition: none;
  }
}
</style>
