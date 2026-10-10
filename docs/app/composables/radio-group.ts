import type { Ref } from 'vue'

/**
 * Keyboard handling for buttons with `role="radio"`: the group is one tab stop, and the arrow keys move
 * the selection, as in a native radio group. Bind `onKeydown` to the group and `tabindex()` to each radio.
 */
export function useRadioGroup<T>(selected: Ref<T>, values: () => readonly T[]) {
  function onKeydown(event: KeyboardEvent) {
    const list = values()
    const index = list.indexOf(selected.value)
    const next = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key]
    if (next === undefined) {
      return
    }
    event.preventDefault()
    selected.value = list[(next + list.length) % list.length]!
    // `currentTarget` is gone once the event is dispatched, so keep the group for after the render.
    const group = event.currentTarget as HTMLElement
    nextTick(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
  }

  return { onKeydown, tabindex: (value: T) => (value === selected.value ? 0 : -1) }
}
