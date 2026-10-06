<script setup lang="ts">
const appConfig = useAppConfig()
const site = useSiteConfig()
const { localePath } = useDocusI18n()

const ariaLabel = appConfig.header?.title || site.name
</script>

<template>
  <!-- Flex link keeps the logo vertically centred. -->
  <NuxtLink
    :to="localePath('/')"
    :aria-label="ariaLabel"
    class="flex items-center"
  >
    <AppHeaderLogo class="h-6 w-auto shrink-0" />
  </NuxtLink>
</template>
