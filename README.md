# forges

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

`forges` is a TypeScript library for working with issues, pull requests, notifications, checks, and webhooks on GitHub, GitLab, Bitbucket, Forgejo, Gitea, Gitee, Azure DevOps, Cursor Origin, Tangled, and pushin.eu. Each provider normalises the forge's responses into one data model and declares which operations it supports.

## Install

```sh
pnpm add forges
```

`forges` requires Node.js 22.18 or later.

## Usage

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

`github()` and the other provider functions return a factory. `createForges()` calls `create()` on each factory. No request goes out until you call a method.

To work with one forge, call `create()` yourself:

```ts
import { github } from 'forges/github'

const gh = github({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } }).create()
const repo = { forge: 'github', instance: 'github.com', owner: 'nuxt', name: 'nuxt' } as const

const thread = await gh.threads.get({ forge: 'github', instance: 'github.com', repo, kind: 'issue', number: '1' })
await gh.threads.comment(thread.ref, 'Thanks for the report.')
```

Each provider has its own subpath export (`forges/github`, `forges/gitlab`, and so on). A bundle that imports one subpath contains one forge.

### Credentials

Each [provider page](#providers) lists the `auth` types that forge accepts. Two options apply to every provider:

- Leave out `auth` for an anonymous provider. It sends no credentials and makes public reads only. Writes, notifications, and subscriptions report `false`.
- Set `readOnly: true` to use a credential for reads only. Every write reports `false` and rejects with `ReadOnlyError`, including `provider.request()` with a method other than `GET`, `HEAD` or `OPTIONS`. Pass `mutates: false` for a request that only reads, such as a GraphQL query. This guard relies on the caller's declaration; it does not restrict the credential's server-side permissions.

```ts
import { github, gitlab } from 'forges'

const publicGitHub = github({}).create()
const audit = gitlab({ auth: { type: 'token', token: process.env.GITLAB_TOKEN! }, readOnly: true }).create()
```

`provider.scopesFor(verb)` returns the token scopes or app permissions that an operation needs on that forge. You can show them on a consent screen or in an error message.

### Errors and retries

Failed requests reject with a typed error, such as `RateLimitedError`, `TokenRevokedError`, or `ForbiddenError`. All of them extend `ForgeError`.

When a forge rate-limits a request and sets `retry-after` to one minute or less, the provider waits that long and retries once. Pass `onRetry` to log or count these retries.

## Capabilities

`provider.capabilities` describes what a provider supports. The provider computes it without a network request. Each entry has one of four values:

| Value | Meaning |
| --- | --- |
| `true` | Native and verified. A test exercises the operation. |
| `'experimental'` | Native, but not verified against a recording of the live forge, or built on an API that the forge marks unstable. |
| `'emulated'` | Composed from other calls, so its behaviour can differ from a native operation. |
| `false` | Not available. Calling it rejects with `UnsupportedOperationError`. |

For example, Forgejo has no done state for notifications. Its `notifications.markDone` is `'emulated'`: it marks the notification read and unsubscribes from the thread.

Call `provider.can()` before an operation. Pass the thread kind when support differs by kind:

```ts
if (gh.can('threads.addLabels', thread.ref.kind)) {
  await gh.threads.addLabels(thread.ref, ['triage'])
}
```

`supports(capabilities, verb, kind?)` returns the same result simply based on a capabilities object. Use it with capabilities that you stored or received from another process.

`capabilities.experimental` is `true` when the provider as a whole is experimental: its tests use hand-written fixtures only, or the forge's API is unstable. Gitee, Azure DevOps, Cursor Origin, and pushin.eu are experimental providers.

Some capabilities depend on the instance version. For example, GitHub Enterprise Server supports marking notifications done from version 3.13. Pass `instanceVersion` if you know it. Otherwise, call `refreshCapabilities()`, which makes at most one request.

CI enforces every `true` entry. During `vitest run`, `test/setup/verbs.ts` records each verb a test calls. `pnpm test:capabilities` then runs `scripts/check-capabilities.ts`, which fails for any capability that a provider declares `true` and no test called.

<details>
<summary>Capability matrix</summary>

The GitHub column assumes app auth with an installation. With a token, `installations` is `❌`. The Tangled column assumes that `notificationsUrl` is set.

<!-- capabilities:start -->
| Capability | GitHub | GitLab | Bitbucket | Forgejo | Gitea | Gitee | Azure DevOps | Cursor Origin | pushin.eu | Tangled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `experimental` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `sources.poll` | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `sources.webhook` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `sources.subscribe` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `repos.get` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `users.get` | ✅ | ✅ | ❌ | ✅ | ✅ | experimental | ❌ | ❌ | ❌ | ❌ |
| `repos.list` | ✅ | ✅ | experimental | ✅ | ✅ | experimental | experimental | experimental | experimental | experimental |
| `repos.labels` | ✅ | ✅ | ❌ | ✅ | ✅ | experimental | ❌ | ❌ | ✅ | ❌ |
| `repos.createLabel` | experimental | experimental | ❌ | experimental | experimental | experimental | ❌ | ❌ | ❌ | ❌ |
| `repos.milestones` | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `repos.collaborators` | ✅ | ✅ | ❌ | ✅ | ✅ | experimental | ❌ | ❌ | experimental | ❌ |
| `repos.permissionFor` | ✅ | ✅ | ❌ | experimental | experimental | ❌ | ❌ | ❌ | ❌ | ❌ |
| `repos.addCollaborator` | experimental | experimental | ❌ | experimental | experimental | ❌ | ❌ | ❌ | ❌ | ❌ |
| `repos.assignableUsers` | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `repos.reviewerCandidates` | emulated | emulated | ❌ | experimental | experimental | ❌ | ❌ | ❌ | ❌ | ❌ |
| `threads.get` | issue, PR, discussion, commit (experimental) | issue, PR, commit (experimental) | issue (experimental), PR, commit (experimental) | issue, PR, commit (experimental) | issue, PR, commit (experimental) | issue (experimental), PR | issue (experimental), PR | PR | issue, PR (experimental) | issue, PR |
| `threads.list` | issue, PR, discussion | issue, PR | issue (experimental), PR | issue, PR | issue, PR | issue (experimental), PR | issue, PR | PR | issue, PR (experimental) | issue (experimental), PR |
| `threads.getMany` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `comments.list` | issue, PR, discussion, commit (experimental) | issue, PR, commit (experimental) | issue (experimental), PR, commit (experimental) | issue, PR | issue, PR | issue (experimental), PR | issue (experimental), PR | PR | issue, PR (experimental) | issue, PR |
| `comments.edit` | issue (experimental), PR, discussion (experimental), commit (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental), commit (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | PR (experimental) | ❌ | issue (experimental), PR (experimental) |
| `comments.delete` | issue (experimental), PR, discussion (experimental), commit (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental), commit (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | PR (experimental) | ❌ | issue (experimental), PR (experimental) |
| `reactions.list` | issue, PR, discussion | issue, PR | ❌ | issue, PR | issue, PR | ❌ | ❌ | ❌ | ❌ | ❌ |
| `notifications.list` | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | experimental | experimental |
| `notifications.markRead` | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | experimental |
| `notifications.markDone` | ✅ | ✅ | ❌ | emulated | emulated | ❌ | ❌ | ❌ | ❌ | ❌ |
| `notifications.unsubscribe` | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `notifications.markAllRead` | ✅ | ❌ | ❌ | ✅ | ✅ | experimental | ❌ | ❌ | ❌ | experimental |
| `notifications.markAllDone` | ❌ | experimental | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `notifications.unreadCount` | ❌ | ✅ | ❌ | ✅ | ✅ | experimental | ❌ | ❌ | ❌ | experimental |
| `writes.comment` | issue (experimental), PR, discussion, commit (experimental) | issue (experimental), PR, commit (experimental) | issue (experimental), PR, commit (experimental) | issue (experimental), PR | issue (experimental), PR | issue (experimental), PR | issue (experimental), PR | PR | ❌ | issue (experimental), PR |
| `writes.upsertComment` | issue (emulated), PR (emulated), discussion (emulated), commit (emulated) | issue (emulated), PR (emulated) | issue (emulated), PR (emulated), commit (emulated) | issue (emulated), PR (emulated) | issue (emulated), PR (emulated) | issue (emulated), PR (emulated) | issue (emulated), PR (emulated) | PR (emulated) | ❌ | issue (emulated), PR (emulated) |
| `writes.close` | issue, PR, discussion | issue (experimental), PR | issue (experimental), PR | issue (experimental), PR | issue (experimental), PR | issue, PR | issue, PR | PR | ❌ | issue (experimental), PR |
| `writes.reopen` | issue (experimental), PR, discussion | issue (experimental), PR | issue (experimental) | issue (experimental), PR | issue (experimental), PR | issue (experimental), PR | issue (experimental), PR | PR | ❌ | issue (experimental), PR |
| `writes.create` | issue, PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | PR (experimental) | ❌ | issue (experimental) |
| `writes.update` | issue (experimental), PR, discussion (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | PR (experimental) | ❌ | issue (experimental), PR (experimental) |
| `writes.setLabels` | issue (experimental), PR | issue (experimental), PR (experimental) | ❌ | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | PR (experimental) | ❌ | ❌ |
| `writes.addLabels` | issue (experimental), PR | issue (experimental), PR (experimental) | ❌ | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | ❌ | ❌ | ❌ | ❌ |
| `writes.removeLabels` | issue (experimental), PR | issue (experimental), PR (experimental) | ❌ | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | ❌ | ❌ | ❌ | ❌ |
| `writes.setMilestone` | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | ❌ | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | ❌ | ❌ | ❌ | ❌ | ❌ |
| `writes.react` | issue (experimental), PR, discussion (experimental) | issue (experimental), PR (experimental) | ❌ | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | ❌ | ❌ | ❌ | ❌ | ❌ |
| `writes.assign` | issue (experimental), PR | issue (experimental), PR (experimental) | issue (experimental) | issue (experimental), PR (experimental) | issue (experimental), PR (experimental) | issue (experimental) | issue (experimental) | ❌ | ❌ | ❌ |
| `writes.requestReview` | PR | PR (experimental) | PR (experimental) | PR (experimental) | PR (experimental) | PR (experimental) | PR (experimental) | PR (experimental) | ❌ | ❌ |
| `writes.approveAndMerge` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `writes.transfer` | experimental | experimental | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `writes.markDuplicate` | experimental | emulated | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `subscriptions.get` | issue, PR, discussion | issue, PR | issue (experimental) | issue, PR | issue, PR | ❌ | ❌ | ❌ | ❌ | issue (experimental), PR (experimental) |
| `subscriptions.set` | issue, PR, discussion | issue, PR | issue (experimental) | issue, PR | issue, PR | ❌ | ❌ | ❌ | ❌ | issue (experimental), PR (experimental) |
| `installations` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `checks.thread` | PR | PR | PR | PR | PR | PR | PR | PR | ❌ | ❌ |
| `checks.list` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `checks.report` | ✅ | experimental | experimental | experimental | experimental | ❌ | experimental | ❌ | ❌ | ❌ |
| `checks.rerun` | ✅ | experimental | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `ci.runs` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `ci.run` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `ci.jobs` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `ci.log` | ✅ | experimental | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `contents.file` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `contents.tree` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `contents.branches` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `contents.tags` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `contents.resolveRef` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `contents.commits` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `contents.commit` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `contents.compare` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `contents.threadFiles` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | ❌ | experimental | ❌ | ❌ |
| `contents.threadCommits` | ✅ | ✅ | ✅ | ✅ | ✅ | experimental | experimental | experimental | ❌ | ❌ |
| `reviews.list` | ✅ | emulated | emulated | ✅ | ✅ | ❌ | emulated | ✅ | ❌ | ❌ |
| `reviews.create` | ✅ | emulated | emulated | experimental | experimental | emulated | emulated | experimental | ❌ | ❌ |
| `reviews.submit` | ✅ | ❌ | ❌ | experimental | experimental | ❌ | ❌ | ❌ | ❌ | ❌ |
| `reviews.approve` | ✅ | emulated | emulated | experimental | experimental | emulated | emulated | experimental | ❌ | ❌ |
| `reviews.resolveThread` | ✅ | experimental | ❌ | ❌ | ❌ | ❌ | experimental | experimental | ❌ | ❌ |
| `releases.list` | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `releases.get` | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `releases.latest` | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `releases.getByTag` | ✅ | ✅ | ❌ | ✅ | ✅ | experimental | ❌ | ❌ | ❌ | ❌ |
| `releases.downloadAsset` | ✅ | ❌ | ❌ | experimental | experimental | ❌ | ❌ | ❌ | ❌ | ❌ |
| `webhooks.list` | ✅ | experimental | experimental | experimental | experimental | experimental | ❌ | ❌ | ❌ | ❌ |
| `webhooks.create` | ✅ | experimental | experimental | experimental | experimental | experimental | ❌ | ❌ | ❌ | ❌ |
| `webhooks.update` | ✅ | experimental | experimental | experimental | experimental | experimental | ❌ | ❌ | ❌ | ❌ |
| `webhooks.delete` | ✅ | experimental | experimental | experimental | experimental | experimental | ❌ | ❌ | ❌ | ❌ |
| `webhooks.rotateSecret` | experimental | experimental | experimental | experimental | experimental | experimental | ❌ | ❌ | ❌ | ❌ |
| `webhooks.deliveries` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `webhooks.redeliver` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `search.threads` | ✅ | ✅ | experimental | ✅ | ✅ | experimental | experimental | ❌ | ❌ | ❌ |
| `search.repos` | ✅ | ✅ | experimental | ✅ | ✅ | experimental | ❌ | ❌ | ❌ | ❌ |
| `search.commits` | ✅ | experimental | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `securityAlerts` | dependency (experimental), code scanning (experimental), secret (experimental) | dependency (experimental), code scanning (experimental), secret (experimental) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `eventKinds` | native | heuristic | native | native | native | native | native | native | native | native |
| `auth` | `token`, `app`, `anonymous` | `token`, `anonymous` | `token`, `basic`, `anonymous` | `token`, `anonymous` | `token`, `anonymous` | `token`, `anonymous` | `token`, `basic`, `anonymous` | `token`, `app` | `token`, `anonymous` | `anonymous`, `app-password`, `oauth` |
| `limits` | body 65536, comment 65536, label 50 | body 1048576, comment 1000000, label 255 | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
<!-- capabilities:end -->

</details>

## Providers

| Forge | Import | Factories |
| --- | --- | --- |
| [GitHub and GitHub Enterprise Server](./docs/providers/github.md) | `forges/github` | `github`, `githubLite` |
| [GitLab](./docs/providers/gitlab.md) | `forges/gitlab` | `gitlab`, `gitlabLite` |
| [Bitbucket Cloud](./docs/providers/bitbucket.md) | `forges/bitbucket` | `bitbucket`, `bitbucketLite` |
| [Forgejo and Codeberg](./docs/providers/forgejo.md) | `forges/forgejo` | `forgejo`, `forgejoLite` |
| [Gitea](./docs/providers/gitea.md) | `forges/gitea` | `gitea`, `giteaLite` |
| [Gitee](./docs/providers/gitee.md) | `forges/gitee` | `gitee`, `giteeLite` |
| [Azure DevOps](./docs/providers/azure-devops.md) | `forges/azure-devops` | `azureDevOps`, `azureDevOpsLite` |
| [Cursor Origin](./docs/providers/cursor-origin.md) | `forges/cursor-origin` | `cursorOrigin`, `cursorOriginLite` |
| [Tangled](./docs/providers/tangled.md) | `forges/tangled` | `tangled`, `tangledLite` |
| [pushin.eu](./docs/providers/pushin.md) | `forges/pushin` | `pushin` |

Each provider page covers authentication, the instance URL, behaviour specific to that forge, webhook verification, and the full capability list.

## Webhooks

`webhooks.ingest()` verifies a delivery against `webhookSecret` and translates it into `ForgeEvent` objects. If the signature doesn't match, it throws `WebhookVerificationError`. The forge signs the exact bytes it sends, so pass the raw body:

```ts
import { github } from 'forges/github'

const forge = github({ webhookSecret: process.env.GITHUB_WEBHOOK_SECRET }).create()

export default async function handler(request: Request) {
  const events = await forge.webhooks.ingest({ headers: request.headers, body: await request.text() })
  for (const event of events) {
    console.log(event.kind, event.action, event.summary)
  }
  return new Response(null, { status: 204 })
}
```

To check the signature without translating the delivery, call `webhooks.verify()`.

## Browser usage

Every provider except pushin.eu has a second factory, `<kind>Lite()`, with no webhook ingestion. A browser doesn't receive webhook deliveries, so a bundle that imports `githubLite` leaves out the signature verification and payload translation code:

```ts
import { githubLite } from 'forges/github'

const forge = githubLite({ auth: { type: 'token', token: userAccessToken } }).create()
```

In this example, `userAccessToken` is a token that your app obtained for the signed-in user, for example through GitHub's OAuth flow.

On a Lite provider, `capabilities.sources.webhook` is `false`, and `webhooks.verify()` and `webhooks.ingest()` reject. `forges/github` loads its GraphQL documents as a separate chunk on first use. [Browser bundles](./docs/bundling.md) lists the bundle sizes and explains how CI enforces them.

## Configuring providers from the environment

`providersFromEnv()` from `forges/env` reads `FORGES_<KIND>_<FIELD>` variables, such as `FORGES_GITHUB_TOKEN` and `FORGES_GITLAB_BASE_URL`, and returns one entry per provider. Add a suffix to configure a second instance of the same forge, as in `FORGES_GITHUB_TOKEN_WORK`. An entry that couldn't be configured has a `skipped` reason, which never contains the credential:

```ts
import { createForges } from 'forges'
import { providersFromEnv } from 'forges/env'

const forges = createForges(providersFromEnv(process.env).flatMap(entry => entry.factory ? [entry.factory] : []))
```

## JSON schemas

`forges/schema` exports a draft-07 JSON Schema for each public model type, keyed by type name. `forges/schema/<Type>.json` serves each schema as a standalone file. You can use them to validate stored events or to generate types in another language:

```ts
import { schemas } from 'forges/schema'

schemas.Thread // { type: 'object', properties: { ref: ..., kind: ..., ... } }
```

## Testing

`forges/fake` is an in-memory forge with the full provider API. Seed it, run your code against it, and then assert on `store`. Every write updates `store` and appends a `ForgeEvent` to `store.events`:

```ts
import { fake } from 'forges/fake'
import { expect, it } from 'vitest'

it('closes stale issues', async () => {
  const forge = fake({
    seed: { threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Crash on start', labels: ['stale'] }] },
  })

  await closeStale(forge.create())

  expect(forge.store.events.map(event => event.action)).toEqual(['closed'])
})
```

To match a real forge's capabilities, pass `support`, for example `{ 'threads.addLabels': false }`.

`forges/testing` replays recorded HTTP responses and signs webhook deliveries with each forge's scheme:

```ts
import { readFile } from 'node:fs/promises'
import { github } from 'forges/github'
import { fixtureFetch, loadFixtures, signDelivery } from 'forges/testing'

const { fetch } = fixtureFetch(await loadFixtures(new URL('./fixtures/', import.meta.url)))
const forge = github({ fetch, webhookSecret: 'secret' }).create()

const body = await readFile(new URL('./fixtures/issue-opened.json', import.meta.url), 'utf8')
const headers = await signDelivery('github', body, 'secret', { 'x-github-event': 'issues' })
const events = await forge.webhooks.ingest({ headers, body })
```

`recordingFetch()` wraps `fetch` and collects each response as a fixture that you can save and replay. It doesn't record request headers, so credentials stay out of fixtures.

## Writing a provider

A provider is one call to `defineForgeProvider()`. You declare each operation once, with `verb(support, run)`, or with `perKind(kinds, run)` when support depends on the thread kind. Each declaration produces both the method and its capability entry. In this excerpt from a provider's `setup()`, issue reads are experimental and `getMany` is unsupported:

```ts
const threads = {
  get: perKind({ issue: 'experimental' }, getIssue),
  listPage: perKind({ issue: 'experimental' }, listIssues),
  getMany: verb(false, async () => []),
}
```

`forges` adds the rest of the provider: `capabilities`, `can()`, the iterables (`list` from `listPage`, for example), `readOnly`, anonymous handling, and a `webhooks.ingest()` that verifies each delivery before it translates it.

`ProviderSpec` in [`src/define.ts`](./src/define.ts) lists every operation and marks which ones are required. Declare a required operation that your forge lacks with `verb(false, ...)`. Any other operation that you leave out, and any thread kind that you don't list, is `false`. [`src/pushin/index.ts`](./src/pushin/index.ts) is a short provider to read as an example.

Webhook handlers go in the `webhooks` field of the definition. For a Lite variant, define a second factory from the same definition without `webhooks`.

Use `ctx.fetcher` for requests. It applies the base URL, auth header, user agent, timeout, and the caller's `fetch`, and it maps rate limits and revoked tokens to `forges` errors.

### Recording fixtures

Providers in this repository declare a capability `true` only when a test exercises it. To verify reads, record them against the live forge:

```sh
GITHUB_TOKEN=ghp_... pnpm record-fixtures github
```

`pnpm record-fixtures <forge>` runs the shared steps in `test/recording/steps.ts` against the forge. It writes the responses to `test/fixtures/<forge>/recorded/<host>/`, with a manifest that lists the steps that succeeded. `test/recorded.test.ts` replays those steps and snapshots the normalised output to `golden.json`. Run `pnpm vitest run test/recorded.test.ts -u` to update the snapshot. Each provider page lists the variables its recording reads.

Source files import each other with `.ts` extensions, so `node scripts/<name>.ts` runs without a build. After you change a provider's capabilities, run `pnpm capability-matrix` to regenerate the matrix in this README and on each provider page.

## Licence

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
