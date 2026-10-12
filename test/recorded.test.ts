import type { ForgeEvent, Notification, NotificationReason, Page, Repo, Thread } from '../src/model.ts'
import type { RecordingManifest, Step, StepContext } from './recording/steps.ts'
import type { WriteContext, WriteManifest, WriteStep } from './recording/write-steps.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { notificationThread, repoKey } from '../src/model.ts'
import { recordedSteps } from './recording/layout.ts'
import { redact } from './recording/redact.ts'
import { golden, REPLAYED_PROVIDERS } from './recording/replay.ts'
import { STEPS } from './recording/steps.ts'
import { WRITE_STEPS } from './recording/write-steps.ts'
import { fixtureDirectory, fixtureFetch, loadFixtures as recordedFixtures, stepFixtureFetch } from './utils/fixtures.ts'
import { markPayload, markStream } from './utils/provenance.ts'

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

/** Replaces timestamps a write stamps when it is sent, which a replay at a fixed instant cannot reproduce. */
function withoutTimes(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>'))
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

/**
 * One recording per instance host, under `<provider>/recorded/<host>/`, plus `<host>-anonymous/` for one made without credentials.
 * `FORGES_RECORDING`, such as `github/recorded/github.com-writes`, replays that recording alone.
 */
function recordings(name: string): string[] {
  const root = fixtureDirectory(`${name}/recorded`)
  const all = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `${name}/recorded/${entry.name}`) : []
  return process.env.FORGES_RECORDING ? all.filter(directory => directory === process.env.FORGES_RECORDING) : all
}

for (const { name, create } of REPLAYED_PROVIDERS) {
  for (const directory of recordings(name)) {
    const root = fixtureDirectory(directory)
    const manifest = existsSync(`${root}manifest.json`) ? JSON.parse(readFileSync(`${root}manifest.json`, 'utf8')) as RecordingManifest : undefined
    const writes = manifest && 'run' in manifest ? manifest as WriteManifest : undefined
    const definitions = new Map<string, Step | WriteStep>((writes ? WRITE_STEPS : STEPS).map(step => [step.name, step]))
    const steps = recordedSteps(root)
    const recorded = new Set(steps.map(step => step.name))
    const jetstreamPath = `${root}jetstream.json`
    const jetstream = existsSync(jetstreamPath)
      ? JSON.parse(readFileSync(jetstreamPath, 'utf8'), (key, value: unknown) => key === 'messages' ? markStream(value as unknown[], 'recorded') : value) as { cursor: string, messages: unknown[] }
      : undefined

    describe.skipIf(!manifest)(`recorded: ${directory.replace('/recorded/', ' ')}`, () => {
      const output: Record<string, unknown> = {}
      const items = <T>(name: string) => (output[name] as Page<T> | undefined)?.items ?? []
      const replay = stepFixtureFetch(directory, { sequential: !!writes })

      beforeAll(async () => {
        vi.useFakeTimers({ now: new Date(manifest!.recordedAt ?? steps[0]?.recordedAt ?? 0), toFake: ['Date'] })
        try {
          if (manifest!.deliveries) {
            const instance = create(fixtureFetch(directory).fetch, manifest!)
            for (const name of manifest!.deliveries) {
              const { headers, body } = JSON.parse(readFileSync(`${root}${name}.delivery.json`, 'utf8')) as { headers: Record<string, string>, body: string }
              output[name] = await instance.webhooks.ingest({ headers, body: markPayload(body, 'recorded') })
            }
            return
          }
          const author = create(replay.fetch, manifest!, jetstream?.messages)
          const reviewer = writes?.reviewerAccount ? create(replay.fetch, { ...writes, account: writes.reviewerAccount, pds: writes.reviewerPds }) : writes ? create(replay.fetch, writes) : author
          const context: StepContext & WriteContext = { pulls: [], comments: {}, wait: async () => {} }
          for (const { name, slug, recordedAt } of steps) {
            const step = definitions.get(name)
            if (!step) {
              continue
            }
            replay.use(slug)
            vi.setSystemTime(new Date(recordedAt))
            output[name] = await step.run(('as' in step && step.as === 'reviewer' ? reviewer : author) as never, manifest as never, context)
          }
        }
        finally {
          vi.useRealTimers()
        }
      })

      it('records only steps that exist', () => {
        expect(steps.map(step => step.name).filter(name => !definitions.has(name))).toEqual([])
      })

      it.skipIf(!writes)('sends the request bodies it recorded', () => {
        const sent = replay.calls.filter(call => call.body !== undefined || call.fixture?.request.body !== undefined)
        const served = new Set(sent.map(call => JSON.stringify(call.fixture)))

        expect(withoutTimes(sent.map(call => call.body === undefined ? undefined : redact(parsed(call.body))))).toEqual(withoutTimes(sent.map(call => call.fixture?.request.body)))
        expect(recordedFixtures(directory).filter(fixture => fixture.request.body !== undefined && !served.has(JSON.stringify(fixture))).map(fixture => `${fixture.request.method} ${fixture.request.url}`)).toEqual([])
      })

      it.skipIf(!manifest?.deliveries)('matches the committed golden output (regenerate with `vitest -u`)', async () => {
        await expect(golden(output, Date.parse(manifest!.recordedAt!))).toMatchFileSnapshot(`${root}golden.json`)
      })

      it.for(steps)('matches the committed golden output of $name (regenerate with `vitest -u`)', async ({ name, slug, recordedAt }) => {
        await expect(golden(output[name] ?? null, Date.parse(recordedAt))).toMatchFileSnapshot(`${root}steps/${slug}/golden.json`)
      })

      it.skipIf(!recorded.has('notifications'))('normalises the first notifications page', () => {
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

      it.skipIf(!recorded.has('repo'))('reads the repository its own web URL names', async () => {
        const repo = stepFixtureFetch(directory)
        repo.use(steps.find(step => step.name === 'repo')!.slug)
        const instance = create(repo.fetch, manifest!)
        const url = instance.urlFor({ repo: manifest!.repo })!
        const parsed = instance.parseUrl(url)

        expect(parsed).toBeDefined()
        expect(repoKey((await instance.repos.get(parsed!.repo)).ref)).toBe(repoKey((output.repo as Repo).ref))
      })

      it.skipIf(!recorded.has('pull'))('normalises a pull request and its first events', () => {
        const thread = output.pull as Thread

        expect(thread.title).not.toBe('')
        expect(thread.state).not.toBe('unknown')
        for (const event of items<ForgeEvent>('pull events')) {
          expect(event.occurredAt.getTime()).toBeGreaterThan(0)
          expect(event.summary).not.toMatch(/\s$/)
        }
      })

      it.skipIf(!recorded.has('pull events'))('recognises every recorded event when kinds are inferred from text', () => {
        if (create(replay.fetch, manifest!).capabilities.eventKinds !== 'heuristic') {
          return
        }

        expect(items<ForgeEvent>('pull events').filter(event => event.kind === 'other').map(event => event.kindRaw)).toEqual([])
      })

      it.skipIf(!recorded.has('issue'))('normalises an issue and its events', () => {
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

      it.skipIf(!recorded.has('discussion'))('normalises a discussion and its first comments', () => {
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
