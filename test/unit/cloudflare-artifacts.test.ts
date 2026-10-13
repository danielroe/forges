import { describe, expect, it } from 'vitest'
import { cloudflareArtifacts } from '../../src/cloudflare-artifacts/index.ts'
import { NotFoundError } from '../../src/errors.ts'
import { fixtureFetch } from '../../src/testing/index.ts'

const account = '023e105f4ecef8ad9ca31a8372d0c353'
const instance = `${account}.artifacts.cloudflare.net`
const repo = { forge: 'cloudflare-artifacts', instance, owner: 'agents', name: 'notes' }
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces`
const notes = `${base}/agents/repos/notes`
const ok = <T>(result: T, cursor?: string) => ({ status: 200, body: { result, success: true, errors: [], messages: [], ...cursor ? { result_info: { cursor, per_page: 1, count: 1 } } : {} } })
const sha = (digit: string) => digit.repeat(40)
const commit = (hash: string, parents: string[], treeHash: string) => ({ hash, treeHash, parents, message: 'm', author: { name: 'a', email: 'a@example.com' }, committer: { name: 'a', email: 'a@example.com' }, authoredAt: 1_790_000_000, committedAt: 1_790_000_000 })
const repository = (name: string) => ({ id: name, name, description: null, default_branch: 'main', remote: `https://${instance}/git/agents/${name}.git` })

function provider(overrides: Parameters<typeof fixtureFetch>[1]) {
  const fixtures = fixtureFetch([], overrides)
  return { ...fixtures, forge: cloudflareArtifacts({ accountId: account, auth: { type: 'token', token: 't' }, fetch: fixtures.fetch }).create() }
}

describe('cloudflare artifacts', () => {
  it('keys refs by the account\'s Git host and has no threads', () => {
    const { forge } = provider({})
    expect(forge.instance).toBe(instance)
    expect(forge.webOrigin).toBeUndefined()
    expect(forge.can('threads.get', 'issue')).toBe(false)
  })

  it('reads `HEAD` and full ref names as Artifacts knows them, and rejects a ref it lists nothing for', async () => {
    const { forge } = provider({
      [`GET ${notes}/log?limit=1`]: ok([commit(sha('a'), [], sha('1'))]),
      [`GET ${notes}/log?ref=main&limit=1`]: ok([commit(sha('a'), [], sha('1'))]),
      [`GET ${notes}/log?ref=gone&limit=1`]: ok([]),
      [`GET ${notes}/file?ref=${sha('a')}&path=README.md`]: { status: 200, body: '# notes' },
      [`GET ${notes}/file?ref=main&path=README.md`]: { status: 200, body: '# notes' },
    })
    expect(await forge.contents.resolveRef(repo, 'HEAD')).toBe(sha('a'))
    expect(await forge.contents.resolveRef(repo, 'refs/heads/main')).toBe(sha('a'))
    await expect(forge.contents.resolveRef(repo, 'gone')).rejects.toThrow(NotFoundError)
    expect((await forge.contents.file(repo, 'README.md', { ref: 'HEAD', as: 'text' })).content).toBe('# notes')
    expect((await forge.contents.file(repo, 'README.md', { ref: 'refs/heads/main', as: 'text' })).content).toBe('# notes')
  })

  it('lists repositories one namespace at a time', async () => {
    const { forge } = provider({
      [`GET ${base}?limit=1`]: ok([{ namespace: 'agents' }], 'after-agents'),
      [`GET ${base}/agents/repos?limit=1`]: ok([repository('notes')], 'more-agents'),
      [`GET ${base}/agents/repos?limit=1&cursor=more-agents`]: ok([repository('plans')]),
      [`GET ${base}?limit=1&cursor=after-agents`]: ok([{ namespace: 'builds' }]),
      [`GET ${base}/builds/repos?limit=1`]: ok([repository('cache')]),
    })
    const names: string[] = []
    for await (const item of forge.repos.list({ perPage: 1 })) {
      names.push(`${item.ref.owner}/${item.ref.name}`)
    }
    expect(names).toEqual(['agents/notes', 'agents/plans', 'builds/cache'])
    expect((await forge.repos.listPage({ affiliation: ['collaborator'] })).items).toEqual([])
  })

  it('pages commits by offset and warns about the filters the log ignores', async () => {
    const { forge } = provider({
      [`GET ${notes}/log?limit=2`]: ok([commit(sha('a'), [sha('b')], sha('1')), commit(sha('b'), [sha('c')], sha('2'))]),
      [`GET ${notes}/log?offset=1&limit=2`]: ok([commit(sha('b'), [sha('c')], sha('2'))]),
    })
    const first = await forge.contents.commitsPage(repo, { perPage: 1, path: 'src' })
    expect(first.items.map(item => item.sha)).toEqual([sha('a')])
    expect(first.warnings?.[0]?.code).toBe('filter_unsupported')
    const second = await forge.contents.commitsPage(repo, { perPage: 1, cursor: first.cursor })
    expect(second).toMatchObject({ items: [{ sha: sha('b') }], cursor: undefined })
  })

  it.each([0, -1, Number.NaN])('falls back to the default page size for `perPage: %s`', async (perPage) => {
    const { forge, calls } = provider({ [`GET ${notes}/log?limit=31`]: ok([commit(sha('a'), [], sha('1'))]) })
    expect((await forge.contents.commitsPage(repo, { perPage })).items).toHaveLength(1)
    expect(calls[0]?.url).toContain('limit=31')
  })

  it('reads a commit whose parent a shallow import left out without its files, and a root commit with every file added', async () => {
    const { forge } = provider({
      [`GET ${notes}/commit/${sha('a')}`]: ok(commit(sha('a'), [sha('b')], sha('1'))),
      [`GET ${notes}/commit/${sha('b')}`]: { status: 404, body: { result: null, success: false, errors: [{ code: 10200, message: 'Commit not found' }], messages: [] } },
      [`GET ${notes}/commit/${sha('c')}`]: ok(commit(sha('c'), [], sha('3'))),
      [`GET ${notes}/tree/${sha('3')}`]: ok([{ name: 'src', mode: '40000', hash: sha('4'), type: 'tree' }, { name: 'README.md', mode: '100644', hash: sha('5'), type: 'blob' }]),
      [`GET ${notes}/tree/${sha('4')}`]: ok([{ name: 'index.ts', mode: '100644', hash: sha('6'), type: 'blob' }]),
    })
    expect((await forge.contents.commit(repo, sha('a'))).files).toBeUndefined()
    expect((await forge.contents.commit(repo, sha('c'))).files).toEqual([
      { path: 'README.md', status: 'added', sha: sha('5') },
      { path: 'src/index.ts', status: 'added', sha: sha('6') },
    ])
  })

  it('rejects a tree path that runs into a file, and warns that it lists one level', async () => {
    const { forge } = provider({
      [`GET ${notes}/log?limit=1`]: ok([commit(sha('a'), [], sha('1'))]),
      [`GET ${notes}/tree/${sha('1')}`]: ok([{ name: 'README.md', mode: '100644', hash: sha('5'), type: 'blob' }]),
    })
    await expect(forge.contents.treePage(repo, { path: 'README.md' })).rejects.toThrow(NotFoundError)
    expect((await forge.contents.treePage(repo, { recursive: true })).warnings?.[0]?.code).toBe('recursive_unsupported')
  })
})
