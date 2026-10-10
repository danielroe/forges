/**
 * Setup and teardown for write recordings, through each forge's own API
 * rather than the providers: forges has no verb that pushes a commit or
 * deletes a branch, label or leftover thread. None of these requests is
 * recorded, and every one of them stays inside the scratch repository.
 */
import type { RepoRef } from '../src/model.ts'
import type { ForgeProvider } from '../src/provider.ts'
import { Buffer } from 'node:buffer'
import { parseJson } from '../src/fetch.ts'
import { FIXTURE_TITLE } from '../test/recording/write-steps.ts'

export interface WriteHarness {
  /** URL prefixes that writes may target: the scratch repository and, when given, the transfer repository. */
  scope: string[]
  /** Allows a write outside `scope` that still only changes the scratch repository, judged by its JSON body. */
  allows?: (url: string, body: unknown) => boolean
  /** Fails unless the credential administers the scratch repository; returns its default branch. */
  prepare: () => Promise<string>
  /** Creates `branch` from `base` with one commit adding `path`; absent where pull requests are not opened from branches. */
  createBranch?: (base: string, branch: string, path: string) => Promise<void>
  /** Closes open threads a fixture run opened, and deletes `branches`, `label` and the run's `hooks`. Best effort. */
  cleanUp: (branches: string[], label: string | undefined, hooks: string[]) => Promise<void>
  /** Removes the account `id` from `repo` again, so the next run can add it. */
  removeCollaborator?: (repo: RepoRef, id: string) => Promise<void>
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
      await settle([
        ...open.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${repo}/issues/${item.number}`, { method: 'PATCH', json: { state: 'closed' } })),
        ...branches.map(branch => () => call(`${repo}/git/refs/heads/${enc(branch)}`, { method: 'DELETE' })),
        ...label ? [() => call(`${repo}/labels/${enc(label)}`, { method: 'DELETE' })] : [],
        ...hooks.map(hook => () => call(`${repo}/hooks/${enc(hook)}`, { method: 'DELETE' })),
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
    async cleanUp(branches, label, hooks) {
      const open = await call<Array<{ number: number, title: string }>>(`${repo}/issues?state=open&limit=50`).catch(() => [])
      const labels = await call<Array<{ id: number, name: string }>>(`${repo}/labels?limit=50`).catch(() => [])
      await settle([
        ...open.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${repo}/issues/${item.number}`, { method: 'PATCH', json: { state: 'closed' } })),
        ...branches.map(branch => () => call(`${repo}/branches/${enc(branch)}`, { method: 'DELETE' })),
        ...labels.filter(item => item.name === label).map(item => () => call(`${repo}/labels/${item.id}`, { method: 'DELETE' })),
        ...hooks.map(hook => () => call(`${repo}/hooks/${enc(hook)}`, { method: 'DELETE' })),
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
      await settle([
        ...issues.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${project}/issues/${item.iid}`, { method: 'PUT', json: { state_event: 'close' } })),
        ...merges.filter(item => item.title.startsWith(FIXTURE_TITLE)).map(item => () => call(`${project}/merge_requests/${item.iid}`, { method: 'PUT', json: { state_event: 'close' } })),
        ...branches.map(branch => () => call(`${project}/repository/branches/${enc(branch)}`, { method: 'DELETE' })),
        ...label ? [() => call(`${project}/labels/${enc(label)}`, { method: 'DELETE' })] : [],
        ...hooks.map(hook => () => call(`${project}/hooks/${enc(hook)}`, { method: 'DELETE' })),
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

/**
 * Tangled writes are records in the signed-in account's own repository on its
 * PDS. A new record may only name the scratch repository, a record of that
 * account, or one of `threads`. The account is the bot's, so any of its
 * Tangled records may be changed or deleted.
 */
function tangled({ scratch, read, threads = [] }: HarnessOptions): WriteHarness {
  const names = [...threads]
  return {
    scope: [],
    allows: (url, body) => {
      const path = new URL(url).pathname
      if (/\/xrpc\/com\.atproto\.server\.(?:createSession|refreshSession)$/.test(path)) {
        return true
      }
      const { repo, collection, rkey, record } = (body ?? {}) as { repo?: string, collection?: string, rkey?: string, record?: unknown }
      if (repo && path.endsWith('/xrpc/com.atproto.repo.createRecord')) {
        return [...names, `at://${repo}/`].some(name => JSON.stringify(record).includes(name))
      }
      return Boolean(repo && rkey) && /\/xrpc\/com\.atproto\.repo\.(?:putRecord|deleteRecord)$/.test(path) && Boolean(collection?.startsWith('sh.tangled.'))
    },
    async prepare() {
      const { ref } = await read!.repos.get(scratch)
      if (ref.externalId) {
        names.push(ref.externalId)
      }
      return ''
    },
    async cleanUp() {},
  }
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
}

/** The setup and teardown for `options.forge`, or `undefined` where write recordings are not supported. */
export function writeHarness(options: HarnessOptions): WriteHarness | undefined {
  return HARNESSES[options.forge]?.(options)
}
