import type { FetchLike } from '../src/fetch.ts'
import type * as Forges from '../src/index.ts'
import type { Fixture } from '../src/testing/index.ts'
import type { RecordingManifest, StepContext } from '../test/recording/steps.ts'
import type { WriteContext, WriteManifest, WriteRun } from '../test/recording/write-steps.ts'
import type { PendingSplice } from './partial-writes.ts'
import type { StepRecording, StepRun } from './recording-store.ts'
import type { HookDelivery, WriteHarness } from './write-harness.ts'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import process, { env, exit } from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { azureDevOps, bitbucket, cloudflareArtifacts, cursorOrigin, forgejo, gitea, gitee, github, gitlab, pushin, tangled } from '../src/index.ts'
import { recordingFetch, signDelivery } from '../src/testing/index.ts'
import { recordedSteps, stepSlug } from '../test/recording/layout.ts'
import { redact } from '../test/recording/redact.ts'
import { seedScratch } from '../test/recording/seed.ts'
import { LOG_LIMIT, STEPS } from '../test/recording/steps.ts'
import { FIXTURE_HOOK_SECRET, FIXTURE_HOOK_URL, FIXTURE_TITLE, fixtureLabel, WRITE_STEPS } from '../test/recording/write-steps.ts'
import { differingKeys, PENDING_SPLICE, reportSplice, spliceWrites } from './partial-writes.ts'
import { patientFetch } from './rate-limits.ts'
import { connectedSteps, trackReads, writeRecording } from './recording-store.ts'
import { canReplay, fixtures } from './stabilise-recordings.ts'
import { guardedFetch } from './write-guard.ts'
import { writeHarness } from './write-harness.ts'

const { positionals: [target], values: flags } = parseArgs({ allowPositionals: true, options: { 'anonymous': { type: 'boolean', default: false }, 'app': { type: 'boolean', default: false }, 'writes': { type: 'boolean', default: false }, 'webhooks': { type: 'boolean', default: false }, 'seed': { type: 'boolean', default: false }, 'only': { type: 'string', multiple: true }, 'allow-fewer': { type: 'boolean', default: false }, 'defer-splice': { type: 'boolean', default: false } } })
const TOKEN_VARIABLES: Record<string, string> = { 'github': 'GITHUB_TOKEN', 'forgejo': 'CODEBERG_TOKEN', 'gitlab': 'GITLAB_TOKEN', 'bitbucket': 'BITBUCKET_TOKEN', 'cursor-origin': 'CURSOR_AUTH_TOKEN', 'gitee': 'GITEE_TOKEN', 'azure-devops': 'AZURE_DEVOPS_TOKEN', 'gitea': 'GITEA_TOKEN', 'pushin': 'PUSHIN_TOKEN', 'tangled': 'TANGLED_PASSWORD', 'cloudflare-artifacts': 'CLOUDFLARE_ARTIFACTS_TOKEN' }

if (!target || !(target in TOKEN_VARIABLES)) {
  console.error('Usage: pnpm record-fixtures <github|forgejo|gitlab|bitbucket|tangled|cursor-origin|gitee|azure-devops|gitea|pushin|cloudflare-artifacts> [--anonymous | --app | --writes [--allow-fewer] [--defer-splice] | --webhooks | --seed] [--only <step>]...')
  exit(1)
}

/** The steps to write, by name or by directory name; the steps before the last of them run too, as later steps read what earlier ones found. */
const selectable: Array<{ name: string }> = flags.writes ? WRITE_STEPS : STEPS
const only = flags.only && new Set(flags.only.map(name => selectable.find(step => step.name === name || stepSlug(step.name) === name)?.name ?? name))
if (only && (flags.webhooks || flags.seed)) {
  console.error('--only records read or write steps. Webhook deliveries and the seed are recorded as a whole.')
  exit(1)
}
const unknown = [...only ?? []].filter(name => !selectable.some(step => step.name === name))
if (unknown.length) {
  console.error(`No ${flags.writes ? 'write' : 'read'} steps named ${unknown.map(name => `\`${name}\``).join(', ')}.`)
  exit(1)
}

const app = flags.app ? githubApp() : undefined

/** GitHub App credentials from `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY_PATH`) and `GITHUB_APP_INSTALLATION_ID`. */
function githubApp(): Forges.AppAuth & { installationId: string } {
  const privateKey = env.GITHUB_APP_PRIVATE_KEY ?? (env.GITHUB_APP_PRIVATE_KEY_PATH && readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8'))
  if (target !== 'github' || !env.GITHUB_APP_ID || !privateKey || !env.GITHUB_APP_INSTALLATION_ID) {
    console.error('--app records GitHub only, and needs GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_APP_INSTALLATION_ID.')
    exit(1)
  }
  return { type: 'app', appId: env.GITHUB_APP_ID, privateKey, installationId: env.GITHUB_APP_INSTALLATION_ID }
}

const bitbucketBasic = !flags.anonymous && target === 'bitbucket' && env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD
const codeForgejo = target === 'forgejo' && env.CODEBERG_BASE_URL?.startsWith('https://code.forgejo.org')
const token = flags.anonymous || app ? undefined : (codeForgejo && env.CODE_FORGEJO_TOKEN) || env[TOKEN_VARIABLES[target] ?? '']
if (!token && (target === 'cursor-origin' || target === 'cloudflare-artifacts')) {
  console.error(flags.anonymous ? `${target} has no anonymous access.` : `No ${TOKEN_VARIABLES[target]} in the environment or .env.`)
  exit(1)
}
const anonymous = !token && !bitbucketBasic && !app && !flags.writes && !flags.webhooks && !flags.seed
if (anonymous) {
  console.info(flags.anonymous ? 'Recording anonymously.' : 'No token; recording anonymously.')
}

/** The example account id from Cloudflare's docs, so the real one stays out of recordings. */
const ARTIFACTS_ACCOUNT = '023e105f4ecef8ad9ca31a8372d0c353'
const artifactsAccount = target === 'cloudflare-artifacts' ? env.CLOUDFLARE_ARTIFACTS_ACCOUNT_ID : undefined
if (target === 'cloudflare-artifacts' && !artifactsAccount) {
  console.error('No CLOUDFLARE_ARTIFACTS_ACCOUNT_ID in the environment or .env.')
  exit(1)
}

/** Sends a request to the real account and names the example one in any text it returns. */
async function liveFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!artifactsAccount) {
    return fetch(input, init)
  }
  const response = await fetch(input.replaceAll(ARTIFACTS_ACCOUNT, artifactsAccount), init)
  const bytes = new Uint8Array(await response.arrayBuffer())
  let text: string | undefined
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {}
  const body = text === undefined ? bytes : text.replaceAll(artifactsAccount, ARTIFACTS_ACCOUNT)
  return new Response(bytes.length ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers })
}

const root = env.FIXTURES_OUT ?? fileURLToPath(new URL(`../test/fixtures/${target}/recorded/`, import.meta.url))
let out = ''

/**
 * Recordings are kept per instance host, so recording another instance never
 * replaces this one. Anonymous recordings go under `<host>-anonymous/`,
 * GitHub App recordings under `<host>-app/`, write recordings under
 * `<host>-writes/` and webhook deliveries under `<host>-webhooks/`. Webhook
 * deliveries replace the directory; other recordings update it step by step.
 */
function useInstance(provider: Forges.ForgeProvider): void {
  out = `${root}${provider.instance}${anonymous ? '-anonymous' : app ? '-app' : flags.writes ? '-writes' : flags.webhooks ? '-webhooks' : ''}/`
  if (flags.webhooks) {
    rmSync(out, { recursive: true, force: true })
  }
  mkdirSync(out, { recursive: true })
}

let failures = 0

/** Query parameters that sign a short-lived download URL, such as a release asset or a job log in blob storage. */
const SIGNATURE_PARAMETERS = new Set(['sig', 'jwt', 'token', 'skoid', 'sktid', 'x-amz-signature', 'x-amz-credential', 'x-amz-security-token'])

function unsign(url: string): string {
  const parsed = new URL(url)
  let signed = false
  for (const key of [...parsed.searchParams.keys()]) {
    if (SIGNATURE_PARAMETERS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, 'REDACTED')
      signed = true
    }
  }
  return signed ? parsed.toString() : url
}

const live = patientFetch(liveFetch, { writeGap: flags.writes || flags.webhooks || flags.seed ? 1000 : 0, timeout: 30_000, log: message => console.error(message) })

const recorder = recordingFetch(async (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase()
  const response = await live.fetch(input, init)
  console.info(`${response.status < 400 ? 'recorded' : 'error   '} ${response.status} ${method} ${unsign(input)}`)
  return response
}, ({ request, response }) => {
  const { body, encoding, headers, ...rest } = response
  const kept = typeof body === 'string' && !encoding && body.length > LOG_LIMIT ? body.slice(0, LOG_LIMIT) : body
  return {
    request: { ...request, url: unsign(request.url), ...request.body !== undefined && { body: redact(request.body) } },
    response: {
      ...rest,
      headers: headers?.location ? { ...headers, location: unsign(new URL(headers.location, request.url).toString()) } : headers,
      // A redirect body repeats the signed location and nothing reads it.
      ...response.status >= 300 && response.status < 400 ? {} : { body: encoding ? body : redact(kept), ...encoding && { encoding } },
    },
  }
}, { requestBodies: flags.writes })
const recordLive = recorder.fetch

/** Responses to failed steps, left out of the recording. */
const discarded = new Set<Fixture>()

/** The steps that succeeded, with the responses each received, and those that failed. */
const recorded: StepRecording[] = []
const failed: StepRun[] = []

/** The context steps share, recording which step wrote each finding and which findings each step read. */
function trackedContext<T extends object>(target: T): { context: T, run: (name: string, run: () => Promise<unknown>) => Promise<boolean> } {
  const { context, start: startStep, reads } = trackReads(target)
  return {
    context,
    run: async (name, run) => {
      startStep(name)
      const start = recorder.fixtures.length
      const recordedAt = new Date().toISOString()
      const ok = await step(name, run)
      const needs = reads()
      if (ok) {
        recorded.push({ name, recordedAt, needs, fixtures: recorder.fixtures.slice(start) })
      }
      else {
        failed.push({ name, needs })
      }
      return ok
    },
  }
}

/** Writes the recorded steps, with the responses received outside any step, which replay falls back to. */
function writeSteps(options: { keepFailed?: boolean } = {}): void {
  const inSteps = new Set(recorded.flatMap(step => step.fixtures))
  const setup = recorder.fixtures.filter(fixture => !inSteps.has(fixture) && !discarded.has(fixture))
  const result = writeRecording(out, { steps: recorded, failed, setup, only, ...options })
  const list = (names: string[]) => names.map(name => `\n  ${name}`).join('')
  console.info(`${result.written.length} step(s) written, ${result.unchanged.length} unchanged apart from rate limits, counters and activity times.`)
  if (result.extra.length) {
    console.info(`Also wrote these steps, which changed and read from or are read by a written step:${list(result.extra)}`)
  }
  if (result.kept.length) {
    console.error(`Kept the earlier recording of the steps that failed:${list(result.kept)}`)
  }
  if (result.dropped.length) {
    console.error(`Removed the earlier recording of the steps that failed, as it read findings recorded since:${list(result.dropped)}`)
  }
  if (result.removed.length) {
    console.info(`Removed steps the provider no longer records:${list(result.removed)}`)
  }
  if (result.stale.length) {
    console.error(`These steps did not run, and read from or are read by a written step, so they may no longer replay; record them too with --only:${list(result.stale)}`)
  }
}

/** Writes `selection` into the committed recording, with the identifiers this run created renamed to the committed ones, and removes the steps in `remove`; returns whether it did. */
function spliceSelected(recording: string, manifest: WriteManifest, selection: Set<string>, remove: string[] = []): boolean {
  const inSteps = new Set(recorded.flatMap(step => step.fixtures))
  const setup = recorder.fixtures.filter(fixture => !inSteps.has(fixture) && !discarded.has(fixture))
  const run = { manifest, steps: recorded, setup }
  if (flags['defer-splice']) {
    writeFileSync(`${out}${PENDING_SPLICE}`, `${JSON.stringify({ ...run, only: [...selection], remove } satisfies PendingSplice)}\n`)
    console.info(`Saved the run in ${out}${PENDING_SPLICE}, for \`node scripts/splice-partial.ts\` to splice into the committed recording.`)
    return true
  }
  return reportSplice(spliceWrites(recording, run, selection, remove))
}

async function step(name: string, run: () => Promise<unknown>): Promise<boolean> {
  const start = recorder.fixtures.length
  try {
    await run()
    return true
  }
  catch (error) {
    failures++
    console.error(`FAILED   ${name}: ${(error as Error).message}`)
    // A failed step isn't replayed from this run, so none of its responses belong in `setup/`.
    for (const fixture of recorder.fixtures.slice(start)) {
      discarded.add(fixture)
    }
    return false
  }
}

/**
 * GitLab to-dos carry no visibility flag, so each referenced project or group
 * is fetched without credentials and to-dos for anything not public are
 * removed from the recording.
 */
async function dropPrivateTodos(baseUrl: string): Promise<void> {
  const fixture = recorder.fixtures.find(fixture => fixture.request.url.includes('/todos'))
  if (!fixture) {
    return
  }
  const todos = fixture.response.body as Array<{ project?: { id: number } | null, group?: { id: number } | null }>
  const visibility = new Map<string, Promise<boolean>>()
  const isPublic = (path: string) => {
    if (!visibility.has(path)) {
      visibility.set(path, fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10_000) }).then(response => response.ok))
    }
    return visibility.get(path)!
  }
  const kept = []
  for (const todo of todos) {
    const path = todo.project ? `/projects/${todo.project.id}` : todo.group ? `/groups/${todo.group.id}` : undefined
    if (path && await isPublic(path)) {
      kept.push(todo)
    }
  }
  console.info(`kept ${kept.length} of ${todos.length} to-dos on public projects or groups`)
  fixture.response.body = kept
}

/** A GitHub token also reads the private events of its own account, so events not marked public are removed from the recording. */
function dropPrivateEvents(): void {
  for (const fixture of recorder.fixtures) {
    if (new URL(fixture.request.url).pathname.endsWith('/events') && Array.isArray(fixture.response.body)) {
      fixture.response.body = (fixture.response.body as Array<{ public?: boolean }>).filter(event => event.public !== false)
    }
  }
}

function ref(forge: string, instance: string, slug: string, kind: Forges.ThreadKind, number: string | undefined): Forges.ThreadRef | undefined {
  if (!number) {
    return undefined
  }
  const [owner = '', name = ''] = slug.split('/')
  return { forge, instance, repo: { forge, instance, owner, name }, kind, number }
}

function repoRef(forge: string, instance: string, slug: string): Forges.RepoRef {
  const [owner = '', name = ''] = slug.split('/')
  return { forge, instance, owner, name }
}

/**
 * The repositories in `FIXTURE_<FORGE>_SCRATCH_REPO`, `FIXTURE_<FORGE>_ALERTS_REPO`,
 * `FIXTURE_<FORGE>_TRANSFER_REPO` and `FIXTURE_<FORGE>_COLLABORATOR_REPO`, for
 * reads that need setup the recorded repository lacks and for write recordings.
 */
function setupRepos(prefix: string, toRef: (slug: string) => Forges.RepoRef): Pick<RecordingManifest, 'scratch' | 'alerts' | 'transfer' | 'collaborators'> {
  const [scratch, alerts, transfer, collaborators] = ['SCRATCH', 'ALERTS', 'TRANSFER', 'COLLABORATOR'].map(kind => env[`FIXTURE_${prefix}_${kind}_REPO`])
  return { ...scratch && { scratch: toRef(scratch) }, ...alerts && { alerts: toRef(alerts) }, ...transfer && { transfer: toRef(transfer) }, ...collaborators && { collaborators: toRef(collaborators) } }
}

/** Long enough for `live` to wait out rate limits, which limits each attempt itself. */
const timeout = 30 * 60_000

/** What a provider signs in with: a token, Basic credentials, GitHub App credentials, or a Tangled app password with its account. */
interface Credentials {
  token?: string
  basic?: { username: string, password: string }
  app?: Forges.AppAuth & { installationId: string }
  identifier?: string
  pds?: string
}

const readCredentials: Credentials = {
  token,
  ...bitbucketBasic && { basic: { username: env.BITBUCKET_USERNAME!, password: env.BITBUCKET_APP_PASSWORD! } },
  ...app && { app },
  identifier: env.TANGLED_IDENTIFIER,
  pds: env.TANGLED_PDS,
}

/** Who reviews in a write recording. A Tangled reviewer writes records into its own account, so it is a second bot rather than yours. */
const reviewerCredentials: Credentials | undefined = target === 'tangled'
  ? env.TANGLED_REVIEWER_PASSWORD ? { token: env.TANGLED_REVIEWER_PASSWORD, identifier: env.TANGLED_REVIEWER_IDENTIFIER, pds: env.TANGLED_REVIEWER_PDS } : undefined
  : readCredentials.token || readCredentials.basic ? readCredentials : undefined

interface Target {
  provider: Forges.ForgeProvider
  manifest: Omit<RecordingManifest, 'steps' | 'recordedAt'>
  /** Fills in manifest refs the forge can only resolve by reading, before the steps run. */
  prepare?: (manifest: RecordingManifest) => Promise<void>
  after?: () => Promise<void>
  /** Removes from the responses what the recording must not keep, before they are written. */
  scrub?: () => Promise<void>
}

function targetFor(credentials: Credentials, fetch: FetchLike): Target {
  const tokenAuth = credentials.token ? { type: 'token' as const, token: credentials.token } : undefined
  switch (target) {
    case 'github': {
      const provider = github({ baseUrl: env.GITHUB_BASE_URL, auth: credentials.app ?? tokenAuth, fetch, timeout }).create()
      const slug = env.FIXTURE_GITHUB_REPO ?? 'h3js/h3'
      const discussionSlug = env.FIXTURE_GITHUB_DISCUSSION_REPO ?? 'nuxt/nuxt'
      return { provider, manifest: {
        repo: repoRef('github', provider.instance, slug),
        pull: ref('github', provider.instance, slug, 'pull_request', env.FIXTURE_GITHUB_PULL ?? '1000'),
        issue: ref('github', provider.instance, slug, 'issue', env.FIXTURE_GITHUB_ISSUE ?? '1558'),
        discussion: ref('github', provider.instance, discussionSlug, 'discussion', env.FIXTURE_GITHUB_DISCUSSION ?? '9303'),
        feedUser: env.FIXTURE_GITHUB_FEED_USER ?? 'danielroe',
        ...credentials.app && { installation: credentials.app.installationId },
        ...setupRepos('GITHUB', slug => repoRef('github', provider.instance, slug)),
      }, scrub: async () => dropPrivateEvents() }
    }
    case 'bitbucket': {
      const provider = bitbucket({
        auth: credentials.basic ? { type: 'basic', ...credentials.basic } : tokenAuth,
        baseUrl: env.BITBUCKET_BASE_URL,
        fetch,
        timeout,
      }).create()
      const slug = env.FIXTURE_BITBUCKET_REPO ?? 'neelabo/neeview'
      return { provider, manifest: {
        repo: repoRef('bitbucket', provider.instance, slug),
        pull: ref('bitbucket', provider.instance, slug, 'pull_request', env.FIXTURE_BITBUCKET_PULL ?? '37'),
        ...setupRepos('BITBUCKET', slug => repoRef('bitbucket', provider.instance, slug)),
      } }
    }
    case 'tangled': {
      const messages: unknown[] = []
      const provider = tangled({
        baseUrl: env.TANGLED_BASE_URL,
        recordsUrl: env.TANGLED_RECORDS_URL,
        ...credentials.token && { auth: { type: 'app_password', identifier: credentials.identifier ?? '', password: credentials.token, pds: credentials.pds }, notificationsUrl: env.TANGLED_NOTIFICATIONS_URL },
        fetch,
        timeout,
        webSocket: (url) => {
          const socket = new WebSocket(url)
          socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
          return socket as unknown as Forges.WebSocketLike
        },
      }).create()
      const placeholder = { forge: 'tangled', instance: provider.instance, owner: '', name: '' }
      const issue: Forges.ThreadRef = { forge: 'tangled', instance: provider.instance, repo: placeholder, kind: 'issue', number: env.FIXTURE_TANGLED_ISSUE ?? 'at://did:plc:7qksav5io2s4qfg67pe7iqqk/sh.tangled.repo.issue/3mxmwlijmkm2y' }
      const pull: Forges.ThreadRef = { forge: 'tangled', instance: provider.instance, repo: placeholder, kind: 'pull_request', number: env.FIXTURE_TANGLED_PULL ?? 'at://did:plc:7qksav5io2s4qfg67pe7iqqk/sh.tangled.repo.pull/3mxhm5yldov22' }
      const manifest: Target['manifest'] = {
        repo: placeholder,
        pull,
        issue,
        feedUser: env.FIXTURE_TANGLED_FEED_USER ?? 'danielroe.dev',
        recordsUrl: env.TANGLED_RECORDS_URL,
        ...credentials.token && { account: credentials.identifier, pds: credentials.pds, notificationsUrl: env.TANGLED_NOTIFICATIONS_URL },
        ...setupRepos('TANGLED', slug => repoRef('tangled', provider.instance, slug)),
      }
      return {
        provider,
        manifest,
        prepare: async (recorded) => {
          const [pullThread, issueThread] = await Promise.all([provider.threads.get(pull), provider.threads.get(issue)])
          recorded.repo = pullThread.ref.repo
          recorded.pull = pullThread.ref
          recorded.issue = issueThread.ref
        },
        after: async () => {
          await step('jetstream', async () => {
            const controller = new AbortController()
            setTimeout(() => controller.abort(), 8_000)
            const cursor = String((Date.now() - 3 * 3_600_000) * 1000)
            let events = 0
            for await (const _ of provider.sources.subscribe({ cursor, signal: controller.signal })) {
              if (++events >= 15) {
                controller.abort()
              }
            }
            if (!events) {
              throw new Error(`${messages.length} jetstream messages since the cursor yielded no events; kept the earlier jetstream.json`)
            }
            let others = 0
            const kept = messages.filter(message => (message as { kind?: string }).kind === 'commit' || others++ < 3)
            writeFileSync(`${out}jetstream.json`, `${JSON.stringify({ cursor, messages: kept }, null, 2)}\n`)
            console.info(`recorded ${messages.length} jetstream messages yielding ${events} events`)
          })
        },
      }
    }
    case 'azure-devops': {
      // A new organisation cannot have public projects, so anonymous recordings read a public one elsewhere.
      const fixture = (name: string, publicDefault: string) => anonymous ? env[`FIXTURE_AZURE_DEVOPS_ANONYMOUS_${name}`] ?? publicDefault : env[`FIXTURE_AZURE_DEVOPS_${name}`] ?? ''
      const organization = fixture('ORGANIZATION', 'dnceng-public')
      const provider = azureDevOps({ auth: tokenAuth, organization, fetch, timeout }).create()
      const projectRepo = (slug: string) => {
        const [project = '', name = ''] = slug.split('/')
        return { forge: 'azure-devops', instance: provider.instance, owner: `${organization}/${project}`, name }
      }
      const repo = projectRepo(`${fixture('PROJECT', 'public')}/${fixture('REPO', 'dotnet-public-wiki')}`)
      const issue = fixture('ISSUE', '')
      return { provider, manifest: {
        repo,
        pull: { forge: 'azure-devops', instance: provider.instance, repo, kind: 'pull_request', number: fixture('PULL', '5') || '1' },
        issue: issue ? { forge: 'azure-devops', instance: provider.instance, repo, kind: 'issue', number: issue } : undefined,
        ...setupRepos('AZURE_DEVOPS', projectRepo),
      } }
    }
    case 'gitee': {
      const provider = gitee({ auth: tokenAuth, fetch, timeout }).create()
      const slug = env.FIXTURE_GITEE_REPO ?? 'cmcc-oneos/OneOS'
      return { provider, manifest: {
        repo: repoRef('gitee', provider.instance, slug),
        pull: ref('gitee', provider.instance, slug, 'pull_request', env.FIXTURE_GITEE_PULL ?? '540'),
        issue: ref('gitee', provider.instance, slug, 'issue', env.FIXTURE_GITEE_ISSUE ?? 'I8NUPF'),
        feedUser: env.FIXTURE_GITEE_FEED_USER,
        ...setupRepos('GITEE', slug => repoRef('gitee', provider.instance, slug)),
      } }
    }
    case 'cursor-origin': {
      const provider = cursorOrigin({ auth: tokenAuth!, fetch, timeout }).create()
      const slug = env.FIXTURE_CURSOR_ORIGIN_REPO ?? ''
      return { provider, manifest: {
        repo: repoRef('cursor-origin', provider.instance, slug),
        pull: ref('cursor-origin', provider.instance, slug, 'pull_request', env.FIXTURE_CURSOR_ORIGIN_PULL ?? '1'),
        ...setupRepos('CURSOR_ORIGIN', slug => repoRef('cursor-origin', provider.instance, slug)),
      } }
    }
    case 'gitlab': {
      const provider = gitlab({ baseUrl: env.GITLAB_BASE_URL, auth: tokenAuth, fetch, timeout }).create()
      const projectRepo = (project: string) => {
        const slash = project.lastIndexOf('/')
        return { forge: 'gitlab', instance: provider.instance, owner: project.slice(0, slash), name: project.slice(slash + 1) }
      }
      const repo = projectRepo(env.FIXTURE_GITLAB_PROJECT ?? 'gitlab-org/cli')
      return {
        provider,
        manifest: {
          repo,
          pull: { forge: 'gitlab', instance: provider.instance, repo, kind: 'pull_request', number: env.FIXTURE_GITLAB_MR ?? '3988' },
          issue: { forge: 'gitlab', instance: provider.instance, repo, kind: 'issue', number: env.FIXTURE_GITLAB_ISSUE ?? '8572' },
          feedUser: env.FIXTURE_GITLAB_FEED_USER ?? 'danielroe',
          ...setupRepos('GITLAB', projectRepo),
        },
        scrub: () => dropPrivateTodos(provider.baseUrl),
      }
    }
    case 'gitea': {
      const provider = gitea({ baseUrl: env.GITEA_BASE_URL, auth: tokenAuth, fetch, timeout }).create()
      const slug = env.FIXTURE_GITEA_REPO ?? 'gitea/tea'
      return { provider, manifest: {
        repo: repoRef('gitea', provider.instance, slug),
        pull: ref('gitea', provider.instance, slug, 'pull_request', env.FIXTURE_GITEA_PULL ?? '1099'),
        issue: ref('gitea', provider.instance, slug, 'issue', env.FIXTURE_GITEA_ISSUE ?? '1095'),
        feedUser: env.FIXTURE_GITEA_FEED_USER ?? 'danielroe',
        ...setupRepos('GITEA', slug => repoRef('gitea', provider.instance, slug)),
      } }
    }
    case 'pushin': {
      const provider = pushin({ baseUrl: env.PUSHIN_BASE_URL, auth: tokenAuth, fetch, timeout }).create()
      const slug = env.FIXTURE_PUSHIN_REPO ?? 'pjullrich/pushin-cli'
      return { provider, manifest: {
        repo: repoRef('pushin', provider.instance, slug),
        issue: ref('pushin', provider.instance, slug, 'issue', env.FIXTURE_PUSHIN_ISSUE ?? '2'),
        pull: ref('pushin', provider.instance, env.FIXTURE_PUSHIN_PULL_REPO ?? 'danielroe/roe.dev-test', 'pull_request', env.FIXTURE_PUSHIN_PULL ?? '1'),
        ...setupRepos('PUSHIN', slug => repoRef('pushin', provider.instance, slug)),
      } }
    }
    case 'cloudflare-artifacts': {
      const provider = cloudflareArtifacts({ accountId: ARTIFACTS_ACCOUNT, auth: tokenAuth!, fetch, timeout }).create()
      return { provider, manifest: { repo: repoRef('cloudflare-artifacts', provider.instance, env.FIXTURE_CLOUDFLARE_ARTIFACTS_REPO ?? 'forges-fixtures/forges') } }
    }
    default: {
      const provider = forgejo({ baseUrl: env.CODEBERG_BASE_URL, auth: tokenAuth, fetch, timeout }).create()
      const slug = env.FIXTURE_FORGEJO_REPO ?? (codeForgejo ? 'forgejo/runner' : 'forgejo/forgejo')
      return {
        provider,
        manifest: {
          repo: repoRef('forgejo', provider.instance, slug),
          pull: ref('forgejo', provider.instance, slug, 'pull_request', env.FIXTURE_FORGEJO_PULL ?? (codeForgejo ? '1765' : '5000')),
          issue: ref('forgejo', provider.instance, slug, 'issue', env.FIXTURE_FORGEJO_ISSUE ?? (env.CODEBERG_BASE_URL ? undefined : '14613')),
          feedUser: env.FIXTURE_FORGEJO_FEED_USER ?? (env.CODEBERG_BASE_URL ? undefined : 'danielroe'),
          ...!env.CODEBERG_BASE_URL && setupRepos('FORGEJO', slug => repoRef('forgejo', provider.instance, slug)),
        },
        // A self-hosted instance gates Actions on its version.
        prepare: async (recorded) => {
          if (env.CODEBERG_BASE_URL) {
            recorded.instanceVersion = (await provider.refreshCapabilities()).version
          }
        },
      }
    }
  }
}

/** The `Authorization` header the harness sends with `token`, as each forge expects it. */
function authorizationFor(token: string): string {
  switch (target) {
    case 'gitlab':
    case 'bitbucket':
      return `Bearer ${token}`
    case 'azure-devops':
      return `Basic ${btoa(`:${token}`)}`
    default:
      return `token ${token}`
  }
}

/**
 * Records `WRITE_STEPS` against the scratch repository: as a bot account in
 * `<TOKEN_VARIABLE with _BOT>`, such as `GITHUB_BOT_TOKEN`, and as the
 * reviewer in the usual token variable.
 */
/** The bot account, scratch repository and harness that write and webhook recordings share. */
function scratchSetup(mode: string) {
  const variable = TOKEN_VARIABLES[target!]!
  const botVariable = variable.replace(/_(TOKEN|PASSWORD)$/, '_BOT_$1')
  const prefix = target!.toUpperCase().replace('-', '_')
  const botToken = env[botVariable]
  const { provider: probe, manifest: repos } = targetFor({ token: botToken }, recordLive)
  const { scratch, transfer, collaborators } = repos
  if (!botToken || !scratch) {
    console.error(`${mode} needs ${botVariable} and FIXTURE_${prefix}_SCRATCH_REPO.`)
    exit(1)
  }
  if (![scratch, transfer, collaborators].every(repo => !repo || repo.name.includes('forges-fixtures'))) {
    console.error('Write recordings only write to repositories whose names include `forges-fixtures`.')
    exit(1)
  }
  const harness = writeHarness({ forge: target!, baseUrl: probe.baseUrl, authorization: authorizationFor(botToken), scratch, transfer, collaborators, read: target === 'tangled' ? tangled({}).create() : undefined, threads: [env[`FIXTURE_${prefix}_SCRATCH_PULL`] ?? ''].filter(Boolean), ...target === 'tangled' && botToken && env.TANGLED_BOT_IDENTIFIER && { account: { identifier: env.TANGLED_BOT_IDENTIFIER, password: botToken, pds: env.TANGLED_BOT_PDS } } })
  if (!harness) {
    console.error(`${target} has no write recording setup.`)
    exit(1)
  }
  return { prefix, botToken, probe, scratch, transfer, collaborators, harness }
}

async function recordWrites(): Promise<void> {
  const { prefix, botToken, probe, scratch, transfer, collaborators, harness } = scratchSetup('--writes')
  const guard = { scope: harness.scope, allows: harness.allows, repos: [scratch, transfer, collaborators].filter(repo => repo !== undefined) }
  const author = targetFor({ token: botToken, identifier: env.TANGLED_BOT_IDENTIFIER, pds: env.TANGLED_BOT_PDS }, guardedFetch(recordLive, { ...guard, account: [`${probe.baseUrl}/notifications`, `${probe.baseUrl}/todos`] }))
  const reviewer = reviewerCredentials && targetFor(reviewerCredentials, guardedFetch(recordLive, guard)).provider
  useInstance(author.provider)
  const recording = out.startsWith(fixtures) ? out.slice(fixtures.length, -1) : undefined
  if (only && (!recording || !existsSync(`${out}manifest.json`))) {
    console.error(`--only adds steps to a write recording under test/fixtures/, and ${out} is not one. Record every step instead of passing --only.`)
    exit(1)
  }
  if (only && !flags['defer-splice'] && !canReplay()) {
    console.error('--only replays the recording with vitest, which is not installed. Run `pnpm install` first.')
    exit(1)
  }
  const id = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const run: WriteRun = {
    id,
    base: await harness.prepare(),
    branches: [1, 2, 3].map(index => `forges-fixtures/${id}-${index}`) as WriteRun['branches'],
    files: [1, 2, 3].map(index => `forges-fixtures/${id}-${index}.md`) as WriteRun['files'],
    ...env[`FIXTURE_${prefix}_REVIEWER`] && { reviewer: env[`FIXTURE_${prefix}_REVIEWER`] },
    ...env[`FIXTURE_${prefix}_SCRATCH_DISCUSSION`] && { discussion: env[`FIXTURE_${prefix}_SCRATCH_DISCUSSION`] },
    ...env[`FIXTURE_${prefix}_SCRATCH_PULL`] && { pull: env[`FIXTURE_${prefix}_SCRATCH_PULL`] },
    // Codeberg refuses a new issue or pull request when the account opened two with similar titles in the last hour.
    ...new URL(probe.baseUrl).hostname === 'codeberg.org' && { salt: randomBytes(16).toString('hex') },
  }
  await harness.cleanUp([], undefined, [])
  for (const [index, branch] of harness.createBranch ? run.branches.entries() : []) {
    await harness.createBranch!(run.base, branch, run.files[index]!)
  }

  const { baseUrl, instanceVersion, account, pds, notificationsUrl, recordsUrl } = { baseUrl: author.provider.baseUrl, ...author.manifest }
  const manifest: WriteManifest = {
    baseUrl,
    instanceVersion,
    account,
    pds,
    notificationsUrl,
    recordsUrl,
    ...target === 'tangled' && reviewerCredentials && { reviewerAccount: reviewerCredentials.identifier, reviewerPds: reviewerCredentials.pds },
    repo: scratch,
    scratch,
    transfer,
    collaborators,
    run,
  }
  const { context, run: recordStep } = trackedContext<WriteContext>({ pulls: [], comments: {}, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) })
  const succeeded = (name: string) => recorded.some(step => step.name === name)
  const last = only ? Math.max(...[...only].map(name => WRITE_STEPS.findIndex(step => step.name === name))) : WRITE_STEPS.length - 1
  const inapplicable = new Set<string>()
  try {
    for (const item of WRITE_STEPS.slice(0, last + 1)) {
      const provider = item.as === 'reviewer' ? reviewer : author.provider
      if (!provider?.can(item.verb, item.kind) || item.when?.(provider, manifest) === false) {
        inapplicable.add(item.name)
        continue
      }
      if (live.limited()) {
        console.error(`Stopped before \`${item.name}\`, as ${live.limited()}.`)
        break
      }
      await recordStep(item.name, () => item.run(provider, manifest, context))
    }
  }
  finally {
    await harness.cleanUp(run.branches, fixtureLabel(run), context.webhook && !succeeded('delete webhook') ? [context.webhook.ref.id] : [])
    if (collaborators && context.reviewer && succeeded('add collaborator')) {
      await harness.removeCollaborator?.(collaborators, context.reviewer.id)
    }
  }
  const list = (names: string[]) => names.map(name => `\n  ${name}`).join('')
  if (only) {
    const notRun = [...only].filter(name => !succeeded(name) && !failed.some(step => step.name === name))
    const skipped = notRun.filter(name => !inapplicable.has(name))
    if (notRun.length > skipped.length) {
      console.info(`These selected steps do not apply to this provider:${list(notRun.filter(name => inapplicable.has(name)))}`)
    }
    if (skipped.length) {
      console.error(`These selected steps did not run:${list(skipped)}`)
    }
    const selectedFailures = failed.filter(step => only.has(step.name)).map(step => step.name)
    if (selectedFailures.length) {
      console.error(`These selected steps failed, so they were not written:${list(selectedFailures)}`)
    }
    process.exitCode = spliceSelected(recording!, manifest, only) && !skipped.length && !selectedFailures.length ? 0 : 1
    return
  }
  const missing = recordedSteps(out).map(step => step.name).filter(name => !succeeded(name))
  const lost = missing.filter(name => WRITE_STEPS.some(step => step.name === name))
  if (lost.length && !flags['allow-fewer']) {
    if (recording && (flags['defer-splice'] || canReplay()) && spliceSelected(recording, manifest, new Set(recorded.map(step => step.name)), missing.filter(name => !lost.includes(name)))) {
      console.error(`Kept the committed recording of these steps, which this run did not record:${list(lost)}`)
      process.exitCode = 1
      return
    }
    console.error(`Kept the earlier recording, as this run did not record these steps it has; pass --allow-fewer to replace it anyway:${list(lost)}`)
    process.exitCode = 1
    return
  }
  // Without renaming, an earlier run's recording of a failed step names identifiers this run did not create, so it cannot be kept.
  writeSteps({ keepFailed: false })
  writeFileSync(`${out}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function recordReads(): Promise<void> {
  const { provider, manifest: partial, prepare, after, scrub } = targetFor(readCredentials, recordLive)
  useInstance(provider)
  const manifest: RecordingManifest = { baseUrl: provider.baseUrl, ...(anonymous && { anonymous }), ...partial }
  await prepare?.(manifest)
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  const previous = only && existsSync(`${out}manifest.json`) ? JSON.parse(readFileSync(`${out}manifest.json`, 'utf8')) as Record<string, unknown> : undefined
  const differing = previous ? differingKeys(previous, JSON.parse(json) as Record<string, unknown>) : []
  if (differing.length) {
    console.error(`${differing.map(key => `\`${key}\``).join(', ')} differ from ${out}manifest.json, so the other steps would no longer match. Record every step instead of passing --only.`)
    exit(1)
  }
  const planned = only && connectedSteps(out, only)
  const last = planned ? Math.max(...[...planned].map(name => STEPS.findIndex(step => step.name === name))) : STEPS.length - 1
  const { context, run: recordStep } = trackedContext<StepContext>({})
  for (const item of STEPS.slice(0, last + 1)) {
    const thread = item.kind === 'issue' ? manifest.issue : item.kind === 'discussion' ? manifest.discussion : item.kind === 'pull_request' ? manifest.pull : true
    if (!thread || !provider.can(item.verb, item.kind) || item.when?.(provider, manifest) === false) {
      continue
    }
    await recordStep(item.name, () => item.run(provider, manifest, context))
  }
  if (!only) {
    await after?.()
  }
  await scrub?.()
  writeSteps()
  writeFileSync(`${out}manifest.json`, json)
}

interface DeliverySource {
  url: string
  deliveries: (hook: string) => Promise<HookDelivery[]>
  close: () => Promise<void>
}

/** The forge's own record of what a hook sent, where its API returns it; the hook can then point nowhere. */
function forgeRecord(harness: WriteHarness): DeliverySource | undefined {
  return harness.payloads && { url: FIXTURE_HOOK_URL, deliveries: harness.payloads, close: async () => {} }
}

/** A webhook.site relay: deliveries sent to `url` are read back over HTTPS, so the recorder needs no inbound access. */
async function relay(): Promise<DeliverySource> {
  const { uuid } = await (await fetch('https://webhook.site/token', { method: 'POST', headers: { accept: 'application/json' } })).json() as { uuid: string }
  return {
    url: `https://webhook.site/${uuid}`,
    deliveries: async () => {
      const { data } = await (await fetch(`https://webhook.site/token/${uuid}/requests?sorting=oldest&per_page=50`, { headers: { accept: 'application/json' } })).json() as { data: Array<{ content: string, headers: Record<string, string[] | string> }> }
      return data.map(request => ({ body: request.content, headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value])) }))
    },
    close: async () => {
      await fetch(`https://webhook.site/token/${uuid}`, { method: 'DELETE' })
    },
  }
}

/** Headers a delivery carries that name the event or the delivery; the rest are the relay's or the transport's. */
const DELIVERY_HEADER = /^(?:x-(?!forwarded|real-ip|amz|vercel|webhook-site)[\w-]+|content-type|user-agent|authorization)$/

/**
 * Records webhook deliveries of the scratch repository: creates a hook, opens
 * and comments on an issue and pushes a branch, then reads the deliveries back
 * from the forge's API or, where the forge keeps no payloads, from a relay the
 * hook points at. Each body is redacted and signed again with the dummy
 * secret, so a replay verifies it like a live delivery.
 */
async function recordWebhooks(): Promise<void> {
  const { botToken, scratch, harness } = scratchSetup('--webhooks')
  const plain = targetFor({ token: botToken }, guardedFetch(live.fetch, { scope: harness.scope, allows: harness.allows, repos: [scratch] })).provider
  const id = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const base = await harness.prepare()
  const relayed = forgeRecord(harness) ?? await relay()
  const hook = await plain.webhooks.create(scratch, { url: relayed.url, events: ['comment', 'state_change', 'push'], secret: FIXTURE_HOOK_SECRET, contentType: 'json' })
  const branch = `forges-fixtures/${id}-webhooks`
  let deliveries: HookDelivery[] = []
  try {
    await harness.createBranch?.(base, branch, `forges-fixtures/${id}-webhooks.md`)
    // Forges without issues, such as Bitbucket, get a pull request from the pushed branch instead.
    const thread = plain.can('threads.create', 'issue')
      ? await plain.threads.create(scratch, { kind: 'issue', title: `${FIXTURE_TITLE} ${id}: webhooks`, body: `Opened by run ${id}.` })
      : await plain.threads.create(scratch, { kind: 'pull_request', title: `${FIXTURE_TITLE} ${id}: webhooks`, body: `Opened by run ${id}.`, head: branch, base })
    await plain.threads.comment(thread.ref, `A comment from run ${id}.`)
    await plain.threads.close(thread.ref)
    // The push, open, comment and close above produce at least four deliveries; forges may send more, so stop once two polls in a row find nothing new.
    for (let attempt = 0, quiet = 0; attempt < 12 && quiet < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5_000))
      const previous = deliveries.length
      deliveries = await relayed.deliveries(hook.ref.id)
      quiet = deliveries.length >= 4 && deliveries.length === previous ? quiet + 1 : 0
    }
  }
  finally {
    await plain.webhooks.delete(hook.ref).catch(() => {})
    await harness.cleanUp([branch], undefined, [])
    await relayed.close().catch(() => {})
  }
  useInstance(plain)
  const names: string[] = []
  for (const [index, delivery] of deliveries.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(delivery.body)
    }
    catch {
      console.error(`skipped a delivery that is not JSON: ${delivery.headers['content-type']}`)
      continue
    }
    const body = JSON.stringify(redact(parsed))
    const kept = Object.fromEntries(Object.entries(delivery.headers).filter(([name]) => DELIVERY_HEADER.test(name) && !/signature|token|authorization/.test(name)))
    const headers = await signDelivery(plain.forge, body, FIXTURE_HOOK_SECRET, kept)
    const event = headers['x-github-event'] ?? headers['x-gitlab-event'] ?? headers['x-gitea-event'] ?? headers['x-forgejo-event'] ?? headers['x-event-key'] ?? 'delivery'
    const name = `${String(index + 1).padStart(2, '0')}-${event.toLowerCase().replace(/\W+/g, '-')}`
    writeFileSync(`${out}${name}.delivery.json`, `${JSON.stringify({ headers, body }, null, 2)}\n`)
    names.push(name)
    console.info(`recorded delivery ${name}`)
  }
  const manifest = { baseUrl: plain.baseUrl, repo: scratch, scratch, webhookSecret: FIXTURE_HOOK_SECRET, recordedAt: new Date().toISOString(), steps: [], deliveries: names }
  writeFileSync(`${out}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Writes the scratch repository's seeded threads with the bot account, recording nothing. */
async function seed(): Promise<void> {
  const { prefix, botToken, scratch, transfer, collaborators, harness } = scratchSetup('--seed')
  await harness.prepare()
  await harness.seed?.()
  const guard = { scope: harness.scope, allows: harness.allows, repos: [scratch, transfer, collaborators].filter(repo => repo !== undefined) }
  const { provider } = targetFor({ token: botToken, identifier: env.TANGLED_BOT_IDENTIFIER, pds: env.TANGLED_BOT_PDS }, guardedFetch(live.fetch, guard))
  const reviewer = reviewerCredentials && targetFor(reviewerCredentials, guardedFetch(live.fetch, guard)).provider
  const pull = env[`FIXTURE_${prefix}_SCRATCH_PULL`]
  const seeded = await seedScratch(provider, scratch, pull ? { forge: provider.forge, instance: provider.instance, repo: scratch, kind: 'pull_request', number: pull } : undefined, reviewer)
  console.info(`seeded issue ${seeded.issue.number}${seeded.pull ? ` and pull ${seeded.pull.number}` : ''}`)
}

await (flags.seed ? seed() : flags.writes ? recordWrites() : flags.webhooks ? recordWebhooks() : recordReads())

if (failures) {
  console.error(`${failures} step(s) failed.`)
}
