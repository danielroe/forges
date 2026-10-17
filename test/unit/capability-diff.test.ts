import type { RenderOptions } from '../../scripts/capability-diff.ts'
import type { CapabilitySnapshot, SnapshotProvider, SupportMap } from '../../scripts/capability-snapshot.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diffSnapshots, parseSnapshot, renderDiff, withCapabilitySection } from '../../scripts/capability-diff.ts'
import { capabilitySnapshot } from '../../scripts/capability-snapshot.ts'

function provider(slug: string, name: string, overrides: Partial<SnapshotProvider> = {}): SnapshotProvider {
  return { slug, name, experimental: false, auth: ['token', 'anonymous'], capabilities: { 'repos.get': 'native' }, anonymous: { 'repos.get': 'native' }, ...overrides }
}

function snapshot(...providers: SnapshotProvider[]): CapabilitySnapshot {
  return { version: 1, providers }
}

function render(base: CapabilitySnapshot, head: CapabilitySnapshot, options?: RenderOptions): string {
  return renderDiff(diffSnapshots(base, head), options)
}

function legend(...entries: string[]): string {
  return entries.map(entry => `<sub>${entry.replaceAll(' ', '&nbsp;')}</sub>`).join(' <sub>·</sub> ')
}

describe('capability snapshots', () => {
  it('accepts the committed baselines of releases without a snapshot script', () => {
    const directory = new URL('../../scripts/capability-baselines/', import.meta.url)
    const files = readdirSync(directory)

    expect(files).not.toEqual([])
    for (const file of files) {
      expect(parseSnapshot(readFileSync(new URL(file, directory), 'utf8')).providers.length).toBeGreaterThan(0)
    }
  })

  it('accepts the snapshot of the working tree', () => {
    const current = capabilitySnapshot()

    expect(parseSnapshot(JSON.stringify(current))).toEqual(current)
  })

  it.each([
    ['another version', { version: 2, providers: [] }],
    ['an unknown level', snapshot(provider('github', 'GitHub', { capabilities: { 'repos.get': 'yes' as never } }))],
    ['Markdown in a capability', snapshot(provider('github', 'GitHub', { capabilities: { 'repos.get`<img>': 'native' } }))],
    ['Markdown in a name', snapshot(provider('github', '[GitHub](https://example.com)'))],
    ['a prototype key', JSON.parse('{"version":1,"providers":[{"slug":"github","name":"GitHub","experimental":false,"auth":[],"capabilities":{"__proto__":"native"},"anonymous":{}}]}')],
    ['two providers with one slug', snapshot(provider('github', 'GitHub'), provider('github', 'GitHub'))],
    ['Markdown in a credential label', snapshot(provider('github', 'GitHub', { credentials: [{ id: 'app', label: '[App](https://example.com)', capabilities: {} }] }))],
    ['two credentials with one id', snapshot(provider('github', 'GitHub', { credentials: [{ id: 'app', label: 'App', capabilities: {} }, { id: 'app', label: 'App', capabilities: {} }] }))],
  ])('rejects %s', (_, value) => {
    expect(() => parseSnapshot(JSON.stringify(value))).toThrow(/Invalid capability snapshot/)
  })
})

describe('capability diff', () => {
  it('renders nothing when nothing changed', () => {
    expect(render(snapshot(provider('github', 'GitHub')), snapshot(provider('github', 'GitHub')))).toBe('')
  })

  it('draws a row per changed capability with a column per provider, in order of impact', () => {
    const base = provider('tangled', 'Tangled', {
      capabilities: { 'repos.get': 'native', 'repos.labels': 'none', 'threads.react:issue': 'none', 'threads.react:pull_request': 'none', 'threads.merge': 'unverified', 'users.me': 'native' },
      anonymous: { 'repos.get': 'native', 'repos.labels': 'none', 'contents.getFile': 'none' },
    })
    const head = provider('tangled', 'Tangled', {
      capabilities: { 'repos.get': 'native', 'repos.labels': 'native', 'threads.react:issue': 'native', 'threads.react:pull_request': 'native', 'threads.merge': 'native', 'users.me': 'none' },
      anonymous: { 'repos.get': 'unverified', 'repos.labels': 'native', 'contents.getFile': 'native' },
    })
    const gitlab = provider('gitlab', 'GitLab', {
      capabilities: { 'repos.get': 'native', 'repos.labels': 'native', 'threads.merge': 'native', 'users.me': 'native' },
      anonymous: { 'repos.get': 'native', 'repos.labels': 'native' },
    })

    expect(render(snapshot(base, gitlab), snapshot(head, gitlab))).toBe([
      '### Capability changes',
      '',
      '🟩 **5** gained · 🟥 **2** removed or downgraded · ✨ **2** now on every provider',
      '',
      '| | Tangled | GitLab |',
      '| --- | :-: | :-: |',
      '| `users.me` | 🟥 | 🟦 |',
      '| `repos.labels` 🔓 | 🟩 | 🟦 |',
      '| `threads.merge` | 🟩 | 🟦 |',
      '| `threads.react` (issue, PR) | 🟩 | ⬜ |',
      '',
      '<details open><summary>Without credentials, where that differs</summary>',
      '',
      '| | Tangled | GitLab |',
      '| --- | :-: | :-: |',
      '| `repos.get` | 🟥 | 🟦 |',
      '| `contents.getFile` | 🟩 | ⬜ |',
      '',
      '</details>',
      '',
      '<details><summary>In detail</summary>',
      '',
      '**Tangled**',
      '',
      '- ✅ → ❔ `repos.get` without credentials ⚠️',
      '- ✅ → ❌ `users.me` ⚠️',
      '- ❌ → ✅ `repos.labels`, also without credentials',
      '- ❔ → ✅ `threads.merge`',
      '- ❌ → ✅ `threads.react` (issue, PR)',
      '- ❌ → ✅ `contents.getFile` without credentials',
      '',
      '</details>',
      '',
      legend('🟦 verified', '🟩 newly verified', '🟥 no longer verified', '⬜ not verified', '🔓 same without credentials'),
      '',
      legend('✅ native', '❔ unverified', '❌ not available'),
    ].join('\n'))
  })

  it('accepts `not_applicable`, and does not call reclassifying `none` to it a regression', () => {
    const base = provider('github', 'GitHub', { capabilities: { 'releases.get': 'none' } })
    const head = provider('github', 'GitHub', { capabilities: { 'releases.get': 'not_applicable' } })
    const output = render(snapshot(base), snapshot(head))

    expect(parseSnapshot(JSON.stringify(snapshot(head)))).toEqual(snapshot(head))
    expect(output).toContain('| `releases.get` | 🟨 |')
    expect(output).toContain('- ❌ → ∅ `releases.get`')
    expect(output).not.toContain('removed or downgraded')
    expect(output).toContain(legend('∅ not applicable'))
  })

  it('treats a drop to `not_applicable` from an available level as a regression', () => {
    const base = provider('github', 'GitHub', { capabilities: { 'releases.get': 'native' } })
    const head = provider('github', 'GitHub', { capabilities: { 'releases.get': 'not_applicable' } })
    const output = render(snapshot(base), snapshot(head))

    expect(output).toContain('🟥 **1** removed or downgraded')
    expect(output).toContain('- ✅ → ∅ `releases.get` ⚠️')
  })

  it('names the providers per capability when three or more change', () => {
    const before = (slug: string, name: string) => provider(slug, name, { capabilities: { 'releases.create': 'none' } })
    const after = (slug: string, name: string, level: 'native' | 'emulated') => provider(slug, name, { capabilities: { 'releases.create': level } })

    expect(render(
      snapshot(before('github', 'GitHub'), before('gitlab', 'GitLab'), before('gitea', 'Gitea'), provider('pushin', 'Pushin.eu')),
      snapshot(after('github', 'GitHub', 'native'), after('gitlab', 'GitLab', 'native'), after('gitea', 'Gitea', 'emulated'), provider('pushin', 'Pushin.eu', { experimental: true })),
    )).toBe([
      '### Capability changes',
      '',
      '🟩 **3** gained',
      '',
      '| | GitHub | GitLab | Gitea | Pushin.eu |',
      '| --- | :-: | :-: | :-: | :-: |',
      '| `releases.create` | 🟩 | 🟩 | 🟩 | ⬜ |',
      '',
      '<details><summary>In detail</summary>',
      '',
      '- **Pushin.eu**: Now marked experimental',
      '',
      '- `releases.create`: ❌ → ✅ GitHub, GitLab; ❌ → 🧩 Gitea',
      '',
      '</details>',
      '',
      legend('🟩 newly verified', '⬜ not verified'),
      '',
      legend('✅ native', '🧩 emulated', '❌ not available'),
    ].join('\n'))
  })

  it.each([7, 6, 2, 0])('shows which providers already had a capability that three gain when %i did', (had) => {
    const providers = (gained: boolean) => Array.from({ length: 10 }, (_, index) => provider(`p${index}`, `P${index}`, {
      capabilities: { 'releases.create': index >= 7 - had && (index < 7 || gained) ? 'native' : 'none' },
    }))
    const output = render(snapshot(...providers(false)), snapshot(...providers(true)))
    const cells = [...Array.from({ length: 7 - had }).fill('⬜'), ...Array.from({ length: had }).fill('🟦'), '🟩', '🟩', '🟩']

    expect(output).toContain(`| \`releases.create\` | ${cells.join(' | ')} |`)
    expect(output.includes('✨ **1** now on every provider')).toBe(had === 7)
  })

  it('puts capabilities that reach every provider before those new to all of them', () => {
    const providers = (gained: boolean) => Array.from({ length: 3 }, (_, index) => provider(`p${index}`, `P${index}`, {
      capabilities: { 'releases.create': gained && index < 2 ? 'native' : 'none', 'releases.update': index === 0 || gained ? 'native' : 'none' },
    }))
    const rows = render(snapshot(...providers(false)), snapshot(...providers(true))).split('\n').filter(line => line.startsWith('| `'))

    expect(rows).toEqual([
      '| `releases.update` | 🟦 | 🟩 | 🟩 |',
      '| `releases.create` | 🟩 | 🟩 | ⬜ |',
    ])
  })

  it('heads columns with provider logos, named in alt text and linked to their docs, where a logo exists', () => {
    const base = snapshot(provider('github', 'GitHub', { capabilities: { 'ci.getJob': 'none' } }), provider('gitee', 'Gitee', { capabilities: { 'ci.getJob': 'none' } }))
    const head = snapshot(provider('github', 'GitHub', { capabilities: { 'ci.getJob': 'native' } }), provider('gitee', 'Gitee', { capabilities: { 'ci.getJob': 'native' } }))

    expect(render(base, head, { icon: slug => slug === 'github' ? 'https://example.com/github.svg' : undefined })).toContain([
      '| | <a href="https://forges.link/providers/github"><img src="https://example.com/github.svg" alt="GitHub" title="GitHub" width="16" height="16"></a> | Gitee |',
      '| --- | :-: | :-: |',
      '| `ci.getJob` | 🟩 | 🟩 |',
    ].join('\n'))
  })

  it('shares a row between capabilities of one namespace that changed alike', () => {
    const providers = (gained: boolean) => Array.from({ length: 3 }, (_, index) => provider(`p${index}`, `P${index}`, {
      capabilities: { 'threads.react:issue': index === 0 || gained ? 'native' : 'none', 'threads.react:pull_request': index === 0 || gained ? 'native' : 'none', 'threads.merge': index === 0 || gained ? 'native' : 'none', 'repos.labels': index === 0 || gained ? 'native' : 'none' },
    }))
    const rows = render(snapshot(...providers(false)), snapshot(...providers(true))).split('\n').filter(line => line.startsWith('| `'))

    expect(rows).toEqual([
      '| `threads` react (issue, PR), merge | 🟦 | 🟩 | 🟩 |',
      '| `repos.labels` | 🟦 | 🟩 | 🟩 |',
    ])
  })

  it('opens the capabilities without credentials when one of them regresses', () => {
    const providers = (lost: boolean) => [
      provider('github', 'GitHub', { capabilities: { 'commits.list': 'native' }, anonymous: { 'commits.list': lost ? 'unverified' : 'native' } }),
      provider('gitlab', 'GitLab', { capabilities: { 'commits.list': 'native' }, anonymous: { 'commits.list': 'native' } }),
    ]

    expect(render(snapshot(...providers(false)), snapshot(...providers(true)))).toContain([
      '<details open><summary>Without credentials, where that differs</summary>',
      '',
      '| | GitHub | GitLab |',
      '| --- | :-: | :-: |',
      '| `commits.list` | 🟥 | 🟦 |',
    ].join('\n'))
  })

  it('puts capabilities on more providers first among those catching up', () => {
    const providers = (gained: boolean) => Array.from({ length: 4 }, (_, index) => provider(`p${index}`, `P${index}`, {
      capabilities: { 'releases.create': index === 0 || (gained && index === 1) ? 'native' : 'none', 'releases.update': index < 2 || (gained && index === 2) ? 'native' : 'none' },
    }))
    const rows = render(snapshot(...providers(false)), snapshot(...providers(true))).split('\n').filter(line => line.startsWith('| `'))

    expect(rows).toEqual([
      '| `releases.update` | 🟦 | 🟦 | 🟩 | ⬜ |',
      '| `releases.create` | 🟦 | 🟩 | ⬜ | ⬜ |',
    ])
  })

  it('notes new and removed providers and auth kinds', () => {
    const base = snapshot(provider('github', 'GitHub'), provider('gitee', 'Gitee'))
    const head = snapshot(provider('github', 'GitHub', { auth: ['token', 'app'] }), provider('tangled', 'Tangled'))

    expect(render(base, head)).toBe([
      '### Capability changes',
      '',
      '🟥 **2** removed or downgraded',
      '',
      '| | GitHub | Tangled |',
      '| --- | :-: | :-: |',
      '| `repos.get` 🔓 | 🟦 | 🟩 |',
      '',
      '<details><summary>In detail</summary>',
      '',
      '**GitHub**',
      '',
      '- Signs in with `app`',
      '- No longer signs in with `anonymous` ⚠️',
      '',
      '**Tangled**',
      '',
      '- New provider, with 1 verified capability',
      '',
      '**Gitee**',
      '',
      '- Provider removed ⚠️',
      '',
      '</details>',
      '',
      legend('🟦 verified', '🟩 newly verified', '🟥 no longer verified', '🔓 same without credentials'),
    ].join('\n'))
  })

  it('lists changes that apply to some kinds of credential only, in the order of the credentials', () => {
    const github = (narrowed: boolean) => provider('github', 'GitHub', {
      capabilities: { 'notifications.list': 'native', 'repos.get': 'native', 'installations.list': 'native' },
      credentials: [
        { id: 'classic', label: 'Classic token', capabilities: { 'notifications.list': 'native', 'repos.get': 'native', 'installations.list': narrowed ? 'none' : 'native' } },
        { id: 'fine-grained', label: 'Fine-grained token', capabilities: { 'notifications.list': narrowed ? 'none' : 'native', 'repos.get': 'native', 'installations.list': narrowed ? 'none' : 'native' } },
      ],
    })
    const output = render(snapshot(github(false), provider('gitlab', 'GitLab')), snapshot(github(true), provider('gitlab', 'GitLab')))

    expect(output).toBe([
      '### Capability changes',
      '',
      '🔑 **2** changed for some kinds of credential',
      '',
      '<details open><summary>With some kinds of credential, where that differs</summary>',
      '',
      '**GitHub**',
      '',
      '- `classic` (Classic token): ✅ → ❌ `installations.list` ⚠️',
      '- `fine-grained` (Fine-grained token): ✅ → ❌ `notifications.list`, `installations.list` ⚠️',
      '',
      '</details>',
      '',
      legend('✅ native', '❌ not available'),
    ].join('\n'))
  })

  it('compares a kind of credential with the provider\'s support where a snapshot does not tell them apart', () => {
    const base = provider('github', 'GitHub', { capabilities: { 'notifications.list': 'native', 'repos.get': 'native' } })
    const head = provider('github', 'GitHub', {
      capabilities: { 'notifications.list': 'native', 'repos.get': 'native' },
      credentials: [
        { id: 'classic', label: 'Classic token', capabilities: { 'notifications.list': 'native', 'repos.get': 'native' } },
        { id: 'app', label: 'App', capabilities: { 'notifications.list': 'none', 'repos.get': 'none' } },
      ],
    })

    expect(render(snapshot(base), snapshot(head))).toContain('- `app` (App): ✅ → ❌ `notifications.list`, `repos.get` ⚠️')
  })

  it('leaves out kinds of credential whose support changed as the provider\'s did, and counts long lists', () => {
    const many = (level: 'native' | 'none') => Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`repos.c${index}`, level])) as SupportMap
    const github = (gained: boolean) => provider('github', 'GitHub', {
      capabilities: { ...many('native'), 'releases.create': gained ? 'native' : 'none' },
      credentials: [
        { id: 'classic', label: 'Classic token', capabilities: { ...many('native'), 'releases.create': gained ? 'native' : 'none' } },
        { id: 'app', label: 'App', capabilities: { ...many(gained ? 'none' : 'native'), 'releases.create': gained ? 'native' : 'none' } },
      ],
    })
    const output = render(snapshot(github(false)), snapshot(github(true)))

    expect(output).toContain('- `app` (App): ✅ → ❌ 13 capabilities ⚠️')
    expect(output).not.toContain('`releases.create` ⚠️')
    expect(output).toContain('- ❌ → ✅ `releases.create`')
  })

  it('treats a capability missing from one snapshot as not available', () => {
    const head = snapshot(provider('github', 'GitHub', { capabilities: Object.fromEntries([['repos.get', 'native'], ['toString', 'native']]) as SupportMap }))

    expect(render(snapshot(provider('github', 'GitHub')), head)).toContain('- ❌ → ✅ `toString`')
  })

  it('charts the verified capabilities each provider gained and lost', () => {
    const base = snapshot(
      provider('github', 'GitHub', { capabilities: { a: 'native', b: 'none', c: 'none', d: 'native', e: 'unverified' } }),
      provider('gitlab', 'GitLab', { capabilities: { a: 'none', b: 'none' } }),
    )
    const head = snapshot(
      provider('github', 'GitHub', { capabilities: { a: 'native', b: 'native', c: 'emulated', d: 'none', e: 'native' } }),
      provider('gitlab', 'GitLab', { capabilities: { a: 'native', b: 'unverified' } }),
    )

    expect(render(base, head, { coverage: true })).toContain([
      '| Provider | Lost | Gained | Verified |',
      '| --- | ---: | :--- | ---: |',
      '| GitHub | -1 🟥 | 🟩🟩🟩 +3 | 2 → 4 |',
      '| GitLab |  | 🟩 +1 | 0 → 1 |',
      '',
      '<sub>Verified capabilities with credentials: native, experimental or emulated.</sub>',
    ].join('\n'))
  })

  it('scales the chart to the largest change', () => {
    const many = (level: 'native' | 'none') => Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`c${index}`, level])) as SupportMap
    const base = snapshot(provider('github', 'GitHub', { capabilities: many('none') }), provider('gitlab', 'GitLab', { capabilities: { a: 'none' } }))
    const head = snapshot(provider('github', 'GitHub', { capabilities: many('native') }), provider('gitlab', 'GitLab', { capabilities: { a: 'native' } }))
    const chart = render(base, head, { coverage: true })

    expect(chart).toContain(`| GitHub | ${'🟩'.repeat(9)} +25 | 0 → 25 |`)
    expect(chart).toContain('| GitLab | 🟩 +1 | 0 → 1 |')
    expect(chart).toContain('Each square stands for up to 3.')
  })
})

describe('capability section of a pull request body', () => {
  const section = '### Capability changes'

  it('appends the section to a body without one', () => {
    expect(withCapabilitySection('Fixes #1.\n', section)).toBe('Fixes #1.\n\n<!-- forges:capabilities:start -->\n### Capability changes\n<!-- forges:capabilities:end -->')
  })

  it('replaces the section where the author left it', () => {
    const body = 'Fixes #1.\r\n\r\n<!-- forges:capabilities:start -->\nold\n<!-- forges:capabilities:end -->\r\n\r\nNotes.'

    expect(withCapabilitySection(body, section)).toBe('Fixes #1.\n\n<!-- forges:capabilities:start -->\n### Capability changes\n<!-- forges:capabilities:end -->\n\nNotes.')
  })

  it('leaves markers quoted within a line alone', () => {
    const body = 'Mentions `<!-- forges:capabilities:start -->` and `<!-- forges:capabilities:end -->`.'

    expect(withCapabilitySection(body, '')).toBe(body)
    expect(withCapabilitySection(body, section)).toBe(`${body}\n\n<!-- forges:capabilities:start -->\n### Capability changes\n<!-- forges:capabilities:end -->`)
  })

  it('adds a new section above the anchor line, and replaces it in place after', () => {
    const release = '> v0.2.0 is the next minor release.\n\n## 👉 Changelog\n\n- feat: something'
    const added = withCapabilitySection(release, section, '## 👉 ')

    expect(added).toBe('> v0.2.0 is the next minor release.\n\n<!-- forges:capabilities:start -->\n### Capability changes\n<!-- forges:capabilities:end -->\n\n## 👉 Changelog\n\n- feat: something')
    expect(withCapabilitySection(`${added}\n\n## 👉 Other`, '### Newer', '## 👉 ')).toBe(`${added.replace(section, '### Newer')}\n\n## 👉 Other`)
  })

  it('appends a new section when no line starts with the anchor', () => {
    expect(withCapabilitySection('Mentions ## 👉 inline.', section, '## 👉 ')).toBe('Mentions ## 👉 inline.\n\n<!-- forges:capabilities:start -->\n### Capability changes\n<!-- forges:capabilities:end -->')
  })

  it('removes the section once nothing changes', () => {
    const body = 'Fixes #1.\n\n<!-- forges:capabilities:start -->\nold\n<!-- forges:capabilities:end -->\n'

    expect(withCapabilitySection(body, '')).toBe('Fixes #1.')
  })
})
