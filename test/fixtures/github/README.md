# GitHub fixtures

The fixtures outside `recorded/` are hand-authored from the public GitHub REST
documentation. `recorded/` holds reads recorded by `pnpm record-fixtures github`,
which uses `GITHUB_TOKEN` when it is set and records anonymously otherwise.

`app-installation-token.json` and the webhook payloads in `test/contract/`
cannot be recorded by that script at all: they need a GitHub App and a live
delivery, so they stay hand-authored.

Values are deliberately distinct: notification ids are `9012345xx`, thread
numbers are `42` and `17`, comment ids are `77000x`, timeline ids are `6600xx`.

GraphQL fixtures (`graphql-*.json`) are matched on `request.operationName` as
well as method and URL. They, the write fixtures (`write-*.json`), and the app
installation fixtures are hand-authored; the recording script only performs
reads and has no app credentials.

Check runs are `400x`, commit statuses `500x`, releases `900x`, and security
alerts use small per-kind numbers (Dependabot `3`, code scanning `7`, secret
scanning `2`), mirroring GitHub numbering each alert kind separately.
