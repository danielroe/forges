# `@forges-examples/fixture-fetch`

This private workspace package is shared by the tests of the other examples. It exports a `fetch` that serves the JSON fixtures in `test/fixtures/<forge>/`, so the tests can run without a network connection:

```ts
import { fixtureFetch } from '@forges-examples/fixture-fetch'

const { fetch, calls } = fixtureFetch(['github'], {
  'GET https://api.github.com/repos/acme/widgets/collaborators/grace/permission': {
    status: 200,
    body: { permission: 'write' },
  },
})
```

The first argument lists the forges whose fixtures should be loaded. The second argument adds or replaces responses, and each key has the form `METHOD url`. For a GraphQL request, the key ends with the name of the operation. `calls` records every request that the providers make, which a test can use to assert that a capability check prevented a write.

This package only exists for the examples. In your own tests, use `fixtureFetch()` and `loadFixtures()` from `forges/testing`.
