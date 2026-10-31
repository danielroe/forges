# GitBucket fixtures

GitBucket has no public instance, so there is no recording yet. These fixtures are the responses of a local GitBucket 4.48.0 server to the requests the provider sent, taken on 2026-10-31 from a `root/widgets` repository with one issue, one pull request with a commit status, and a `v1.0.0` release. The host is rewritten to `gitbucket.example.com` and the email addresses to `example.com`; everything else is as GitBucket sent it, including the fields it leaves out, such as release ids.

The reads were taken after the writes in `writes/`, so the pull request is already merged and the commit has two statuses. `writes/` holds the writes, taken in one run against the same repository.

`webhooks/` holds two deliveries exactly as GitBucket sent them, signed with the secret `tops3cret`, so their hosts stay `localhost:8090`.
