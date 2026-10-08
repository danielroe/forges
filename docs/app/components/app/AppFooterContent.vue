<script setup lang="ts">
const { data: attribution } = await useFetch('/api/footer-contributors', {
  default: () => ({ contributors: [{ login: 'danielroe', to: 'https://github.com/danielroe' }], remaining: 0 }),
})

const links = [
  { label: 'Documentation', to: '/getting-started/introduction' },
  { label: 'API reference', to: '/reference/overview' },
  { label: 'Developers', to: '/developers' },
]
</script>

<template>
  <footer class="docs-footer relative border-t border-default [--ui-container:72rem]">
    <UContainer class="relative py-8 sm:py-10">
      <div
        class="absolute top-0 flex gap-1"
        aria-hidden="true"
      >
        <span class="h-0.5 w-8 bg-primary" />
        <span class="h-0.5 w-2 bg-primary/50" />
        <span class="h-0.5 w-2 bg-primary/25" />
      </div>

      <div class="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <NuxtLink
            to="/"
            aria-label="forges home"
            class="inline-flex"
          >
            <AppHeaderLogo />
          </NuxtLink>
          <p class="mt-3 text-sm text-muted">
            one client, every forge.
          </p>
        </div>

        <nav aria-label="Footer">
          <p class="font-mono text-xs text-muted">
            explore
          </p>
          <ul class="mt-3 flex flex-wrap gap-x-6 gap-y-3 text-sm">
            <li
              v-for="link of links"
              :key="link.to"
            >
              <ULink
                :to="link.to"
                class="text-toned hover:text-highlighted transition-colors"
              >
                {{ link.label }}
              </ULink>
            </li>
          </ul>
        </nav>
      </div>

      <div class="mt-8 flex flex-col gap-0 border-t border-default/60 pt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p class="text-xs leading-6 text-muted">
          made with <span class="text-primary" role="img" aria-label="love">♥</span> by
          <template
            v-for="(contributor, index) of attribution.contributors"
            :key="contributor.login"
          >
            <ULink
              :to="contributor.to"
              class="underline decoration-default underline-offset-4 hover:text-highlighted hover:decoration-current transition-colors"
            >
              {{ contributor.login }}
            </ULink>{{ index < attribution.contributors.length - 1 ? (attribution.remaining || index < attribution.contributors.length - 2 ? ', ' : ' and ') : '' }}
          </template>
          <template v-if="attribution.remaining">
            and
            <ULink
              to="/contributing/contributors"
              class="underline decoration-default underline-offset-4 hover:text-highlighted hover:decoration-current transition-colors"
            >
              {{ attribution.remaining }} other {{ attribution.remaining === 1 ? 'contributor' : 'contributors' }}
            </ULink>
          </template>
        </p>

        <div class="-ml-2 flex shrink-0 items-center gap-1 sm:ml-0">
          <ULink
            to="https://github.com/danielroe/forges/blob/main/LICENCE"
            class="inline-flex min-h-11 items-center px-2 text-xs text-muted hover:text-highlighted transition-colors"
          >
            MIT licence
          </ULink>
          <ULink
            to="https://github.com/danielroe/forges"
            class="inline-flex min-h-11 items-center px-2 text-xs text-muted hover:text-highlighted transition-colors"
          >
            source
          </ULink>
          <ULink
            to="https://npmx.dev/package/forges"
            class="inline-flex min-h-11 items-center px-2 text-xs text-muted hover:text-highlighted transition-colors"
          >
            npmx
          </ULink>
        </div>
      </div>
    </UContainer>
  </footer>
</template>

<style scoped>
.docs-footer {
  background: radial-gradient(ellipse at top left, color-mix(in oklab, var(--ui-primary) 5%, transparent), transparent 65%);
}
</style>
