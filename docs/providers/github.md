# GitHub

The GitHub provider covers github.com and GitHub Enterprise Server. It reads and writes issues, pull requests, discussions, and commit comments. It also covers notifications, Actions runs and jobs, checks, releases, security alerts, webhooks, and GitHub App installations.

## Authentication

The provider accepts a personal access token (classic or fine-grained), an OAuth token, or GitHub App credentials:

```ts
import { github } from 'forges/github'

const forge = github({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } }).create()

const app = github({
  auth: { type: 'app', appId: 123456, privateKey: process.env.GITHUB_APP_PRIVATE_KEY!, installationId: 7890 },
}).create()
```

For app auth, `privateKey` is the app's PEM key, in PKCS#1 or PKCS#8 format. With `installationId`, the provider mints and caches installation tokens as it needs them. Without `installationId`, the provider authenticates as the app itself. In that case, `installations.list()` lists the app's installations, and `installations.provider(installation)` returns a provider for one installation.

Without `auth`, the provider makes anonymous public reads.

## GitHub Enterprise Server

Set `baseUrl` to the API root of the server. The `instance` in every ref is the server's host:

```ts
github({ baseUrl: 'https://ghe.example.com/api/v3', auth, instanceVersion: '3.14.0' })
```

Two capabilities depend on the server version:

- Marking notifications done requires 3.13 or later.
- Dependabot alerts require 3.8 or later.

Pass `instanceVersion` if you know the version. Otherwise, `refreshCapabilities()` reads it from `/meta`.

## Merging

If you don't pass `method`, `merge()` reads the repository's allowed merge methods. When exactly one method is allowed, it uses that method. When several are allowed, it throws `MergeMethodRequiredError`.

`merge()` and `approveAndMerge()` request a direct merge through GitHub's asynchronous merge API, so neither adds the pull request to a merge queue. Both wait for the result, within the provider's `timeout` (30 seconds by default), and resolve once GitHub reports the pull request merged, including when it was already merged. Otherwise, they reject with one of these errors:

- `MergeBlockedError` when GitHub refuses or fails the merge, for example for a draft, a failing required check, or a pull request already in a merge queue. When GitHub reports a failed merge, the error message is GitHub's description of the failure.
- `MergeConflictError` when GitHub responds with a conflict status that names no pending merge request.
- `ForgeTimeoutError` when the merge is still pending after `timeout`. The message includes the merge request's UUID. GitHub can still complete the merge after this error, so read the pull request's state before you retry.

If a direct merge with the same method is already pending, and it expects the same head sha when you pass `sha`, the operation waits for that request instead. A pending request with different options rejects with `MergeBlockedError`. Supplying `message` also prevents adopting a pending request because GitHub doesn't return its commit message.

When the pull request is part of a stack, GitHub also merges every open pull request below it in the stack. `approveAndMerge()` approves only the pull request you pass.

GitHub Enterprise Server releases without the asynchronous merge API use the synchronous merge endpoint instead. That endpoint doesn't support stacked pull requests.

These options reject with `UnsupportedOperationError`:

- `whenChecksPass`, because the REST API doesn't enable auto-merge.
- The `rebase_merge` and `fast_forward_only` methods, which GitHub doesn't have.

## Checks

With an app installation credential, `checks.report()` writes a check run. With any other credential, it writes a commit status. `checks.rerun()` re-requests a check run. Commit statuses can't be re-run.

## Large files and trees

`contents.file()` reads files over 1 MB through the Git blobs API, so these files have `encoding: 'none'`. When GitHub truncates a large tree, `contents.tree()` adds a `tree_truncated` warning.

## Search

GitHub gives search a lower rate limit than the rest of the API. Commit search has its own limit, separate from issue and repository search. After a search, `page.rateLimit` reports the limit that the search used.

Repository search can't sort by creation time. A request for that sort order returns results by relevance, with a `sort_unsupported` warning.

## Webhook management

GitHub responds with `404` on its webhook endpoints when the credential lacks `admin:repo_hook` or `admin:org_hook`. The provider raises this response as `ForbiddenError` with `reason: 'resource_protected'`.

`webhooks.deliveries()` reads a hook's delivery log, and `webhooks.redeliver()` sends a delivery again.

## Webhooks

Set `webhookSecret` to the secret configured on the hook:

```ts
const forge = github({ webhookSecret: process.env.GITHUB_WEBHOOK_SECRET }).create()

const events = await forge.webhooks.ingest({ headers: request.headers, body: await request.text() })
```

GitHub sends these headers with each delivery:

| Header | Content |
| --- | --- |
| `X-Hub-Signature-256` | `sha256=` followed by the hex HMAC-SHA256 of the body |
| `X-GitHub-Event` | The event name |
| `X-GitHub-Delivery` | The delivery ID |

`installation` and `installation_repositories` deliveries become `installation` events.

## Recording fixtures

```sh
GITHUB_TOKEN=ghp_... pnpm record-fixtures github
```

To record different targets, set `FIXTURE_GITHUB_REPO`, `FIXTURE_GITHUB_PULL`, `FIXTURE_GITHUB_ISSUE`, `FIXTURE_GITHUB_DISCUSSION_REPO`, or `FIXTURE_GITHUB_DISCUSSION`. To record a GitHub Enterprise Server instance, set `GITHUB_BASE_URL`.

<!-- capabilities:start -->
## Capabilities

Generated by `pnpm capability-matrix`; do not edit by hand.

| Capability | Support |
| --- | --- |
| `experimental` | ❌ |
| `sources.poll` | ✅ |
| `sources.webhook` | ✅ |
| `sources.subscribe` | ❌ |
| `repos.get` | ✅ |
| `users.get` | ✅ |
| `repos.list` | ✅ |
| `repos.labels` | ✅ |
| `repos.createLabel` | experimental |
| `repos.milestones` | ✅ |
| `repos.collaborators` | ✅ |
| `repos.permissionFor` | ✅ |
| `repos.addCollaborator` | experimental |
| `repos.assignableUsers` | ✅ |
| `repos.reviewerCandidates` | emulated |
| `threads.get` | issue, PR, discussion, commit (experimental) |
| `threads.list` | issue, PR, discussion |
| `threads.getMany` | ✅ |
| `comments.list` | issue, PR, discussion, commit (experimental) |
| `comments.edit` | issue (experimental), PR, discussion (experimental), commit (experimental) |
| `comments.delete` | issue (experimental), PR, discussion (experimental), commit (experimental) |
| `reactions.list` | issue, PR, discussion |
| `notifications.list` | ✅ |
| `notifications.markRead` | ✅ |
| `notifications.markDone` | ✅ |
| `notifications.unsubscribe` | ✅ |
| `notifications.markAllRead` | ✅ |
| `notifications.markAllDone` | ❌ |
| `notifications.unreadCount` | ❌ |
| `writes.comment` | issue (experimental), PR, discussion, commit (experimental) |
| `writes.upsertComment` | issue (emulated), PR (emulated), discussion (emulated), commit (emulated) |
| `writes.close` | issue, PR, discussion |
| `writes.reopen` | issue (experimental), PR, discussion |
| `writes.create` | issue, PR (experimental) |
| `writes.update` | issue (experimental), PR, discussion (experimental) |
| `writes.setLabels` | issue (experimental), PR |
| `writes.addLabels` | issue (experimental), PR |
| `writes.removeLabels` | issue (experimental), PR |
| `writes.setMilestone` | issue (experimental), PR (experimental) |
| `writes.react` | issue (experimental), PR, discussion (experimental) |
| `writes.setAssignees` | issue (experimental), PR |
| `writes.requestReview` | PR |
| `writes.merge` | ✅ |
| `writes.approveAndMerge` | ✅ |
| `writes.transfer` | experimental |
| `writes.markDuplicate` | experimental |
| `subscriptions.get` | issue, PR, discussion |
| `subscriptions.set` | issue, PR, discussion |
| `installations` | ✅ |
| `checks.thread` | PR |
| `checks.list` | ✅ |
| `checks.report` | ✅ |
| `checks.rerun` | ✅ |
| `ci.runs` | ✅ |
| `ci.run` | ✅ |
| `ci.jobs` | ✅ |
| `ci.log` | ✅ |
| `contents.file` | ✅ |
| `contents.tree` | ✅ |
| `contents.branches` | ✅ |
| `contents.tags` | ✅ |
| `contents.resolveRef` | ✅ |
| `contents.commits` | ✅ |
| `contents.commit` | ✅ |
| `contents.compare` | ✅ |
| `contents.threadFiles` | ✅ |
| `contents.threadCommits` | ✅ |
| `reviews.list` | ✅ |
| `reviews.create` | ✅ |
| `reviews.submit` | ✅ |
| `reviews.approve` | ✅ |
| `reviews.resolveThread` | ✅ |
| `releases.list` | ✅ |
| `releases.get` | ✅ |
| `releases.latest` | ✅ |
| `releases.getByTag` | ✅ |
| `releases.downloadAsset` | ✅ |
| `webhooks.list` | ✅ |
| `webhooks.create` | ✅ |
| `webhooks.update` | ✅ |
| `webhooks.delete` | ✅ |
| `webhooks.rotateSecret` | experimental |
| `webhooks.deliveries` | ✅ |
| `webhooks.redeliver` | ✅ |
| `search.threads` | ✅ |
| `search.repos` | ✅ |
| `search.commits` | ✅ |
| `securityAlerts` | dependency (experimental), code scanning (experimental), secret (experimental) |
| `eventKinds` | native |
| `auth` | `token`, `app`, `anonymous` |
| `limits` | body 65536, comment 65536, label 50 |
<!-- capabilities:end -->
