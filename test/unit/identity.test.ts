import type { ForgeIterable, ForgeListing, ForgeProvider, Page, RepoRef, RepoSection, SearchQuery, Thread, ThreadRef } from '../../src/index.ts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { fake } from '../../src/fake/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitea } from '../../src/gitea/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { createForges, parseNotificationKey, parseRepoKey, parseThreadKey, repoKey, repoSlug, threadKey, threadSlug } from '../../src/index.ts'
import { forgeIterable } from '../../src/kit.ts'
import { pushin } from '../../src/pushin/index.ts'
import { sourcehut } from '../../src/sourcehut/index.ts'
import { tangled } from '../../src/tangled/index.ts'

function unpaged<T>(iterable: ForgeIterable<T>): ForgeListing<T> {
  return Object.assign(iterable, { page: async () => ({ items: [] }) })
}

function stubSearch(provider: ForgeProvider, read: (query: SearchQuery) => Promise<Page<Thread>>) {
  provider.search.threads = (query = {}) => Object.assign(forgeIterable<Thread>(async function* () {}), { page: () => read(query) })
}

const auth = { type: 'token', token: 't' } as const
const repo: RepoRef = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }
const pull: ThreadRef = { forge: 'github', instance: 'github.com', repo, kind: 'pull_request', number: '42' }

describe('keys and slugs', () => {
  it('round-trips repo, thread and notification keys', () => {
    const nested = { forge: 'gitlab', instance: 'git.example.com:8443', owner: 'acme/platform', name: 'widgets' }
    const tangledThread = { forge: 'tangled', instance: 'tangled.org', repo: { forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:abc', name: 'core' }, kind: 'issue' as const, number: 'at://did:plc:abc/sh.tangled.repo.issue/3k' }

    expect(parseRepoKey(repoKey(nested))).toEqual(nested)
    expect(parseThreadKey(threadKey(tangledThread))).toEqual(tangledThread)
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
  })
})

describe('web links', () => {
  const gh = github({ auth })
  const gl = gitlab({ auth })
  const cb = forgejo({ auth, baseUrl: 'https://codeberg.org' })
  const bb = bitbucket({ auth: { type: 'token', token: 't' } })
  const az = azureDevOps({ auth: { type: 'token', token: 't' }, organization: 'contoso' })
  const tg = tangled({})

  it('builds web URLs without a request', () => {
    expect(gh.urlFor({ thread: pull })).toBe('https://github.com/acme/widgets/pull/42')
    expect(gh.urlFor({ comment: { forge: 'github', instance: 'github.com', thread: pull, id: '9' } })).toBe('https://github.com/acme/widgets/pull/42#issuecomment-9')
    expect(gh.urlFor({ file: { repo, path: 'src/a b.ts', at: 'main', line: 3 } })).toBe('https://github.com/acme/widgets/blob/main/src/a%20b.ts#L3')
    expect(gl.urlFor({ thread: { ...pull, forge: 'gitlab', instance: 'gitlab.com', repo: { ...repo, forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform' } } })).toBe('https://gitlab.com/acme/platform/widgets/-/merge_requests/42')
    expect(cb.urlFor({ release: { forge: 'forgejo', instance: 'codeberg.org', repo, id: '1', tag: 'v1.0.0' } })).toBe('https://codeberg.org/acme/widgets/releases/tag/v1.0.0')
    expect(bb.urlFor({ thread: { ...pull, forge: 'bitbucket', instance: 'bitbucket.org' } })).toBe('https://bitbucket.org/acme/widgets/pull-requests/42')
    expect(gh.urlFor({ thread: { ...pull, number: undefined } })).toBeUndefined()
  })

  it('exposes the forge web origin', () => {
    expect(gh.webOrigin).toBe('https://github.com')
    expect(gl.webOrigin).toBe('https://gitlab.com')
    expect(cb.webOrigin).toBe('https://codeberg.org')
    expect(bb.webOrigin).toBe('https://bitbucket.org')
    expect(az.webOrigin).toBe('https://dev.azure.com')
    expect(tg.webOrigin).toBe('https://tangled.org')
  })

  it('exposes the origin of a self-hosted instance', () => {
    expect(github({ auth, baseUrl: 'https://ghe.example.com/api/v3' }).webOrigin).toBe('https://ghe.example.com')
    expect(gitlab({ auth, baseUrl: 'https://git.example.com' }).webOrigin).toBe('https://git.example.com')
    expect(forgejo({ auth, baseUrl: 'https://forgejo.example.com' }).webOrigin).toBe('https://forgejo.example.com')
    expect(gitea({ auth, baseUrl: 'https://gitea.example.com' }).webOrigin).toBe('https://gitea.example.com')
  })

  it('exposes the canonical origin for a subpath deployment, keeping the path for links', () => {
    const subpath = gitlab({ auth, baseUrl: 'https://example.com/gitlab' })
    expect(subpath.webOrigin).toBe('https://example.com')
    expect(subpath.urlFor({ repo: { forge: 'gitlab', instance: 'example.com', owner: 'a', name: 'b' } })).toBe('https://example.com/gitlab/a/b')
  })

  it('types webOrigin as a string where the forge has a website', () => {
    expectTypeOf(gh.webOrigin).toEqualTypeOf<string>()
    expectTypeOf(fake().webOrigin).toEqualTypeOf<string | undefined>()
  })

  it('types a repository link as present where the forge has a website', () => {
    expectTypeOf(gh.urlFor({ repo })).toEqualTypeOf<string>()
    expectTypeOf(gh.urlFor({ repo, section: 'issues' })).toEqualTypeOf<string | undefined>()
    expectTypeOf(fake().urlFor({ repo })).toEqualTypeOf<string | undefined>()
  })

  const sha = 'a'.repeat(40)
  it.each([
    ['github', gh, repo, 'https://raw.githubusercontent.com/acme/widgets/v1.0.0/src/a%20b.ts', `https://github.com/acme/widgets/commit/${sha}`],
    ['github enterprise', github({ auth, baseUrl: 'https://ghe.example.com/api/v3' }), { ...repo, instance: 'ghe.example.com' }, 'https://ghe.example.com/acme/widgets/raw/v1.0.0/src/a%20b.ts', `https://ghe.example.com/acme/widgets/commit/${sha}`],
    ['gitlab', gl, { ...repo, forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform' }, 'https://gitlab.com/acme/platform/widgets/-/raw/v1.0.0/src/a%20b.ts', `https://gitlab.com/acme/platform/widgets/-/commit/${sha}`],
    ['forgejo', cb, { ...repo, forge: 'forgejo', instance: 'codeberg.org' }, 'https://codeberg.org/acme/widgets/raw/v1.0.0/src/a%20b.ts', `https://codeberg.org/acme/widgets/commit/${sha}`],
    ['gitea', gitea({ auth }), { ...repo, forge: 'gitea', instance: 'gitea.com' }, 'https://gitea.com/acme/widgets/raw/v1.0.0/src/a%20b.ts', `https://gitea.com/acme/widgets/commit/${sha}`],
    ['gitee', gitee({ auth }), { ...repo, forge: 'gitee', instance: 'gitee.com' }, 'https://gitee.com/acme/widgets/raw/v1.0.0/src/a%20b.ts', `https://gitee.com/acme/widgets/commit/${sha}`],
    ['pushin', pushin({ auth }), { ...repo, forge: 'pushin', instance: 'pushin.eu' }, undefined, `https://pushin.eu/acme/widgets/commits/${sha}`],
    ['bitbucket', bb, { ...repo, forge: 'bitbucket', instance: 'bitbucket.org' }, 'https://bitbucket.org/acme/widgets/raw/v1.0.0/src/a%20b.ts', `https://bitbucket.org/acme/widgets/commits/${sha}`],
    ['azure-devops', az, { ...repo, forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets' }, 'https://dev.azure.com/contoso/Widgets/_apis/git/repositories/widgets/items?path=%2Fsrc%2Fa%20b.ts&versionDescriptor.version=v1.0.0&versionDescriptor.versionType=branch&$format=octetStream', `https://dev.azure.com/contoso/Widgets/_git/widgets/commit/${sha}`],
    ['tangled', tg, { ...repo, forge: 'tangled', instance: 'tangled.org', owner: 'acme.dev' }, 'https://tangled.org/acme.dev/widgets/raw/v1.0.0/src/a%20b.ts', `https://tangled.org/acme.dev/widgets/commit/${sha}`],
    ['sourcehut', sourcehut({ auth }), { ...repo, forge: 'sourcehut', instance: 'sr.ht', owner: '~acme' }, 'https://git.sr.ht/~acme/widgets/blob/v1.0.0/src/a%20b.ts', `https://git.sr.ht/~acme/widgets/commit/${sha}`],
  ] as const)('builds raw file and commit URLs on %s', (_, provider, target, raw, commit) => {
    expect(provider.urlFor({ raw: { repo: target, path: 'src/a b.ts', at: 'v1.0.0' } })).toBe(raw)
    expect(provider.urlFor({ commit: { repo: target, sha } })).toBe(commit)
    expect(provider.parseUrl(commit)).toMatchObject({ commit: { repo: { owner: target.owner, name: target.name }, sha } })
    expect(provider.parseUrl(commit)?.thread).toBeUndefined()
    expect(provider.urlFor({ commit: { repo: target, sha: '' } })).toBeUndefined()
  })

  it('builds Forgejo file URLs at a branch, tag or commit', () => {
    const target = { ...repo, forge: 'forgejo', instance: 'codeberg.org' }
    expect(cb.urlFor({ file: { repo: target, path: 'README.md', at: 'v1.0.0', line: 3 } })).toBe('https://codeberg.org/acme/widgets/src/v1.0.0/README.md#L3')
    expect(cb.urlFor({ file: { repo: target, path: 'README.md', at: 'feat/a' } })).toBe('https://codeberg.org/acme/widgets/src/feat%2Fa/README.md')
    expect(cb.urlFor({ file: { repo: target, path: 'README.md', at: sha } })).toBe(`https://codeberg.org/acme/widgets/src/commit/${sha}/README.md`)
  })

  it('builds Azure DevOps file and comparison URLs at a commit', () => {
    const target = { ...repo, forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets' }
    expect(az.urlFor({ file: { repo: target, path: 'README.md', at: sha, line: 3 } })).toBe(`https://dev.azure.com/contoso/Widgets/_git/widgets?path=%2FREADME.md&version=GC${sha}&line=3`)
    expect(az.urlFor({ file: { repo: target, path: 'README.md', at: 'main' } })).toBe('https://dev.azure.com/contoso/Widgets/_git/widgets?path=%2FREADME.md&version=GBmain')
    expect(az.urlFor({ compare: { repo: target, base: 'main', head: sha } })).toBe(`https://dev.azure.com/contoso/Widgets/_git/widgets/branchCompare?baseVersion=GBmain&targetVersion=GC${sha}`)
  })

  it('builds Tangled file URLs', () => {
    expect(tg.urlFor({ file: { repo: { ...repo, forge: 'tangled', instance: 'tangled.org', owner: 'acme.dev' }, path: 'src/a b.ts', at: 'feat/a', line: 3 } })).toBe('https://tangled.org/acme.dev/widgets/blob/feat%2Fa/src/a%20b.ts#L3')
  })

  it('builds raw file URLs at a branch with a slash or a commit', () => {
    expect(gh.urlFor({ raw: { repo, path: 'README.md', at: 'feat/a' } })).toBe('https://raw.githubusercontent.com/acme/widgets/feat%2Fa/README.md')
    expect(az.urlFor({ raw: { repo: { ...repo, forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets' }, path: 'README.md', at: sha } })).toContain(`versionDescriptor.version=${sha}&versionDescriptor.versionType=commit`)
  })

  it('builds Tangled URLs with an unescaped DID owner', () => {
    expect(tg.urlFor({ repo: { forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:abc', name: 'core' } })).toBe('https://tangled.org/did:plc:abc/core')
  })

  it.each([
    ['gitlab', gl, { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: '', kind: 'namespace' }],
    ['azure-devops', az, { forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets', name: '', kind: 'namespace' }],
  ] as const)('builds no file, raw file, commit or comparison URL for a %s namespace', (_, provider, group) => {
    expect(provider.urlFor({ file: { repo: group, path: 'README.md', at: 'main' } })).toBeUndefined()
    expect(provider.urlFor({ raw: { repo: group, path: 'README.md', at: 'main' } })).toBeUndefined()
    expect(provider.urlFor({ commit: { repo: group, sha } })).toBeUndefined()
    expect(provider.urlFor({ compare: { repo: group, base: 'main', head: 'next' } })).toBeUndefined()
  })

  it.each([
    ['github', gh, repo, ['https://github.com/acme/widgets/issues', 'https://github.com/acme/widgets/pulls', 'https://github.com/acme/widgets/compare', 'https://github.com/acme/widgets/releases']],
    ['gitlab', gl, { ...repo, forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform' }, ['https://gitlab.com/acme/platform/widgets/-/issues', 'https://gitlab.com/acme/platform/widgets/-/merge_requests', 'https://gitlab.com/acme/platform/widgets/-/compare', 'https://gitlab.com/acme/platform/widgets/-/releases']],
    ['gitlab group', gl, { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform', name: '', kind: 'namespace' }, ['https://gitlab.com/groups/acme/platform/-/issues', 'https://gitlab.com/groups/acme/platform/-/merge_requests', undefined, undefined]],
    ['forgejo', cb, { ...repo, forge: 'forgejo', instance: 'codeberg.org' }, ['https://codeberg.org/acme/widgets/issues', 'https://codeberg.org/acme/widgets/pulls', 'https://codeberg.org/acme/widgets/compare', 'https://codeberg.org/acme/widgets/releases']],
    ['bitbucket', bb, { ...repo, forge: 'bitbucket', instance: 'bitbucket.org' }, ['https://bitbucket.org/acme/widgets/issues', 'https://bitbucket.org/acme/widgets/pull-requests', 'https://bitbucket.org/acme/widgets/branches/compare', undefined]],
    ['azure-devops', az, { ...repo, forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets' }, ['https://dev.azure.com/contoso/Widgets/_workitems', 'https://dev.azure.com/contoso/Widgets/_git/widgets/pullrequests', 'https://dev.azure.com/contoso/Widgets/_git/widgets/branchCompare', undefined]],
    ['azure-devops project', az, { forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets', name: '', kind: 'namespace' }, ['https://dev.azure.com/contoso/Widgets/_workitems', undefined, undefined, undefined]],
    ['tangled', tg, { ...repo, forge: 'tangled', instance: 'tangled.org', owner: 'acme.dev' }, ['https://tangled.org/acme.dev/widgets/issues', 'https://tangled.org/acme.dev/widgets/pulls', 'https://tangled.org/acme.dev/widgets/compare', undefined]],
    ['github namespace', gh, { ...repo, name: '', kind: 'namespace' }, [undefined, undefined, undefined, undefined]],
  ] as const)('builds repository section URLs on %s', (_, provider, target, urls) => {
    expect((['issues', 'pullRequests', 'compare', 'releases'] as const).map(section => provider.urlFor({ repo: target, section }))).toEqual(urls)
  })

  it.each([
    ['github', gh, repo, ['https://github.com/acme/widgets/stargazers', 'https://github.com/acme/widgets/forks', 'https://github.com/acme/widgets/watchers']],
    ['github enterprise', github({ auth, baseUrl: 'https://ghe.example.com/api/v3' }), { ...repo, instance: 'ghe.example.com' }, ['https://ghe.example.com/acme/widgets/stargazers', 'https://ghe.example.com/acme/widgets/forks', 'https://ghe.example.com/acme/widgets/watchers']],
    ['gitlab', gl, { ...repo, forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform' }, ['https://gitlab.com/acme/platform/widgets/-/starrers', 'https://gitlab.com/acme/platform/widgets/-/forks', undefined]],
    ['gitlab group', gl, { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform', name: '', kind: 'namespace' }, [undefined, undefined, undefined]],
    ['bitbucket', bb, { ...repo, forge: 'bitbucket', instance: 'bitbucket.org' }, [undefined, 'https://bitbucket.org/acme/widgets/forks', undefined]],
    ['forgejo', cb, { ...repo, forge: 'forgejo', instance: 'codeberg.org' }, ['https://codeberg.org/acme/widgets/stars', 'https://codeberg.org/acme/widgets/forks', 'https://codeberg.org/acme/widgets/watchers']],
    ['gitea', gitea({ auth }), { ...repo, forge: 'gitea', instance: 'gitea.com' }, ['https://gitea.com/acme/widgets/stars', 'https://gitea.com/acme/widgets/forks', 'https://gitea.com/acme/widgets/watchers']],
    ['gitee', gitee({ auth }), { ...repo, forge: 'gitee', instance: 'gitee.com' }, ['https://gitee.com/acme/widgets/stargazers', 'https://gitee.com/acme/widgets/members', 'https://gitee.com/acme/widgets/watchers']],
    ['pushin', pushin({ auth }), { ...repo, forge: 'pushin', instance: 'pushin.eu' }, ['https://pushin.eu/acme/widgets/stargazers', undefined, undefined]],
    ['tangled', tg, { ...repo, forge: 'tangled', instance: 'tangled.org', owner: 'acme.dev' }, ['https://tangled.org/acme.dev/widgets/stars', 'https://tangled.org/acme.dev/widgets/forks', undefined]],
    ['azure-devops', az, { ...repo, forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets' }, [undefined, undefined, undefined]],
    ['azure-devops project', az, { forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets', name: '', kind: 'namespace' }, [undefined, undefined, undefined]],
    ['github namespace', gh, { ...repo, name: '', kind: 'namespace' }, [undefined, undefined, undefined]],
  ] as const)('builds repository stargazer, fork and watcher URLs on %s', (_, provider, target, urls) => {
    expect((['stargazers', 'forks', 'watchers'] as const).map(section => provider.urlFor({ repo: target, section }))).toEqual(urls)
  })

  it('builds the repository URL when the section is undefined', () => {
    const section: RepoSection | undefined = undefined
    expect(gh.urlFor({ repo, section })).toBe('https://github.com/acme/widgets')
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

  it('reads a Tangled URL on tangled.sh as tangled.org', () => {
    expect(tg.parseUrl('https://tangled.sh/@acme.dev/core/issues/4')).toMatchObject({ repo: { instance: 'tangled.org', owner: 'acme.dev', name: 'core' }, thread: { kind: 'issue', displayNumber: '4' } })
    expect(tangled({ baseUrl: 'https://knot.example.com' }).parseUrl('https://tangled.sh/@acme.dev/core')).toBeUndefined()
  })

  it('reads a GitLab tag page as the tag, and a release page as the release', () => {
    expect(gl.parseUrl('https://gitlab.com/acme/platform/widgets/-/tags/v1.0.0')).toEqual({ repo: { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform', name: 'widgets' }, tag: 'v1.0.0' })
    expect(gl.parseUrl('https://gitlab.com/acme/widgets/-/tags/release/1.0')?.tag).toBe('release/1.0')
    expect(gl.parseUrl('https://gitlab.com/acme/widgets/-/tags')?.tag).toBeUndefined()
    expect(gl.parseUrl('https://gitlab.com/acme/widgets/-/releases/v1.0.0')).toMatchObject({ release: { tag: 'v1.0.0' } })
    expect(gl.parseUrl('https://gitlab.com/acme/widgets/-/releases/v1.0.0')?.tag).toBeUndefined()
  })

  it.each([
    ['github', gh, 'https://github.com/acme/widgets/compare/main...feat/a', { base: 'main', head: 'feat/a' }],
    ['github two-dot', gh, 'https://github.com/acme/widgets/compare/v1.0.0..v1.1.0', { base: 'v1.0.0', head: 'v1.1.0' }],
    ['github across forks', gh, 'https://github.com/acme/widgets/compare/main...octocat:widgets:feat', { base: 'main', head: 'octocat:widgets:feat' }],
    ['forgejo', cb, 'https://codeberg.org/acme/widgets/compare/main...feat', { base: 'main', head: 'feat' }],
    ['gitlab', gl, 'https://gitlab.com/acme/platform/widgets/-/compare/main...feat?from_project_id=1', { base: 'main', head: 'feat' }],
    ['gitlab two-dot', gl, 'https://gitlab.com/acme/platform/widgets/-/compare/main..feat', { base: 'main', head: 'feat' }],
    ['bitbucket', bb, 'https://bitbucket.org/acme/widgets/branches/compare/feat%0Dmain', { base: 'main', head: 'feat' }],
    ['azure-devops', az, `https://dev.azure.com/contoso/Widgets/_git/widgets/branchCompare?baseVersion=GBmain&targetVersion=GC${sha}`, { base: 'main', head: sha }],
  ] as const)('reads the revisions of a %s comparison', (_, provider, url, compare) => {
    expect(provider.parseUrl(url)?.compare).toEqual(compare)
  })

  it.each([
    ['github', gh, repo],
    ['gitlab', gl, { ...repo, forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform' }],
    ['forgejo', cb, { ...repo, forge: 'forgejo', instance: 'codeberg.org' }],
    ['bitbucket', bb, { ...repo, forge: 'bitbucket', instance: 'bitbucket.org' }],
    ['azure-devops', az, { ...repo, forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets' }],
  ] as const)('reads back the %s comparison URL it builds', (_, provider, target) => {
    const compare = { base: 'main', head: 'feat/a' }
    expect(provider.parseUrl(provider.urlFor({ compare: { repo: target, ...compare } })!)?.compare).toEqual(compare)
  })

  it('leaves the comparison off a compare page without two revisions', () => {
    expect(gh.parseUrl('https://github.com/acme/widgets/compare')?.compare).toBeUndefined()
    expect(gh.parseUrl('https://github.com/acme/widgets/compare/feat')?.compare).toBeUndefined()
    expect(gl.parseUrl('https://gitlab.com/acme/widgets/-/compare')?.compare).toBeUndefined()
  })

  it.each([
    ['github', gh, `https://github.com/acme/widgets/pull/42/commits/${sha}`, { owner: 'acme', name: 'widgets' }],
    ['forgejo', cb, `https://codeberg.org/acme/widgets/pulls/42/commits/${sha}`, { owner: 'acme', name: 'widgets' }],
    ['gitlab', gl, `https://gitlab.com/acme/platform/widgets/-/merge_requests/42/diffs?commit_id=${sha}`, { owner: 'acme/platform', name: 'widgets' }],
  ] as const)('reads a commit of a %s pull request as the pull request and the commit', (_, provider, url, target) => {
    expect(provider.parseUrl(url)).toMatchObject({ thread: { kind: 'pull_request', number: '42', repo: target }, commit: { sha, repo: target } })
  })

  it.each([
    ['github', gh, 'https://github.com/acme/widgets/blob/main/src/a%20b.ts#L3', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'src/a b.ts', line: 3 }],
    ['github at a line range', gh, 'https://github.com/acme/widgets/blob/main/README.md?plain=1#L3-L5', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md', line: 3 }],
    ['github at a heading', gh, 'https://github.com/acme/widgets/blob/main/README.md#usage', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md' }],
    ['github at a branch with a slash', gh, 'https://github.com/acme/widgets/blob/feat%2Fa/README.md', { owner: 'acme', name: 'widgets' }, { at: 'feat/a', path: 'README.md' }],
    ['github enterprise', github({ auth, baseUrl: 'https://ghe.example.com/api/v3' }), 'https://ghe.example.com/acme/widgets/blob/main/README.md', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md' }],
    ['forgejo at a branch', cb, 'https://codeberg.org/acme/widgets/src/branch/main/README.md', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md' }],
    ['forgejo at a tag', cb, 'https://codeberg.org/acme/widgets/src/tag/v1.0.0/README.md', { owner: 'acme', name: 'widgets' }, { at: 'v1.0.0', path: 'README.md' }],
    ['forgejo at a commit', cb, `https://codeberg.org/acme/widgets/src/commit/${sha}/README.md`, { owner: 'acme', name: 'widgets' }, { at: sha, path: 'README.md' }],
    ['forgejo at a short commit', cb, 'https://codeberg.org/acme/widgets/src/commit/abc1234/README.md', { owner: 'acme', name: 'widgets' }, { at: 'abc1234', path: 'README.md' }],
    ['forgejo at a branch with a slash', cb, 'https://codeberg.org/acme/widgets/src/branch/feat%2Fa/README.md', { owner: 'acme', name: 'widgets' }, { at: 'feat/a', path: 'README.md' }],
    ['forgejo at a branch with a nested path', cb, 'https://codeberg.org/forgejo/forgejo/src/branch/forgejo/release-notes-published/16.0.5.md', { owner: 'forgejo', name: 'forgejo' }, { at: 'forgejo', path: 'release-notes-published/16.0.5.md' }],
    ['forgejo at a branch without a qualifier', cb, 'https://codeberg.org/acme/widgets/src/main/README.md#L3', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md', line: 3 }],
    ['gitea', gitea({ auth }), 'https://gitea.com/acme/widgets/src/branch/main/README.md', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md' }],
    ['gitee', gitee({ auth }), 'https://gitee.com/acme/widgets/blob/main/README.md', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md' }],
    ['pushin', pushin({ auth }), 'https://pushin.eu/acme/widgets/blob/main/README.md', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md' }],
    ['gitlab', gl, 'https://gitlab.com/acme/platform/widgets/-/blob/main/src/a%20b.ts#L3', { owner: 'acme/platform', name: 'widgets' }, { at: 'main', path: 'src/a b.ts', line: 3 }],
    ['gitlab at a line range', gl, 'https://gitlab.com/acme/platform/widgets/-/blob/main/README.md?ref_type=heads#L3-5', { owner: 'acme/platform', name: 'widgets' }, { at: 'main', path: 'README.md', line: 3 }],
    ['bitbucket', bb, 'https://bitbucket.org/acme/widgets/src/main/src/a%20b.ts#lines-3', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'src/a b.ts', line: 3 }],
    ['bitbucket at a line range', bb, 'https://bitbucket.org/acme/widgets/src/main/README.md#lines-3:5', { owner: 'acme', name: 'widgets' }, { at: 'main', path: 'README.md', line: 3 }],
    ['tangled', tg, 'https://tangled.org/acme.dev/widgets/blob/feat%2Fa/src/a%20b.ts#L3', { owner: 'acme.dev', name: 'widgets' }, { at: 'feat/a', path: 'src/a b.ts', line: 3 }],
    ['azure-devops at a branch', az, 'https://dev.azure.com/contoso/Widgets/_git/widgets?path=%2FREADME.md&version=GBmain', { owner: 'contoso/Widgets', name: 'widgets' }, { at: 'main', path: 'README.md' }],
    ['azure-devops at a tag', az, 'https://dev.azure.com/contoso/Widgets/_git/widgets?path=%2FREADME.md&version=GTv1.0.0', { owner: 'contoso/Widgets', name: 'widgets' }, { at: 'v1.0.0', path: 'README.md' }],
    ['azure-devops at a commit', az, `https://dev.azure.com/contoso/Widgets/_git/widgets?path=%2FREADME.md&version=GC${sha}&line=3`, { owner: 'contoso/Widgets', name: 'widgets' }, { at: sha, path: 'README.md', line: 3 }],
    ['azure-devops on the default branch', az, 'https://dev.azure.com/contoso/Widgets/_git/widgets?path=%2FREADME.md', { owner: 'contoso/Widgets', name: 'widgets' }, { path: 'README.md' }],
  ] as const)('reads the file path from a %s URL', (_, provider, url, repo, file) => {
    const parsed = provider.parseUrl(url)

    expect(parsed?.repo).toMatchObject(repo)
    expect(parsed?.file).toEqual(file)
  })

  it.each([
    ['github', gh, { ...repo }],
    ['forgejo', cb, { ...repo, forge: 'forgejo', instance: 'codeberg.org' }],
    ['gitlab', gl, { ...repo, forge: 'gitlab', instance: 'gitlab.com', owner: 'acme/platform' }],
    ['bitbucket', bb, { ...repo, forge: 'bitbucket', instance: 'bitbucket.org' }],
    ['tangled', tg, { ...repo, forge: 'tangled', instance: 'tangled.org', owner: 'acme.dev' }],
    ['azure-devops', az, { ...repo, forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets' }],
  ] as const)('reads back the %s file URL it builds', (_, provider, target) => {
    for (const at of ['main', 'feat/a', sha]) {
      const file = { path: 'src/a b.ts', at, line: 3 }

      expect(provider.parseUrl(provider.urlFor({ file: { repo: target, ...file } })!)?.file).toEqual(file)
    }
  })

  it('leaves the file off a URL that is not a file page', () => {
    expect(gh.parseUrl('https://github.com/acme/widgets')?.file).toBeUndefined()
    expect(gh.parseUrl('https://github.com/acme/widgets/blob')?.file).toBeUndefined()
    expect(gl.parseUrl('https://gitlab.com/acme/platform/widgets/-/blob/main')?.file).toBeUndefined()
    expect(bb.parseUrl('https://bitbucket.org/acme/widgets/src/main')?.file).toBeUndefined()
    expect(az.parseUrl('https://dev.azure.com/contoso/Widgets/_git/widgets?path=%2F&version=GBmain')?.file).toBeUndefined()
    expect(cb.parseUrl('https://codeberg.org/acme/widgets/src/branch/main')?.file).toBeUndefined()
    expect(cb.parseUrl('https://codeberg.org/acme/widgets/src/tag/v1.0.0')?.file).toBeUndefined()
    expect(cb.parseUrl(`https://codeberg.org/acme/widgets/src/commit/${sha}`)?.file).toBeUndefined()
  })

  it('reads an azure-devops pull request with a file query as the pull request', () => {
    expect(az.parseUrl('https://dev.azure.com/contoso/Widgets/_git/widgets/pullrequest/12?_a=files&path=%2Fsrc%2Fa.ts&version=GBmain')).toMatchObject({ thread: { kind: 'pull_request', number: '12' } })
  })

  it('reads a file URL through the aggregate', () => {
    const forges = createForges([github({ auth })])
    expect(forges.parseUrl('https://github.com/acme/widgets/blob/main/README.md')).toMatchObject({ file: { at: 'main', path: 'README.md' } })
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

  it.each([
    'https://github.com/acme/widgets.git',
    'http://github.com/acme/widgets',
    'git+https://github.com/acme/widgets.git',
    'git+http://github.com/acme/widgets.git',
    'git://github.com/acme/widgets.git',
    'git://github.com:9418/acme/widgets.git',
    'git+git://github.com/acme/widgets.git',
  ])('parses the npm repository URL %s', (url) => {
    expect(gh.parseUrl(url)?.repo).toMatchObject({ owner: 'acme', name: 'widgets' })
  })

  it('parses the npm repository shorthand such as github:acme/widgets', () => {
    expect(gh.parseUrl('github:acme/widgets')?.repo).toMatchObject({ owner: 'acme', name: 'widgets' })
    expect(gl.parseUrl('gitlab:acme/platform/widgets')?.repo).toMatchObject({ owner: 'acme/platform', name: 'widgets' })
    expect(bb.parseUrl('bitbucket:acme/widgets')?.repo).toMatchObject({ owner: 'acme', name: 'widgets' })
    expect(gh.parseUrl('gitlab:acme/widgets')).toBeUndefined()
    expect(gh.parseUrl('github://acme/widgets')).toBeUndefined()
    expect(gh.parseUrl('git+github:acme/widgets')).toBeUndefined()
  })

  it('reads the npm repository shorthand as the public instance only', () => {
    const ghes = github({ auth, baseUrl: 'https://ghe.example.com/api/v3' })
    const glSelf = gitlab({ auth, baseUrl: 'https://git.example.com' })
    expect(ghes.parseUrl('github:acme/widgets')).toBeUndefined()
    expect(glSelf.parseUrl('gitlab:acme/widgets')).toBeUndefined()
    expect(createForges([github({ auth, baseUrl: 'https://ghe.example.com/api/v3' }), github({ auth })]).parseUrl('github:acme/widgets')?.repo.instance).toBe('github.com')
  })

  it('parses clone URLs on its own instance only', () => {
    expect(gl.parseUrl('git@gitlab.com:acme/platform/widgets.git')?.repo).toMatchObject({ owner: 'acme/platform', name: 'widgets' })
    expect(gh.parseUrl('git@gitlab.com:acme/widgets.git')).toBeUndefined()
    expect(gh.parseUrl('git+https://gitlab.com/acme/widgets.git')).toBeUndefined()
    expect(gh.parseUrl('git://gitlab.com/acme/widgets.git')).toBeUndefined()
    expect(gh.parseUrl('git://github.com.evil.example/acme/widgets.git')).toBeUndefined()
    expect(gh.parseUrl('http://gitlab.com/acme/widgets')).toBeUndefined()
  })

  it('refuses clone URLs that carry credentials', () => {
    expect(gh.parseUrl('https://user:password@github.com/acme/widgets')).toBeUndefined()
    expect(gh.parseUrl('git+https://user:password@github.com/acme/widgets.git')).toBeUndefined()
    expect(gh.parseUrl('http://user@github.com/acme/widgets')).toBeUndefined()
  })

  it('writes each forge\'s cross-reference syntax', () => {
    const glPull = { ...pull, forge: 'gitlab', instance: 'gitlab.com', repo: { ...repo, forge: 'gitlab', instance: 'gitlab.com' } }

    expect(gh.referenceFor(pull, { from: repo })).toBe('#42')
    expect(gh.referenceFor(pull)).toBe('acme/widgets#42')
    expect(gl.referenceFor(glPull, { from: glPull.repo, expand: true })).toBe('!42+')
    expect(bb.referenceFor({ ...pull, forge: 'bitbucket', instance: 'bitbucket.org', repo: { ...repo, forge: 'bitbucket', instance: 'bitbucket.org' } })).toBe('https://bitbucket.org/acme/widgets/pull-requests/42')
  })

  it('writes each forge\'s reference to a commit', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'
    const glRepo = { ...repo, forge: 'gitlab', instance: 'gitlab.com' }
    const bbRepo = { ...repo, forge: 'bitbucket', instance: 'bitbucket.org' }

    expect(gh.referenceFor({ forge: 'github', instance: 'github.com', repo, sha }, { from: repo })).toBe('0123456')
    expect(gh.referenceFor({ forge: 'github', instance: 'github.com', repo, sha })).toBe('acme/widgets@0123456')
    expect(gl.referenceFor({ forge: 'gitlab', instance: 'gitlab.com', repo: glRepo, sha })).toBe('acme/widgets@01234567')
    expect(bb.referenceFor({ forge: 'bitbucket', instance: 'bitbucket.org', repo: bbRepo, sha }, { from: bbRepo })).toBe('0123456789ab')
    expect(bb.referenceFor({ forge: 'bitbucket', instance: 'bitbucket.org', repo: bbRepo, sha })).toBe(`https://bitbucket.org/acme/widgets/commits/${sha}`)
  })
})

describe('forges aggregate', () => {
  it('routes by origin and URL, and finds no provider for an unregistered origin', async () => {
    const forges = createForges([github({ auth }), forgejo({ auth, baseUrl: 'https://codeberg.org' })])

    expect(forges.for(pull)?.forge).toBe('github')
    expect(forges.forUrl('https://codeberg.org/acme/widgets/pulls/1')?.forge).toBe('forgejo')
    expect(forges.parseUrl('https://github.com/acme/widgets/pull/42')?.thread).toMatchObject({ kind: 'pull_request', number: '42' })
    expect(forges.for({ ...pull, instance: 'ghe.example.com' })).toBeUndefined()
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
    forges.get('fake', 'two.test')!.notifications.list = () => unpaged(forgeIterable(async function* () {
      throw new Error('offline')
    }))

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
        return unpaged(forgeIterable(async function* () {}))
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
    stubSearch(brokenProvider, () => Promise.reject(new Error('index offline')))

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
      stubSearch(provider, async (query) => {
        queries.push({ ...query, instance: provider.instance })
        return pages[provider.instance]![Number(query.cursor?.token ?? 0)]!
      })
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
    stubSearch(forges.providers[0]!, async () => {
      reads++
      return { items: [thread(String(reads), 10 - reads)], cursor: { token: 'more' } }
    })

    const iterator = forges.search.threads()[Symbol.asyncIterator]()
    const titles = [(await iterator.next()).value?.title, (await iterator.next()).value?.title]
    await iterator.return?.()

    expect(titles).toEqual(['1', '2'])
    expect(reads).toBe(2)
  })

  it('keeps the items a provider yielded before a later page fails', async () => {
    const forges = createForges([fake({ instance: 'one.test' })])
    stubSearch(forges.providers[0]!, async query => query.cursor
      ? Promise.reject(new Error('index offline'))
      : { items: [thread('first', 1)], cursor: { token: 'more' } })

    const iterable = forges.search.threads()
    const titles = (await Array.fromAsync(iterable)).map(item => item.title)

    expect(titles).toEqual(['first'])
    expect(iterable.warnings).toMatchObject([{ code: 'search_failed', message: 'index offline', subject: 'fake:one.test' }])
  })
})
