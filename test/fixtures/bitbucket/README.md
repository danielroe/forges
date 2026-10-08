# Bitbucket Cloud fixtures

The fixtures outside `recorded/` are hand-authored from the Bitbucket Cloud REST
API 2.0 documentation. `recorded/` holds reads recorded by
`pnpm record-fixtures bitbucket`.

Pull request activity is paginated with `next` in the body and returned
newest first, as Bitbucket does; the provider sorts events oldest first.

Values are deliberately distinct: the pull request id is `31`, comment ids are
`4400xx`, and repository and user UUIDs all differ.
