/**
 * Which credential the capability tables show, kept in `?auth=`: `undefined`
 * for the best of any credential, `'anonymous'` for none, or a credential id.
 */
export function useCredentialView() {
  const route = useRoute()
  const view = ref<string>()

  onMounted(() => {
    view.value = typeof route.query.auth === 'string' ? route.query.auth : undefined
    watch(view, (value) => {
      const url = new URL(window.location.href)
      if (value) {
        url.searchParams.set('auth', value)
      }
      else {
        url.searchParams.delete('auth')
      }
      // `router.replace()` would scroll back to the URL's hash on every change.
      window.history.replaceState(window.history.state, '', url)
    })
  })

  return view
}

/** Whether the capability tables show what an anonymous provider supports, kept in `?auth=anonymous`. */
export function useAnonymousView() {
  const view = useCredentialView()
  return computed({
    get: () => view.value === 'anonymous',
    set: (anonymous) => {
      view.value = anonymous ? 'anonymous' : undefined
    },
  })
}
