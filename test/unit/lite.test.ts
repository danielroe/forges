import type { ForgeProvider } from '../../src/provider.ts'
import { describe, expect, it } from 'vitest'
import { hmacSha256Hex } from '../../src/crypto.ts'
import { UnsupportedOperationError } from '../../src/errors.ts'
import { azureDevOps, azureDevOpsLite, bitbucket, bitbucketLite, cursorOrigin, cursorOriginLite, forgejo, forgejoLite, gitea, giteaLite, gitee, giteeLite, github, githubLite, gitlab, gitlabLite, tangled, tangledLite } from '../../src/index.ts'
import { CASES } from './push-cases.ts'

const auth = { type: 'token', token: 't' } as const

const PAIRS: Array<[string, () => ForgeProvider, () => ForgeProvider]> = [
  ['github', () => github({ auth }).create(), () => githubLite({ auth }).create()],
  ['gitlab', () => gitlab({ auth }).create(), () => gitlabLite({ auth }).create()],
  ['bitbucket', () => bitbucket({ auth }).create(), () => bitbucketLite({ auth }).create()],
  ['forgejo', () => forgejo({ auth }).create(), () => forgejoLite({ auth }).create()],
  ['gitea', () => gitea({ auth }).create(), () => giteaLite({ auth }).create()],
  ['gitee', () => gitee({ auth }).create(), () => giteeLite({ auth }).create()],
  ['azure devops', () => azureDevOps({ auth, organization: 'acme' }).create(), () => azureDevOpsLite({ auth, organization: 'acme' }).create()],
  ['cursor origin', () => cursorOrigin({ auth }).create(), () => cursorOriginLite({ auth }).create()],
  ['tangled', () => tangled({ auth: { type: 'app_password', identifier: 'h', password: 'p' } }).create(), () => tangledLite({ auth: { type: 'app_password', identifier: 'h', password: 'p' } }).create()],
]

describe('lite factories', () => {
  it.each(PAIRS)('%s: reports webhook ingestion unsupported and nothing else changed', (_name, full, lite) => {
    const a = full()
    const b = lite()

    expect(a.capabilities.sources.webhook).toBe(true)
    expect(b.capabilities.sources.webhook).toBe(false)
    expect(a.webhooks.events.length).toBeGreaterThan(0)
    expect(b.webhooks.events).toEqual([])
    expect({ ...b.capabilities, sources: { ...b.capabilities.sources, webhook: true } }).toEqual(a.capabilities)
    expect(b.capabilities.webhooks).toEqual(a.capabilities.webhooks)
  })

  it.each(PAIRS)('%s: rejects verify and ingest', async (_name, _full, lite) => {
    const provider = lite()
    const delivery = { headers: {}, body: '{}' }

    await expect(provider.webhooks.verify(delivery)).rejects.toThrow(UnsupportedOperationError)
    await expect(provider.webhooks.ingest(delivery)).rejects.toThrow(UnsupportedOperationError)
  })

  it('ingests the same delivery through the full factory', async () => {
    const body = JSON.stringify(CASES['github push']!.payload)
    const delivery = {
      headers: { ...CASES['github push']!.headers, 'x-hub-signature-256': `sha256=${await hmacSha256Hex('s', body)}` },
      body,
    }

    const [event] = await github({ auth, webhookSecret: 's' }).create().webhooks.ingest(delivery)
    expect(event?.kind).toBe('push')
    await expect(githubLite({ auth, webhookSecret: 's' }).create().webhooks.ingest(delivery)).rejects.toThrow(UnsupportedOperationError)
  })
})
