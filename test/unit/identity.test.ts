import type { Page, RepoRef, SearchQuery, Thread, ThreadRef } from '../../src/index.ts'
import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { fake } from '../../src/fake/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { createForges, parseNotificationKey, parseRepoKey, parseThreadKey, repoKey, repoSlug, threadKey, threadSlug, UnknownForgeError } from '../../src/index.ts'
import { forgeIterable } from '../../src/kit.ts'
import { tangled } from '../../src/tangled/index.ts'

const auth = { type: 'token', token: 't' } as const
const repo: RepoRef = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }
const pull: ThreadRef = { forge: 'github', instance: 'github.com', repo, kind: 'pull_request', number: '42' }

describe('keys and slugs', () => {
  it('round-trips repo, thread and notification keys', () => {
    const nested = { forge: 'gitlab', instance: 'git.example.com:8443', owner: 'acme/platform', name: 'widgets' }
    const tangledThread = { forge: 'tangled', instance: 'tangled.org', repo: { forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:abc', name: 'core' }, kind: 'issue' as const, number: 'at://did:plc:abc/sh.tangled.repo.issue/3k' }
    const other = { ...pull, kind: 'other' as const, typeRaw: 'Epic', number: '7' }

    expect(parseRepoKey(repoKey(nested))).toEqual(nested)
    expect(parseThreadKey(threadKey(tangledThread))).toEqual(tangledThread)
    expect(parseThreadKey(threadKey(other))).toEqual(other)
    expect(parseNotificationKey('github:github.com:notification/901')).toEqual({ forge: 'github', instance: 'github.com', id: '901' })
    expect(parseRepoKey('nonsense')).toBeUndefined()
    expect(parseThreadKey('github:github.com/acme/widgets#bogus/1')).toBeUndefined()
  })

  it('keys names case-insensitively where the forge does', () => {
    expect(repoKey({ ...repo, owner: 'Nuxt', name: 'Nuxt' })).toBe(repoKey({ ...repo, owner: 'nuxt', name: 'nuxt' }))
    expect(repoKey({ forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:Ab', name: 'X' })).toBe('tangled:tangled.org/did:plc:Ab/X')
  })

  it('prints slugs people type', () => {
    expect(repoSlug(repo)).toBe('acme/widgets')
    expect(threadSlug(pull)).toBe('acme/widgets#42')
    expect(threadSlug({ ...pull, kind: 'commit', number: 'abcdef1234567' })).toBe('acme/widgets@abcdef1')
  })
})

describe('web links', () => {
  const gh = github({ auth }).create()
  const gl = gitlab({ auth }).create()
  const cb = forgejo({ auth, baseUrl: 'https://codeberg.org' }).create()
  const bb = bitbucket({ auth: { type: 'token', token: 't' } }).create()
  const az = azureDevOps({ auth: { type: 'token', token: 't' }, organization: 'contoso' }).create()
  const tg = tangled({}).create()

  it('builds web URLs without a request', () => {
    expect(gh.urlFor({ thread: pull })).toBe('https://github.com/acme/widgets/pull/42')
    expect(gh.urlFor({ comment: { forge: 'github', instance: 'github.com', thread: pull, id: '9' } })).toBe('https://github.com/acme/widgets/pull/42#issuecomment-9')
    expect(gh.urlFor({ file: { repo, path: 'src/a b.ts', at: 'main', line: 3 } })).toBe('https://github.com/acme/widgets/blob/main/src/a%20b.ts#L3')
    expect(gl.urlFor({ thread: { ...pull, forge: 'gitlab', instance: 'gitlab.com', repo: { ...repo, forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform' } } })).toBe('https://gitlab.com/acme/platform/widgets/-/merge_requests/42')
    expect(cb.urlFor({ release: { forge: 'forgejo', instance: 'codeberg.org', repo, id: '1', tag: 'v1.0.0' } })).toBe('https://codeberg.org/acme/widgets/releases/tag/v1.0.0')
    expect(bb.urlFor({ thread: { ...pull, forge: 'bitbucket', instance: 'bitbucket.org' } })).toBe('https://bitbucket.org/acme/widgets/pull-requests/42')
    expect(gh.urlFor({ thread: { ...pull, number: undefined } })).toBeUndefined()
  })

  it('parses web URLs on its own instance only', () => {
    expect(gh.parseUrl('https://github.com/acme/widgets/issues/7#issuecomment-55')).toMatchObject({
      repo: { owner: 'acme', name: 'widgets' },
      thread: { kind: 'issue', number: '7' },
      comment: { id: '55' },
    })
    expect(gl.parseUrl('https://gitlab.com/acme/platform/widgets/-/merge_requests/3')).toMatchObject({ repo: { owner: 'acme/platform', name: 'widgets' }, thread: { kind: 'pull_request', number: '3' } })
    expect(az.parseUrl('https://dev.azure.com/contoso/Widgets/_git/widgets/pullrequest/42')).toMatchObject({ repo: { owner: 'contoso/Widgets', name: 'widgets' }, thread: { kind: 'pull_request', number: '42' } })
    expect(tg.parseUrl('https://tangled.org/@acme.dev/core/issues/4')).toMatchObject({ repo: { owner: 'acme.dev', name: 'core' }, thread: { kind: 'issue', displayNumber: '4' } })
    expect(gh.parseUrl('https://gitlab.com/acme/widgets')).toBeUndefined()
  })

  it.each([
    'git@github.com:acme/widgets.git',
    'org-12345@github.com:acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
    'ssh://git@github.com:22/acme/widgets',
    'git+ssh://git@github.com/acme/widgets.git',
  ])('parses the clone URL %s', (url) => {
    expect(gh.parseUrl(url)?.repo).toMatchObject({ owner: 'acme', name: 'widgets' })
  })

  it('parses clone URLs on its own instance only', () => {
    expect(gl.parseUrl('git@gitlab.com:acme/platform/widgets.git')?.repo).toMatchObject({ owner: 'acme/platform', name: 'widgets' })
    expect(gh.parseUrl('git@gitlab.com:acme/widgets.git')).toBeUndefined()
  })

  it('writes each forge\'s cross-reference syntax', () => {
    const glPull = { ...pull, forge: 'gitlab', instance: 'gitlab.com', repo: { ...repo, forge: 'gitlab', instance: 'gitlab.com' } }

    expect(gh.referenceTo(pull, { from: repo })).toBe('#42')
    expect(gh.referenceTo(pull)).toBe('acme/widgets#42')
    expect(gl.referenceTo(glPull, { from: glPull.repo, expand: true })).toBe('!42+')
    expect(bb.referenceTo({ ...pull, forge: 'bitbucket', instance: 'bitbucket.org', repo: { ...repo, forge: 'bitbucket', instance: 'bitbucket.org' } })).toBe('https://bitbucket.org/acme/widgets/pull-requests/42')
  })
})

describe('forges aggregate', () => {
  it('routes by origin and URL, and rejects unregistered origins', async () => {
    const forges = createForges([github({ auth }), forgejo({ auth, baseUrl: 'https://codeberg.org' })])

    expect(forges.for(pull)?.forge).toBe('github')
    expect(forges.forUrl('https://codeberg.org/acme/widgets/pulls/1')?.forge).toBe('forgejo')
    expect(forges.parseUrl('https://github.com/acme/widgets/pull/42')?.thread).toMatchObject({ kind: 'pull_request', number: '42' })
    expect(() => forges.threads.get({ ...pull, instance: 'ghe.example.com' })).toThrow(UnknownForgeError)
  })

  it('turns a ref no provider serves into a per-item warning in getMany', async () => {
    const forges = createForges([fake({ instance: 'one.test', seed: { repos: [{ repo: 'acme/widgets' }], threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Hello' }] } })])
    const known = { forge: 'fake', instance: 'one.test', repo: { forge: 'fake', instance: 'one.test', owner: 'acme', name: 'widgets' }, kind: 'issue', number: '1' } as const
    const unknown = { ...pull, instance: 'ghe.example.com' }

    const results = await forges.threads.getMany([unknown, known])

    expect(results).toMatchObject([
      { ok: false, ref: unknown, warning: { code: 'thread_unreadable', cause: { name: 'UnknownForgeError' } } },
      { ok: true, thread: { title: 'Hello' } },
    ])
  })

  it('reads a URL with a malformed escape or a reserved path as nothing', () => {
    const forges = createForges([github({ auth }), forgejo({ auth, baseUrl: 'https://codeberg.org' })])

    expect(forges.parseUrl('https://github.com/acme/widgets/issues/%E0%A4%A')).toBeUndefined()
    expect(forges.parseUrl('https://github.com/settings/profile')).toBeUndefined()
    expect(forges.parseUrl('https://codeberg.org/explore/repos')).toBeUndefined()
    expect(forges.parseUrl('https://codeberg.org/user/settings')).toBeUndefined()
  })

  it('refuses two providers for the same instance', () => {
    expect(() => createForges([github({ auth }), github({ auth })])).toThrow('Two providers are registered for github on github.com')
  })

  it('keeps listing notifications when one provider fails', async () => {
    const working = fake({ instance: 'one.test', seed: { repos: [{ repo: 'acme/widgets' }], threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Hello' }], notifications: [{ repo: 'acme/widgets', number: 1 }] } })
    const broken = fake({ instance: 'two.test' })
    const forges = createForges([broken, working])
    forges.get('fake', 'two.test')!.notifications.list = () => forgeIterable(async function* () {
      throw new Error('offline')
    })

    const iterable = forges.notifications.list()
    const titles = (await Array.fromAsync(iterable)).map(notification => notification.title)

    expect(titles).toEqual(['Hello'])
    expect(iterable.warnings).toMatchObject([{ code: 'notifications_failed', message: 'offline', subject: 'fake:two.test' }])
  })

  it('lists each provider\'s notifications from the start, ignoring a cursor', async () => {
    const forges = createForges([fake({ instance: 'one.test' }), fake({ instance: 'two.test' })])
    const seen: unknown[] = []
    for (const provider of forges.providers) {
      provider.notifications.list = (options) => {
        seen.push(options)
        return forgeIterable(async function* () {})
      }
    }

    await Array.fromAsync(forges.notifications.list({ all: true, cursor: { nextUrl: 'https://one.test/next' } } as never))

    expect(seen).toEqual([{ all: true, cursor: undefined }, { all: true, cursor: undefined }])
  })
})

describe('cross-forge search', () => {
  it('merges results newest first and records one warning per failing provider', async () => {
    const first = fake({ instance: 'one.test', seed: { repos: [{ repo: 'acme/widgets' }], threads: [{ repo: 'acme/widgets', kind: 'issue', title: 'Crash on start' }] } })
    const second = fake({ instance: 'two.test', seed: { repos: [{ repo: 'acme/gadgets' }], threads: [{ repo: 'acme/gadgets', kind: 'issue', title: 'Crash on save' }] } })
    const broken = fake({ instance: 'three.test' })
    first.store.repos.get('acme/widgets')!.threads.get('1')!.thread.updatedAt = new Date('2025-01-02T00:00:00Z')
    second.store.repos.get('acme/gadgets')!.threads.get('1')!.thread.updatedAt = new Date('2025-01-03T00:00:00Z')
    const forges = createForges([first, second, broken])
    const brokenProvider = forges.get('fake', 'three.test')!
    brokenProvider.search.threadsPage = () => Promise.reject(new Error('index offline'))

    const iterable = forges.search.threads({ text: 'crash' })
    const titles = (await Array.fromAsync(iterable)).map(thread => thread.title)

    expect(titles).toEqual(['Crash on save', 'Crash on start'])
    expect(iterable.warnings).toMatchObject([{ code: 'search_failed', message: 'index offline', subject: 'fake:three.test' }])
  })
})

describe('cross-forge search paging', () => {
  const date = (day?: number) => day === undefined ? undefined : new Date(Date.UTC(2025, 0, day))
  const thread = (title: string, day?: number, createdDay?: number) => ({ title, updatedAt: date(day), createdAt: date(createdDay) }) as Thread

  function searchWith(pages: Record<string, Array<Page<Thread>>>) {
    const forges = createForges(Object.keys(pages).map(instance => fake({ instance })))
    const queries: Array<SearchQuery & { instance: string }> = []
    for (const provider of forges.providers) {
      provider.search.threadsPage = async (query) => {
        queries.push({ ...query, instance: provider.instance })
        return pages[provider.instance]![Number(query.cursor?.token ?? 0)]!
      }
    }
    return { forges, queries }
  }

  it('reads every page of each provider and merges them newest first', async () => {
    const { forges, queries } = searchWith({
      'one.test': [{ items: [thread('a1', 9), thread('a2', 6)], cursor: { token: '1' } }, { items: [thread('a3', 2)] }],
      'two.test': [{ items: [], cursor: { token: '1' } }, { items: [thread('b1', 8)], cursor: { token: '2' } }, { items: [thread('b2', 4)] }],
    })

    const titles = (await Array.fromAsync(forges.search.threads({ text: 'x', cursor: { token: '1' }, sort: 'comments' } as never))).map(item => item.title)

    expect(titles).toEqual(['a1', 'b1', 'a2', 'b2', 'a3'])
    expect(queries.filter(query => !query.cursor).map(query => query.instance)).toEqual(['one.test', 'two.test'])
    expect(queries.every(query => query.sort === 'updated' && query.direction === 'desc')).toBe(true)
  })

  it('orders each page before merging, oldest first with `direction: \'asc\'`', async () => {
    const { forges, queries } = searchWith({
      'one.test': [{ items: [thread('a9', 9), thread('a1', 1)], cursor: { token: '1' } }, { items: [thread('a5', 5)] }],
      'two.test': [{ items: [thread('b3', 3)] }],
    })

    const titles = (await Array.fromAsync(forges.search.threads({ direction: 'asc' }))).map(item => item.title)

    expect(titles).toEqual(['a1', 'b3', 'a9', 'a5'])
    expect(queries.every(query => query.direction === 'asc')).toBe(true)
  })

  it('merges by creation time with `sort: \'created\'`', async () => {
    const { forges, queries } = searchWith({
      'one.test': [{ items: [thread('a-old', 9, 1), thread('a-new', 2, 7)] }],
      'two.test': [{ items: [thread('b', 8, 4)] }],
    })

    const titles = (await Array.fromAsync(forges.search.threads({ sort: 'created' }))).map(item => item.title)

    expect(titles).toEqual(['a-new', 'b', 'a-old'])
    expect(queries.every(query => query.sort === 'created' && query.direction === 'desc')).toBe(true)
  })

  it('yields an item without `updatedAt` once it leads its page', async () => {
    const { forges } = searchWith({
      'one.test': [{ items: [thread('undated'), thread('a5', 5)], cursor: { token: '1' } }, { items: [thread('a1', 1)] }],
      'two.test': [{ items: [thread('b9', 9), thread('b3', 3), thread('b2', 2)] }],
    })

    const titles = (await Array.fromAsync(forges.search.threads())).map(item => item.title)

    expect(titles).toEqual(['b9', 'a5', 'undated', 'b3', 'b2', 'a1'])
  })

  it('reads the next page only when the iteration reaches it', async () => {
    const forges = createForges([fake({ instance: 'one.test' })])
    let reads = 0
    forges.providers[0]!.search.threadsPage = async () => {
      reads++
      return { items: [thread(String(reads), 10 - reads)], cursor: { token: 'more' } }
    }

    const iterator = forges.search.threads()[Symbol.asyncIterator]()
    const titles = [(await iterator.next()).value?.title, (await iterator.next()).value?.title]
    await iterator.return?.()

    expect(titles).toEqual(['1', '2'])
    expect(reads).toBe(2)
  })

  it('keeps the items a provider yielded before a later page fails', async () => {
    const forges = createForges([fake({ instance: 'one.test' })])
    forges.providers[0]!.search.threadsPage = async query => query.cursor
      ? Promise.reject(new Error('index offline'))
      : { items: [thread('first', 1)], cursor: { token: 'more' } }

    const iterable = forges.search.threads()
    const titles = (await Array.fromAsync(iterable)).map(item => item.title)

    expect(titles).toEqual(['first'])
    expect(iterable.warnings).toMatchObject([{ code: 'search_failed', message: 'index offline', subject: 'fake:one.test' }])
  })
})
