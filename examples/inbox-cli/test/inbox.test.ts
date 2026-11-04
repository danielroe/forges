import { fixtureFetch } from '@forges-examples/fixture-fetch'
import { bitbucket, createForges, github } from 'forges'
import { describe, expect, it } from 'vitest'
import { collectInbox, formatRow, markDone } from '../src/inbox.ts'

function setup() {
  const { fetch, calls } = fixtureFetch(['github', 'bitbucket'], {
    'GET https://api.bitbucket.org/2.0/repositories/acme/widgets/issues?pagelen=50&q=%28state+%3D+%22new%22+OR+state+%3D+%22open%22+OR+state+%3D+%22on+hold%22%29&sort=-created_on': {
      status: 200,
      body: { pagelen: 50, values: [] },
    },
  })
  const forges = createForges([
    github({
      auth: { type: 'token', token: 'ghp_test' },
      fetch,
    }),
    bitbucket({
      auth: { type: 'basic', username: 'tester', password: 'app-password' },
      fetch,
    }),
  ])
  return { forges, calls }
}

const bitbucketRepo = {
  forge: 'bitbucket',
  instance: 'bitbucket.org',
  owner: 'acme',
  name: 'widgets',
} as const

describe('inbox', () => {
  it('should merge notifications and thread listings into one time-sorted list', async () => {
    const { forges } = setup()

    const { rows } = await collectInbox(forges, {
      repos: [bitbucketRepo],
    })

    expect(rows.map(row => `${row.forge} ${row.repo} ${row.kind} ${row.reason}`)).toMatchInlineSnapshot(`
      [
        "bitbucket acme/widgets pull_request open",
        "github acme/widgets pull_request review_requested",
        "github acme/widgets issue mention",
        "github acme/widgets discussion author",
      ]
    `)
    expect(rows.map(row => row.at.getTime())).toEqual([
      ...rows.map(row => row.at.getTime()),
    ].sort((a, b) => b - a))
  })

  it('should list threads for a forge that has no notifications', async () => {
    const { forges } = setup()

    const { rows } = await collectInbox(forges, {
      repos: [bitbucketRepo],
    })

    const bitbucketRows = rows.filter(row => row.forge === 'bitbucket')
    expect(bitbucketRows.length).toBeGreaterThan(0)
    expect(bitbucketRows.every(row => row.notification === undefined)).toBe(true)
  })

  it('should warn when a forge has neither notifications nor a configured repository', async () => {
    const { forges } = setup()

    const { warnings } = await collectInbox(forges)

    expect(warnings.map(warning => warning.code)).toContain('no_notifications_source')
  })

  it('should format a row with forge, repo, kind, reason and title', async () => {
    const { forges } = setup()

    const { rows } = await collectInbox(forges, {
      repos: [bitbucketRepo],
    })
    const row = rows.find(candidate => candidate.notification !== undefined)

    expect(row && formatRow(row)).toMatchInlineSnapshot(`"2025-09-18 09:12  github  acme/widgets  pull_request  review_requested  Add retry handling to the uploader"`)
  })

  it('should mark a notification done through the forge that owns it', async () => {
    const { forges, calls } = setup()

    const { rows } = await collectInbox(forges, {
      repos: [bitbucketRepo],
    })
    const [row] = rows.filter(candidate => candidate.notification !== undefined)
    if (!row) {
      throw new Error('expected a notification row')
    }

    const result = await markDone(forges, row.key, {
      repos: [bitbucketRepo],
    })

    expect(result.verb).toBe('markDone')
    expect(calls.some(call => call.method === 'DELETE' && call.url.includes('/notifications/threads/'))).toBe(true)
  })
})
