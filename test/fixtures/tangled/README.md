# Tangled fixtures

Every fixture here is hand-authored. Shapes follow the `sh.tangled.*` lexicons
(Tangled core at `7fcec78`, via `@atcute/tangled`) and records, Constellation
responses and Jetstream messages observed live, with every value replaced.

- `plc-*.json`: DID documents from `plc.directory`.
- `record-*.json`: `com.atproto.repo.getRecord` from the author's PDS.
- `links-*.json`: Constellation backlinks (which records point at a target).
- `knot-collaborators.json`: `sh.tangled.repo.listCollaborators` from the knot
  named in the repo DID document.
- `service-auth-*.json`, `notifications-*.json`: service-auth tokens and the
  experimental `org.tangled.temp.notification.*` XRPCs, shaped after deliberi's
  handlers in Tangled core.
- `session-create.json`, `record-create.json`: app-password session and
  record writes.
- `webhooks/`: a `pull_request:created` delivery, from the Tangled webhook
  docs.
- `jetstream/`: messages as a Jetstream `subscribe` socket delivers them.

The pull status record is authored by a DID that is neither the pull author,
the repo owner, nor a collaborator, so it must be ignored when computing state.

Values are deliberately distinct: record keys are `3mwq<name>22…`, the pull's
display number in the webhook is `4`, and the repo DID, owner DID and author
DIDs all differ.
