# Forgejo fixtures

The fixtures outside `recorded/` are hand-authored from the public Forgejo and
Gitea Swagger documentation. `recorded/` holds reads recorded by
`pnpm record-fixtures forgejo`, which uses `CODEBERG_TOKEN` when it is set and
records anonymously otherwise.

Values are deliberately distinct: notification ids are `551x`, thread numbers
are `7` and `9`, comment ids are `88000x`, timeline ids are `7701xx`.

The write fixtures (`write-*.json`) are hand-authored; the recording script
only performs reads.
