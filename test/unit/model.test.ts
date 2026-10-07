import type { Notification, NotificationReason, NotificationRef, RepoRef, ResolvedThreadRef, ThreadRef } from '../../src/model.ts'
import type { ForgeProvider, Forges } from '../../src/provider.ts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { forgejo } from '../../src/forgejo/index.ts'
import { github } from '../../src/github/index.ts'
import * as root from '../../src/index.ts'
import * as kit from '../../src/kit.ts'
import { commentMarker, notificationKey, repoKey, threadKey } from '../../src/model.ts'
import { createForges } from '../../src/provider.ts'
import { summariseChecks } from '../../src/utils.ts'
import { sameRepo } from '../../src/web.ts'

const repo: RepoRef = { forge: 'github', instance: 'github.com', owner: 'acme', name: 'widgets' }
const ghes: RepoRef = { ...repo, instance: 'ghe.example.com' }

describe('identity keys', () => {
  it('separates the same repo on different instances', () => {
    expect(repoKey(repo)).not.toBe(repoKey(ghes))
  })

  it('always carries the repo in a thread key', () => {
    const thread: ResolvedThreadRef = { forge: 'github', instance: 'github.com', repo, kind: 'issue', number: '42' }
    const other: ResolvedThreadRef = { ...thread, repo: { ...repo, name: 'gadgets' } }

    expect(threadKey(thread)).toBe('github:github.com/acme/widgets#issue/42')
    expect(threadKey(thread)).not.toBe(threadKey(other))
  })

  it('distinguishes an issue from a pull request with the same number', () => {
    const issue: ResolvedThreadRef = { forge: 'github', instance: 'github.com', repo, kind: 'issue', number: '42' }
    expect(threadKey(issue)).not.toBe(threadKey({ ...issue, kind: 'pull_request' }))
  })

  it('keeps other subjects with the same id apart by type', () => {
    const release: ResolvedThreadRef = { forge: 'github', instance: 'github.com', repo, kind: 'other', typeRaw: 'Release', number: '7' }
    expect(threadKey(release)).not.toBe(threadKey({ ...release, typeRaw: 'CheckSuite' }))
  })

  it('only accepts resolved refs when keying', () => {
    expectTypeOf(threadKey).parameter(0).toEqualTypeOf<ResolvedThreadRef>()
  })

  it('keys on externalId when the provider set one, so renames keep the key', () => {
    const stable = { ...repo, externalId: '31337' }

    expect(repoKey(stable)).toBe('github:github.com/@31337')
    expect(repoKey({ ...stable, owner: 'renamed-org', name: 'renamed' })).toBe(repoKey(stable))
    expect(repoKey(stable)).not.toBe(repoKey({ ...stable, instance: 'ghe.example.com' }))
  })

  it('keeps a namespace id apart from a repo with the same id', () => {
    const project: RepoRef = { forge: 'gitlab', instance: 'gitlab.com', owner: 'acme', name: 'widgets', externalId: '7781' }
    const group: RepoRef = { forge: 'gitlab', instance: 'gitlab.com', kind: 'namespace', owner: 'acme', name: '', externalId: '7781' }

    expect(repoKey(project)).not.toBe(repoKey(group))
  })

  it('namespaces notification keys away from thread keys', () => {
    const ref: NotificationRef = { forge: 'github', instance: 'github.com', id: '42' }
    expect(notificationKey(ref)).toBe('github:github.com:notification/42')
  })
})

describe('root entry', () => {
  it('exports every provider factory', () => {
    const factories = ['bitbucket', 'forgejo', 'gitea', 'github', 'gitlab', 'tangled']
    expect(Object.keys(root).filter(name => factories.includes(name)).sort()).toEqual(factories)
  })

  it('exports the consumer helpers and leaves provider-authoring tools to `forges/kit`', () => {
    const authoring = ['CAPABILITY_TABLE', 'createFetcher', 'createListing', 'defineForgeProvider', 'forgeIterable', 'githubShapedWeb', 'hmacSha256Hex', 'iteratePages', 'nativeEventsFor', 'perKind', 'reactionContent', 'refEvent', 'soleMergeMethod', 'toFileContent', 'toMergeError', 'toPage', 'verb']

    expect(Object.keys(root).filter(name => authoring.includes(name))).toEqual([])
    expect(Object.keys(kit).filter(name => authoring.includes(name)).sort()).toEqual([...authoring].sort())
    expect(Object.keys(root)).toEqual(expect.arrayContaining(['AuthenticationRequiredError', 'commentMarker', 'hasCommentMarker', 'isNamespaceRef', 'NotFoundError', 'REACTION_CONTENTS']))
    expectTypeOf<root.CommitSearchQuery>().toHaveProperty('committer')
  })

  it('lets every provider factory be called without options', () => {
    for (const factory of [root.bitbucket, root.forgejo, root.gitea, root.gitee, root.github, root.gitlab, root.pushin, root.tangled]) {
      expect(factory().create().kind).toBeTypeOf('string')
    }
  })
})

describe('createForges', () => {
  it('registers providers lazily and looks them up by kind and instance', () => {
    const forges = createForges([
      github({ auth: { type: 'token', token: 't' } }),
      github({ baseUrl: 'https://ghe.example.com/api/v3', auth: { type: 'token', token: 't' } }),
      forgejo({ auth: { type: 'token', token: 't' } }),
    ])

    expect(forges.providers).toHaveLength(3)
    expect(forges.get('github')!.instance).toBe('github.com')
    expect(forges.get('github', 'ghe.example.com')!.baseUrl).toBe('https://ghe.example.com/api/v3')
    expect(forges.all('github')).toHaveLength(2)
    expect(forges.get('gitlab')).toBeUndefined()
  })

  it('yields nothing when no provider is registered', async () => {
    const forges = createForges([])
    const seen: Notification[] = []
    for await (const notification of forges.notifications.list()) {
      seen.push(notification)
    }

    expect(seen).toEqual([])
  })
})

describe('exported types', () => {
  it('models dates as Date and ids as string', () => {
    expectTypeOf<Notification['updatedAt']>().toEqualTypeOf<Date>()
    expectTypeOf<NotificationRef['id']>().toEqualTypeOf<string>()
    expectTypeOf<ThreadRef['number']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ResolvedThreadRef['number']>().toEqualTypeOf<string>()
  })

  it('keeps notification refs and thread refs structurally incompatible', () => {
    expectTypeOf<NotificationRef>().not.toMatchObjectType<ThreadRef>()
    expectTypeOf<ThreadRef>().toHaveProperty('repo')
    expectTypeOf<NotificationRef>().not.toHaveProperty('repo')
  })

  it('normalises reasons to a closed union and keeps the native string optional', () => {
    expectTypeOf<Notification['reason']>().toEqualTypeOf<NotificationReason>()
    expectTypeOf<Notification['reasonRaw']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<'unknown'>().toExtend<NotificationReason>()
  })

  it('exports merge options and file metadata from the package root', () => {
    expectTypeOf<root.MergeOptions>().toEqualTypeOf<NonNullable<Parameters<ForgeProvider['threads']['merge']>[1]>>()
    expectTypeOf<root.FileMetadata>().toEqualTypeOf<Omit<root.FileContent, 'encoding' | 'content'>>()
  })

  it('declares every verb as present on the provider surface', () => {
    expectTypeOf<ForgeProvider['threads']['comment']>().not.toBeNullable()
    expectTypeOf<ForgeProvider['notifications']['markRead']>().not.toBeNullable()
    expectTypeOf<Forges['providers']>().toEqualTypeOf<ForgeProvider[]>()
  })
})

describe('small helpers', () => {
  it('summarises checks as unknown when any state is unknown and nothing failed or runs', () => {
    expect(summariseChecks(['success', 'unknown']).state).toBe('unknown')
    expect(summariseChecks(['success', 'neutral']).state).toBe('success')
    expect(summariseChecks(['unknown', 'pending']).state).toBe('pending')
    expect(summariseChecks([]).state).toBe('unknown')
  })

  it('refuses a comment key that would end the hidden marker', () => {
    expect(() => commentMarker('a-->b')).toThrow(TypeError)
    expect(() => commentMarker('a--!>b')).toThrow(TypeError)
    expect(commentMarker('release')).toBe('<!-- forges:key=release -->')
  })

  it('compares repositories case-insensitively only where the forge does', () => {
    const tangledRepo: RepoRef = { forge: 'tangled', instance: 'tangled.org', owner: 'did:plc:abc', name: 'Core' }

    expect(sameRepo(repo, { ...repo, owner: 'ACME' })).toBe(true)
    expect(sameRepo(tangledRepo, { ...tangledRepo, name: 'core' })).toBe(false)
  })

  it('resolves a full SHA-256 commit id without a request', async () => {
    const sha = 'a'.repeat(64)
    const provider = github({ auth: { type: 'token', token: 't' }, fetch: () => Promise.reject(new Error('no request expected')) }).create()

    expect(await provider.contents.resolveRef(repo, sha.toUpperCase())).toBe(sha)
  })
})
