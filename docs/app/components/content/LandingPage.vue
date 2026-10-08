<script setup lang="ts">
const features = [
  {
    icon: 'i-lucide-shapes',
    title: 'one data model',
    description: 'Issues, pull requests, comments, checks and events have the same shape on every forge, and the original payload is still there in the raw field when you need it.',
    to: '/concepts/data-model',
  },
  {
    icon: 'i-lucide-list-checks',
    title: 'declared capabilities',
    description: 'Every provider declares what its forge supports, and we check those claims against the tests on every commit to forges. Ask provider.can() before you call an operation.',
    to: '/concepts/capabilities',
  },
  {
    icon: 'i-lucide-webhook',
    title: 'verified webhooks',
    description: 'The provider verifies each delivery for you and turns it into typed events, with the same kinds and actions on every forge.',
    to: '/guides/webhooks',
  },
  {
    icon: 'i-lucide-package',
    title: 'small bundles',
    description: 'Import a single forge from its subpath, and use a Lite factory in the browser to leave out the webhook code. The GitHub Lite provider is about 24 kB gzipped.',
    to: '/guides/bundling',
  },
  {
    icon: 'i-lucide-flask-conical',
    title: 'offline tests',
    description: 'Test your code against an in-memory forge or replayed responses, without ever touching the network.',
    to: '/guides/testing',
  },
  {
    icon: 'i-lucide-shield-check',
    title: 'typed errors and retries',
    description: 'Rate limits, revoked tokens and missing scopes each have their own error class, and after a short rate limit the provider retries once by itself.',
    to: '/guides/errors',
  },
]

const projects = [
  {
    icon: 'i-lucide-inbox',
    title: 'a notification inbox',
    description: 'Merge the notifications of every forge you configure into one list.',
    to: '/examples/inbox-cli',
  },
  {
    icon: 'i-lucide-tag',
    title: 'a label bot',
    description: 'Label new threads, and close them from a comment command, on any forge.',
    to: '/examples/label-bot',
  },
  {
    icon: 'i-lucide-newspaper',
    title: 'a release digest',
    description: 'Show the latest release and the failing pull requests across repositories.',
    to: '/examples/release-digest',
  },
  {
    icon: 'i-lucide-radio',
    title: 'a webhook receiver',
    description: 'Turn the deliveries of any forge into a single event type.',
    to: '/guides/webhooks',
  },
]

// Tighter than the UPageSection defaults, so sections read as one page.
const section = { container: 'py-10 sm:py-12 lg:py-16 gap-8 sm:gap-10' }
</script>

<template>
  <!-- Narrower container than the Docus default. The hero stays full width. -->
  <div class="[--ui-container:72rem]">
    <LandingHero />

    <UPageSection
      :ui="{ container: `${section.container} pt-0 sm:pt-0 lg:pt-0` }"
    >
      <LazyLandingForgeSwitcher
        class="mx-auto w-full max-w-5xl"
        hydrate-on-visible
      />
    </UPageSection>

    <UPageSection
      :ui="section"
      title="features"
      description="You write your code against one model, and forges takes care of the endpoints, pagination, authentication and rate limits of each forge."
    >
      <UPageGrid class="lg:grid-cols-3">
        <LazyUPageCard
          v-for="feature of features"
          :key="feature.title"
          v-bind="feature"
          hydrate-on-interaction
          spotlight
          spotlight-color="primary"
        />
      </UPageGrid>
    </UPageSection>

    <UPageSection
      :ui="section"
      title="see what each forge can do"
      description="Every provider declares what its forge supports, so your code can check before it makes a call."
    >
      <div>
        <LazyLandingCapabilityGrid hydrate-never />

        <div class="mt-6 flex justify-center">
          <UButton
            to="/reference/capability-matrix"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-arrow-right"
          >
            read the full matrix
          </UButton>
        </div>
      </div>
    </UPageSection>

    <UPageSection
      :ui="section"
      title="what you can build"
      description="Explore the examples and guides to get started on your next project."
    >
      <UPageGrid class="lg:grid-cols-4">
        <LazyUPageCard
          v-for="project of projects"
          :key="project.title"
          v-bind="project"
          hydrate-on-interaction
          variant="subtle"
        />
      </UPageGrid>
    </UPageSection>

    <UPageSection :ui="section">
      <div class="mx-auto flex max-w-2xl flex-col items-center text-center">
        <h2 class="text-3xl font-semibold tracking-tight text-highlighted sm:text-4xl">
          make your first call
        </h2>
        <p class="mt-4 text-pretty text-muted">
          Install the package, read an issue and add a second forge.
        </p>
        <div class="mt-8 flex flex-wrap justify-center gap-3">
          <UButton
            to="/getting-started/quick-start"
            size="xl"
            color="neutral"
            trailing-icon="i-lucide-arrow-right"
          >
            quick start
          </UButton>
          <UButton
            to="https://npmx.dev/package/forges"
            target="_blank"
            size="xl"
            color="neutral"
            variant="outline"
            icon="i-custom-npmx"
          >
            view on npmx
          </UButton>
        </div>
      </div>
    </UPageSection>
  </div>
</template>
