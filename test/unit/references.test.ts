import type { ForgeProvider, RepoRef } from '../../src/index.ts'
import { describe, expect, it } from 'vitest'
import { azureDevOps } from '../../src/azure-devops/index.ts'
import { bitbucket } from '../../src/bitbucket/index.ts'
import { forgejo } from '../../src/forgejo/index.ts'
import { gitee } from '../../src/gitee/index.ts'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'
import { createForges } from '../../src/index.ts'
import { sourcehut } from '../../src/sourcehut/index.ts'
import { tangled } from '../../src/tangled/index.ts'

const auth = { type: 'token', token: 't' } as const
const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

function repoOn(provider: ForgeProvider, owner: string, name: string): RepoRef {
  return { forge: provider.forge, instance: provider.instance, owner, name }
}

function read(provider: ForgeProvider, text: string, from: RepoRef) {
  return provider.parseReferences(text, { from }).map(({ start, end, ref }) => ({ text: text.slice(start, end), ref }))
}

describe('parseReferences', () => {
  const gh = github()
  const ghRepo = repoOn(gh, 'acme', 'widgets')

  it('reads GitHub references with their offsets', () => {
    const text = 'Fixes #42 and GH-7, see octo/tools#3 and octo/tools@abc1234, landed in 9f8e7d6.'

    expect(gh.parseReferences(text, { from: ghRepo })).toEqual([
      { start: 6, end: 9, ref: { forge: 'github', instance: 'github.com', repo: ghRepo, kind: 'issue', number: '42' } },
      { start: 14, end: 18, ref: { forge: 'github', instance: 'github.com', repo: ghRepo, kind: 'issue', number: '7' } },
      { start: 24, end: 36, ref: { forge: 'github', instance: 'github.com', repo: repoOn(gh, 'octo', 'tools'), kind: 'issue', number: '3' } },
      { start: 41, end: 59, ref: { forge: 'github', instance: 'github.com', repo: repoOn(gh, 'octo', 'tools'), sha: 'abc1234' } },
      { start: 71, end: 78, ref: { forge: 'github', instance: 'github.com', repo: ghRepo, sha: '9f8e7d6' } },
    ])
  })

  it('reads back every reference that referenceFor writes', () => {
    const other = repoOn(gh, 'octo', 'tools')
    const refs = [
      { forge: 'github', instance: 'github.com', repo: ghRepo, kind: 'issue', number: '42' },
      { forge: 'github', instance: 'github.com', repo: other, kind: 'issue', number: '3' },
      { forge: 'github', instance: 'github.com', repo: ghRepo, sha },
      { forge: 'github', instance: 'github.com', repo: other, sha },
    ] as const
    for (const ref of refs) {
      const text = gh.referenceFor(ref, { from: ghRepo })!
      const [parsed] = gh.parseReferences(`See ${text}.`, { from: ghRepo })

      expect(parsed?.ref).toMatchObject('sha' in ref ? { repo: ref.repo, sha: ref.sha.slice(0, 7) } : { repo: ref.repo, number: ref.number })
    }
  })

  it.each([
    ['a word', 'issue#42'],
    ['a path', 'docs/guide/intro.md#42'],
    ['a URL', 'https://example.com/page#42 and https://github.com/acme/widgets/commit/abc1234'],
    ['an email address', 'me@abc1234.example.com'],
    ['a number', '20261018'],
    ['a hex word', 'deadbeefcafe'],
    ['a file name', 'abc1234.js'],
    ['a scoped package', '@acme/widgets@1234567'],
    ['a heading marker', '# 42'],
  ])('reads nothing from %s', (_, text) => {
    expect(gh.parseReferences(text, { from: ghRepo })).toEqual([])
  })

  it('reads nothing when the text is written on another instance', () => {
    expect(gh.parseReferences('#42', { from: { ...ghRepo, instance: 'ghe.example.com' } })).toEqual([])
    expect(gh.parseReferences('#42', { from: repoOn(gitlab(), 'acme', 'widgets') })).toEqual([])
  })

  it('reads GitLab issues, merge requests and nested groups, with the + suffix', () => {
    const gl = gitlab()
    const from = repoOn(gl, 'acme/platform', 'widgets')

    expect(read(gl, '#1, !2+, acme/tools!3, a/b/c#4+s and a/b/c@abc12345', from)).toEqual([
      { text: '#1', ref: { forge: 'gitlab', instance: 'gitlab.com', repo: from, kind: 'issue', number: '1' } },
      { text: '!2+', ref: { forge: 'gitlab', instance: 'gitlab.com', repo: from, kind: 'pull_request', number: '2' } },
      { text: 'acme/tools!3', ref: { forge: 'gitlab', instance: 'gitlab.com', repo: repoOn(gl, 'acme', 'tools'), kind: 'pull_request', number: '3' } },
      { text: 'a/b/c#4+s', ref: { forge: 'gitlab', instance: 'gitlab.com', repo: repoOn(gl, 'a/b', 'c'), kind: 'issue', number: '4' } },
      { text: 'a/b/c@abc12345', ref: { forge: 'gitlab', instance: 'gitlab.com', repo: repoOn(gl, 'a/b', 'c'), sha: 'abc12345' } },
    ])
  })

  it('reads Gitee issues by their letters and pull requests by their digits', () => {
    const ge = gitee({ auth })
    const from = repoOn(ge, 'acme', 'widgets')

    expect(read(ge, '#I6XZ2N, !7 and #42', from).map(({ text, ref }) => [text, 'kind' in ref && ref.kind])).toEqual([['#I6XZ2N', 'issue'], ['!7', 'pull_request']])
  })

  it('reads Bitbucket references within the repository only', () => {
    const bb = bitbucket()
    const from = repoOn(bb, 'acme', 'widgets')

    expect(read(bb, '#1, pull request #2, acme/tools#3 and 0123456789ab', from)).toEqual([
      { text: '#1', ref: { forge: 'bitbucket', instance: 'bitbucket.org', repo: from, kind: 'issue', number: '1' } },
      { text: 'pull request #2', ref: { forge: 'bitbucket', instance: 'bitbucket.org', repo: from, kind: 'pull_request', number: '2' } },
      { text: '0123456789ab', ref: { forge: 'bitbucket', instance: 'bitbucket.org', repo: from, sha: '0123456789ab' } },
    ])
  })

  it('reads an Azure DevOps work item on the project, and a pull request in the repository', () => {
    const az = azureDevOps({ organization: 'contoso' })
    const from = repoOn(az, 'contoso/Widgets', 'widgets')

    expect(read(az, '#1 and !2', from)).toEqual([
      { text: '#1', ref: { forge: 'azure-devops', instance: 'dev.azure.com', repo: { forge: 'azure-devops', instance: 'dev.azure.com', owner: 'contoso/Widgets', name: '', kind: 'namespace' }, kind: 'issue', number: '1' } },
      { text: '!2', ref: { forge: 'azure-devops', instance: 'dev.azure.com', repo: from, kind: 'pull_request', number: '2' } },
    ])
  })

  it('reads Forgejo and Sourcehut references', () => {
    const cb = forgejo()
    const sh = sourcehut({ auth })

    expect(read(cb, 'acme/tools#3', repoOn(cb, 'acme', 'widgets'))).toMatchObject([{ text: 'acme/tools#3', ref: { repo: { owner: 'acme', name: 'tools' }, number: '3' } }])
    expect(read(sh, '#1 and ~acme/tools#3', repoOn(sh, '~acme', 'widgets'))).toMatchObject([
      { text: '#1', ref: { repo: { owner: '~acme', name: 'widgets' }, number: '1' } },
      { text: '~acme/tools#3', ref: { repo: { owner: '~acme', name: 'tools' }, number: '3' } },
    ])
  })

  it('reads nothing on a forge without a reference syntax', () => {
    const tg = tangled()
    expect(tg.parseReferences('#1', { from: repoOn(tg, 'acme.dev', 'widgets') })).toEqual([])
  })

  it('reads references through the aggregate with the provider of the repository', () => {
    const gl = gitlab()
    const forges = createForges([gh, gl])

    expect(forges.parseReferences('!2', { from: repoOn(gl, 'acme', 'widgets') })).toMatchObject([{ ref: { forge: 'gitlab', kind: 'pull_request' } }])
    expect(forges.parseReferences('!2', { from: ghRepo })).toEqual([])
    expect(forges.parseReferences('#2', { from: repoOn(forgejo(), 'acme', 'widgets') })).toEqual([])
  })
})
