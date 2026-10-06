<script setup lang="ts">
interface Contributor {
  login: string
  avatar_url: string
  html_url: string
  contributions: number
  type: string
}

const repository = 'danielroe/forges'

// Fetched at build time. A private repository needs a GITHUB_TOKEN with read access.
const { data: contributors } = await useAsyncData('contributors', async () => {
  const token = import.meta.server ? useRuntimeConfig().githubToken : ''
  try {
    const list = await $fetch<Contributor[]>(`https://api.github.com/repos/${repository}/contributors`, {
      query: { per_page: 100 },
      headers: { Accept: 'application/vnd.github+json', ...token ? { Authorization: `Bearer ${token}` } : {} },
    })
    return list.filter(contributor => contributor.type === 'User')
  }
  catch {
    return []
  }
})
</script>

<template>
  <ul
    v-if="contributors?.length"
    class="my-8 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4"
  >
    <li
      v-for="contributor of contributors"
      :key="contributor.login"
    >
      <a
        :href="contributor.html_url"
        target="_blank"
        rel="noopener"
        class="group flex items-center gap-3 rounded-lg border border-default p-3 transition hover:border-accented hover:bg-elevated/50"
      >
        <img
          :src="`${contributor.avatar_url}&s=96`"
          alt=""
          width="40"
          height="40"
          loading="lazy"
          class="size-10 rounded-full"
        >
        <span class="min-w-0">
          <span class="block truncate text-sm font-medium text-highlighted">{{ contributor.login }}</span>
          <span class="block text-xs whitespace-nowrap text-muted">{{ contributor.contributions }} {{ contributor.contributions === 1 ? 'commit' : 'commits' }}</span>
        </span>
      </a>
    </li>
  </ul>
  <p
    v-else
    class="my-8 text-muted"
  >
    The contributor list is unavailable. See the
    <a
      :href="`https://github.com/${repository}/graphs/contributors`"
      target="_blank"
      rel="noopener"
      class="text-primary underline"
    >contributors on GitHub</a>.
  </p>
</template>
