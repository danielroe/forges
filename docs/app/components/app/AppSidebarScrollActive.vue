<script setup lang="ts">
const route = useRoute()

const MAX_ATTEMPTS = 30

/**
 * Scroll the sidebar so the active link is visible.
 * The sidebar may not be laid out yet (layout switch, page transition), so retry for a few frames.
 */
function revealActiveLink(attempt = 0) {
  const link = document.querySelector<HTMLElement>(`aside a[href="${CSS.escape(route.path)}"]`)
  const container = link?.closest<HTMLElement>('aside')
  const linkRect = link?.getBoundingClientRect()
  const containerRect = container?.getBoundingClientRect()

  if (!link || !container || !linkRect?.height || !containerRect?.height) {
    if (attempt < MAX_ATTEMPTS)
      requestAnimationFrame(() => revealActiveLink(attempt + 1))
    return
  }

  if (linkRect.top >= containerRect.top && linkRect.bottom <= containerRect.bottom)
    return

  container.scrollTop += linkRect.top - containerRect.top - (containerRect.height - linkRect.height) / 2
}

onMounted(() => revealActiveLink())

watch(() => route.path, () => nextTick(() => revealActiveLink()))
</script>

<template>
  <span hidden />
</template>
