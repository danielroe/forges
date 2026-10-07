<script setup lang="ts">
// Docus header with an added npmx link.
const appConfig = useAppConfig()
const { forced: forcedColorMode } = useDocusColorMode()

const { isEnabled: isAssistantEnabled } = useAssistant()
const { isEnabled, locales } = useDocusI18n()
const { subNavigationMode } = useSubNavigation()

const links = computed(() => [
  ...(appConfig.github && appConfig.github.url
    ? [{
        'icon': 'i-simple-icons-github',
        'to': appConfig.github.url,
        'target': '_blank',
        'aria-label': 'forges on GitHub',
      }]
    : []),
  {
    'icon': 'i-custom-npmx',
    'to': 'https://npmx.dev/package/forges',
    'target': '_blank',
    'aria-label': 'forges on npmx',
  },
])
</script>

<template>
  <UHeader
    :ui="{ center: 'flex-1' }"
    :class="{ 'flex flex-col': subNavigationMode === 'header' }"
  >
    <AppHeaderCenter />

    <template #left>
      <AppHeaderLeft />
    </template>

    <template #right>
      <AppHeaderCTA />

      <template v-if="isAssistantEnabled">
        <LazyAssistantChat />
      </template>

      <template v-if="isEnabled && locales.length > 1">
        <ClientOnly>
          <LazyLanguageSelect />

          <template #fallback>
            <div class="h-8 w-8 animate-pulse bg-neutral-200 dark:bg-neutral-800 rounded-md" />
          </template>
        </ClientOnly>

        <USeparator
          orientation="vertical"
          class="h-8"
        />
      </template>

      <UContentSearchButton class="lg:hidden" />

      <ClientOnly v-if="!forcedColorMode">
        <UColorModeButton />

        <template #fallback>
          <div class="h-8 w-8 animate-pulse bg-neutral-200 dark:bg-neutral-800 rounded-md" />
        </template>
      </ClientOnly>

      <UButton
        v-for="link of links"
        :key="link.to"
        v-bind="{ color: 'neutral', variant: 'ghost', ...link }"
      />
    </template>

    <template #toggle="{ open, toggle }">
      <IconMenuToggle
        :open="open"
        class="lg:hidden"
        @click="toggle"
      />
    </template>

    <template #body>
      <AppHeaderBody />
    </template>

    <template
      v-if="subNavigationMode === 'header'"
      #bottom
    >
      <LazyAppHeaderBottom />
    </template>
  </UHeader>
</template>
