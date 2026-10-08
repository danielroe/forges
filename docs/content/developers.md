---
title: Developers
description: Install forges, get credentials, try calls in a sandbox and connect an AI agent.
icon: i-lucide-code
navigation: false
---

`forges` is a TypeScript library that runs inside your own code and calls each forge directly. This means there is nothing to sign up for. You don't need a forges account or a forges API key, because every provider sends the credentials of its own forge.

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

Each provider takes the credentials of its forge in the `auth` option. Most forges accept a token, and some also accept a username and password, an app or OAuth. If you leave out `auth`, you can still make public reads without any credentials.

To find out more, start with one of these pages:

- [Authenticate](/guides/authentication) covers each type of credential and how to restrict a provider to reads.
- The [provider page](/providers) for your forge lists the types of credentials that it accepts.
- [Configure from the environment](/guides/environment) shows how to read credentials from environment variables.

## Try calls in a sandbox

Before you connect a real forge, you can try the API against `forges/fake`. It is an in-memory forge with the full provider API, and it needs neither credentials nor a network connection:

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

Every write updates `sandbox.store` and adds an event to `sandbox.store.events`, so you can see what your code did. The same forge is useful in your tests, and so are responses recorded from a real forge. [Test your code](/guides/testing) explains both.

## Reference

When you need to look something up, these pages have the details:

- [API reference](/reference/overview) lists every export, and every namespace and method on a provider.
- [Capability matrix](/reference/capability-matrix) shows which operations each forge supports.
- [Errors](/reference/errors) lists every error class that `forges` throws.
- [Environment variables](/reference/environment-variables) lists every variable that `forges/env` reads.
- [JSON Schemas](/reference/json-schemas) has a schema for each public type of the data model.

## Connect an AI agent

The documentation is also available in forms that suit AI agents:

- [`/llms.txt`](/llms.txt) lists every page of the documentation, and [`/llms-full.txt`](/llms-full.txt) contains all of it in one file.
- Every page has a Markdown version. To get it, append `.md` to the URL of the page, or send an `Accept: text/markdown` header.
- `https://forges.link/mcp` is an MCP server for the documentation, with tools and resources. It uses streamable HTTP and needs no authentication.
- [`/openapi.json`](/openapi.json) describes the routes that this site serves to agents, and `/.well-known/api-catalog` lists the service documents.
