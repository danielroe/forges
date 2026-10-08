import type { FetchLike } from '../src/fetch.ts'
import type { ForgeEvent, Notification, NotificationReason, Page, Repo, Thread } from '../src/model.ts'
import type { ForgeProvider } from '../src/provider.ts'
import type { RecordingManifest, StepContext } from './recording/steps.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { bitbucket } from '../src/bitbucket/index.ts'
import { forgejo } from '../src/forgejo/index.ts'
import { gitea } from '../src/gitea/index.ts'
import { github } from '../src/github/index.ts'
import { gitlab } from '../src/gitlab/index.ts'
import { notificationThread, repoKey } from '../src/model.ts'
import { pushin } from '../src/pushin/index.ts'
import { tangled } from '../src/tangled/index.ts'
import { STEPS } from './recording/steps.ts'
import { fixtureDirectory, fixtureFetch } from './utils/fixtures.ts'
import { FakeWebSocket } from './utils/websocket.ts'

type Manifest = RecordingManifest

const REASONS: NotificationReason[] = [
  'access_requested',
  'merge_blocked',
  'review_submitted',
  'approval_requested',
  'assigned',
  'author',
  'ci_activity',
  'comment',
  'invitation',
  'manual',
  'mention',
  'review_requested',
  'security_alert',
  'starred',
  'followed',
  'state_change',
  'subscribed',
  'team_mention',
  'unknown',
]

type Create = (fetch: FetchLike, manifest: Manifest, messages?: unknown[]) => ForgeProvider

const auth = { type: 'token', token: 't' } as const
const providers: Array<{ name: string, create: Create }> = [
  { name: 'github', create: (fetch, { baseUrl }) => github({ auth, baseUrl, fetch }).create() },
  { name: 'forgejo', create: (fetch, { baseUrl, instanceVersion }) => forgejo({ auth, baseUrl, instanceVersion, fetch }).create() },
  { name: 'gitea', create: (fetch, { baseUrl }) => gitea({ auth, baseUrl, fetch }).create() },
  { name: 'gitlab', create: (fetch, { baseUrl }) => gitlab({ auth, baseUrl, fetch }).create() },
  { name: 'bitbucket', create: (fetch, { baseUrl }) => bitbucket({ auth, baseUrl, fetch }).create() },
  { name: 'pushin', create: (fetch, { baseUrl }) => pushin({ auth, baseUrl, fetch }).create() },
  {
    name: 'tangled',
    create: (fetch, manifest, messages = []) => tangled({
      fetch,
      recordsUrl: manifest.recordsUrl,
      webSocket: url => new FakeWebSocket(url, messages),
    }).create(),
  },
]

const RECENT = 60 * 60 * 1000

/** Normalised output as stable JSON: no verbatim forge data, and fallback "now" timestamps masked. */
function golden(value: unknown, now: number): string {
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

/** One recording per instance host, under `<provider>/recorded/<host>/`. */
function recordings(name: string): string[] {
  const root = fixtureDirectory(`${name}/recorded`)
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `${name}/recorded/${entry.name}`) : []
}

for (const { name, create } of providers) {
  for (const directory of recordings(name)) {
    const manifestPath = `${fixtureDirectory(directory)}manifest.json`
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest : undefined
    const jetstreamPath = `${fixtureDirectory(directory)}jetstream.json`
    const jetstream = existsSync(jetstreamPath)
      ? JSON.parse(readFileSync(jetstreamPath, 'utf8')) as { cursor: string, messages: unknown[] }
      : undefined

    describe.skipIf(!manifest)(`recorded: ${directory.replace('/recorded/', ' ')}`, () => {
      const output: Record<string, unknown> = {}
      const has = (name: string) => manifest!.steps.includes(name)
      const items = <T>(name: string) => (output[name] as Page<T> | undefined)?.items ?? []

      beforeAll(async () => {
        vi.useFakeTimers({ now: new Date(manifest!.recordedAt), toFake: ['Date'] })
        try {
          const instance = create(fixtureFetch(directory).fetch, manifest!, jetstream?.messages)
          const context: StepContext = {}
          for (const step of STEPS.filter(step => has(step.name))) {
            output[step.name] = await step.run(instance, manifest!, context)
          }
        }
        finally {
          vi.useRealTimers()
        }
      })

      it('matches the committed golden output (regenerate with `vitest -u`)', async () => {
        await expect(golden(output, Date.parse(manifest!.recordedAt))).toMatchFileSnapshot(`${fixtureDirectory(directory)}golden.json`)
      })

      it.skipIf(!manifest || !manifest.steps.includes('notifications'))('normalises the first notifications page', () => {
        for (const notification of items<Notification>('notifications')) {
          expect(REASONS).toContain(notification.reason)
          expect(notification.updatedAt.getTime()).not.toBeNaN()
          expect(notification.subjectTypeRaw).toBeTruthy()
          const thread = notificationThread(notification)
          if (!thread) {
            continue
          }
          expect(notification.ref.id).not.toBe(thread.number)
          expect(thread.number).not.toBe('')
          if (thread.kind === 'issue' || thread.kind === 'pull_request') {
            expect(thread.number).toMatch(/^\d+$/)
          }
        }
      })

      it.skipIf(!manifest?.steps.includes('repo'))('reads the repository its own web URL names', async () => {
        const instance = create(fixtureFetch(directory).fetch, manifest!)
        const url = instance.urlFor({ repo: manifest!.repo })!
        const parsed = instance.parseUrl(url)

        expect(parsed).toBeDefined()
        expect(repoKey((await instance.repos.get(parsed!.repo)).ref)).toBe(repoKey((output.repo as Repo).ref))
      })

      it.skipIf(!manifest?.steps.includes('pull'))('normalises a pull request and its first events', () => {
        const thread = output.pull as Thread

        expect(thread.title).not.toBe('')
        expect(thread.state).not.toBe('unknown')
        for (const event of items<ForgeEvent>('pull events')) {
          expect(event.occurredAt.getTime()).toBeGreaterThan(0)
          expect(event.summary).not.toMatch(/\s$/)
        }
      })

      it.skipIf(!manifest?.steps.includes('pull events'))('recognises every recorded event when kinds are inferred from text', () => {
        if (create(fixtureFetch(directory).fetch, manifest!).capabilities.eventKinds !== 'heuristic') {
          return
        }

        expect(items<ForgeEvent>('pull events').filter(event => event.kind === 'other').map(event => event.kindRaw)).toEqual([])
      })

      it.skipIf(!manifest?.steps.includes('issue'))('normalises an issue and its events', () => {
        const thread = output.issue as Thread

        expect(thread.kind).toBe('issue')
        expect(thread.ref.repo.owner).not.toBe('')
        for (const event of items<ForgeEvent>('issue events')) {
          expect(event.occurredAt.getTime()).toBeGreaterThan(0)
          expect(event.actor?.login).toBeTruthy()
        }
      })

      it.skipIf(!jetstream)('replays recorded subscription messages in cursor order', async () => {
        const instance = create(fixtureFetch(directory).fetch, manifest!, jetstream?.messages)
        const cursors: string[] = []
        const error = await (async () => {
          for await (const { event, cursor } of instance.sources.subscribe({ cursor: jetstream!.cursor })) {
            expect(event.source).toBe('subscribe')
            expect(event.occurredAt.getTime()).toBeGreaterThan(0)
            cursors.push(cursor)
          }
        })().catch((error: unknown) => error)

        expect(cursors.length).toBeGreaterThan(0)
        expect(cursors).toEqual([...cursors].sort())
        expect((error as Error).name).toBe('SubscriptionClosedError')
      })

      it.skipIf(!manifest?.steps.includes('discussion'))('normalises a discussion and its first comments', () => {
        const thread = output.discussion as Thread

        expect(thread.kind).toBe('discussion')
        expect(thread.ref.externalId).toBeTruthy()
        for (const event of items<ForgeEvent>('discussion events')) {
          expect(event.kind).toBe('comment')
          expect(event.occurredAt.getTime()).toBeGreaterThan(0)
        }
      })
    })
  }
}
