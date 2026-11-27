# forges

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

One client, every forge.

`forges` is a TypeScript library for working with issues, pull requests, notifications, checks and webhooks on fourteen forges: GitHub, GitLab, Bitbucket, Forgejo, Gitea, Gitee, Azure DevOps, Cursor Origin, Tangled, Pushin.eu, Sourcehut, GitBucket, GitCafe and Upstream. A forge is a service that hosts Git repositories and the collaboration around them. It also reads repositories and their contents from Git hosts without the collaboration, such as Cloudflare Artifacts. Each provider normalises the forge's responses into one data model and declares which operations it supports.

Read the documentation at [forges.link](https://forges.link).

## install

```sh
pnpm add forges
```

`forges` requires Node.js 22.18 or later.

## usage

```ts
import { createForges, forgejo, github } from 'forges'

const forges = createForges([
  github({
    auth: { type: 'token', token: process.env.GITHUB_TOKEN! }
  }),
  forgejo({
    baseUrl: 'https://codeberg.org',
    auth: { type: 'token', token: process.env.CODEBERG_TOKEN! }
  }),
])

for await (const notification of forges.notifications.list()) {
  console.log(notification.ref.forge, notification.title)
}
```

The example above lists the notifications of two forges in a single loop. To go further, the [quick start](https://forges.link/getting-started/quick-start) walks you through reading a thread, writing a comment and checking what a forge supports.

## documentation

- [Getting started](https://forges.link/getting-started/introduction) covers installation, import paths and a first call.
- The [guides](https://forges.link/guides/authentication) explain authentication, working with several forges, environment variables, webhooks, capabilities, errors, pagination, browser bundles and testing.
- The [concepts](https://forges.link/concepts/data-model) describe the data model, capabilities, providers and events.
- Each [provider page](https://forges.link/providers) explains how to authenticate and how that forge behaves.
- The [reference](https://forges.link/reference/overview) lists the API, the capability matrix, errors and JSON schemas.
- The [examples](https://forges.link/examples) are small, tested projects that use `forges`.

## agents and nerds

Want forges from an agent or your terminal? [`@agntn/forges`](https://github.com/agntn/forges) is a separate package that builds on `forges` and has a very similar API. It's built by a contributor to this repository. It brings a CLI and agent tools. Agents and nerds, same test bench.

Pass nothing and [`@agntn/credentials`](https://github.com/agntn/credentials) finds tokens on your machine. It checks environment variables, forge CLI logins like `gh` or `glab`, then their config files. Already logged in? No keys to paste, and your first call should just work.

It's experimental and keeps changing, but it's battle tested across agent harnesses and model providers. Better yet, bugs found there become improvements here. CLI or agent integration issues belong in [agntn/forges issues](https://github.com/agntn/forges/issues), not here.

## related projects

- [`git-pkgs/forge`](https://github.com/git-pkgs/forge): a Go library and CLI for GitHub, GitLab, Gitea, Forgejo, Bitbucket Cloud, Gerrit and Tangled.

## contributing

Contributions are welcome. The [contribution guide](./CONTRIBUTING.md) explains how to set up the repository and run the checks.

## licence

Made with ❤️

Published under the [MIT licence](./LICENCE).

<!-- Badges -->

[npm-version-src]: https://npmx.dev/api/registry/badge/version/forges
[npm-version-href]: https://npmx.dev/package/forges
[npm-downloads-src]: https://npmx.dev/api/registry/badge/downloads/forges
[npm-downloads-href]: https://npm.chart.dev/forges
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/danielroe/forges/ci.yml?branch=main&style=flat-square
[github-actions-href]: https://github.com/danielroe/forges/actions?query=workflow%3Aci
[codecov-src]: https://img.shields.io/codecov/c/gh/danielroe/forges/main?style=flat-square
[codecov-href]: https://codecov.io/gh/danielroe/forges
