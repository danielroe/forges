<script setup lang="ts">
const features = [
  {
    icon: 'i-lucide-shapes',
    title: 'one data model',
    description: 'Issues, pull requests, comments, checks and events have the same shape on every forge. The original payload is in the raw field.',
    to: '/concepts/data-model',
  },
  {
    icon: 'i-lucide-list-checks',
    title: 'declared capabilities',
    description: 'Each provider declares what it supports, and CI checks the claims against the tests. Call provider.can() to check support before you call an operation.',
    to: '/concepts/capabilities',
  },
  {
    icon: 'i-lucide-webhook',
    title: 'verified webhooks',
    description: 'The provider verifies each delivery and turns it into typed events, with the same kinds and actions on every forge.',
    to: '/guides/webhooks',
  },
  {
    icon: 'i-lucide-package',
    title: 'small bundles',
    description: 'Import one forge from its subpath. Lite factories leave out webhook code. The GitHub Lite provider is about 24 kB gzipped.',
    to: '/guides/bundling',
  },
  {
    icon: 'i-lucide-flask-conical',
    title: 'offline tests',
    description: 'Run your tests against an in-memory forge or replayed responses, with no network.',
    to: '/guides/testing',
  },
  {
    icon: 'i-lucide-shield-check',
    title: 'typed errors and retries',
    description: 'Rate limits, revoked tokens and missing scopes have their own error classes. After a short rate limit, the provider retries once.',
    to: '/guides/errors',
  },
]

const projects = [
  {
    icon: 'i-lucide-inbox',
    title: 'a notification inbox',
    description: 'Merge the notifications from every forge you configure into one list.',
    to: '/examples/inbox-cli',
  },
  {
    icon: 'i-lucide-tag',
    title: 'a label bot',
    description: 'Label new threads and close them from a comment command, on any forge.',
    to: '/examples/label-bot',
  },
  {
    icon: 'i-lucide-newspaper',
    title: 'a release digest',
    description: 'Show the latest release and failing pull requests across repositories.',
    to: '/examples/release-digest',
  },
  {
    icon: 'i-lucide-radio',
    title: 'a webhook receiver',
    description: 'Turn deliveries from any forge into one event type.',
    to: '/guides/webhooks',
  },
]

const manyForges = `import { createForges, forgejo, github, gitlab } from 'forges'

const forges = createForges([
  github({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } }),
  gitlab({ auth: { type: 'token', token: process.env.GITLAB_TOKEN! } }),
  forgejo({ baseUrl: 'https://codeberg.org', auth: { type: 'token', token: process.env.CODEBERG_TOKEN! } }),
])

for await (const notification of forges.notifications.list()) {
  console.log(notification.ref.forge, notification.title)
}`

const webhook = `import { github } from 'forges/github'

const forge = github({ webhookSecret: process.env.GITHUB_WEBHOOK_SECRET }).create()

export default async function handler(request: Request) {
  const events = await forge.webhooks.ingest({ headers: request.headers, body: await request.text() })
  for (const event of events) {
    console.log(event.kind, event.action, event.summary)
  }
  return new Response(null, { status: 204 })
}`
</script>

<template>
  <!-- Narrower container than the Docus default. The hero stays full width. -->
  <div class="[--ui-container:72rem]">
    <LandingHero />

    <UPageSection
      :ui="{ container: 'py-12 sm:py-16 lg:py-20' }"
      title="what the providers handle"
      description="You write code against the shared model. Each provider handles the endpoints, pagination, authentication and rate limits of its forge."
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
      :ui="{ container: 'py-12 sm:py-16 lg:py-20' }"
      title="the same code on every forge"
      description="Register as many providers as you need. Each call goes to the provider that matches its ref."
    >
      <div class="grid gap-6 lg:grid-cols-2">
        <LazyLandingCode
          label="Notifications from three forges"
          :code="manyForges"
          hydrate-never
        />
        <LazyLandingCode
          label="A verified webhook endpoint"
          :code="webhook"
          hydrate-never
        />
      </div>
    </UPageSection>

    <UPageSection
      :ui="{ container: 'py-12 sm:py-16 lg:py-20' }"
      title="see what each forge can do"
      description="Every provider declares what it supports, so your code can check before it calls."
    >
      <LazyLandingCapabilityGrid hydrate-never />

      <div class="mt-10 flex justify-center">
        <UButton
          to="/reference/capability-matrix"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        >
          read the full matrix
        </UButton>
      </div>
    </UPageSection>

    <UPageSection
      :ui="{ container: 'py-12 sm:py-16 lg:py-20' }"
      title="what you can build"
      description="Explore examples and guides for your next project."
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

    <UPageSection :ui="{ container: 'py-12 sm:py-16 lg:py-24' }">
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
