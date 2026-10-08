# Cursor Origin fixtures

Hand-authored from the Origin API `v1alpha1` OpenAPI specification and
reference. Every fixture is marked `handAuthored: true`.

`keys.json` serves the public half of a test-only Ed25519 key pair whose
private half lives in `test/contract/providers.ts`, so webhook signatures can
be produced and verified offline. It is not an Origin key.
