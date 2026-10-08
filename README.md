# forges

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

One client, every forge.

`forges` is a TypeScript library for working with issues, pull requests, notifications, checks and webhooks on ten forges: GitHub, GitLab, Bitbucket, Forgejo, Gitea, Gitee, Azure DevOps, Cursor Origin, Tangled and Pushin.eu. A forge is a service that hosts Git repositories and the collaboration around them. Each provider normalises the forge's responses into one data model and declares which operations it supports.

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
  github({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } }),
  forgejo({ baseUrl: 'https://codeberg.org', auth: { type: 'token', token: process.env.CODEBERG_TOKEN! } }),
])

for await (const notification of forges.notifications.list()) {
  console.log(notification.ref.forge, notification.title)
}
```

The [quick start](https://forges.link/getting-started/quick-start) walks through reading a thread, writing a comment and checking what a forge supports.

## documentation

- [Getting started](https://forges.link/getting-started/introduction): installation, import paths and a first call.
- [Guides](https://forges.link/guides/authentication): authentication, several forges, environment variables, webhooks, capabilities, errors, pagination, browser bundles and testing.
- [Concepts](https://forges.link/concepts/data-model): the data model, capabilities, providers and events.
- [Providers](https://forges.link/providers): authentication and behaviour specific to each forge.
- [Reference](https://forges.link/reference/overview): the API, the capability matrix, errors and JSON schemas.
- [Examples](https://forges.link/examples): small, tested projects that use `forges`.

## related projects

- [`@agntn/forges`](https://github.com/agntn/forges): a TypeScript API for GitHub, GitLab, Gitea, Forgejo and GitBucket, with an MCP server and Pi and OMP extensions for agents.
- [`git-pkgs/forge`](https://github.com/git-pkgs/forge): a Go library and CLI for GitHub, GitLab, Gitea, Forgejo, Bitbucket Cloud, Gerrit and Tangled.

## contributing

Read the [contribution guide](./CONTRIBUTING.md) to set up the repository and run the checks.

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
