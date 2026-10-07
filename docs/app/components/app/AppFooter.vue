<script setup lang="ts">
const { data: contributors } = await useFetch('/api/footer-contributors', {
  default: () => [{ login: 'danielroe', to: 'https://github.com/danielroe' }],
})

const links = [
  { label: 'Documentation', to: '/getting-started/introduction' },
  { label: 'API reference', to: '/reference/provider-api' },
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
            one API for every code forge.
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

      <div class="mt-8 flex flex-col gap-4 border-t border-default/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-xs leading-6 text-muted">
          made with <span class="text-primary" role="img" aria-label="love">♥</span> by
          <template
            v-for="(contributor, index) of contributors"
            :key="contributor.login"
          >
            <ULink
              :to="contributor.to"
              class="underline decoration-default underline-offset-4 hover:text-highlighted hover:decoration-current transition-colors"
            >
              {{ contributor.login }}
            </ULink>{{ index < contributors.length - 2 ? ', ' : index === contributors.length - 2 ? ' and ' : '' }}
          </template>
        </p>

        <div class="flex shrink-0 items-center gap-5">
          <ULink
            to="https://github.com/danielroe/forges/blob/main/LICENCE"
            class="text-xs text-muted hover:text-highlighted transition-colors"
          >
            MIT licence
          </ULink>
          <ULink
            to="https://github.com/danielroe/forges"
            class="text-xs text-muted hover:text-highlighted transition-colors"
          >
            github
          </ULink>
          <ULink
            to="https://npmx.dev/package/forges"
            class="text-xs text-muted hover:text-highlighted transition-colors"
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
