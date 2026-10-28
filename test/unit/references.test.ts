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

  describe('commit references', () => {
    const shas = {
      'mixed': sha,
      'letters before the first digit': 'deadbeef1234567890abcdef1234567890abcdef',
      'digits before the first letter': '12345678a0b1c2d3e4f5061728394a5b6c7d8e9f',
      'only digits': '1234567890'.repeat(4),
      'only letters': 'abcdef'.repeat(7).slice(0, 40),
    }
    const providers = [github(), gitlab(), sourcehut({ auth }), tangled(), bitbucket(), forgejo(), gitee({ auth })]

    it.each(providers.flatMap(provider => Object.entries(shas).map(([name, value]) => [provider.forge, name, provider, value] as const)))('reads back what %s writes for a sha with %s', (_forge, _name, provider, value) => {
      const owner = provider.forge === 'sourcehut' ? '~acme' : 'acme'
      const from = repoOn(provider, owner, 'widgets')
      for (const repo of [from, repoOn(provider, owner, 'tools')]) {
        const ref = { forge: provider.forge, instance: provider.instance, repo, sha: value }
        const text = provider.referenceFor(ref, { from })
        if (text === undefined) {
          continue
        }
        if (text.startsWith('https://')) {
          expect(provider.parseUrl(text)).toMatchObject({ commit: { repo: { owner: repo.owner, name: repo.name }, sha: value } })
          continue
        }
        const [parsed] = provider.parseReferences(`See ${text}.`, { from })

        expect(parsed?.ref).toMatchObject({ repo: { owner: repo.owner, name: repo.name } })
        expect(value.startsWith((parsed!.ref as { sha: string }).sha)).toBe(true)
      }
    })

    it('extends a bare sha until it has a letter and a digit', () => {
      const gh = github()
      const from = repoOn(gh, 'acme', 'widgets')
      const at = (value: string) => gh.referenceFor({ forge: 'github', instance: 'github.com', repo: from, sha: value }, { from })

      expect(at(sha)).toBe('a1b2c3d')
      expect(at(shas['letters before the first digit'])).toBe('deadbeef1')
      expect(at(shas['digits before the first letter'])).toBe('12345678a')
      expect(gitlab().referenceFor({ forge: 'gitlab', instance: 'gitlab.com', repo: repoOn(gitlab(), 'acme', 'widgets'), sha: shas['letters before the first digit'] }, { from: repoOn(gitlab(), 'acme', 'widgets') })).toBe('deadbeef1')
    })

    it('qualifies a sha with no bare prefix by its repository, or links it where the forge has no such syntax', () => {
      const gh = github()
      const from = repoOn(gh, 'acme', 'widgets')
      const bb = bitbucket()
      const bbFrom = repoOn(bb, 'acme', 'widgets')

      expect(gh.referenceFor({ forge: 'github', instance: 'github.com', repo: from, sha: shas['only digits'] }, { from })).toBe('acme/widgets@1234567')
      expect(gh.referenceFor({ forge: 'github', instance: 'github.com', repo: from, sha: shas['only letters'] }, { from })).toBe('acme/widgets@abcdefa')
      expect(bb.referenceFor({ forge: 'bitbucket', instance: 'bitbucket.org', repo: bbFrom, sha: shas['only digits'] }, { from: bbFrom })).toMatch(/^https:\/\/bitbucket\.org\/acme\/widgets\/commits\//)
    })
  })

  it('reads Tangled references back from their display number, short, cross-repo and by DID owner', () => {
    const tg = tangled()
    const from = repoOn(tg, 'acme.dev', 'widgets')
    const other = repoOn(tg, 'vueuse', 'vueuse')
    const did = repoOn(tg, 'did:plc:abc', 'core')
    const refs = [
      { forge: 'tangled', instance: 'tangled.org', repo: from, kind: 'issue', displayNumber: '4195' },
      { forge: 'tangled', instance: 'tangled.org', repo: other, kind: 'issue', displayNumber: '4195' },
      { forge: 'tangled', instance: 'tangled.org', repo: did, kind: 'issue', displayNumber: '7' },
    ] as const

    expect(tg.referenceFor(refs[0], { from })).toBe('#4195')
    expect(tg.referenceFor(refs[1], { from })).toBe('vueuse/vueuse#4195')
    expect(tg.referenceFor(refs[2], { from })).toBe('did:plc:abc/core#7')
    for (const ref of refs) {
      const text = tg.referenceFor(ref, { from })!
      const [parsed] = tg.parseReferences(`See ${text}.`, { from })

      expect(parsed?.ref).toMatchObject({ repo: ref.repo, kind: 'issue', displayNumber: ref.displayNumber })
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

  it('reads a long run of word characters in linear time', () => {
    expect(gh.parseReferences('a'.repeat(200_000), { from: ghRepo })).toEqual([])
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

  it('reads Bitbucket pull request references within the repository only', () => {
    const bb = bitbucket()
    const from = repoOn(bb, 'acme', 'widgets')

    expect(read(bb, '#1, #2, acme/tools#3 and 0123456789ab', from)).toEqual([
      { text: '#1', ref: { forge: 'bitbucket', instance: 'bitbucket.org', repo: from, kind: 'pull_request', number: '1' } },
      { text: '#2', ref: { forge: 'bitbucket', instance: 'bitbucket.org', repo: from, kind: 'pull_request', number: '2' } },
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

  it('reads Tangled issues by their display number, and commits', () => {
    const tg = tangled()
    const from = repoOn(tg, 'acme.dev', 'widgets')

    expect(read(tg, '#1 and abc1234', from)).toEqual([
      { text: '#1', ref: { forge: 'tangled', instance: 'tangled.org', repo: from, kind: 'issue', displayNumber: '1' } },
      { text: 'abc1234', ref: { forge: 'tangled', instance: 'tangled.org', repo: from, sha: 'abc1234' } },
    ])
  })

  it('reads references through the aggregate with the provider of the repository', () => {
    const gl = gitlab()
    const forges = createForges([gh, gl])

    expect(forges.parseReferences('!2', { from: repoOn(gl, 'acme', 'widgets') })).toMatchObject([{ ref: { forge: 'gitlab', kind: 'pull_request' } }])
    expect(forges.parseReferences('!2', { from: ghRepo })).toEqual([])
    expect(forges.parseReferences('#2', { from: repoOn(forgejo(), 'acme', 'widgets') })).toEqual([])
  })
})
