# Cursor Origin fixtures

`recorded/` holds recordings of `forges/forges-fixtures` on Origin: reads of pull request 4 in `origin.cursor.com/`, and the write run in `origin.cursor.com-writes/`. Record them again with:

```bash
node scripts/record-forge.ts cursor-origin --kind reads
node scripts/record-forge.ts cursor-origin --kind writes
```

The fixtures outside `recorded/` are hand-authored from the Origin API `v1alpha1` OpenAPI specification and reference. Every one of them is marked `handAuthored: true`.

`keys.json` serves the public half of a test-only Ed25519 key pair whose
private half lives in `test/contract/providers.ts`, so webhook signatures can
be produced and verified offline. It is not an Origin key.
