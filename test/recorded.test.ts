import type { FetchLike } from '../src/fetch.ts'
import type { Comment, FileContent, ForgeEvent, Notification, NotificationReason, Page, Repo, ResolvedThreadRef, Review, Thread } from '../src/model.ts'
import type { ForgeProvider } from '../src/provider.ts'
import type { RecordingManifest, Step, StepContext } from './recording/steps.ts'
import type { WriteContext, WriteManifest, WriteStep } from './recording/write-steps.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { affectedKeys, commentKey, isResolvedThread, notificationThread, parseCommentKey, parseRepoKey, parseThreadKey, repoKey } from '../src/model.ts'
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

/** The forges, by display name, on which a recording reads each listing again with its first page's `etag`. */
const conditionalListings = new Map<string, Set<string>>()

const FORGE_NAMES: Record<string, string> = { 'github': 'GitHub', 'gitlab': 'GitLab', 'bitbucket': 'Bitbucket', 'forgejo': 'Forgejo', 'gitea': 'Gitea', 'gitee': 'Gitee', 'azure-devops': 'Azure DevOps', 'cursor-origin': 'Cursor Origin', 'pushin': 'Pushin.eu', 'tangled': 'Tangled', 'cloudflare-artifacts': 'Cloudflare Artifacts' }

function sameRequest(a: string, b: string): boolean {
  const [first, second] = [new URL(a), new URL(b)]
  first.searchParams.sort()
  second.searchParams.sort()
  return first.toString() === second.toString()
}

/** `provider` with the options of every call to `verb` given `cursor: { etag }`, collecting the pages that the calls return. */
function withEtag(provider: ForgeProvider, verb: string, etag: string, pages: Array<Page<unknown>>): ForgeProvider {
  const [group, method] = verb.split('.') as [string, string]
  return new Proxy(provider, {
    get(target, key, receiver) {
      const api = Reflect.get(target, key, receiver) as Record<string, unknown>
      return key !== group
        ? api
        : new Proxy(api, {
            get(apiTarget, apiKey, apiReceiver) {
              const read = Reflect.get(apiTarget, apiKey, apiReceiver) as (...args: unknown[]) => Promise<Page<unknown>>
              return apiKey !== method
                ? read
                : async (...args: unknown[]) => {
                  const page = await read(...args.slice(0, -1), { ...args.at(-1) as object, cursor: { etag } })
                  pages.push(page)
                  return page
                }
            },
          })
    },
  })
}

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
      let failure: unknown
      let intercept: ((input: string, init?: RequestInit) => Response | undefined) | undefined
      const replayFetch: FetchLike = (input, init) => {
        const response = intercept?.(input, init)
        return response ? Promise.resolve(response) : replay.fetch(input, init)
      }
      const contexts = new Map<string, StepContext & WriteContext>()
      let author: ForgeProvider | undefined
      let conditionalRequests: string[] = []
      const forgeName = FORGE_NAMES[name] ?? name
      const conditionalSteps = writes || manifest?.deliveries
        ? []
        : steps.flatMap((step) => {
            const verb = definitions.get(step.name)?.verb
            const goldenPath = `${root}steps/${step.slug}/golden.json`
            const etag = verb?.endsWith('Page') && existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as { etag?: string } | null)?.etag : undefined
            const url = etag && recordedFixtures(`${directory}/steps/${step.slug}`).find(fixture => fixture.response.headers?.etag === etag)?.request.url
            return url ? [{ ...step, verb: verb!, etag: etag!, url }] : []
          })

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
          author = create(replayFetch, manifest!, jetstream?.messages)
          const reviewer = writes?.reviewerAccount ? create(replay.fetch, { ...writes, account: writes.reviewerAccount, pds: writes.reviewerPds }) : writes ? create(replay.fetch, writes) : author
          const context: StepContext & WriteContext = { pulls: [], comments: {}, wait: async () => {} }
          for (const { name, slug, recordedAt } of steps) {
            const step = definitions.get(name)
            if (!step) {
              continue
            }
            replay.use(slug)
            vi.setSystemTime(new Date(recordedAt))
            contexts.set(name, { ...context })
            output[name] = await step.run(('as' in step && step.as === 'reviewer' ? reviewer : author) as never, manifest as never, context)
          }
          conditionalRequests = replay.calls.filter(call => call.headers.has('if-none-match')).map(call => `${call.method} ${call.url}`)
        }
        catch (error) {
          failure = error
        }
        finally {
          vi.useRealTimers()
        }
      })

      beforeEach(() => {
        if (failure) {
          throw failure
        }
      })

      it('sends no `If-None-Match` without an etag from the caller', () => {
        expect(conditionalRequests).toEqual([])
      })

      it.for(conditionalSteps)('reads the first page of $name again with its etag', async ({ name, slug, recordedAt, verb, etag, url }) => {
        const sent: Array<{ url: string, headers: Headers }> = []
        intercept = (input, init) => {
          sent.push({ url: input, headers: new Headers(init?.headers) })
          return sameRequest(input, url) ? new Response(null, { status: 304, headers: { etag } }) : undefined
        }
        const pages: Array<Page<unknown>> = []
        const step = definitions.get(name) as Step
        replay.use(slug)
        vi.useFakeTimers({ now: new Date(recordedAt), toFake: ['Date'] })
        try {
          // A step may read on past the conditional page, into responses that were never recorded.
          await step.run(withEtag(author!, verb, etag, pages), manifest!, { ...contexts.get(name)! }).catch((error: unknown) => {
            if (!pages.some(page => page.notModified)) {
              throw error
            }
          })
        }
        finally {
          intercept = undefined
          vi.useRealTimers()
        }
        const notModified = pages.find(page => page.notModified)

        expect(sent.filter(call => sameRequest(call.url, url)).map(call => call.headers.get('if-none-match'))).toContain(etag)
        expect(notModified).toMatchObject({ items: [], etag })
        expect(notModified?.cursor).toBeUndefined()
        if (verb === 'threads.listPage') {
          expect(sent.filter(call => new URL(call.url).pathname.endsWith('/graphql'))).toEqual([])
        }
        const forges = conditionalListings.get(verb) ?? new Set()
        conditionalListings.set(verb, forges.add(forgeName))
      })

      it('records only steps that exist', () => {
        expect(steps.map(step => step.name).filter(name => !definitions.has(name))).toEqual([])
      })

      it.skipIf(!steps.length)('records only steps the recorder still runs', () => {
        const author = create(fixtureFetch(directory).fetch, manifest!)
        const reviewer = writes?.reviewerAccount ? create(fixtureFetch(directory).fetch, { ...writes, account: writes.reviewerAccount, pds: writes.reviewerPds }) : author
        const threads: Record<string, unknown> = { issue: manifest!.issue, pull_request: manifest!.pull, discussion: manifest!.discussion }
        const skipped = steps.flatMap(({ name }) => definitions.get(name) ?? []).filter((step) => {
          const provider = 'as' in step && step.as === 'reviewer' ? reviewer : author
          const thread = writes || !step.kind || !(step.kind in threads) || threads[step.kind]
          return !thread || !provider.can(step.verb, step.kind) || step.when?.(provider, manifest as never) === false
        })
        expect(skipped.map(step => step.name)).toEqual([])
      })

      it.skipIf(!writes)('sends the request bodies it recorded', () => {
        const sent = replay.calls.filter(call => call.body !== undefined || call.fixture?.request.body !== undefined)
        const served = new Set(sent.map(call => JSON.stringify(call.fixture)))

        expect(withoutTimes(sent.map(call => call.body === undefined ? undefined : redact(parsed(call.body))))).toEqual(withoutTimes(sent.map(call => call.fixture?.request.body)))
        expect(recordedFixtures(directory).filter(fixture => fixture.request.body !== undefined && !served.has(JSON.stringify(fixture))).map(fixture => `${fixture.request.method} ${fixture.request.url}`)).toEqual([])
      })

      it.skipIf(!manifest?.deliveries)('keys every delivered event so that each key reads back', () => {
        const keys = (manifest!.deliveries ?? []).flatMap(name => output[name] as ForgeEvent[]).map(event => affectedKeys(event))

        expect(keys.flatMap(({ repos }) => repos).filter(key => !parseRepoKey(key))).toEqual([])
        expect(keys.flatMap(({ threads }) => threads).filter(key => !parseThreadKey(key))).toEqual([])
        expect(keys.flatMap(({ comments }) => comments).filter(key => !parseCommentKey(key))).toEqual([])
        expect(keys.some(({ threads }) => threads.length)).toBe(true)
      })

      it.for(['issue', 'pull', 'commit', 'discussion'].filter(key => recorded.has(`${key} events`) && recorded.has(`${key} comments`)))('keys the comments that %s events name as its comment listing does', (key, context) => {
        const listed = items<Comment>(`${key} comments`).map(comment => comment.ref).filter(ref => isResolvedThread(ref.thread)).map(ref => commentKey({ ...ref, thread: ref.thread as ResolvedThreadRef }))
        const commented = items<ForgeEvent>(`${key} events`).filter(event => event.kind === 'comment')
        if (!listed.length || !commented.length) {
          return context.skip()
        }

        expect(commented.flatMap(event => affectedKeys(event).comments).filter(key => listed.includes(key))).not.toEqual([])
      })

      it.skipIf(!recorded.has('pull events') || !recorded.has('pull reviews'))('names the reviews of pull events as its review listing does', (context) => {
        const listed = items<Review>('pull reviews').map(review => review.ref.id)
        const reviewed = items<ForgeEvent>('pull events').filter(event => event.kind === 'review')
        if (!listed.length || !reviewed.length) {
          return context.skip()
        }

        expect(reviewed.flatMap(event => event.detail?.type === 'review' && event.detail.review ? [event.detail.review.id] : []).filter(id => listed.includes(id))).not.toEqual([])
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

      it.skipIf(!recorded.has('repo'))('reads the repository its own web URL names', async (context) => {
        const repo = stepFixtureFetch(directory)
        repo.use(steps.find(step => step.name === 'repo')!.slug)
        const instance = create(repo.fetch, manifest!)
        if (!instance.webOrigin) {
          return context.skip()
        }
        const url = instance.urlFor({ repo: manifest!.repo })!
        const parsed = instance.parseUrl(url)

        expect(parsed).toBeDefined()
        expect(repoKey((await instance.repos.get(parsed!.repo)).ref)).toBe(repoKey((output.repo as Repo).ref))
      })

      it.skipIf(!recorded.has('readme'))('parses the web URL of its README', (context) => {
        const readme = output.readme as FileContent
        if (!readme.url) {
          return context.skip()
        }
        const parsed = create(replay.fetch, manifest!).parseUrl(readme.url)

        expect(parsed?.repo).toMatchObject({ owner: manifest!.repo.owner, name: manifest!.repo.name })
        expect(parsed?.file).toMatchObject({ path: readme.path })
        expect(parsed?.file?.at).toBeTruthy()
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

describe.skipIf(!!process.env.FORGES_RECORDING)('conditional listings', () => {
  it('lists in the pagination guide the listings that a recording reads again with its etag', (context) => {
    if (!conditionalListings.size) {
      return context.skip()
    }
    const forges = Object.values(FORGE_NAMES).filter(forge => [...conditionalListings.values()].some(set => set.has(forge)))
    const rows = [...conditionalListings].sort(([a], [b]) => a.localeCompare(b)).map(([verb, on]) => `| \`${verb}\` | ${forges.map(forge => on.has(forge) ? '✅' : '❌').join(' | ')} |`)
    const table = [`| Listing | ${forges.join(' | ')} |`, `| --- |${' --- |'.repeat(forges.length)}`, ...rows].join('\n')
    const guide = readFileSync(new URL('../docs/content/2.guides/7.pagination.md', import.meta.url), 'utf8')
    const section = guide.slice(guide.indexOf('## Polling with conditional requests'))

    expect(/^\|.*\|$(?:\n\|.*\|$)*/m.exec(section)?.[0], 'Update the table in docs/content/2.guides/7.pagination.md').toBe(table)
  })
})
