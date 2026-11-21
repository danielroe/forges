# Upstream fixtures

`recorded/` holds recordings of upstream.codes, made against the scratch repository `upstream_forges_bot/forges-fixtures` with `pnpm record-fixtures upstream`, with `--anonymous`, `--writes` and `--webhooks`.

`webhooks/` holds deliveries that upstream.codes sent for a change request in the scratch repository: opened, labelled, assigned, reviewed with a line comment, approved and closed, along with the creation and deletion of its branch, a tag and a published release. They were read back from the hook's delivery history, redacted, and signed again with the fixture secret, as the `--webhooks` recording does.
