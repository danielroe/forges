# GitLab fixtures

The fixtures outside `recorded/` are hand-authored from the public GitLab REST
API documentation. `recorded/` holds reads recorded by
`pnpm record-fixtures gitlab`, and `recorded/gitlab.com-anonymous/` holds
the reads that succeed without credentials, recorded with `--anonymous`.

The project lives in a nested group (`acme/platform/widgets`) so the namespace
handling is exercised. The page 2 to-do points at a group-level epic with no
project.

Values are deliberately distinct: to-do ids are `1029384xx`, merge request and
issue iids are `23` and `11`, the epic iid is `4`, note ids are `55500xx`,
and the project id is `278964`.
