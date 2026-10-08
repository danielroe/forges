<script setup lang="ts">
import { providers } from '#capabilities'

const command = 'pnpm add forges'
const { copied, copy, message } = useCopyToClipboard(() => command)
</script>

<template>
  <section class="hero relative isolate overflow-hidden">
    <div
      class="hero-gradient absolute inset-0 -z-10"
      aria-hidden="true"
    />
    <div
      class="hero-noise absolute inset-0 -z-10"
      aria-hidden="true"
    />
    <LandingPixelField class="-z-10" />

    <div class="mx-auto flex max-w-4xl flex-col items-center px-4 pt-10 pb-14 text-center sm:px-6 sm:pt-16 sm:pb-16">
      <img
        src="/logo/mark.svg"
        alt="forges"
        width="800"
        height="800"
        class="mb-6 size-20 sm:size-24"
      >
      <h1 class="text-balance text-4xl font-semibold tracking-tight text-highlighted sm:text-6xl">
        one client,
        <span class="text-primary">every forge</span>
      </h1>

      <p class="mt-6 max-w-2xl text-balance text-lg text-muted">
        A unified interface for issues, pull requests, notifications, checks and webhooks
        <span class="whitespace-nowrap">across {{ providers.length }} <ForgeTerm>forges</ForgeTerm>.</span>
      </p>

      <div class="mt-9 flex flex-wrap items-center justify-center gap-3">
        <UButton
          to="/getting-started/introduction"
          size="xl"
          color="neutral"
          class="ps-4"
          trailing-icon="i-lucide-arrow-right"
        >
          get started
        </UButton>
        <UButton
          size="xl"
          color="neutral"
          variant="ghost"
          class="cursor-copy font-mono text-muted hover:bg-transparent hover:text-highlighted"
          :aria-label="`Copy ${command}`"
          title="Copy to the clipboard"
          @click="copy"
        >
          <span class="inline-flex w-4 justify-center text-primary">
            <UIcon
              v-if="copied"
              name="i-lucide-check"
              class="size-4"
            />
            <template v-else>$</template>
          </span>
          {{ command }}
        </UButton>
        <span
          class="sr-only"
          aria-live="polite"
        >{{ message }}</span>
      </div>
    </div>
  </section>
</template>

<style>
.hero-gradient {
  background:
    radial-gradient(60% 55% at 15% 0%, color-mix(in oklab, var(--ui-color-primary-500) var(--glow-strong), transparent), transparent 70%),
    radial-gradient(55% 60% at 88% 5%, color-mix(in oklab, var(--ui-color-secondary-500) var(--glow-soft), transparent), transparent 70%),
    radial-gradient(45% 40% at 55% -5%, color-mix(in oklab, var(--ui-color-primary-300) var(--glow-soft), transparent), transparent 75%);
  mask-image: linear-gradient(to bottom, black 35%, transparent 100%);
}

.hero-noise {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 1.4 -0.2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 240px;
  mix-blend-mode: var(--noise-blend);
  opacity: var(--noise-opacity);
  mask-image: linear-gradient(to bottom, black 20%, transparent 95%);
}

.hero {
  --glow-strong: 38%;
  --glow-soft: 24%;
  --noise-blend: multiply;
  --noise-opacity: 0.55;
}

.dark .hero {
  --glow-strong: 62%;
  --glow-soft: 40%;
  --noise-blend: overlay;
  --noise-opacity: 0.7;
}
</style>
