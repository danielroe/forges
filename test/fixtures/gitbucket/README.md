# GitBucket fixtures

GitBucket has no public instance, so `recorded/` holds recordings of a GitBucket server that [`scripts/gitbucket-server.ts`](../../../scripts/gitbucket-server.ts) starts in Docker and seeds for each run. Record them again with:

```bash
node scripts/record-forge.ts gitbucket --kind reads
node scripts/record-forge.ts gitbucket --kind writes
```

The writes run also records webhook deliveries, through a relay on your machine that the container reaches as `host.docker.internal`. The server listens on `127.0.0.1:8080`, and the recordings name it `gitbucket.test` in refs. To record a server you already run, set `GITBUCKET_BASE_URL` to its root; it must be empty, with GitBucket's default `root` account.
