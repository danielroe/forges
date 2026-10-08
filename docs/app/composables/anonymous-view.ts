/** Whether the capability tables show what an anonymous provider supports, kept in `?auth=anonymous`. */
export function useAnonymousView() {
  const route = useRoute()
  const anonymous = ref(false)

  onMounted(() => {
    anonymous.value = route.query.auth === 'anonymous'
    watch(anonymous, (value) => {
      const url = new URL(window.location.href)
      if (value) {
        url.searchParams.set('auth', 'anonymous')
      }
      else {
        url.searchParams.delete('auth')
      }
      // `router.replace()` would scroll back to the URL's hash on every change.
      window.history.replaceState(window.history.state, '', url)
    })
  })

  return anonymous
}
