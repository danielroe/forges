# GitCafe fixtures

`recorded/` holds recordings of git.cafe, made with `pnpm record-fixtures gitcafe`.

`webhooks/issue-comment-created.json` is the body of a delivery that git.cafe sent for a comment on the scratch repository, read back from the delivery history. `webhooks/git-push.json` and `webhooks/pull-merged.json` are hand-authored from the `webhooks` section of the [OpenAPI description](https://git.cafe/api/openapi/json) and from [Webhooks](https://git.cafe/docs/integrations/webhooks.md), with the ids of the scratch repository.
