/**
 * Setup and teardown for write recordings, through each forge's own API
 * rather than the providers: forges has no verb that pushes a commit or
 * deletes a branch, label, release, tag or leftover thread. None of these requests is
 * recorded, and every one of them stays inside the scratch repository.
 */
import type { RepoRef } from '../src/model.ts'
import type { ForgeProvider } from '../src/provider.ts'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { parseJson } from '../src/fetch.ts'
import { SEED_LABEL } from '../test/recording/seed.ts'
import { FIXTURE_LABEL, FIXTURE_TAG, FIXTURE_TITLE } from '../test/recording/write-steps.ts'

export interface WriteHarness {
  /** URL prefixes that writes may target: the scratch repository and, when given, the transfer repository. */
  scope: string[]
  /** Allows a write outside `scope` that still only changes the scratch repository, judged by its JSON body. */
  allows?: (url: string, body: unknown) => boolean
  /** Fails unless the credential administers the scratch repository; returns its default branch. */
  prepare: () => Promise<string>
  /** Creates `branch` from `base` with one commit adding `path`; absent where pull requests are not opened from branches. */
  createBranch?: (base: string, branch: string, path: string) => Promise<void>
  /** Creates `tag` at the tip of `base`; absent where creating a release creates its tag. */
  createTag?: (base: string, tag: string) => Promise<void>
  /** Closes open threads a fixture run opened, and deletes `branches`, `label`, the run's `hooks` and every fixture release and tag. Best effort. */
  cleanUp: (branches: string[], label: string | undefined, hooks: string[]) => Promise<void>
  /** Removes the account `id` from `repo` again, so the next run can add it. */
  removeCollaborator?: (repo: RepoRef, id: string) => Promise<void>
  /** Writes what `--seed` needs that no provider verb writes, such as the account's profile. */
  seed?: () => Promise<void>
  /** The deliveries `hook` sent, oldest first, for forges whose API returns their headers and payloads. */
  payloads?: (hook: string) => Promise<HookDelivery[]>
}

/** A webhook delivery as the forge sent it. */
export interface HookDelivery {
  headers: Record<string, string>
  body: string
}

function lowercased(headers: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]))
}

export interface HarnessOptions {
  forge: string
  baseUrl: string
  authorization: string
  /** The repository the run writes to; every write must stay inside it, or inside `transfer` and `collaborators`. */
  scratch: RepoRef
  /** Where the run transfers an issue to. */
  transfer?: RepoRef
  /** Where the run adds a collaborator, when not the scratch repository. */
  collaborators?: RepoRef
  /** Reads the scratch repository without recording, for forges whose writes name it by an id. */
  read?: ForgeProvider
  /** Threads in the scratch repository that writes may name, beyond those the run creates. */
  threads?: string[]
  /** The bot's atproto account, for forges whose writes are records in it. */
  account?: { identifier: string, password: string, pds?: string }
}

const enc = encodeURIComponent

function client(baseUrl: string, authorization: string) {
  return async function call<T = unknown>(path: string, init: { method?: string, json?: unknown, form?: FormData } = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization, accept: 'application/json', ...init.json === undefined ? {} : { 'content-type': 'application/json' } },
      body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    const text = await response.text()
    // GitHub delivery ids exceed `Number.MAX_SAFE_INTEGER`, so they are kept as their digits.
    return (text ? parseJson(text) : undefined) as T
  }
}

function base64(text: string): string {
  return Buffer.from(text).toString('base64')
}

async function settle(tasks: Array<() => Promise<unknown>>): Promise<void> {
  for (const task of tasks) {
    await task().catch((error: Error) => console.warn(`cleanup: ${error.message}`))
  }
}

function fixtureContent(branch: string): string {
  return `Added by the forges write recording on ${branch}.\n`
}

function github({ baseUrl, authorization, scratch, transfer }: HarnessOptions): WriteHarness {
  const call = client(baseUrl, authorization)
  const repo = `/repos/${enc(scratch.owner)}/${enc(scratch.name)}`
  return {
    scope: [scratch, transfer].filter(Boolean).map(target => `${baseUrl}/repos/${enc(target!.owner)}/${enc(target!.name)}`),
    async prepare() {
      const data = await call<{ default_branch: string, permissions?: { admin?: boolean } }>(repo)
      if (!data.permissions?.admin) {
        throw new Error('The author credential does not administer the scratch repository')
      }
      return data.default_branch
    },
    async createBranch(base, branch, path) {
      const { object } = await call<{ object: { sha: string } }>(`${repo}/git/ref/heads/${enc(base)}`)
      await call(`${repo}/git/refs`, { method: 'POST', json: { ref: `refs/heads/${branch}`, sha: object.sha } })
      await call(`${repo}/contents/${path}`, { method: 'PUT', json: { message: `test: add ${path}`, content: base64(fixtureContent(branch)), branch } })
    },
    async cleanUp(branches, label, hooks) {
      const open = await call<Array<{ number: number, title: string }>>(`${repo}/issues?state=open&per_page=100`).catch(() => [])
      const releases = await call<Array<{ id: number, tag_name: string }>>(`${repo}/releases?per_page=100`).catch(() => [])
      const tags = await call<Array<{ ref: string }>>(`${repo}/git/matching-refs/tags/${enc(FIXTURE_TAG)}`).catch(() => [])
      await settle([
        ...open.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${repo}/issues/${item.number}`, { method: 'PATCH', json: { state: 'closed' } })),
        ...branches.map(branch => () => call(`${repo}/git/refs/heads/${enc(branch)}`, { method: 'DELETE' })),
        ...label ? [() => call(`${repo}/labels/${enc(label)}`, { method: 'DELETE' })] : [],
        ...hooks.map(hook => () => call(`${repo}/hooks/${enc(hook)}`, { method: 'DELETE' })),
        ...releases.filter(item => item.tag_name.startsWith(FIXTURE_TAG)).map(item => () => call(`${repo}/releases/${item.id}`, { method: 'DELETE' })),
        ...tags.map(item => () => call(`${repo}/git/${item.ref.split('/').map(enc).join('/')}`, { method: 'DELETE' })),
      ])
    },
    async payloads(hook) {
      const list = await call<Array<{ id: string }>>(`${repo}/hooks/${enc(hook)}/deliveries?per_page=50`)
      const details = await Promise.all(list.map(({ id }) => call<{ request: { headers: Record<string, string>, payload: unknown } }>(`${repo}/hooks/${enc(hook)}/deliveries/${id}`)))
      return details.reverse().map(({ request }) => ({ headers: lowercased(request.headers), body: JSON.stringify(request.payload) }))
    },
  }
}

function forgejo({ baseUrl, authorization, scratch }: HarnessOptions): WriteHarness {
  const call = client(baseUrl, authorization)
  const repo = `/repos/${enc(scratch.owner)}/${enc(scratch.name)}`
  return {
    scope: [`${baseUrl}${repo}`],
    async prepare() {
      const data = await call<{ default_branch: string, permissions?: { admin?: boolean } }>(repo)
      if (!data.permissions?.admin) {
        throw new Error('The author credential does not administer the scratch repository')
      }
      return data.default_branch
    },
    async createBranch(base, branch, path) {
      await call(`${repo}/contents/${path}`, { method: 'POST', json: { message: `test: add ${path}`, content: base64(fixtureContent(branch)), branch: base, new_branch: branch } })
    },
    async cleanUp(branches, _label, hooks) {
      const open = await call<Array<{ number: number, title: string }>>(`${repo}/issues?state=open&limit=50`).catch(() => [])
      const labels = await call<Array<{ id: number, name: string }>>(`${repo}/labels?limit=50`).catch(() => [])
      const releases = await call<Array<{ id: number, tag_name: string }>>(`${repo}/releases?limit=50`).catch(() => [])
      const tags = await call<Array<{ name: string }>>(`${repo}/tags?limit=50`).catch(() => [])
      // A tag that a release points to cannot be deleted, so the releases go first.
      // Steps read the list of every label to find the run's, so every fixture label goes.
      await settle([
        ...open.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${repo}/issues/${item.number}`, { method: 'PATCH', json: { state: 'closed' } })),
        ...branches.map(branch => () => call(`${repo}/branches/${enc(branch)}`, { method: 'DELETE' })),
        ...labels.filter(item => item.name.startsWith(FIXTURE_LABEL)).map(item => () => call(`${repo}/labels/${item.id}`, { method: 'DELETE' })),
        ...hooks.map(hook => () => call(`${repo}/hooks/${enc(hook)}`, { method: 'DELETE' })),
        ...releases.filter(item => item.tag_name.startsWith(FIXTURE_TAG)).map(item => () => call(`${repo}/releases/${item.id}`, { method: 'DELETE' })),
        ...tags.filter(item => item.name.startsWith(FIXTURE_TAG)).map(item => () => call(`${repo}/tags/${enc(item.name)}`, { method: 'DELETE' })),
      ])
    },
  }
}

function gitlab({ baseUrl, authorization, scratch, transfer, collaborators }: HarnessOptions): WriteHarness {
  const call = client(baseUrl, authorization)
  const project = `/projects/${enc(`${scratch.owner}/${scratch.name}`)}`
  const scope = [scratch, transfer, collaborators].filter(Boolean).map(target => `${baseUrl}/projects/${enc(`${target!.owner}/${target!.name}`)}`)
  return {
    scope,
    async removeCollaborator(repo, id) {
      await call(`/projects/${enc(`${repo.owner}/${repo.name}`)}/members/${enc(id)}`, { method: 'DELETE' }).catch((error: Error) => console.warn(`cleanup: ${error.message}`))
    },
    async prepare() {
      const data = await call<{ id: number, default_branch: string, permissions?: { project_access?: { access_level: number } | null, group_access?: { access_level: number } | null } }>(project)
      const level = Math.max(data.permissions?.project_access?.access_level ?? 0, data.permissions?.group_access?.access_level ?? 0)
      if (level < 40) {
        throw new Error('The author credential is not a maintainer of the scratch project')
      }
      scope.push(`${baseUrl}/projects/${data.id}`)
      return data.default_branch
    },
    async createBranch(base, branch, path) {
      await call(`${project}/repository/commits`, { method: 'POST', json: { branch, start_branch: base, commit_message: `test: add ${path}`, actions: [{ action: 'create', file_path: path, content: fixtureContent(branch) }] } })
    },
    async cleanUp(branches, label, hooks) {
      const issues = await call<Array<{ iid: number, title: string }>>(`${project}/issues?state=opened&per_page=100`).catch(() => [])
      const merges = await call<Array<{ iid: number, title: string }>>(`${project}/merge_requests?state=opened&per_page=100`).catch(() => [])
      const releases = await call<Array<{ tag_name: string }>>(`${project}/releases?per_page=100`).catch(() => [])
      const tags = await call<Array<{ name: string }>>(`${project}/repository/tags?search=${enc(`^${FIXTURE_TAG}`)}&per_page=100`).catch(() => [])
      await settle([
        ...issues.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${project}/issues/${item.iid}`, { method: 'PUT', json: { state_event: 'close' } })),
        ...merges.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${project}/merge_requests/${item.iid}`, { method: 'PUT', json: { state_event: 'close' } })),
        ...branches.map(branch => () => call(`${project}/repository/branches/${enc(branch)}`, { method: 'DELETE' })),
        ...label ? [() => call(`${project}/labels/${enc(label)}`, { method: 'DELETE' })] : [],
        ...hooks.map(hook => () => call(`${project}/hooks/${enc(hook)}`, { method: 'DELETE' })),
        ...releases.filter(item => item.tag_name.startsWith(FIXTURE_TAG)).map(item => () => call(`${project}/releases/${enc(item.tag_name)}`, { method: 'DELETE' })),
        ...tags.filter(item => item.name.startsWith(FIXTURE_TAG)).map(item => () => call(`${project}/repository/tags/${enc(item.name)}`, { method: 'DELETE' })),
      ])
    },
    async payloads(hook) {
      const events = await call<Array<{ request_headers: Record<string, string>, request_data: unknown }>>(`${project}/hooks/${enc(hook)}/events`)
      return events.reverse().map(event => ({ headers: lowercased(event.request_headers), body: typeof event.request_data === 'string' ? event.request_data : JSON.stringify(event.request_data) }))
    },
  }
}

function bitbucket({ baseUrl, authorization, scratch }: HarnessOptions): WriteHarness {
  const call = client(baseUrl, authorization)
  const repo = `/repositories/${enc(scratch.owner)}/${enc(scratch.name)}`
  return {
    scope: [`${baseUrl}${repo}`],
    async prepare() {
      const data = await call<{ mainbranch: { name: string } }>(repo)
      await call(`${repo}/hooks?pagelen=1`).catch(() => {
        throw new Error('The author credential does not administer the scratch repository')
      })
      return data.mainbranch.name
    },
    async createBranch(base, branch, path) {
      const { target } = await call<{ target: { hash: string } }>(`${repo}/refs/branches/${enc(base)}`)
      const form = new FormData()
      form.set('branch', branch)
      form.set('parents', target.hash)
      form.set('message', `test: add ${path}`)
      form.set(path, fixtureContent(branch))
      await call(`${repo}/src`, { method: 'POST', form })
    },
    async cleanUp(branches, _label, hooks) {
      const { values: pulls } = await call<{ values: Array<{ id: number, title: string }> }>(`${repo}/pullrequests?state=OPEN&pagelen=50`).catch(() => ({ values: [] }))
      await settle([
        ...pulls.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${repo}/pullrequests/${item.id}/decline`, { method: 'POST' })),
        ...branches.map(branch => () => call(`${repo}/refs/branches/${enc(branch)}`, { method: 'DELETE' })),
        ...hooks.map(hook => () => call(`${repo}/hooks/${enc(hook)}`, { method: 'DELETE' })),
      ])
    },
  }
}

function gitee({ baseUrl, authorization, scratch }: HarnessOptions): WriteHarness {
  const call = client(baseUrl, authorization)
  const repo = `/repos/${enc(scratch.owner)}/${enc(scratch.name)}`
  return {
    scope: [`${baseUrl}${repo}`],
    allows: (url, body) => url.startsWith(`${baseUrl}/repos/${enc(scratch.owner)}/issues/`) && (body as { repo?: string } | undefined)?.repo === scratch.name,
    async prepare() {
      const data = await call<{ default_branch: string, permission?: { admin?: boolean } }>(repo)
      if (!data.permission?.admin) {
        throw new Error('The author credential does not administer the scratch repository')
      }
      return data.default_branch
    },
    async createBranch(base, branch, path) {
      await call(`${repo}/branches`, { method: 'POST', json: { refs: base, branch_name: branch } })
      await call(`${repo}/contents/${path}`, { method: 'POST', json: { message: `test: add ${path}`, content: base64(fixtureContent(branch)), branch } })
    },
    async cleanUp(_branches, label, hooks) {
      const issues = await call<Array<{ number: string, title: string }>>(`${repo}/issues?state=open&per_page=100`).catch(() => [])
      const pulls = await call<Array<{ number: number, title: string }>>(`${repo}/pulls?state=open&per_page=100`).catch(() => [])
      await settle([
        ...issues.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`/repos/${enc(scratch.owner)}/issues/${enc(item.number)}`, { method: 'PATCH', json: { repo: scratch.name, state: 'closed' } })),
        ...pulls.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${repo}/pulls/${item.number}`, { method: 'PATCH', json: { state: 'closed' } })),
        ...label ? [() => call(`${repo}/labels/${enc(label)}`, { method: 'DELETE' })] : [],
        ...hooks.map(hook => () => call(`${repo}/hooks/${enc(hook)}`, { method: 'DELETE' })),
      ])
    },
  }
}

/**
 * Work items and pull request policies are project-wide, so writes may target
 * anything under the scratch project's `_apis`, not only the scratch repository.
 */
function azureDevOps({ baseUrl, authorization, scratch }: HarnessOptions): WriteHarness {
  const call = client(baseUrl, authorization)
  const [org = '', project = ''] = scratch.owner.split('/')
  const repo = `/${enc(org)}/${enc(project)}/_apis/git/repositories/${enc(scratch.name)}`
  const version = 'api-version=7.1'
  const headOf = async (branch: string) => (await call<{ value: Array<{ objectId: string }> }>(`${repo}/refs?filter=heads/${enc(branch)}&${version}`)).value[0]?.objectId
  return {
    scope: [`${baseUrl}/${enc(org)}/${enc(project)}/_apis/`],
    async prepare() {
      const data = await call<{ defaultBranch?: string }>(`${repo}?${version}`)
      return (data.defaultBranch ?? 'refs/heads/main').replace('refs/heads/', '')
    },
    async createBranch(base, branch, path) {
      await call(`${repo}/pushes?${version}`, { method: 'POST', json: {
        refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: await headOf(base) }],
        commits: [{ comment: `test: add ${path}`, changes: [{ changeType: 'add', item: { path: `/${path}` }, newContent: { content: fixtureContent(branch), contentType: 'rawtext' } }] }],
      } })
    },
    async cleanUp(branches) {
      const { value: pulls } = await call<{ value: Array<{ pullRequestId: number, title: string }> }>(`${repo}/pullrequests?searchCriteria.status=active&${version}`).catch(() => ({ value: [] }))
      await settle([
        ...pulls.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${repo}/pullrequests/${item.pullRequestId}?${version}`, { method: 'PATCH', json: { status: 'abandoned' } })),
        ...branches.map(branch => async () => {
          const sha = await headOf(branch)
          if (sha) {
            await call(`${repo}/refs?${version}`, { method: 'POST', json: [{ name: `refs/heads/${branch}`, oldObjectId: sha, newObjectId: '0'.repeat(40) }] })
          }
        }),
      ])
    },
  }
}

/** Pushin.eu has no API for branches or tags, so they are created and deleted over git. */
function pushin({ baseUrl, authorization, scratch }: HarnessOptions): WriteHarness {
  const call = client(baseUrl, authorization)
  const repo = `/repos/${enc(scratch.owner)}/${enc(scratch.name)}`
  const remote = `${baseUrl.replace(/\/api\/v1$/, '')}/${enc(scratch.owner)}/${enc(scratch.name)}.git`
  // Git over HTTPS accepts the token as a basic-auth password, not as a bearer token.
  const auth = extraHeader(`Authorization: Basic ${base64(`forges:${authorization.replace(/^\S+ /, '')}`)}`)
  let clone: string | undefined
  const checkout = (base: string) => {
    if (!clone) {
      clone = mkdtempSync(join(tmpdir(), 'forges-pushin-'))
      git(clone, ['clone', '-q', '--depth', '1', '--branch', base, remote, '.'], auth)
    }
    return clone
  }
  return {
    scope: [`${baseUrl}${repo}`],
    async prepare() {
      const data = await call<{ default_branch: string, permissions?: { admin?: boolean } }>(repo)
      if (!data.permissions?.admin) {
        throw new Error('The author credential does not administer the scratch repository')
      }
      return data.default_branch
    },
    async createBranch(base, branch, path) {
      const directory = checkout(base)
      git(directory, ['switch', '-q', '-C', branch, `origin/${base}`])
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), fixtureContent(branch))
      git(directory, ['add', path])
      git(directory, ['commit', '-q', '-m', `test: add ${path}`])
      git(directory, ['push', '-q', 'origin', branch], auth)
    },
    async createTag(base, tag) {
      git(checkout(base), ['push', '-q', 'origin', `refs/remotes/origin/${base}:refs/tags/${tag}`], auth)
    },
    /**
     * The API cannot close threads, so fixture issues and pull requests are closed by importing them
     * again with `state: 'closed'`, which replaces every field the import leaves out.
     */
    async cleanUp(branches) {
      interface Open { number: number, title: string, body: string | null, pull_request?: unknown, head?: { ref: string }, base?: { ref: string } }
      const pulls = await call<Open[]>(`${repo}/pulls?state=open&per_page=100`).catch(() => [])
      const issues = await call<Open[]>(`${repo}/issues?state=open&per_page=100`).catch(() => [])
      const releases = await call<Array<{ id: number, tag_name: string }>>(`${repo}/releases?per_page=100`).catch(() => [])
      const fixture = (item: Open) => item.title.startsWith(FIXTURE_TITLE)
      await settle([
        ...pulls.filter(fixture).map(item => () => call(`${repo}/pulls`, { method: 'POST', json: { number: item.number, title: item.title, body: item.body, head: item.head?.ref, base: item.base?.ref, state: 'closed' } })),
        ...issues.filter(item => fixture(item) && !item.pull_request).map(item => () => call(`${repo}/issues`, { method: 'POST', json: { number: item.number, title: item.title, body: item.body, state: 'closed' } })),
        ...releases.filter(item => item.tag_name.startsWith(FIXTURE_TAG)).map(item => () => call(`${repo}/releases/${item.id}`, { method: 'DELETE' })),
        async () => {
          const directory = mkdtempSync(join(tmpdir(), 'forges-pushin-'))
          git(directory, ['init', '-q'])
          const stale = git(directory, ['ls-remote', remote], auth).split('\n').map(line => line.split('\t')[1] ?? '').filter(ref =>
            ref.startsWith(`refs/tags/${FIXTURE_TAG}`) || ref.startsWith('refs/heads/forges-fixtures/') || branches.some(branch => ref === `refs/heads/${branch}`))
          if (stale.length) {
            git(directory, ['push', '-q', remote, ...stale.map(ref => `:${ref}`)], auth)
          }
        },
      ])
    },
  }
}

/**
 * Tangled writes are records in the signed-in account's own repository on its
 * PDS. A new record may only name the scratch repository, a record of that
 * account, or one of `threads`, apart from the definition of a fixture or
 * seed label, which names nothing. The account is the bot's, so any of its Tangled
 * records may be changed or deleted.
 */
function tangled({ scratch, read, threads = [], account }: HarnessOptions): WriteHarness {
  const names = [...threads]
  let pds: Promise<{ call: <T>(nsid: string, init?: { query?: Record<string, string>, json?: unknown }) => Promise<T>, did: string }> | undefined
  const session = () => pds ??= (async () => {
    const host = account!.pds ?? await resolvePds(account!.identifier)
    const created = await (await fetch(`${host}/xrpc/com.atproto.server.createSession`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: account!.identifier, password: account!.password }) })).json() as { did: string, accessJwt: string }
    const call = async <T>(nsid: string, init: { query?: Record<string, string>, json?: unknown } = {}) => {
      const response = await fetch(`${host}/xrpc/${nsid}${init.query ? `?${new URLSearchParams(init.query)}` : ''}`, {
        method: init.json === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${created.accessJwt}`, ...init.json === undefined ? {} : { 'content-type': 'application/json' } },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        throw new Error(`${nsid} failed with ${response.status}: ${await response.text()}`)
      }
      return await response.json() as T
    }
    return { call, did: created.did }
  })()
  async function* records<T>(collection: string) {
    const { call, did } = await session()
    let cursor: string | undefined
    do {
      const page = await call<{ records: Array<{ uri: string, cid: string, value: T }>, cursor?: string }>('com.atproto.repo.listRecords', { query: { repo: did, collection, limit: '100', ...cursor ? { cursor } : {} } })
      yield* page.records
      cursor = page.records.length ? page.cursor : undefined
    } while (cursor)
  }
  const rkeyOf = (uri: string) => uri.split('/').at(-1)!

  let repoKnot: Promise<{ origin: string, repoDid: string }> | undefined
  const knot = () => repoKnot ??= read!.repos.get(scratch).then(({ ref, raw }) => {
    const host = (raw as { value: { knot: string } }).value.knot
    return { origin: /^https?:\/\//.test(host) ? host.replace(/\/$/, '') : `https://${host}`, repoDid: ref.externalId! }
  })
  async function serviceToken(lxm: string): Promise<string> {
    const { call } = await session()
    const { origin } = await knot()
    return (await call<{ token: string }>('com.atproto.server.getServiceAuth', { query: { aud: `did:web:${encodeURIComponent(new URL(origin).host)}`, lxm } })).token
  }
  async function knotPost(nsid: string, json: unknown): Promise<void> {
    const { origin } = await knot()
    const response = await fetch(`${origin}/xrpc/${nsid}`, { method: 'POST', headers: { 'authorization': `Bearer ${await serviceToken(nsid)}`, 'content-type': 'application/json' }, body: JSON.stringify(json), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      throw new Error(`${nsid} failed with ${response.status}: ${await response.text()}`)
    }
  }
  /** Pushes `refspecs` to the knot over HTTPS, with the token in the environment rather than the command line. */
  async function push(directory: string, ...refspecs: string[]): Promise<void> {
    const { origin, repoDid } = await knot()
    git(directory, ['push', '-q', `${origin}/${repoDid}`, ...refspecs], extraHeader(`Authorization: Bearer ${await serviceToken('sh.tangled.repo.push')}`))
  }
  let clone: Promise<string> | undefined
  const checkout = (base: string) => clone ??= knot().then(({ origin, repoDid }) => {
    const directory = mkdtempSync(join(tmpdir(), 'forges-tangled-'))
    git(directory, ['clone', '-q', '--depth', '1', '--branch', base, `${origin}/${repoDid}`, '.'])
    return directory
  })

  return {
    scope: [],
    allows: (url, body) => {
      const path = new URL(url).pathname
      if (/\/xrpc\/com\.atproto\.server\.(?:createSession|refreshSession)$/.test(path)) {
        return true
      }
      if (path.endsWith('/xrpc/com.atproto.repo.uploadBlob')) {
        return true
      }
      const { repo, collection, rkey, record } = (body ?? {}) as { repo?: string, collection?: string, rkey?: string, record?: unknown }
      if (/\/xrpc\/sh\.tangled\.repo\.(?:merge|addCollaborator)$/.test(path)) {
        return Boolean(repo && names.includes(repo))
      }
      if (repo && path.endsWith('/xrpc/com.atproto.repo.createRecord')) {
        if (collection === 'sh.tangled.label.definition') {
          const name = (record as { name?: string } | undefined)?.name
          return Boolean(name?.startsWith(FIXTURE_LABEL) || name === SEED_LABEL)
        }
        return [...names, `at://${repo}/`].some(name => JSON.stringify(record).includes(name))
      }
      return Boolean(repo && rkey) && /\/xrpc\/com\.atproto\.repo\.(?:putRecord|deleteRecord)$/.test(path) && Boolean(collection?.startsWith('sh.tangled.'))
    },
    async seed() {
      const { call, did } = await session()
      await call('com.atproto.repo.putRecord', { json: { repo: did, collection: 'sh.tangled.actor.profile', rkey: 'self', record: {
        $type: 'sh.tangled.actor.profile',
        description: 'The account forges records its Tangled fixtures with.',
        location: 'The scratch repository',
        links: ['https://forges.link'],
        bluesky: false,
      } } })
      const { repoDid } = await knot()
      for await (const star of records<{ subject?: { did?: string } }>('sh.tangled.feed.star')) {
        if (star.value.subject?.did === repoDid) {
          return
        }
      }
      await call('com.atproto.repo.createRecord', { json: { repo: did, collection: 'sh.tangled.feed.star', record: {
        $type: 'sh.tangled.feed.star',
        subject: { $type: 'sh.tangled.feed.star#repo', did: repoDid },
        createdAt: new Date().toISOString(),
      } } })
    },
    async prepare() {
      const repo = await read!.repos.get(scratch)
      names.push(`at://${repo.ref.owner}/`)
      if (repo.ref.externalId) {
        names.push(repo.ref.externalId)
      }
      return repo.defaultBranch ?? 'main'
    },
    async createBranch(base, branch, path) {
      const directory = await checkout(base)
      git(directory, ['switch', '-q', '-C', branch, `origin/${base}`])
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), `Written by a forges fixture run on ${branch}.\n`)
      git(directory, ['add', path])
      git(directory, ['commit', '-q', '-m', `Add ${path}`])
      await push(directory, branch)
    },
    async removeCollaborator(_repo, id) {
      await knotPost('sh.tangled.repo.removeCollaborator', { repo: (await knot()).repoDid, subject: id })
    },
    /**
     * Deletes `branches` and the fixture branches earlier runs left, the issues
     * and pull requests earlier runs opened, the account's comments, states,
     * labels and reactions on those and on `threads`, and fixture label
     * definitions with their entries in the repo record.
     */
    async cleanUp(branches) {
      if (!account) {
        return
      }
      const { call, did } = await session()
      const { ref } = await read!.repos.get(scratch)
      const stale = (await read!.contents.branches(ref, { perPage: 100 }).page()).items.map(branch => branch.name).filter(name => branches.includes(name) || name.startsWith('forges-fixtures/'))
      if (stale.length) {
        const directory = mkdtempSync(join(tmpdir(), 'forges-tangled-'))
        git(directory, ['init', '-q'])
        await push(directory, ...stale.map(name => `:${name}`))
      }
      const remove = (collection: string, uri: string) => call('com.atproto.repo.deleteRecord', { json: { repo: did, collection, rkey: rkeyOf(uri) } })
      const labels: string[] = []
      for await (const definition of records<{ name?: string }>('sh.tangled.label.definition')) {
        if (definition.value.name?.startsWith(FIXTURE_LABEL)) {
          labels.push(definition.uri)
        }
      }
      if (labels.length) {
        const current = await call<{ cid: string, value: { labels?: string[] } }>('com.atproto.repo.getRecord', { query: { repo: did, collection: 'sh.tangled.repo', rkey: ref.name } })
        await call('com.atproto.repo.putRecord', { json: { repo: did, collection: 'sh.tangled.repo', rkey: ref.name, record: { ...current.value, labels: (current.value.labels ?? []).filter(uri => !labels.includes(uri)) }, swapRecord: current.cid } })
        await Promise.allSettled(labels.map(uri => remove('sh.tangled.label.definition', uri)))
      }
      const threadsToDelete: Array<[string, string]> = []
      for (const collection of ['sh.tangled.repo.issue', 'sh.tangled.repo.pull']) {
        for await (const thread of records<{ title?: string, repo?: string, target?: { repo?: string } }>(collection)) {
          if (thread.value.title?.startsWith(FIXTURE_TITLE) && (thread.value.repo ?? thread.value.target?.repo) === ref.externalId && !threads.includes(thread.uri)) {
            threadsToDelete.push([collection, thread.uri])
          }
        }
      }
      await Promise.allSettled(threadsToDelete.map(([collection, uri]) => remove(collection, uri)))
      const activity: Array<[string, string]> = []
      const subjects = [...threads, ...threadsToDelete.map(([, uri]) => uri)]
      for (const collection of ['sh.tangled.feed.comment', 'sh.tangled.repo.pull.status', 'sh.tangled.label.op', 'sh.tangled.feed.reaction']) {
        for await (const record of records(collection)) {
          if (subjects.some(subject => JSON.stringify(record.value).includes(subject))) {
            activity.push([collection, record.uri])
            subjects.push(record.uri)
          }
        }
      }
      await Promise.allSettled(activity.map(([collection, uri]) => remove(collection, uri)))
    },
  }
}

/** Scratch commits are the fixture identity's, made without the user's git configuration. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'forges fixtures',
  GIT_AUTHOR_EMAIL: 'forges-fixtures@example.invalid',
  GIT_COMMITTER_NAME: 'forges fixtures',
  GIT_COMMITTER_EMAIL: 'forges-fixtures@example.invalid',
}

function git(directory: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd: directory, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env } })
}

/** Sends `header` with every HTTP request git makes, through the environment rather than the command line. */
function extraHeader(header: string): Record<string, string> {
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0)
  return { GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: 'http.extraHeader', [`GIT_CONFIG_VALUE_${count}`]: header }
}

async function resolvePds(identifier: string): Promise<string> {
  const did = identifier.startsWith('did:')
    ? identifier
    : (await (await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${enc(identifier)}`)).json() as { did: string }).did
  const document = await (await fetch(`https://plc.directory/${did}`)).json() as { service?: Array<{ id: string, serviceEndpoint: string }> }
  return document.service!.find(service => service.id.endsWith('#atproto_pds'))!.serviceEndpoint
}

const HARNESSES: Record<string, (options: HarnessOptions) => WriteHarness> = {
  'tangled': tangled,
  'github': github,
  'forgejo': forgejo,
  'gitea': forgejo,
  'gitlab': gitlab,
  'bitbucket': bitbucket,
  'gitee': gitee,
  'azure-devops': azureDevOps,
  'pushin': pushin,
}

/** The setup and teardown for `options.forge`, or `undefined` where write recordings are not supported. */
export function writeHarness(options: HarnessOptions): WriteHarness | undefined {
  return HARNESSES[options.forge]?.(options)
}
