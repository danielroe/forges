---
title: Developers
description: Install forges, get credentials, try calls in a sandbox and connect an AI agent.
icon: i-lucide-code
navigation: false
---

`forges` is a TypeScript library that runs in your code and calls each forge directly. You don't need a forges account or a forges API key. Each provider sends the credentials of its own forge.

## Start building

::card-group
  ::card{title="Installation" icon="i-lucide-download" to="/getting-started/installation"}
  Add the package and pick an import path.
  ::

  ::card{title="Quick start" icon="i-lucide-terminal" to="/getting-started/quick-start"}
  Read an issue, write a comment and add a second forge.
  ::
::

## Get credentials

Each provider takes the credentials of its forge in the `auth` option. Most forges accept a token. Some also accept a username and password, an app or OAuth. Leave out `auth` to make public reads with no credentials.

- [Authenticate](/guides/authentication) covers each credential type and read-only providers.
- The [provider page](/providers) for your forge lists the credential types it accepts.
- [Configure from the environment](/guides/environment) reads credentials from environment variables.

## Try calls in a sandbox

`forges/fake` is an in-memory forge with the full provider API. It needs no credentials and no network, so you can try calls against it before you connect a real forge:

```ts
import { fake } from 'forges/fake'

const sandbox = fake({
  seed: {
    threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Crash on start' }],
  },
})
const forge = sandbox.create()

const repo = {
  forge: 'fake',
  instance: 'fake.test',
  owner: 'acme',
  name: 'widgets',
} as const

for await (const issue of forge.threads.list(repo, { kind: 'issue' })) {
  await forge.threads.comment(issue.ref, 'Thanks for the report.')
}

console.log(sandbox.store.events)
```

Every write updates `sandbox.store` and adds an event to `sandbox.store.events`. To run your tests against the sandbox or against recorded responses from a real forge, read [Test your code](/guides/testing).

## Reference

- [API reference](/reference/overview): every export, and every namespace and method on a provider
- [Capability matrix](/reference/capability-matrix): which operations each forge supports
- [Errors](/reference/errors): every error class that forges throws
- [Environment variables](/reference/environment-variables): every variable that `forges/env` reads
- [JSON Schemas](/reference/json-schemas): a schema for each public model type

## Connect an AI agent

- [`/llms.txt`](/llms.txt) lists every page of the documentation, and [`/llms-full.txt`](/llms-full.txt) has all of it in one file.
- Each page has a Markdown version. Append `.md` to the page URL, or send `Accept: text/markdown`.
- `https://forges.link/mcp` is an MCP server for these docs, with tools and resources. It uses streamable HTTP and needs no authentication.
- [`/openapi.json`](/openapi.json) describes the routes that this site serves to agents. `/.well-known/api-catalog` lists the service documents.
