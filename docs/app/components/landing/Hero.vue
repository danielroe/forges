<script setup lang="ts">
import { providers } from '#capabilities'

const example = `import { createForges, github, gitlab } from 'forges'

const forges = createForges([
  github({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } }),
  gitlab({ auth: { type: 'token', token: process.env.GITLAB_TOKEN! } }),
])

for await (const notification of forges.notifications.list()) {
  console.log(notification.ref.forge, notification.title)
}`
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

    <div class="hero-entry relative z-10 mx-auto grid max-w-5xl items-center gap-8 px-6 pt-10 pb-8 sm:px-8 sm:pt-20 sm:pb-10 md:gap-x-12 lg:gap-x-20 lg:pt-24 lg:pb-12">
      <img
        src="/logo/mark.svg"
        alt=""
        aria-hidden="true"
        width="800"
        height="800"
        class="hero-mark mx-auto size-32 sm:size-48 md:size-full md:max-w-64 lg:max-w-80"
      >

      <div class="min-w-0">
        <h1 class="text-[5.5rem] leading-none text-highlighted sm:text-[7rem]">
          forges
        </h1>
        <p class="mt-3 flex items-baseline gap-4 border-b border-default/70 pb-4 text-muted">
          <span class="text-lg">/fɔːrdʒɪz/</span>
          <span class="italic">noun</span>
        </p>

        <ol class="mt-5 list-decimal space-y-4 pl-6 text-lg leading-relaxed marker:font-mono marker:text-xs marker:text-primary">
          <li class="pl-3">
            Platforms for hosting and collaborating on code.
            <ul
              class="hero-provider-band mt-2 flex min-w-0 list-none items-center gap-1 overflow-x-auto p-1 sm:gap-2"
              aria-label="Supported forges"
            >
              <li
                v-for="provider of providers"
                :key="provider.slug"
                class="shrink-0"
              >
                <NuxtLink
                  :to="provider.to"
                  :aria-label="provider.title"
                  :title="provider.title"
                  class="flex size-6 items-center justify-center rounded-sm text-muted transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <UIcon
                    :name="provider.icon"
                    class="size-4"
                    aria-hidden="true"
                  />
                </NuxtLink>
              </li>
            </ul>
          </li>
          <li class="pl-3">
            <NuxtLink
              to="/getting-started/introduction"
              aria-label="Get started: A typed client for working across code forges."
              class="hero-definition-link block rounded-sm hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
            >
              A typed client for working across
              <span class="whitespace-nowrap">
                code forges.
                <span
                  class="hero-start-slot relative ml-1 inline-block size-6 align-middle text-primary"
                  aria-hidden="true"
                >
                  <span class="hero-start-action absolute top-0 left-0 flex h-6 items-center">
                    <span class="hero-start-label text-sm">get started</span>
                    <UIcon
                      name="i-lucide-arrow-right"
                      class="size-4 shrink-0"
                    />
                  </span>
                </span>
              </span>
            </NuxtLink>
          </li>
        </ol>
      </div>
    </div>

    <div
      class="hero-code-texture pointer-events-none mx-auto mt-6 flex h-64 max-w-5xl justify-center overflow-hidden px-6 select-none"
      aria-hidden="true"
    >
      <pre class="shrink-0 font-mono text-xs leading-6 text-muted/60 sm:text-sm"><code>{{ example }}</code></pre>
    </div>
  </section>
</template>

<style>
@media (min-width: 48rem) {
  .hero-entry {
    grid-template-columns: 0.85fr 1.15fr;
  }
}

.hero-start-label {
  width: 0;
  overflow: hidden;
  white-space: nowrap;
  opacity: 0;
  transition: width 250ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease;
}

.hero-definition-link:is(:hover, :focus-visible) .hero-start-label {
  width: 5rem;
  opacity: 1;
}

@media (width < 80rem), (hover: none) {
  .hero-start-slot {
    width: 6rem;
  }
}

@media (hover: none) {
  .hero-start-label {
    width: 5rem;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-start-label {
    transition: none;
  }
}

.hero-code-texture {
  mask-image:
    linear-gradient(to bottom, transparent, black 12%, black 35%, transparent),
    linear-gradient(to right, transparent, black 15%, black 85%, transparent);
  mask-composite: intersect;
}

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
