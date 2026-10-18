import type { RepoRef, ThreadRef } from '../../src/model.ts'
import type { Fixture } from '../../src/testing/index.ts'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NotFoundError } from '../../src/errors.ts'
import { sourcehut } from '../../src/sourcehut/index.ts'
import { fixtureFetch as serveFixtures, signDelivery } from '../../src/testing/index.ts'
import { markPayload, markResponse } from '../utils/provenance.ts'

const TOKEN = { type: 'token', token: 't' } as const
const origin = { forge: 'sourcehut', instance: 'sr.ht' } as const
const repo: RepoRef = { ...origin, owner: '~sircmpwn', name: 'scdoc' }
const listRepo: RepoRef = { ...origin, owner: '~sircmpwn', name: 'sr.ht-dev' }
const issue: ThreadRef = { ...origin, repo, kind: 'issue', number: '1' }
const pull: ThreadRef = { ...origin, repo: listRepo, kind: 'pull_request', number: '1' }
const runRef = { ...origin, repo, id: '100' } as const
const jobRef = { ...origin, repo, id: '200', run: runRef } as const

/** A GraphQL fixture, hand-authored from Sourcehut's published schema. */
function gql(service: string, operationName: string, variables: Record<string, unknown>, data: unknown): Fixture {
  return {
    handAuthored: true,
    request: { method: 'POST', url: `https://${service}.sr.ht/query`, operationName, variables },
    response: { status: 200, body: { data } },
  }
}

function get(url: string, body: string): Fixture {
  return { handAuthored: true, request: { method: 'GET', url }, response: { status: 200, body } }
}

const USER = {
  id: 1,
  created: '2020-01-01T00:00:00Z',
  updated: '2020-01-02T00:00:00Z',
  canonicalName: '~sircmpwn',
  username: 'sircmpwn',
  email: 'sircmpwn@example.org',
  url: 'https://meta.sr.ht/~sircmpwn',
  location: null,
  bio: 'hi',
  avatar: null,
}
const ALICE = { id: 2, created: '2020-01-01T00:00:00Z', updated: '2020-01-01T00:00:00Z', canonicalName: '~alice', username: 'alice', email: 'alice@example.org', url: null, location: null, bio: null, avatar: null }
const REPOSITORY = {
  id: 42,
  rid: '42',
  created: '2020-01-01T00:00:00Z',
  updated: '2020-01-02T00:00:00Z',
  owner: USER,
  name: 'scdoc',
  description: 'man pages',
  visibility: 'PUBLIC',
  HEAD: { name: 'refs/heads/master', target: 'sha1' },
  access: 'RW',
}
const ACL = { id: 1, created: '2020-01-01T00:00:00Z', mode: 'RW', entity: ALICE }
const COMMIT = {
  id: 'sha1',
  shortId: 'sha1',
  author: { name: 'Alice', email: 'alice@example.org', time: '2020-01-01T00:00:00Z' },
  committer: { name: 'Alice', email: 'alice@example.org', time: '2020-01-01T00:00:00Z' },
  message: 'Initial commit',
  parents: [],
}
const ARTIFACT = { id: 9, created: '2020-01-01T00:00:00Z', filename: 'a.txt', checksum: 'sha256:abc', size: 3, url: 'https://git.sr.ht/query/artifact/sha256:abc/a.txt' }
const TAG_REF = { name: 'refs/tags/v1.0.0', target: 'sha2', follow: { id: 'sha2', committer: { time: '2021-01-01T00:00:00Z' } }, artifacts: { results: [ARTIFACT], cursor: null } }
const REFS = [
  { name: 'HEAD', target: 'refs/heads/master', follow: { id: 'sha1' }, artifacts: { results: [], cursor: null } },
  { name: 'refs/heads/master', target: 'sha1', follow: { id: 'sha1' }, artifacts: { results: [], cursor: null } },
  TAG_REF,
]
const TREE_ENTRY = { id: 'b1', name: 'README.md', mode: 33188, object: { type: 'BLOB', id: 'b1', shortId: 'b1', size: 5 } }
const MATCH = { lang: 'TypeScript', name: 'src/a.ts', score: 1, lines: [{ line: 'import x', lineNo: 1 }] }
const TRACKER = { id: 7, rid: '7', created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z', owner: USER, name: 'scdoc', description: null, visibility: 'PUBLIC' }
const LABEL = { id: 3, name: 'bug', backgroundColor: '#ff0000', foregroundColor: '#ffffff' }
const TICKET = {
  id: 1,
  created: '2021-01-01T00:00:00Z',
  updated: '2021-01-02T00:00:00Z',
  ref: '~sircmpwn/scdoc#1',
  subject: 'Crash on start',
  body: 'It crashes',
  status: 'REPORTED',
  resolution: 'UNRESOLVED',
  submitter: ALICE,
  tracker: TRACKER,
  labels: [LABEL],
  assignees: [ALICE],
  subscription: { id: 5, created: '2021-01-01T00:00:00Z' },
}
const EVENT = {
  id: 11,
  created: '2021-01-03T00:00:00Z',
  changes: [
    { eventType: 'COMMENT', author: ALICE, text: 'Me too', authenticity: 'AUTHENTIC' },
    { eventType: 'STATUS_CHANGE', editor: ALICE, oldStatus: 'REPORTED', newStatus: 'RESOLVED', oldResolution: 'UNRESOLVED', newResolution: 'WONT_FIX' },
  ],
}
const PATCHSET = {
  id: 1,
  created: '2021-02-01T00:00:00Z',
  updated: '2021-02-02T00:00:00Z',
  subject: 'Fix the thing',
  version: 1,
  prefix: null,
  status: 'PROPOSED',
  submitter: ALICE,
  coverLetter: { id: 20, body: 'Please review' },
  list: { id: 9, rid: '9', name: 'sr.ht-dev', owner: USER },
}
const EMAIL = { id: 30, sender: ALICE, received: '2021-02-03T00:00:00Z', date: null, subject: 'Re: Fix the thing', body: 'Looks good', messageID: 'm1', inReplyTo: null }
const JOB = {
  id: 100,
  created: '2021-03-01T00:00:00Z',
  updated: '2021-03-01T01:00:00Z',
  status: 'SUCCESS',
  manifest: 'tasks: []',
  note: 'build',
  tags: ['main'],
  visibility: 'PUBLIC',
  image: 'debian',
  runner: null,
  owner: USER,
  tasks: [{ id: 200, created: '2021-03-01T00:00:00Z', updated: '2021-03-01T01:00:00Z', name: 'build', status: 'SUCCESS', log: { last128KiB: 'log', fullURL: 'https://builds.sr.ht/~sircmpwn/job/100/log' } }],
  log: { last128KiB: '', fullURL: 'https://builds.sr.ht/~sircmpwn/job/100/log' },
  artifacts: [],
}

const FIXTURES: Fixture[] = [
  gql('meta', 'UserByName', { username: 'sircmpwn' }, { userByName: USER }),
  gql('meta', 'Me', {}, { me: USER }),
  gql('git', 'RepositoryByOwner', { owner: 'sircmpwn', name: 'scdoc' }, { user: { repository: REPOSITORY } }),
  gql('git', 'MyRepositories', {}, { repositories: { results: [REPOSITORY], cursor: null } }),
  gql('git', 'OwnerRepositories', { owner: 'sircmpwn' }, { user: { repositories: { results: [REPOSITORY], cursor: null } } }),
  gql('git', 'RepositoryAcls', { owner: 'sircmpwn', name: 'scdoc' }, { user: { repository: { acls: { results: [ACL], cursor: null } } } }),
  gql('git', 'RepositoryRefs', { owner: 'sircmpwn', name: 'scdoc' }, { user: { repository: { HEAD: { name: 'refs/heads/master' }, references: { results: REFS, cursor: null } } } }),
  gql('git', 'RepositoryLog', { owner: 'sircmpwn', name: 'scdoc' }, { user: { repository: { log: { results: [COMMIT], cursor: null } } } }),
  gql('git', 'RepositoryCommit', { owner: 'sircmpwn', name: 'scdoc', revspec: 'sha1' }, { user: { repository: { revparse_single: COMMIT } } }),
  gql('git', 'RepositoryResolveRef', { owner: 'sircmpwn', name: 'scdoc', revspec: 'HEAD' }, { user: { repository: { revparse_single: { id: 'sha1' } } } }),
  gql('git', 'RepositoryRootTree', { owner: 'sircmpwn', name: 'scdoc', revspec: 'HEAD' }, { user: { repository: { revparse_single: { tree: { entries: { results: [TREE_ENTRY], cursor: null } } } } } }),
  gql('git', 'RepositoryFile', { owner: 'sircmpwn', name: 'scdoc', revspec: 'HEAD', path: 'README.md' }, { user: { repository: { path: { id: 'b1', object: { type: 'BLOB', id: 'b1', shortId: 'b1', text: 'hello', size: 5 } } } } }),
  gql('git', 'RepositoryCodeSearch', { owner: 'sircmpwn', name: 'scdoc', query: 'import' }, { user: { repository: { codeSearch: { totalFiles: 1, totalMatches: 1, results: [MATCH], cursor: null } } } }),
  gql('git', 'RepositoryReference', { owner: 'sircmpwn', name: 'scdoc', refName: 'refs/tags/v1.0.0' }, { user: { repository: { reference: TAG_REF } } }),
  gql('todo', 'Tracker', { owner: 'sircmpwn', name: 'scdoc' }, { user: { tracker: TRACKER } }),
  gql('todo', 'TrackerTickets', { owner: 'sircmpwn', name: 'scdoc' }, { user: { tracker: { tickets: { results: [TICKET], cursor: null } } } }),
  gql('todo', 'Ticket', { owner: 'sircmpwn', name: 'scdoc', id: 1 }, { user: { tracker: { ticket: TICKET } } }),
  gql('todo', 'TicketEvents', { owner: 'sircmpwn', name: 'scdoc', id: 1 }, { user: { tracker: { ticket: { events: { results: [EVENT], cursor: null } } } } }),
  gql('todo', 'TrackerLabels', { owner: 'sircmpwn', name: 'scdoc' }, { user: { tracker: { labels: { results: [LABEL], cursor: null } } } }),
  gql('lists', 'Patchset', { id: 1 }, { patchset: PATCHSET }),
  gql('lists', 'ListPatches', { owner: 'sircmpwn', name: 'sr.ht-dev' }, { user: { list: { patches: { results: [PATCHSET], cursor: null } } } }),
  gql('lists', 'PatchsetEmails', { id: 1 }, { patchset: { id: 1, list: PATCHSET.list, thread: { descendants: { results: [EMAIL], cursor: null } } } }),
  gql('builds', 'Jobs', {}, { jobs: { results: [JOB], cursor: null } }),
  gql('builds', 'Job', { id: 100 }, { job: JOB }),
  get('https://builds.sr.ht/~sircmpwn/job/100/log', 'the log'),
  get('https://git.sr.ht/query/artifact/sha256:abc/a.txt', 'asset'),
]

function provider(fixtures: Fixture[] = FIXTURES, auth: { type: 'token', token: string } = TOKEN) {
  const served = serveFixtures(fixtures)
  const fetch = async (input: string, init?: RequestInit) => {
    const index = served.calls.length
    const response = await served.fetch(input, init)
    if (served.calls[index]?.fixture) {
      markResponse(response, 'documented')
    }
    return response
  }
  return { forge: sourcehut({ auth, fetch }).create(), calls: served.calls }
}

describe('sourcehut', () => {
  it('reads repositories, their contents and their access list', async () => {
    const { forge } = provider()
    expect((await forge.repos.get(repo)).ref).toMatchObject({ owner: '~sircmpwn', name: 'scdoc' })
    expect((await forge.repos.listPage()).items).toHaveLength(1)
    expect((await forge.repos.byOwnerPage({ ...origin, owner: '~sircmpwn', name: '', kind: 'namespace' })).items).toHaveLength(1)
    expect((await forge.repos.collaboratorsPage(repo)).items[0]).toMatchObject({ role: 'write', roleRaw: 'RW' })
    expect((await forge.repos.labelsPage(repo)).items[0]).toMatchObject({ name: 'bug', colour: 'ff0000' })
    expect(await forge.repos.permissionFor(repo, '~alice')).toBe('write')
    expect(await forge.repos.permissionFor(repo, '~sircmpwn')).toBe('admin')
    expect(await forge.repos.permissionFor(repo, '~nobody')).toBe('none')
  })

  it('reads file contents, trees, branches, tags, commits and a comparison', async () => {
    const { forge } = provider()
    const file = await forge.contents.file(repo, 'README.md', { as: 'text' })
    expect(file).toMatchObject({ encoding: 'utf-8', content: 'hello', sha: 'b1' })
    expect((await forge.contents.treePage(repo)).items[0]).toMatchObject({ path: 'README.md', type: 'file' })
    expect((await forge.contents.branchesPage(repo)).items[0]).toMatchObject({ name: 'master', isDefault: true })
    expect((await forge.contents.tagsPage(repo)).items[0]).toMatchObject({ name: 'v1.0.0', sha: 'sha2' })
    expect(await forge.contents.resolveRef(repo, 'HEAD')).toBe('sha1')
    expect((await forge.contents.commitsPage(repo)).items[0]!.message).toBe('Initial commit')
    expect((await forge.contents.commit(repo, 'sha1')).sha).toBe('sha1')
  })

  it('reads issues, their comments, events and subscription', async () => {
    const { forge } = provider()
    expect((await forge.threads.get(issue)).title).toBe('Crash on start')
    expect((await forge.threads.listPage(repo, { kind: 'issue' })).items).toHaveLength(1)
    expect((await forge.threads.getMany([issue]))[0]).toMatchObject({ ok: true })
    expect((await forge.threads.commentsPage(issue)).items[0]!.body).toBe('Me too')
    expect((await forge.threads.getComment({ ...origin, thread: issue, id: '11' })).body).toBe('Me too')
    expect((await forge.threads.eventsPage(issue)).items[0]!.kind).toBe('comment')
    expect((await forge.threads.eventsPage(issue)).items[1]).toMatchObject({ kind: 'state_change', detail: { type: 'state_change', state: 'closed', reason: 'not_planned' } })
    expect(await forge.threads.subscription(issue)).toBe('subscribed')
  })

  it('leaves the involves, mentions and milestone filters to the core', async () => {
    const { forge } = provider()
    // Sourcehut declares no `threads.listFilters`, so core strips these and warns for them.
    const page = await forge.threads.listPage(repo, { kind: 'issue', milestone: 'v1' })

    expect(page.warnings).toContainEqual({ code: 'filter_unsupported', message: 'This listing has no milestone filter; it was ignored' })
  })

  it('reads patchsets as pull requests', async () => {
    const { forge } = provider()
    expect((await forge.threads.get(pull)).kind).toBe('pull_request')
    expect((await forge.threads.listPage(listRepo, { kind: 'pull_request' })).items).toHaveLength(1)
    expect((await forge.threads.commentsPage(pull)).items[0]!.body).toBe('Looks good')
    expect((await forge.threads.getComment({ ...origin, thread: pull, id: '30' })).body).toBe('Looks good')
    expect((await forge.threads.eventsPage(pull)).items[0]!.kind).toBe('comment')
  })

  it('reads builds and their logs', async () => {
    const { forge } = provider()
    expect((await forge.ci.runsPage(repo)).items[0]).toMatchObject({ state: 'success' })
    expect((await forge.ci.run(runRef)).ref.id).toBe('100')
    expect((await forge.ci.jobsPage(runRef)).items[0]).toMatchObject({ name: 'build', state: 'success' })
    expect((await forge.ci.job(jobRef)).ref.id).toBe('200')
    expect(await new Response(await forge.ci.log(jobRef)).text()).toBe('the log')
  })

  it('reports a not-found for a job, build or patchset that does not exist', async () => {
    const { forge } = provider()
    // A job is a task of its build, so an id the build does not have is not found, not the build's own log.
    await expect(forge.ci.log({ ...origin, repo, id: '999', run: runRef })).rejects.toThrow(NotFoundError)
    await expect(forge.ci.run({ ...origin, repo, id: 'nope' })).rejects.toThrow(NotFoundError)
    // A patchset id is global, so one from another list is not the pull this ref names.
    await expect(forge.threads.get({ ...origin, repo: { ...origin, owner: '~other', name: 'other' }, kind: 'pull_request', number: '1' })).rejects.toThrow(NotFoundError)
  })

  it('sends the token through request() to a service subdomain', async () => {
    const fixture: Fixture = { handAuthored: true, request: { method: 'GET', url: 'https://todo.sr.ht/api/1/user' }, response: { status: 200, body: { ok: true } } }
    const { forge, calls } = provider([...FIXTURES, fixture])
    await forge.request('GET', 'https://todo.sr.ht/api/1/user')
    expect(calls.at(-1)?.authorization).toBe('Bearer t')
  })

  it('reads accounts, searches code and reads releases', async () => {
    const { forge } = provider()
    expect((await forge.users.get('~sircmpwn')).login).toBe('~sircmpwn')
    expect((await forge.users.me()).login).toBe('~sircmpwn')
    expect((await forge.search.codePage({ repo, text: 'import' })).items[0]).toMatchObject({ path: 'src/a.ts' })
    expect((await forge.search.reposPage({ text: 'scdoc' })).items).toHaveLength(1)
    expect((await forge.releases.listPage(repo)).items[0]!.tag).toBe('v1.0.0')
    expect((await forge.releases.get({ ...origin, repo, id: 'v1.0.0', tag: 'v1.0.0' })).tag).toBe('v1.0.0')
    expect((await forge.releases.getByTag(repo, 'v1.0.0')).tag).toBe('v1.0.0')
    expect((await forge.releases.latest(repo))?.tag).toBe('v1.0.0')
    const asset = (await forge.releases.listPage(repo)).items[0]!.assets![0]!
    expect(await new Response(await forge.releases.downloadAsset(asset.ref!)).text()).toBe('asset')
  })
})

describe('sourcehut web links', () => {
  const forge = sourcehut({ auth: TOKEN }).create()

  it('builds a raw file URL on the blob route', () => {
    // Sourcehut serves raw bytes on `blob`, unlike GitHub's `raw`.
    expect(forge.urlFor({ raw: { repo, path: 'README.md', at: 'master' } })).toBe('https://git.sr.ht/~sircmpwn/scdoc/blob/master/README.md')
    expect(forge.urlFor({ raw: { repo, path: 'src/a b.ts', at: 'v1.0.0' } })).toBe('https://git.sr.ht/~sircmpwn/scdoc/blob/v1.0.0/src/a%20b.ts')
  })
})

describe('sourcehut webhooks', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  })

  it('verifies and translates a signed delivery', async () => {
    const webhookPublicKey = publicKey.subarray(publicKey.length - 32).toString('base64')
    const forge = sourcehut({ auth: TOKEN, fetch: serveFixtures([]).fetch, webhookPublicKey }).create()
    const body = markPayload(JSON.stringify({ data: { webhook: {
      uuid: 'u1',
      event: 'GIT_POST_RECEIVE',
      date: '2021-01-01T00:00:00Z',
      repository: { name: 'scdoc', owner: { canonicalName: '~sircmpwn' } },
      pusher: { canonicalName: '~alice' },
      updates: [{ ref: { name: 'refs/heads/master' }, old: { id: 'a' }, new: { id: 'b' } }],
    } } }), 'documented')
    const headers = await signDelivery('sourcehut', body, privateKey.toString('base64'))
    const events = await forge.webhooks.ingest({ headers, body })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'push', source: 'webhook', repo: { owner: '~sircmpwn', name: 'scdoc' } })
  })

  it('rejects a delivery signed by another key', async () => {
    const other = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'der' }, publicKeyEncoding: { type: 'spki', format: 'der' } })
    const webhookPublicKey = publicKey.subarray(publicKey.length - 32).toString('base64')
    const forge = sourcehut({ auth: TOKEN, fetch: serveFixtures([]).fetch, webhookPublicKey }).create()
    const body = JSON.stringify({ data: { webhook: { uuid: 'u1', event: 'REPO_UPDATE', date: '2021-01-01T00:00:00Z' } } })
    const headers = await signDelivery('sourcehut', body, other.privateKey.toString('base64'))
    await expect(forge.webhooks.ingest({ headers, body })).rejects.toThrow()
  })
})
