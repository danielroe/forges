import type * as Forges from '../src/index.ts'
import type { RecordingManifest, StepContext } from '../test/recording/steps.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { argv, env, exit } from 'node:process'

import { fileURLToPath } from 'node:url'
import { azureDevOps, bitbucket, cursorOrigin, forgejo, gitea, gitee, github, gitlab, pushin, tangled } from '../src/index.ts'
import { recordingFetch } from '../src/testing/index.ts'
import { STEPS } from '../test/recording/steps.ts'

const USER_KEYS_TO_DROP = new Set([
  'account_status',
  'can_create_group',
  'can_create_project',
  'collaborators',
  'color_scheme_id',
  'confirmed_at',
  'created',
  'current_sign_in_at',
  'disk_usage',
  'external',
  'has_2fa_enabled',
  'identities',
  'is_admin',
  'is_auditor',
  'language',
  'last_activity_on',
  'last_login',
  'last_sign_in_at',
  'login_name',
  'namespace_id',
  'owned_private_repos',
  'plan',
  'private_gists',
  'private_profile',
  'prohibit_login',
  'projects_limit',
  'restricted',
  'scim_identities',
  'theme_id',
  'total_private_repos',
  'two_factor_authentication',
  'two_factor_enabled',
  'using_license_seat',
  'visibility',
])
const TOKEN_PATTERN = /\b(?:gh[pousr]_\w{20,}|github_pat_\w{20,}|pun_pat_\w{20,})\b/g

function isPrivate(value: unknown): boolean {
  const item = value as { private?: boolean, visibility?: string, is_private?: boolean } | null | undefined
  return Boolean(item && typeof item === 'object' && (item.private || item.is_private || item.visibility === 'private'))
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(TOKEN_PATTERN, 'REDACTED_TOKEN')
      .replace(/<[^<>@\s]+@[^<>\s]+>/g, '<redacted@example.invalid>')
      .replace(/^(https:\/\/)[^@/]+@/, '$1')
  }
  if (Array.isArray(value)) {
    return value
      .filter(item => !isPrivate(item) && !isPrivate((item as { repository?: unknown } | null)?.repository))
      .map(redact)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const isUser = 'login' in value || 'username' in value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/email/i.test(key)) {
      result[key] = entry ? 'redacted@example.invalid' : entry
    }
    else if (isUser && USER_KEYS_TO_DROP.has(key)) {
      continue
    }
    else if (isUser && key === 'node_id') {
      result[key] = 'REDACTED'
    }
    else {
      result[key] = redact(entry)
    }
  }
  return result
}

const target = argv[2]
const TOKEN_VARIABLES: Record<string, string> = { 'github': 'GITHUB_TOKEN', 'forgejo': 'CODEBERG_TOKEN', 'gitlab': 'GITLAB_TOKEN', 'bitbucket': 'BITBUCKET_TOKEN', 'cursor-origin': 'CURSOR_AUTH_TOKEN', 'gitee': 'GITEE_TOKEN', 'azure-devops': 'AZURE_DEVOPS_TOKEN', 'gitea': 'GITEA_TOKEN', 'pushin': 'PUSHIN_TOKEN' }

if (!target || (target !== 'tangled' && !(target in TOKEN_VARIABLES))) {
  console.error('Usage: pnpm record-fixtures <github|forgejo|gitlab|bitbucket|tangled|cursor-origin|gitee|azure-devops|gitea|pushin>')
  exit(1)
}

const bitbucketBasic = target === 'bitbucket' && env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD
const token = env[TOKEN_VARIABLES[target] ?? '']
if (!token && !bitbucketBasic && ['cursor-origin', 'azure-devops'].includes(target)) {
  console.error(`No ${TOKEN_VARIABLES[target]} in the environment or .env.`)
  exit(1)
}
if (!token && !bitbucketBasic) {
  console.info('No token; recording anonymously.')
}

const root = env.FIXTURES_OUT ?? fileURLToPath(new URL(`../test/fixtures/${target}/recorded/`, import.meta.url))
let out = ''

/** Recordings are kept per instance host, so recording another instance never replaces this one. */
function useInstance(provider: Forges.ForgeProvider): void {
  out = `${root}${provider.instance}/`
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
}

let failures = 0

const recorder = recordingFetch(async (input, init) => {
  const response = await fetch(input, init)
  const method = (init?.method ?? 'GET').toUpperCase()
  const recorded = response.ok || (response.status >= 300 && response.status < 400)
  console.info(`${recorded ? 'recorded' : 'FAILED  '} ${response.status} ${method} ${input}`)
  if (!recorded) {
    failures++
  }
  return response
}, fixture => ({ ...fixture, response: { ...fixture.response, body: redact(fixture.response.body) } }))
const recordLive = recorder.fetch

function writeFixtures(): void {
  let sequence = 0
  for (const fixture of recorder.fixtures) {
    if (fixture.response.status >= 400) {
      continue
    }
    const { method, url, operationName } = fixture.request
    const slug = `${String(++sequence).padStart(2, '0')}-${method.toLowerCase()}-${operationName ?? new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('-')}`
    writeFileSync(`${out}${slug}.json`, `${JSON.stringify(fixture, null, 2)}\n`)
  }
}

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  }
  catch (error) {
    failures++
    console.error(`FAILED   ${name}: ${(error as Error).message}`)
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

const timeout = 10_000
const tokenAuth = token ? { type: 'token' as const, token } : undefined

interface Target {
  provider: Forges.ForgeProvider
  manifest: Omit<RecordingManifest, 'steps' | 'recordedAt'>
  /** Fills in manifest refs the forge can only resolve by reading, before the steps run. */
  prepare?: (manifest: RecordingManifest) => Promise<void>
  after?: () => Promise<void>
  /** Step names not to record, where a read is too large to keep as a fixture. */
  skip?: string[]
}

function targetFor(): Target {
  switch (target) {
    case 'github': {
      const provider = github({ baseUrl: env.GITHUB_BASE_URL, auth: tokenAuth, fetch: recordLive, timeout }).create()
      const slug = env.FIXTURE_GITHUB_REPO ?? 'unjs/h3'
      const discussionSlug = env.FIXTURE_GITHUB_DISCUSSION_REPO ?? 'nuxt/nuxt'
      return { provider, manifest: {
        repo: repoRef('github', provider.instance, slug),
        pull: ref('github', provider.instance, slug, 'pull_request', env.FIXTURE_GITHUB_PULL ?? '1000'),
        issue: ref('github', provider.instance, slug, 'issue', env.FIXTURE_GITHUB_ISSUE ?? '1001'),
        discussion: ref('github', provider.instance, discussionSlug, 'discussion', env.FIXTURE_GITHUB_DISCUSSION ?? '9303'),
      } }
    }
    case 'bitbucket': {
      const provider = bitbucket({
        auth: bitbucketBasic ? { type: 'basic', username: env.BITBUCKET_USERNAME!, password: env.BITBUCKET_APP_PASSWORD! } : tokenAuth,
        baseUrl: env.BITBUCKET_BASE_URL,
        fetch: recordLive,
        timeout,
      }).create()
      const slug = env.FIXTURE_BITBUCKET_REPO ?? 'neelabo/neeview'
      return { provider, manifest: {
        repo: repoRef('bitbucket', provider.instance, slug),
        pull: ref('bitbucket', provider.instance, slug, 'pull_request', env.FIXTURE_BITBUCKET_PULL ?? '37'),
      } }
    }
    case 'tangled': {
      const messages: unknown[] = []
      const provider = tangled({
        baseUrl: env.TANGLED_BASE_URL,
        recordsUrl: env.TANGLED_RECORDS_URL,
        fetch: recordLive,
        timeout,
        webSocket: (url) => {
          const socket = new WebSocket(url)
          socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
          return socket as unknown as Forges.WebSocketLike
        },
      }).create()
      const placeholder = { forge: 'tangled', instance: provider.instance, owner: '', name: '' }
      const issue: Forges.ThreadRef = { forge: 'tangled', instance: provider.instance, repo: placeholder, kind: 'issue', number: env.FIXTURE_TANGLED_ISSUE ?? 'at://did:plc:cnx5rmsyvousaqjfbbzzllbi/sh.tangled.repo.issue/3mwqhyckjiz22' }
      const pull: Forges.ThreadRef = { forge: 'tangled', instance: provider.instance, repo: placeholder, kind: 'pull_request', number: env.FIXTURE_TANGLED_PULL ?? 'at://did:plc:pzywyr3ji56pinuglmm4t7xj/sh.tangled.repo.pull/3mwq55xakxq22' }
      const manifest: Target['manifest'] = { repo: placeholder, pull, issue, recordsUrl: env.TANGLED_RECORDS_URL }
      return {
        provider,
        manifest,
        skip: ['pull list', 'issue list'],
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
            let others = 0
            const kept = messages.filter(message => (message as { kind?: string }).kind === 'commit' || others++ < 3)
            writeFileSync(`${out}jetstream.json`, `${JSON.stringify({ cursor, messages: kept }, null, 2)}\n`)
            console.info(`recorded ${messages.length} jetstream messages yielding ${events} events`)
          })
        },
      }
    }
    case 'azure-devops': {
      const organization = env.FIXTURE_AZURE_DEVOPS_ORGANIZATION ?? ''
      const provider = azureDevOps({ auth: tokenAuth!, organization, fetch: recordLive, timeout }).create()
      const repo = { forge: 'azure-devops', instance: provider.instance, owner: `${organization}/${env.FIXTURE_AZURE_DEVOPS_PROJECT ?? ''}`, name: env.FIXTURE_AZURE_DEVOPS_REPO ?? '' }
      return { provider, manifest: {
        repo,
        pull: { forge: 'azure-devops', instance: provider.instance, repo, kind: 'pull_request', number: env.FIXTURE_AZURE_DEVOPS_PULL ?? '1' },
        issue: env.FIXTURE_AZURE_DEVOPS_ISSUE ? { forge: 'azure-devops', instance: provider.instance, repo, kind: 'issue', number: env.FIXTURE_AZURE_DEVOPS_ISSUE } : undefined,
      } }
    }
    case 'gitee': {
      const provider = gitee({ auth: tokenAuth, fetch: recordLive, timeout }).create()
      const slug = env.FIXTURE_GITEE_REPO ?? 'dromara/hutool'
      return { provider, manifest: {
        repo: repoRef('gitee', provider.instance, slug),
        pull: ref('gitee', provider.instance, slug, 'pull_request', env.FIXTURE_GITEE_PULL ?? '1'),
        issue: ref('gitee', provider.instance, slug, 'issue', env.FIXTURE_GITEE_ISSUE),
      } }
    }
    case 'cursor-origin': {
      const provider = cursorOrigin({ auth: tokenAuth!, fetch: recordLive, timeout }).create()
      const slug = env.FIXTURE_CURSOR_ORIGIN_REPO ?? ''
      return { provider, manifest: {
        repo: repoRef('cursor-origin', provider.instance, slug),
        pull: ref('cursor-origin', provider.instance, slug, 'pull_request', env.FIXTURE_CURSOR_ORIGIN_PULL ?? '1'),
      } }
    }
    case 'gitlab': {
      const provider = gitlab({ baseUrl: env.GITLAB_BASE_URL, auth: tokenAuth, fetch: recordLive, timeout }).create()
      const project = env.FIXTURE_GITLAB_PROJECT ?? 'gitlab-org/gitlab'
      const slash = project.lastIndexOf('/')
      const repo = { forge: 'gitlab', instance: provider.instance, owner: project.slice(0, slash), name: project.slice(slash + 1) }
      return {
        provider,
        manifest: {
          repo,
          pull: { forge: 'gitlab', instance: provider.instance, repo, kind: 'pull_request', number: env.FIXTURE_GITLAB_MR ?? '1' },
          issue: env.FIXTURE_GITLAB_ISSUE ? { forge: 'gitlab', instance: provider.instance, repo, kind: 'issue', number: env.FIXTURE_GITLAB_ISSUE } : undefined,
        },
        after: () => dropPrivateTodos(provider.baseUrl),
      }
    }
    case 'gitea': {
      const provider = gitea({ baseUrl: env.GITEA_BASE_URL, auth: tokenAuth, fetch: recordLive, timeout }).create()
      const slug = env.FIXTURE_GITEA_REPO ?? 'gitea/tea'
      return { provider, manifest: {
        repo: repoRef('gitea', provider.instance, slug),
        pull: ref('gitea', provider.instance, slug, 'pull_request', env.FIXTURE_GITEA_PULL ?? '1'),
        issue: ref('gitea', provider.instance, slug, 'issue', env.FIXTURE_GITEA_ISSUE),
      } }
    }
    case 'pushin': {
      const provider = pushin({ baseUrl: env.PUSHIN_BASE_URL, auth: tokenAuth, fetch: recordLive, timeout }).create()
      const slug = env.FIXTURE_PUSHIN_REPO ?? 'pjullrich/pushin'
      return { provider, manifest: {
        repo: repoRef('pushin', provider.instance, slug),
        issue: ref('pushin', provider.instance, slug, 'issue', env.FIXTURE_PUSHIN_ISSUE ?? '31'),
        pull: ref('pushin', provider.instance, slug, 'pull_request', env.FIXTURE_PUSHIN_PULL),
      } }
    }
    default: {
      const provider = forgejo({ baseUrl: env.CODEBERG_BASE_URL, auth: tokenAuth, fetch: recordLive, timeout }).create()
      const slug = env.FIXTURE_FORGEJO_REPO ?? 'forgejo/forgejo'
      return { provider, manifest: {
        repo: repoRef('forgejo', provider.instance, slug),
        pull: ref('forgejo', provider.instance, slug, 'pull_request', env.FIXTURE_FORGEJO_PULL ?? '5000'),
        issue: ref('forgejo', provider.instance, slug, 'issue', env.FIXTURE_FORGEJO_ISSUE),
      } }
    }
  }
}

const { provider, manifest: partial, prepare, after, skip = [] } = targetFor()
useInstance(provider)
const recorded: RecordingManifest = { baseUrl: provider.baseUrl, ...partial, recordedAt: new Date().toISOString(), steps: [] }
await prepare?.(recorded)
const context: StepContext = {}
for (const item of STEPS) {
  const thread = item.kind === 'issue' ? recorded.issue : item.kind === 'discussion' ? recorded.discussion : item.kind === 'pull_request' ? recorded.pull : true
  if (!thread || skip.includes(item.name) || !provider.can(item.verb, item.kind)) {
    continue
  }
  const before = failures
  await step(item.name, () => item.run(provider, recorded, context))
  if (failures === before) {
    recorded.steps.push(item.name)
  }
}
await after?.()

writeFixtures()
writeFileSync(`${out}manifest.json`, `${JSON.stringify(recorded, null, 2)}\n`)

if (failures) {
  console.error(`${failures} request(s) failed; the manifest lists only the steps that succeeded.`)
}
