export function useHeaderLinks() {
  const appConfig = useAppConfig()
  return computed(() => [
    ...(appConfig.github && appConfig.github.url
      ? [{
          'icon': 'i-simple-icons-github',
          'to': appConfig.github.url,
          'target': '_blank',
          'aria-label': 'forges on GitHub',
        }]
      : []),
    {
      'icon': 'i-custom-npmx',
      'to': 'https://npmx.dev/package/forges',
      'target': '_blank',
      'aria-label': 'forges on npmx',
    },
  ])
}
