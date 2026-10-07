const MESSAGES = {
  copied: 'Copied to the clipboard',
  failed: 'Could not copy to the clipboard',
}

export function useCopyToClipboard(getText: () => string) {
  const state = ref<keyof typeof MESSAGES>()
  const copied = computed(() => state.value === 'copied')
  const message = computed(() => state.value ? MESSAGES[state.value] : '')
  let timer: ReturnType<typeof setTimeout> | undefined

  async function copy() {
    try {
      await navigator.clipboard.writeText(getText())
      state.value = 'copied'
    }
    catch {
      state.value = 'failed'
    }
    clearTimeout(timer)
    timer = setTimeout(() => (state.value = undefined), 2000)
  }

  onScopeDispose(() => clearTimeout(timer))

  return { copied, copy, message }
}
