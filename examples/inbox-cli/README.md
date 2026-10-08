# `inbox-cli`

A command-line inbox. It prints one line per notification, newest first, from every forge that you configure.

The CLI reads its providers from the `FORGES_<KIND>_<FIELD>` environment variables with `providersFromEnv()` from `forges/env`, so adding another forge only takes another set of variables. Not every provider can list notifications. Bitbucket, Azure DevOps and Cursor Origin can't, for example, so for those forges the CLI lists the open threads of the repository that you set in `FORGES_<KIND>_DEMO_REPO` instead. Any warnings from the providers go to stderr.

## Run it

Set the credentials of the forges you want to see, and start the CLI:

```sh
FORGES_GITHUB_TOKEN=ghp_... \
FORGES_BITBUCKET_USERNAME=me@example.com FORGES_BITBUCKET_PASSWORD=api-token \
FORGES_BITBUCKET_DEMO_REPO=acme/widgets \
pnpm --filter @forges-examples/inbox-cli start
```

```
github:github.com:notification/901234567  2025-09-18 09:12  github  acme/widgets  pull_request  review_requested  Add retry handling to the uploader
```

The first column is the key of the row. To mark a notification as done, pass its key to `--done`:

```sh
pnpm --filter @forges-examples/inbox-cli start -- --done github:github.com:notification/901234567
```

On a forge that has only a read state, `--done` marks the notification as read.

## Run the tests

```sh
pnpm --filter @forges-examples/inbox-cli test
```

The tests run the real providers against the fixtures in `test/fixtures/`, so they work without a network connection.
