# `release-digest`

Prints the latest release of each repository that you pass, together with the open pull requests whose checks are failing. The repositories can be on any number of forges.

For every open pull request, the digest reads the checks once with `threads.checks()`. The result has the names of the failing checks, along with the number of failed and total checks. If a forge doesn't support an operation, such as listing releases on Bitbucket, the digest prints a warning to stderr and carries on.

## Run it

Pass the repositories as arguments, and the credentials of each forge as environment variables:

```sh
FORGES_GITHUB_TOKEN=ghp_... FORGES_GITLAB_TOKEN=glpat-... \
pnpm --filter @forges-examples/release-digest start \
  github:acme/widgets gitlab:acme/platform/widgets
```

```
github  acme/widgets  v1.2.0 (2025-09-10)
  #42  Add retry handling to the uploader 1/3 failed  [lint]
gitlab  acme/platform/widgets  v2.0.0 (2025-09-10)
  #23  Cache compiled templates 1/3 failed  [test: lint]
```

Each argument has the form `<forge>:<owner>/<name>`. A GitLab owner can contain slashes, as in `gitlab:acme/platform/widgets`.

## Run the tests

```sh
pnpm --filter @forges-examples/release-digest test
```

The tests run the GitHub, GitLab, Forgejo and Bitbucket providers against the fixtures in `test/fixtures/`, so they work without a network connection.
