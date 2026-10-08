<script setup lang="ts">
const props = defineProps<{
  html: string
  label: string
}>()

const viewer = useTemplateRef<HTMLDivElement>('viewer')
const active = shallowRef<HTMLElement | null>(null)
const typeInfo = ref('')
const overPopup = ref(false)
let closing: ReturnType<typeof setTimeout> | undefined

function hover(element: HTMLElement | null) {
  clearTimeout(closing)
  if (element) {
    active.value = element
    return
  }
  closing = setTimeout(() => {
    if (!overPopup.value) {
      active.value = null
    }
  }, 150)
}

function onPointerOver(event: PointerEvent) {
  if (event.pointerType !== 'touch') {
    hover(event.target instanceof Element ? event.target.closest<HTMLElement>('.twoslash-hover') : null)
  }
}

function onPopupLeave() {
  overPopup.value = false
  hover(null)
}

watch(active, (element, previous) => {
  previous?.removeAttribute('data-active')
  element?.setAttribute('data-active', '')
  typeInfo.value = element?.querySelector('.twoslash-popup-container')?.innerHTML ?? ''
})

watch(() => props.html, () => {
  active.value = null
  viewer.value?.scrollTo({ top: 0, left: 0 })
  if (viewer.value) {
    syncScrollable(viewer.value)
  }
}, { flush: 'post' })

onMounted(() => {
  if (!viewer.value) {
    return
  }
  syncScrollable(viewer.value)
  const observer = new ResizeObserver(() => viewer.value && syncScrollable(viewer.value))
  observer.observe(viewer.value)
  onBeforeUnmount(() => observer.disconnect())
})

onBeforeUnmount(() => clearTimeout(closing))
</script>

<template>
  <figure class="overflow-hidden rounded-xl border border-default/70 bg-elevated/30">
    <figcaption class="sr-only">
      {{ label }}
    </figcaption>
    <div
      v-if="$slots.header"
      class="border-b border-default/70 bg-default/50 px-3"
    >
      <slot name="header" />
    </div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div
      ref="viewer"
      class="code-viewer syntax-code h-80 overflow-auto p-6 font-mono text-[13px] leading-6 sm:p-8"
      role="region"
      :aria-label="label"
      @pointerover="onPointerOver"
      @pointerleave="hover(null)"
      @scroll="active = null"
      @keydown.esc="active = null"
      v-html="html"
    />
    <UTooltip
      :reference="active ?? undefined"
      :open="Boolean(active && typeInfo)"
      :content="{ side: 'top', align: 'start', sideOffset: 6, collisionPadding: 16, hideWhenDetached: true }"
      :ui="{ content: 'code-type-popup syntax-code block h-auto max-h-[min(28rem,60vh)] w-max max-w-[min(42rem,calc(100vw-2rem))] select-text overflow-auto rounded-lg bg-elevated px-4 py-3 text-default shadow-lg ring-default' }"
    >
      <span
        class="hidden"
        aria-hidden="true"
      />
      <template #content>
        <!-- eslint-disable vue/no-v-html -->
        <div
          class="font-mono text-xs leading-5"
          @pointerenter="overPopup = true"
          @pointerleave="onPopupLeave"
          v-html="typeInfo"
        />
        <!-- eslint-enable vue/no-v-html -->
      </template>
    </UTooltip>
  </figure>
</template>

<style>
.code-viewer > pre {
  width: max-content;
  min-width: 100%;
  margin: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

.code-viewer:focus-visible {
  outline-offset: -2px;
}

.code-viewer .twoslash-popup-container {
  display: none;
}

.code-viewer .twoslash-hover {
  cursor: help;
  border-radius: 3px;
  transition: background-color 120ms ease;
}

.code-viewer .twoslash-hover:is(:hover, [data-active]) {
  background-color: color-mix(in oklab, var(--ui-primary) 12%, transparent);
}

.code-type-popup :is(.twoslash-popup-code, pre) {
  display: block;
  margin: 0;
  white-space: pre;
  font-family: var(--font-mono);
}

.code-type-popup .twoslash-popup-docs {
  max-width: 36rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--ui-border);
  white-space: normal;
  font-family: var(--font-sans);
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--ui-text-muted);
}

.code-type-popup .twoslash-popup-docs-tags {
  display: none;
}
</style>
