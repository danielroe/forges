<template>
  <UMain>
    <UContainer>
      <UPage>
        <template #left>
          <UPageAside>
            <DocsAsideLeftTop />
            <!-- The aside is hidden below the `lg` breakpoint. -->
            <LazyDocsAsideLeftBody hydrate-on-media-query="(min-width: 64rem)" />
          </UPageAside>
        </template>
        <slot />
      </UPage>
    </UContainer>
  </UMain>
</template>
