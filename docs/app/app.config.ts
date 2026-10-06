export default defineAppConfig({
  search: {
    fts: true,
  },
  seo: {
    title: 'forges',
    schema: {
      type: 'SoftwareApplication',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      price: 0,
      priceCurrency: 'USD',
      sameAs: [
        'https://github.com/danielroe/forges',
        'https://www.npmjs.com/package/forges',
        'https://npmx.dev/package/forges',
      ],
    },
  },
  header: {
    title: 'forges',
  },
  github: {
    url: 'https://github.com/danielroe/forges',
    branch: 'main',
    rootDir: 'docs',
  },
  toc: {
    bottom: {
      links: [
        {
          icon: 'i-simple-icons-github',
          label: 'GitHub repository',
          to: 'https://github.com/danielroe/forges',
          target: '_blank',
        },
        {
          icon: 'i-custom-npmx',
          label: 'Package on npmx',
          to: 'https://npmx.dev/package/forges',
          target: '_blank',
        },
      ],
    },
  },
  ui: {
    header: {
      slots: {
        // Translucent, so the hero shows through.
        root: 'bg-default/20 backdrop-blur-lg border-default/50',
      },
    },
    contentSearchButton: {
      slots: {
        base: 'bg-default/30 hover:bg-default/50 backdrop-blur-md ring ring-inset ring-default/60',
      },
    },
    prose: {
      pre: {
        // Long lines scroll.
        slots: { base: 'whitespace-pre' },
      },
    },
    colors: {
      primary: 'orange',
      secondary: 'rose',
    },
    pageCard: {
      slots: {
        container: 'lg:flex min-w-0',
        wrapper: 'flex-none',
      },
    },
  },
})
