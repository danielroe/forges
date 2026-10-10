<script setup lang="ts" generic="T extends string">
/** Icon tabs that switch what a panel shows, such as the forge of a code example. Arrow keys move the selection. */
const props = defineProps<{
  /** `text` shows next to the icon; `label` names the tab for screen readers and in its tooltip. */
  items: Array<{ value: T, label: string, icon: string, text?: string }>
  /** Names the group for screen readers. */
  label: string
}>()

const selected = defineModel<T>({ required: true })
const radios = useRadioGroup(selected, () => props.items.map(item => item.value))
</script>

<template>
  <div
    class="flex min-w-0 items-center gap-1 overflow-x-auto"
    role="radiogroup"
    :aria-label="label"
    @keydown="radios.onKeydown"
  >
    <button
      v-for="item of items"
      :key="item.value"
      type="button"
      role="radio"
      :aria-checked="selected === item.value"
      :aria-label="item.label"
      :title="item.label"
      :tabindex="radios.tabindex(item.value)"
      class="switcher-tab relative flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-2 px-3 font-mono text-xs"
      :class="selected === item.value ? 'text-highlighted' : 'text-muted hover:text-highlighted'"
      @click="selected = item.value"
    >
      <UIcon
        :name="item.icon"
        class="size-4"
        aria-hidden="true"
      />
      <span v-if="item.text">{{ item.text }}</span>
    </button>
  </div>
</template>

<style scoped>
.switcher-tab[aria-checked='true'] {
  box-shadow: inset 0 -1px 0 var(--ui-primary);
}

.switcher-tab:focus-visible {
  outline-offset: -2px;
}
</style>
