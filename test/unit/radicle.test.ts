import type { FetchLike } from '../../src/fetch.ts'
import { describe, expect, it } from 'vitest'
import { UnsupportedOperationError } from '../../src/errors.ts'
import { radicle } from '../../src/radicle/index.ts'
import { radicle as radicleWeb } from '../../src/web/index.ts'

const origin = { forge: 'radicle', instance: 'seed.radicle.dev' } as const
const repo = { ...origin, owner: 'rad', name: 'z2UcCU1LgMshWvXj6hXSDDrwB8q8M' }
const api = `https://seed.radicle.dev/api/v1/repos/rad:${repo.name}`
const head = 'c6d10d40f5aadaa1898f65b8d77ca524336cb1f9'
const did = 'did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM'
const author = { id: did, alias: 'fintohaps' }

const project = {
  rid: `rad:${repo.name}`,
  payloads: {
    'xyz.radicle.project': {
      data: { name: 'radicle-job', description: '', defaultBranch: 'main' },
    },
  },
  defaultBranch: 'refs/heads/main',
  delegates: [author],
  threshold: 1,
  visibility: { type: 'public' },
  seeding: 36,
  refs: {
    refs: { 'refs/heads/main': head },
    tags: {
      'refs/tags/releases/v0.5.0': { commit: '525dc9a9e43217e038aa26a1dcb082ada32f1192' },
    },
  },
}

function comment(id: string, timestamp: number, body = 'hello') {
  return {
    id,
    author,
    body,
    edits: [
      { author, body, timestamp },
    ],
    reactions: [],
    timestamp,
    replyTo: null,
    resolved: false,
  }
}

function patch(id: string, status: 'open' | 'draft') {
  return {
    id,
    author,
    title: `Patch ${id}`,
    state: { status },
    target: 'delegates',
    labels: [],
    merges: [],
    assignees: [],
    revisions: [
      {
        id,
        author,
        description: '',
        base: head,
        oid: head,
        refs: [],
        discussions: [],
        reactions: [],
        timestamp: 1,
        reviews: [],
      },
    ],
  }
}

/** A seed node that answers each path from `routes`, and records the URLs it was sent. */
function node(routes: Record<string, unknown>) {
  const calls: string[] = []
  const fetch: FetchLike = async (url) => {
    calls.push(url)
    const { pathname, search } = new URL(url)
    const body = routes[`${pathname}${search}`] ?? routes[pathname]
    return body === undefined
      ? Response.json({ error: 'Not Found', code: 404 }, { status: 404 })
      : Response.json(body)
  }
  return {
    forge: radicle({ fetch }),
    calls,
  }
}

describe('radicle', () => {
  it('reads without credentials from seed.radicle.dev by default', () => {
    const forge = radicle()

    expect(forge.authKind).toBe('anonymous')
    expect(forge.baseUrl).toBe('https://seed.radicle.dev/api/v1')
    expect(forge.can('threads.create', 'issue')).toBe(false)
  })

  it('pages issues by page number until a page comes back short', async () => {
    const issues = Array.from({ length: 2 }, (_, index) => ({
      id: String(index).padStart(40, '0'),
      author,
      title: `Issue ${index}`,
      state: { status: 'open' },
      assignees: [],
      discussion: [
        comment('a'.repeat(40), 1),
      ],
      labels: [],
    }))
    const { forge, calls } = node({
      [`/api/v1/repos/rad:${repo.name}/issues?status=open&page=0&perPage=2`]: issues,
      [`/api/v1/repos/rad:${repo.name}/issues?status=open&page=1&perPage=2`]: [issues[0]],
    })

    const first = await forge.threads.list(repo, { kind: 'issue', perPage: 2 }).page()
    const second = await forge.threads.list(repo, { kind: 'issue', perPage: 2, cursor: first.cursor }).page()

    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(1)
    expect(second.cursor).toBeUndefined()
    expect(calls.map(url => new URL(url).searchParams.get('page'))).toEqual(['0', '1'])
  })

  it('lists open patches and then drafts, as httpd keeps drafts apart', async () => {
    const { forge } = node({
      [`/api/v1/repos/rad:${repo.name}`]: project,
      [`/api/v1/repos/rad:${repo.name}/patches?status=open&page=0&perPage=30`]: [
        patch('1'.repeat(40), 'open'),
      ],
      [`/api/v1/repos/rad:${repo.name}/patches?status=draft&page=0&perPage=30`]: [
        patch('2'.repeat(40), 'draft'),
      ],
    })

    const listing = forge.threads.list(repo, { kind: 'pull_request' })
    const open = await listing.page()
    const drafts = await forge.threads.list(repo, { kind: 'pull_request', cursor: open.cursor }).page()

    expect(open.items.map(thread => [thread.state, thread.isDraft])).toEqual([
      ['open', false],
    ])
    expect(drafts.items.map(thread => [thread.state, thread.isDraft])).toEqual([
      ['open', true],
    ])
    expect(drafts.items[0]!.branches?.base.ref).toBe('main')
  })

  it('leaves the description out of the comments of an issue, and applies `since` itself', async () => {
    const { forge } = node({
      [`/api/v1/repos/rad:${repo.name}/issues/${'f'.repeat(40)}`]: {
        id: 'f'.repeat(40),
        author,
        title: 'An issue',
        state: { status: 'closed', reason: 'solved' },
        assignees: [],
        discussion: [
          comment('f'.repeat(40), 100, 'The description'),
          comment('1'.repeat(40), 200),
          comment('2'.repeat(40), 300),
        ],
        labels: ['type=bug'],
      },
    })
    const ref = {
      ...origin,
      repo,
      kind: 'issue',
      number: 'f'.repeat(40),
    } as const

    const thread = await forge.threads.get(ref)
    const all = await forge.threads.comments(ref).page()
    const recent = await forge.threads.comments(ref, {
      since: new Date(250_000),
    }).page()

    expect([
      thread.state,
      thread.stateReason,
      thread.body,
      thread.labels,
    ]).toEqual([
      'closed',
      'completed',
      'The description',
      [
        { name: 'type=bug' },
      ],
    ])
    expect(all.items.map(item => item.ref.id)).toEqual([
      '1'.repeat(40),
      '2'.repeat(40),
    ])
    expect(recent.items.map(item => item.ref.id)).toEqual([
      '2'.repeat(40),
    ])
  })

  it('resolves branch and tag names through the canonical refs, as httpd takes only shas', async () => {
    const { forge } = node({ [`/api/v1/repos/rad:${repo.name}`]: project })

    expect(await forge.contents.resolveRef(repo, 'HEAD')).toBe(head)
    expect(await forge.contents.resolveRef(repo, 'refs/heads/main')).toBe(head)
    expect(await forge.contents.resolveRef(repo, 'releases/v0.5.0')).toBe('525dc9a9e43217e038aa26a1dcb082ada32f1192')
    await expect(forge.contents.resolveRef(repo, 'nope')).rejects.toThrow('No canonical ref nope')
  })

  it('decodes a binary blob from base64', async () => {
    const { forge } = node({
      [`/api/v1/repos/rad:${repo.name}`]: project,
      [`/api/v1/repos/rad:${repo.name}/blob/${head}/logo.png`]: {
        binary: true,
        name: 'logo.png',
        path: 'logo.png',
        content: btoa('\u0089PNG'),
        lastCommit: {},
      },
    })

    const file = await forge.contents.getFile(repo, 'logo.png')

    expect(file.encoding).toBe('binary')
    expect([...file.content as Uint8Array]).toEqual([0x89, 0x50, 0x4E, 0x47])
  })

  it('lists the repositories of a delegate by its DID only', async () => {
    const { forge, calls } = node({
      [`/api/v1/delegates/${did}/repos`]: [project],
    })
    const namespace = {
      ...origin,
      owner: did,
      name: '',
      kind: 'namespace',
    } as const

    const page = await forge.repos.byOwner(namespace).page()

    expect(page.items.map(item => item.displayName)).toEqual(['radicle-job'])
    expect(new URL(calls[0]!).searchParams.get('show')).toBe('all')
    await expect(forge.repos.byOwner({ ...namespace, owner: 'fintohaps' }).page()).rejects.toThrow(UnsupportedOperationError)
  })

  it('reads and writes links to the Radicle explorer for the node', () => {
    const web = radicleWeb({ baseUrl: 'https://iris.radicle.xyz' })
    const patchUrl = `https://radicle.network/nodes/iris.radicle.xyz/rad:${repo.name}/patches/${'a'.repeat(40)}`

    expect(web.instance).toBe('iris.radicle.xyz')
    expect(web.urlFor({
      repo: { ...repo, instance: 'iris.radicle.xyz' },
    })).toBe(`https://radicle.network/nodes/iris.radicle.xyz/rad:${repo.name}`)
    expect(web.parseUrl(patchUrl)?.thread).toMatchObject({
      kind: 'pull_request',
      number: 'a'.repeat(40),
    })
    expect(web.parseUrl(`https://radicle.network/nodes/seed.radicle.dev/rad:${repo.name}`)).toBeUndefined()
  })

  it('takes a repository id with or without its `rad:` prefix', async () => {
    const { forge, calls } = node({ [`/api/v1/repos/rad:${repo.name}`]: project })

    await forge.repos.get(repo)
    await forge.repos.get({ ...repo, name: `rad:${repo.name}` })

    expect(calls).toEqual([api, api])
  })

  it('refuses an id that isn\'t one before any request', async () => {
    const { forge, calls } = node({})

    await expect(forge.repos.get({ ...repo, name: '..' })).rejects.toThrow('is not a Radicle repository id')
    await expect(forge.threads.get({
      ...origin,
      repo,
      kind: 'issue',
      number: '..',
    })).rejects.toThrow('is not a Radicle issue id')
    await expect(forge.threads.get({
      ...origin,
      repo,
      kind: 'pull_request',
      number: '%2e%2e',
    })).rejects.toThrow('is not a Radicle patch id')
    expect(calls).toEqual([])
  })

  it('lists archived and then merged patches for `closed`', async () => {
    const merged = {
      ...patch('3'.repeat(40), 'open'),
      state: {
        status: 'merged',
        revision: '3'.repeat(40),
        commit: head,
      },
    }
    const { forge } = node({
      [`/api/v1/repos/rad:${repo.name}`]: project,
      [`/api/v1/repos/rad:${repo.name}/patches?status=archived&page=0&perPage=30`]: [
        {
          ...patch('4'.repeat(40), 'open'),
          state: { status: 'archived' },
        },
      ],
      [`/api/v1/repos/rad:${repo.name}/patches?status=merged&page=0&perPage=30`]: [merged],
    })

    const archived = await forge.threads.list(repo, { kind: 'pull_request', state: 'closed' }).page()
    const rest = await forge.threads.list(repo, { kind: 'pull_request', state: 'closed', cursor: archived.cursor }).page()

    expect([
      ...archived.items,
      ...rest.items,
    ].map(thread => thread.state)).toEqual(['closed', 'merged'])
  })

  it('keeps a comment edited after `since`, and links a ref without `externalId`', async () => {
    const edited = {
      ...comment('1'.repeat(40), 100),
      edits: [
        { author, body: 'old', timestamp: 100 },
        { author, body: 'new', timestamp: 300 },
      ],
    }
    const { forge } = node({
      [`/api/v1/repos/rad:${repo.name}/issues/${'f'.repeat(40)}`]: {
        id: 'f'.repeat(40),
        author,
        title: 'An issue',
        state: { status: 'open' },
        assignees: [],
        discussion: [
          comment('f'.repeat(40), 50),
          edited,
        ],
        labels: [],
      },
    })
    const ref = {
      ...origin,
      repo,
      kind: 'issue',
      number: 'f'.repeat(40),
    } as const

    const recent = await forge.threads.comments(ref, {
      since: new Date(250_000),
    }).page()
    const thread = await forge.threads.get(ref)

    expect(recent.items.map(item => item.body)).toEqual(['new'])
    expect(thread.url).toBe(`https://radicle.network/nodes/seed.radicle.dev/rad:${repo.name}/issues/${'f'.repeat(40)}`)
  })

  it('diffs the merged revision, pages the files, and counts the merge as activity', async () => {
    const [first, second] = [
      '5'.repeat(40),
      '6'.repeat(40),
    ]
    const revision = (id: string, base: string, oid: string) => ({
      ...patch(id, 'open').revisions[0],
      id,
      base,
      oid,
      timestamp: 10,
    })
    const raw = {
      ...patch(first, 'open'),
      state: { status: 'merged', revision: first, commit: head },
      merges: [
        {
          author,
          commit: head,
          timestamp: 500,
          revision: first,
        },
      ],
      revisions: [
        revision(first, 'a'.repeat(40), 'b'.repeat(40)),
        revision(second, 'c'.repeat(40), 'd'.repeat(40)),
      ],
    }
    const files = ['a', 'b', 'c'].map(path => ({
      status: 'added',
      path,
      new: { oid: head, mode: 'blob' },
      diff: { type: 'empty' },
    }))
    const { forge, calls } = node({
      [`/api/v1/repos/rad:${repo.name}`]: project,
      [`/api/v1/repos/rad:${repo.name}/patches/${first}`]: raw,
      [`/api/v1/repos/rad:${repo.name}/diff/${'a'.repeat(40)}/${'b'.repeat(40)}`]: {
        diff: { files, stats: {} },
        commits: [],
      },
    })
    const ref = {
      ...origin,
      repo,
      kind: 'pull_request',
      number: first,
    } as const

    const page = await forge.threads.files(ref, { perPage: 2 }).page()
    const next = await forge.threads.files(ref, { perPage: 2, cursor: page.cursor }).page()
    const thread = await forge.threads.get(ref)

    expect([
      page.items.map(file => file.path),
      next.items.map(file => file.path),
      next.cursor,
    ]).toEqual([
      ['a', 'b'],
      ['c'],
      undefined,
    ])
    expect(calls.some(url => url.includes(`/diff/${'c'.repeat(40)}`))).toBe(false)
    expect(thread.lastActivityAt).toEqual(new Date(500_000))
  })

  it('counts an inline review comment edited late as activity', async () => {
    const id = '7'.repeat(40)
    const inline = {
      ...comment('8'.repeat(40), 20),
      edits: [
        { author, body: 'x', timestamp: 20 },
        { author, body: 'y', timestamp: 900 },
      ],
    }
    const base = patch(id, 'open')
    const raw = {
      ...base,
      revisions: [
        {
          ...base.revisions[0],
          reviews: [
            {
              id: '9'.repeat(40),
              author,
              verdict: null,
              summary: null,
              comments: [inline],
              timestamp: 30,
            },
          ],
        },
      ],
    }
    const { forge } = node({
      [`/api/v1/repos/rad:${repo.name}`]: project,
      [`/api/v1/repos/rad:${repo.name}/patches/${id}`]: raw,
    })

    const thread = await forge.threads.get({
      ...origin,
      repo,
      kind: 'pull_request',
      number: id,
    })

    expect(thread.lastActivityAt).toEqual(new Date(900_000))
  })
})
