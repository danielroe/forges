/**
 * Starts a GitBucket server in Docker and seeds it for the GitBucket recordings:
 *
 *   node scripts/gitbucket-server.ts up [--out <file>]
 *   node scripts/gitbucket-server.ts down
 *
 * `up` runs `gitbucket/gitbucket` on `127.0.0.1:8080`, or seeds the empty
 * server at `GITBUCKET_BASE_URL` instead when that is set, signing in as its
 * default `root` account. It creates the `forges-reader` account, which reads and
 * reviews, the `forges-bot` account, which writes, and the `forges`
 * organisation with the recorded repository and the scratch repository, then
 * writes their tokens and names in `.env` format to `--out`, or prints
 * them. The recorded repository gets an issue, an open and a merged pull
 * request, labels, a milestone, a commit status, a tag and a release with an
 * asset; the scratch repository gets a webhook. Webhook recordings relay the
 * deliveries through this machine, which the server must be able to reach.
 * `down` removes the container that `up` started.
 */
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** The GitBucket release the recordings are made against. */
const GITBUCKET_IMAGE = 'gitbucket/gitbucket:4.48.0'

const CONTAINER = 'forges-gitbucket'
const DEFAULT_URL = 'http://127.0.0.1:8080'
const ORG = 'forges'
const REPO = 'forges-fixtures'
const SCRATCH = 'forges-fixtures-scratch'
const READER = 'forges-reader'
const BOT = 'forges-bot'
const PASSWORD = 'forges-fixtures'
const COMMITTER = { name: 'forges fixtures', email: 'forges-fixtures@example.invalid' }

const enc = encodeURIComponent

async function waitForServer(root: string): Promise<void> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const ready = await fetch(`${root}/api/v3/`, {
      signal: AbortSignal.timeout(5_000),
    }).then(response => response.ok, () => false)
    if (ready) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`GitBucket did not start at ${root} within three minutes`)
}

/** Signs in through the web UI, the only place GitBucket creates a personal access token, and returns a new one. */
async function tokenFor(root: string, login: string, password: string): Promise<string> {
  const signin = await fetch(`${root}/signin`, {
    method: 'POST',
    body: new URLSearchParams({ userName: login, password }),
    redirect: 'manual',
  })
  const cookie = signin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  if (!cookie) {
    throw new Error(`Signing in to GitBucket as ${login} failed with ${signin.status}`)
  }
  await fetch(`${root}/${enc(login)}/_personalToken`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams({ note: 'forges fixtures' }),
    redirect: 'manual',
  })
  const page = await (await fetch(`${root}/${enc(login)}/_application`, {
    headers: { cookie },
  })).text()
  const token = /value="([0-9a-f]+)"[^>]*id="generated-token"/.exec(page)?.[1]
  if (!token) {
    throw new Error(`GitBucket created no token for ${login}`)
  }
  return token
}

function api(root: string, token: string) {
  return async function call<T = unknown>(path: string, init: { method?: string, json?: unknown, body?: string, type?: string } = {}): Promise<T> {
    const method = init.method ?? (init.json === undefined && init.body === undefined
      ? 'GET'
      : 'POST')
    const response = await fetch(`${root}/api/v3${path}`, {
      method,
      headers: { 'authorization': `token ${token}`, 'accept': 'application/json', 'content-type': init.type ?? 'application/json' },
      body: init.body ?? (init.json === undefined
        ? undefined
        : JSON.stringify(init.json)),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 200)}`)
    }
    return (text
      ? JSON.parse(text)
      : undefined) as T
  }
}

async function seed(root: string): Promise<Record<string, string>> {
  const admin = api(root, await tokenFor(root, 'root', 'root'))
  for (const login of [READER, BOT]) {
    await admin('/admin/users', {
      json: {
        login,
        password: PASSWORD,
        email: `${login}@example.invalid`,
        fullName: login === BOT
          ? 'forges bot'
          : 'forges reader',
      },
    })
  }
  await admin('/admin/organizations', {
    json: { login: ORG, admin: BOT, profile_name: 'forges' },
  })
  const [readerToken, botToken] = [await tokenFor(root, READER, PASSWORD), await tokenFor(root, BOT, PASSWORD)]
  const bot = api(root, botToken)
  const reader = api(root, readerToken)

  for (const name of [REPO, SCRATCH]) {
    await bot(`/orgs/${ORG}/repos`, {
      json: {
        name,
        description: name === REPO
          ? 'The repository the forges read recordings read.'
          : 'The repository the forges write recordings write to.',
        auto_init: true,
      },
    })
    await bot(`/repos/${ORG}/${name}/collaborators/${READER}`, {
      method: 'PUT',
      json: { permission: 'push' },
    })
  }
  const repo = `/repos/${ORG}/${REPO}`
  const put = (path: string, text: string, branch: string, sha?: string) => bot(`${repo}/contents/${path}`, {
    method: 'PUT',
    json: {
      message: `docs: write ${path}`,
      content: Buffer.from(text).toString('base64'),
      branch,
      sha,
      committer: COMMITTER,
      author: COMMITTER,
    },
  })
  const readme = await bot<{ sha: string }>(`${repo}/contents/README.md`)
  await put('README.md', `# ${REPO}\n\nThe repository that the [forges](https://forges.link) read recordings read.\n`, 'main', readme.sha)
  await put('docs/guide.md', '# Guide\n\nA second file, in a directory.\n', 'main')
  const main = await bot<{ object: { sha: string } }>(`${repo}/git/ref/heads/main`)
  for (const branch of ['feature', 'merged']) {
    await bot(`${repo}/git/refs`, {
      json: { ref: `refs/heads/${branch}`, sha: main.object.sha },
    })
    await put(`${branch}.md`, `Added on ${branch}.\n`, branch)
  }
  await put('feature.md', 'Added on feature, then edited.\n', 'feature', (await bot<{ sha: string }>(`${repo}/contents/feature.md?ref=feature`)).sha)
  const head = await bot<{ object: { sha: string } }>(`${repo}/git/ref/heads/feature`)

  await bot(`${repo}/labels`, {
    json: { name: 'forges-seed', color: '8b5cf6' },
  })
  await bot(`${repo}/milestones`, {
    json: { title: 'v1.0', description: 'The first release.' },
  })
  const issue = await bot<{ number: number }>(`${repo}/issues`, {
    json: {
      title: 'forges seed: issue',
      body: `An issue that read recordings read, for @${READER}.`,
      assignees: [BOT],
      milestone: 1,
      labels: ['bug', 'forges-seed'],
    },
  })
  await bot(`${repo}/issues/${issue.number}/comments`, {
    json: { body: 'A seeded comment.' },
  })
  await reader(`${repo}/issues/${issue.number}/comments`, {
    json: { body: 'A seeded comment from the reviewer.' },
  })

  const pull = await bot<{ number: number }>(`${repo}/pulls`, {
    json: {
      title: 'forges seed: pull',
      head: 'feature',
      base: 'main',
      body: 'A pull request that read recordings read.',
    },
  })
  await bot(`${repo}/issues/${pull.number}/labels`, {
    json: {
      labels: ['forges-seed'],
    },
  })
  await reader(`${repo}/issues/${pull.number}/comments`, {
    json: { body: 'A seeded review comment.' },
  })
  await bot(`${repo}/statuses/${head.object.sha}`, {
    json: {
      state: 'success',
      context: 'forges/seed',
      description: 'A seeded status',
      target_url: `${root}/${ORG}/${REPO}`,
    },
  })
  const merged = await bot<{ number: number }>(`${repo}/pulls`, {
    json: {
      title: 'forges seed: merged pull',
      head: 'merged',
      base: 'main',
      body: 'A pull request that is merged.',
    },
  })
  await bot(`${repo}/pulls/${merged.number}/merge`, {
    method: 'PUT',
    json: { merge_method: 'merge', commit_message: 'Merged by the seed.' },
  })

  const tip = await bot<{ object: { sha: string } }>(`${repo}/git/ref/heads/main`)
  await bot(`${repo}/git/refs`, {
    json: { ref: 'refs/tags/v1.0.0', sha: tip.object.sha },
  })
  await bot(`${repo}/releases`, {
    json: { tag_name: 'v1.0.0', name: 'v1.0.0', body: 'The first release.' },
  })
  await bot(`${repo}/releases/v1.0.0/assets?name=notes.txt`, { body: 'Release notes.\n', type: 'text/plain' })

  await bot(`/repos/${ORG}/${SCRATCH}/hooks`, {
    json: {
      name: 'web',
      config: { url: 'https://example.com/seeded-hook', content_type: 'json' },
      events: ['issues', 'issue_comment', 'push'],
      active: true,
    },
  })

  return {
    GITBUCKET_BASE_URL: root,
    GITBUCKET_TOKEN: readerToken,
    GITBUCKET_BOT_TOKEN: botToken,
    FIXTURE_GITBUCKET_REPO: `${ORG}/${REPO}`,
    FIXTURE_GITBUCKET_ISSUE: String(issue.number),
    FIXTURE_GITBUCKET_PULL: String(pull.number),
    FIXTURE_GITBUCKET_FEED_USER: READER,
    FIXTURE_GITBUCKET_SCRATCH_REPO: `${ORG}/${SCRATCH}`,
    FIXTURE_GITBUCKET_REVIEWER: READER,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals: [command], values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
    },
  })
  if (command === 'down') {
    if (!process.env.GITBUCKET_BASE_URL) {
      execFileSync('docker', ['rm', '--force', CONTAINER], { stdio: 'ignore' })
    }
  }
  else if (command === 'up') {
    const root = process.env.GITBUCKET_BASE_URL?.replace(/\/$/, '') ?? DEFAULT_URL
    const docker = !process.env.GITBUCKET_BASE_URL
    if (docker) {
      execFileSync('docker', [
        'run',
        '--detach',
        '--rm',
        '--name',
        CONTAINER,
        '--publish',
        '127.0.0.1:8080:8080',
        '--add-host',
        'host.docker.internal:host-gateway',
        GITBUCKET_IMAGE,
      ], {
        stdio: ['ignore', 'ignore', 'inherit'],
      })
    }
    await waitForServer(root)
    // Webhook deliveries go to a relay on this machine, which a container reaches by another name.
    const relayHost = docker
      ? 'host.docker.internal'
      : ['127.0.0.1', 'localhost'].includes(new URL(root).hostname)
          ? '127.0.0.1'
          : undefined
    const env = Object.entries({
      ...await seed(root),
      ...relayHost && { FIXTURE_GITBUCKET_RELAY_HOST: relayHost },
    }).map(([name, value]) => `${name}="${value}"`).join('\n')
    if (values.out) {
      writeFileSync(values.out, `${env}\n`, { mode: 0o600 })
    }
    else {
      console.info(env)
    }
  }
  else {
    console.error('Usage: node scripts/gitbucket-server.ts up [--out <file>] | down')
    process.exit(1)
  }
}
