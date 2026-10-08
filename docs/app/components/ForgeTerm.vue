<script setup lang="ts">
const id = useId()
const definition = 'A service that hosts Git repositories and the collaboration around them: issues, pull requests, reviews and CI. GitHub, GitLab and Codeberg are forges.'
const focusOpen = ref(false)
const hoverOpen = ref(false)
const open = computed({
  get: () => focusOpen.value || hoverOpen.value,
  set: (value: boolean) => { hoverOpen.value = value },
})

function close() {
  focusOpen.value = false
  hoverOpen.value = false
}
</script>

<template>
  <!-- Hover cards are invisible to screen readers. aria-describedby can still reference the hidden span. -->
  <UPopover
    v-model:open="open"
    mode="hover"
    enable-touch
    :open-delay="200"
    :content="{ side: 'top' }"
  >
    <dfn
      tabindex="0"
      :aria-describedby="id"
      class="cursor-help not-italic underline decoration-dotted decoration-from-font underline-offset-4"
      @focus="focusOpen = true"
      @blur="focusOpen = false"
      @keydown.esc="close"
    ><slot>forge</slot></dfn>
    <template #content>
      <p class="max-w-xs p-3 text-left text-sm text-muted">
        {{ definition }}
      </p>
    </template>
  </UPopover>
  <span
    :id="id"
    hidden
  >{{ definition }}</span>
</template>
