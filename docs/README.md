# forges docs

The documentation site for `forges`, built with [Docus](https://docus.dev).

```sh
pnpm --filter forges-docs dev
pnpm --filter forges-docs build
```

- `content/` holds the pages, grouped as getting started, guides, concepts, providers, reference, examples and contributing.
- `content/index.md` renders the landing page from `app/components/content/LandingPage.vue`. Its parts live in `app/components/landing/`.
- `app/components/app/AppHeader.vue` copies the Docus header to add the npmx link.
- The provider pages and `content/5.reference/2.capability-matrix.md` hold generated capability tables. Run `pnpm capability-matrix` from the repository root after you change a provider.
