import type { FetchLike } from '../../src/fetch.ts'
import type { ForgeProvider } from '../../src/provider.ts'
import type { RecordingManifest } from './steps.ts'
import { generateKeyPairSync } from 'node:crypto'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitea } from '../../src/gitea/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { pushin } from '../../src/pushin/index.ts'
import { tangled } from '../../src/tangled/index.ts'
import { FakeWebSocket } from '../utils/websocket.ts'

type Create = (fetch: FetchLike, manifest: RecordingManifest, messages?: unknown[]) => ForgeProvider

const token = { type: 'token', token: 't' } as const
const authFor = ({ anonymous }: RecordingManifest) => anonymous ? undefined : token
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const githubAuthFor = (manifest: RecordingManifest) => manifest.installation ? { type: 'app', appId: 1, privateKey, installationId: manifest.installation } as const : authFor(manifest)

/** How replay creates each recorded provider from a manifest, with dummy credentials of the kind the recording used. */
export const REPLAYED_PROVIDERS: Array<{ name: string, create: Create }> = [
  { name: 'github', create: (fetch, manifest) => github({ auth: githubAuthFor(manifest), baseUrl: manifest.baseUrl, webhookSecret: manifest.webhookSecret, fetch }).create() },
  { name: 'forgejo', create: (fetch, manifest) => forgejo({ auth: authFor(manifest), baseUrl: manifest.baseUrl, instanceVersion: manifest.instanceVersion, webhookSecret: manifest.webhookSecret, fetch }).create() },
  { name: 'gitea', create: (fetch, manifest) => gitea({ auth: authFor(manifest), baseUrl: manifest.baseUrl, webhookSecret: manifest.webhookSecret, fetch }).create() },
  { name: 'gitlab', create: (fetch, manifest) => gitlab({ auth: authFor(manifest), baseUrl: manifest.baseUrl, webhookSecret: manifest.webhookSecret, fetch }).create() },
  { name: 'bitbucket', create: (fetch, manifest) => bitbucket({ auth: authFor(manifest), baseUrl: manifest.baseUrl, webhookSecret: manifest.webhookSecret, fetch }).create() },
  { name: 'pushin', create: (fetch, manifest) => pushin({ auth: authFor(manifest), baseUrl: manifest.baseUrl, fetch }).create() },
  { name: 'gitee', create: (fetch, manifest) => gitee({ auth: authFor(manifest), fetch }).create() },
  { name: 'azure-devops', create: (fetch, manifest) => azureDevOps({ auth: authFor(manifest), organization: manifest.repo.owner.split('/')[0]!, fetch }).create() },
  {
    name: 'tangled',
    create: (fetch, manifest, messages = []) => tangled({
      fetch,
      recordsUrl: manifest.recordsUrl,
      ...manifest.account && { auth: { type: 'app_password', identifier: manifest.account, password: 'p', pds: manifest.pds }, notificationsUrl: manifest.notificationsUrl },
      webSocket: url => new FakeWebSocket(url, messages),
    }).create(),
  },
]

const RECENT = 60 * 60 * 1000

/** Normalised output as stable JSON: no verbatim forge data, and fallback "now" timestamps masked. */
export function golden(value: unknown, now: number): string {
  return `${JSON.stringify(value, function (key, item: unknown) {
    if (key === 'raw' || key === 'payload') {
      return undefined
    }
    const original = (this as Record<string, unknown>)[key]
    if (original instanceof Date) {
      return Math.abs(now - original.getTime()) < RECENT ? '<now>' : original.toISOString()
    }
    return item
  }, 2)}\n`
}
