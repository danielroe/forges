import { describe, expect, it } from 'vitest'
import { translateBitbucketWebhook } from '../../src/bitbucket/events.ts'
import { completeEvent } from '../../src/events.ts'
import { translateForgejoWebhook } from '../../src/forgejo/events.ts'
import { toFeedEvent as toForgejoFeedEvent } from '../../src/forgejo/feed.ts'
import { translateGitHubWebhook } from '../../src/github/events.ts'
import { translateGitLabWebhook } from '../../src/gitlab/events.ts'

function github(event: string, payload: Record<string, unknown>) {
  return translateGitHubWebhook('github.com', {
    headers: { 'x-github-event': event, 'x-github-delivery': 'd' },
    body: JSON.stringify({ repository: { id: 1, name: 'widgets', full_name: 'acme/widgets' }, sender: { login: 'ada', id: 2 }, ...payload }),
  }).map(completeEvent)
}

describe('star, fork, wiki and release events', () => {
  it('reads every GitHub release action as a release', () => {
    const [edited] = github('release', { action: 'edited', release: { id: 7, tag_name: 'v1.0.0', name: 'One', body: 'Notes', prerelease: true, draft: false, html_url: 'https://github.com/acme/widgets/releases/tag/v1.0.0' } })
    const [released] = github('release', { action: 'released', release: { id: 7, tag_name: 'v1.0.0' } })

    expect(edited).toMatchObject({
      kind: 'release',
      action: 'edited',
      detail: { type: 'release', release: { id: '7', tag: 'v1.0.0' }, tag: 'v1.0.0', name: 'One', body: 'Notes', isPrerelease: true, isDraft: false, url: 'https://github.com/acme/widgets/releases/tag/v1.0.0' },
    })
    expect(edited!.undated).toBe(true)
    expect(released).toMatchObject({ kind: 'release', action: 'other', actionRaw: 'released' })
  })

  it('reads GitHub stars, forks and visibility changes', () => {
    const [star] = github('star', { action: 'deleted', starred_at: null })
    const [fork] = github('fork', { forkee: { id: 3, name: 'widgets', full_name: 'ada/widgets', owner: { login: 'ada' }, created_at: '2026-05-01T10:00:00Z' } })
    const [hidden] = github('repository', { action: 'privatized', repository: { id: 1, name: 'widgets', full_name: 'acme/widgets', updated_at: '2026-05-02T10:00:00Z' } })

    expect(star).toMatchObject({ kind: 'star', action: 'deleted', undated: true })
    expect(fork).toMatchObject({ kind: 'fork', action: 'created', repo: { owner: 'acme' }, detail: { type: 'fork', fork: { owner: 'ada', name: 'widgets' } }, occurredAt: new Date('2026-05-01T10:00:00Z') })
    expect(hidden).toMatchObject({ kind: 'repo', action: 'edited', detail: { type: 'repo_visibility', isPublic: false }, occurredAt: new Date('2026-05-02T10:00:00Z') })
  })

  it('splits a GitHub wiki delivery into one event per page', () => {
    const events = github('gollum', { pages: [{ title: 'Home', action: 'created' }, { title: 'FAQ', action: 'edited' }] })

    expect(events.map(event => [event.id, event.kind, event.action, event.actionRaw, event.detail])).toEqual([
      ['d:0', 'wiki', 'created', 'created', { type: 'wiki', title: 'Home', url: undefined }],
      ['d:1', 'wiki', 'edited', 'edited', { type: 'wiki', title: 'FAQ', url: undefined }],
    ])
  })

  it('puts a Forgejo fork on the repository that was forked', () => {
    const [fork] = translateForgejoWebhook({ forge: 'forgejo', instance: 'codeberg.org' }, {
      headers: { 'x-forgejo-event': 'fork', 'x-forgejo-delivery': 'd' },
      body: JSON.stringify({ forkee: { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } }, repository: { id: 2, name: 'widgets', full_name: 'ada/widgets', owner: { login: 'ada' }, created_at: '2026-05-01T10:00:00Z' }, sender: { login: 'ada', id: 3 } }),
    })

    expect(fork).toMatchObject({ kind: 'fork', repo: { owner: 'acme' }, detail: { type: 'fork', fork: { owner: 'ada' } }, occurredAt: new Date('2026-05-01T10:00:00Z') })
  })

  it('reads a Bitbucket fork', () => {
    const [fork] = translateBitbucketWebhook('bitbucket.org', {
      headers: { 'x-event-key': 'repo:fork' },
      body: JSON.stringify({ repository: { full_name: 'acme/widgets', name: 'widgets' }, fork: { full_name: 'ada/widgets', name: 'widgets' } }),
    })

    expect(fork).toMatchObject({ kind: 'fork', action: 'created', repo: { owner: 'acme' }, detail: { type: 'fork', fork: { owner: 'ada', name: 'widgets' } }, undated: true })
  })

  it('dates a GitLab release by its creation only when it is created', () => {
    const [created, updated] = ['create', 'update'].map(action => translateGitLabWebhook('gitlab.com', {
      headers: { 'x-gitlab-event': 'Release Hook' },
      body: JSON.stringify({ object_kind: 'release', action, id: 3, tag: 'v1.0.0', description: '', created_at: '2026-05-01 10:00:00 UTC', project: { id: 1, path_with_namespace: 'acme/widgets' } }),
    })[0])

    expect(created).toMatchObject({ kind: 'release', action: 'published', detail: { body: '' }, occurredAt: new Date('2026-05-01T10:00:00Z') })
    expect(updated).toMatchObject({ kind: 'release', action: 'edited', undated: true })
  })

  it('reads a GitLab wiki page event', () => {
    const [page] = translateGitLabWebhook('gitlab.com', {
      headers: { 'x-gitlab-event': 'Wiki Page Hook' },
      body: JSON.stringify({ object_kind: 'wiki_page', project: { id: 1, path_with_namespace: 'acme/widgets' }, object_attributes: { title: 'Home', url: 'https://gitlab.com/acme/widgets/-/wikis/home', action: 'update' } }),
    })

    expect(page).toMatchObject({ kind: 'wiki', action: 'edited', detail: { type: 'wiki', title: 'Home', url: 'https://gitlab.com/acme/widgets/-/wikis/home' } })
  })

  it('reads the tag of a Forgejo feed release, which names no release id', () => {
    const event = toForgejoFeedEvent({ forge: 'forgejo', instance: 'codeberg.org' }, { id: 1, op_type: 'publish_release', ref_name: 'refs/tags/v1.2.0', content: 'Faster parsing', created: '2026-01-02T03:04:05Z' })

    expect(event).toMatchObject({ kind: 'release', action: 'published', detail: { type: 'release', tag: 'v1.2.0', name: 'Faster parsing' } })
    expect(event.detail).not.toHaveProperty('release')
  })
})
