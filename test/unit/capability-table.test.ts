import type { CapabilityFlags } from '../../src/capabilities.ts'
import type { ForgeVerb, TableSpecPath } from '../../src/capability-table.ts'
import type { CapabilityEnv, ProviderSpec } from '../../src/define.ts'
import { describe, expect, it, vi } from 'vitest'
import { declaredCapabilities } from '../../src/capabilities.ts'
import { CAPABILITY_TABLE } from '../../src/capability-table.ts'
import { fake } from '../../src/fake/index.ts'
import { azureDevOps, bitbucket, cursorOrigin, forgejo, gitea, gitee, github, gitlab, tangled } from '../../src/index.ts'

const specs: ProviderSpec[] = []

vi.mock('../../src/capabilities.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../src/capabilities.ts')>()
  return {
    ...actual,
    capabilitiesOf: (spec: ProviderSpec, env: CapabilityEnv, flags: CapabilityFlags, declared?: boolean) => {
      specs.push(spec)
      return actual.capabilitiesOf(spec, env, flags, declared)
    },
  }
})

const table = CAPABILITY_TABLE

/** Dotted paths to every `Verb` or `KindVerb` field of {@link ProviderSpec}. */
type SpecPath<T> = {
  [K in keyof T & string]: NonNullable<T[K]> extends { run: unknown }
    ? K
    : NonNullable<T[K]> extends object ? `${K}.${SpecPath<NonNullable<T[K]>>}` : never
}[keyof T & string]

type TablePath = TableSpecPath

/** A `ProviderSpec` verb with no table entry; the type is `never` while the table is complete. */
type Uncovered = Exclude<SpecPath<ProviderSpec>, TablePath>

const auth = { type: 'token', token: 'token' } as const

const providers = [
  ['github token', () => github({ auth })],
  ['github app', () => github({ auth: { type: 'app', appId: 1, privateKey: '', installationId: 1 } })],
  ['github anonymous', () => github({})],
  ['github read-only', () => github({ auth, readOnly: true })],
  ['gitlab token', () => gitlab({ auth })],
  ['gitlab anonymous', () => gitlab({})],
  ['bitbucket token', () => bitbucket({ auth })],
  ['forgejo token', () => forgejo({ auth })],
  ['forgejo anonymous', () => forgejo({})],
  ['gitea token', () => gitea({ auth })],
  ['gitee token', () => gitee({ auth })],
  ['azure devops token', () => azureDevOps({ auth, organization: 'acme' })],
  ['cursor origin token', () => cursorOrigin({ auth })],
  ['tangled app password', () => tangled({ auth: { type: 'app_password', identifier: 'handle', password: 'password' }, notificationsUrl: 'https://notifications.example' })],
  ['fake', () => fake()],
] as const

const KIND_KEYS = new Set(['issue', 'pull_request', 'discussion', 'commit', 'dependency', 'code_scanning', 'secret', 'advisory'])

/** Leaf paths of a capability object; a record keyed by thread or alert kind is itself a leaf. */
function capabilityLeaves(value: unknown, prefix = ''): string[] {
  const isGroup = Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && !Object.keys(value as object).every(key => KIND_KEYS.has(key))
  return isGroup
    ? Object.keys(value as object).flatMap(key => capabilityLeaves((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key))
    : [prefix]
}

/** Paths of every `verb()` or `perKind()` declaration in a spec. */
function specVerbs(spec: unknown, prefix = ''): string[] {
  if (!spec || typeof spec !== 'object') {
    return []
  }
  if ('run' in spec && ('support' in spec || 'kinds' in spec)) {
    return [prefix]
  }
  return Object.entries(spec).flatMap(([key, value]) => specVerbs(value, prefix ? `${prefix}.${key}` : key))
}

const declared = new Set(providers.flatMap(([, create]) => {
  specs.length = 0
  create()
  return specs.flatMap(spec => specVerbs(spec))
}))

describe('capability table', () => {
  it('declares listings as their page verb', () => {
    const labels = table.find(entry => entry.capability === 'repos.labels')

    expect(labels).toEqual({ capability: 'repos.labels', spec: 'repos.labelsPage', verbs: ['repos.labels'], listings: ['repos.labels'] })
    expect(table.filter(entry => 'listing' in entry)).toEqual([])
  })

  it('produces every capability leaf exactly once', () => {
    const produced = table.flatMap(entry => entry.verbs?.length ? entry.verbs : [entry.capability])

    expect(new Set(produced).size).toBe(produced.length)
    for (const [name, create] of providers) {
      const leaves = new Set(capabilityLeaves(create().capabilities)
        .filter(path => path !== 'version')
        .map(path => path.replace(/^limits\..*/, 'limits')))
      const expected = produced.filter(path => path !== 'experimental' && path !== 'limits' ? true : leaves.has(path))
      expect([name, [...leaves].sort()]).toEqual([name, expected.sort()])
    }
  })

  it('reads every declared verb exactly once', () => {
    const paths = table.flatMap(entry => entry.spec ?? [])

    expect(new Set(paths).size).toBe(paths.length)
    expect([...declared].sort()).toEqual([...declared].filter(path => paths.includes(path)).sort())
  })

  it('reads thread events for every kind a signed-in provider reads threads of', () => {
    const kinds = ['issue', 'pull_request', 'discussion'] as const

    for (const [name, create] of providers.filter(([name]) => name.endsWith('token'))) {
      const provider = create()
      expect([name, kinds.map(kind => provider.can('threads.events', kind))]).toEqual([name, kinds.map(kind => provider.can('threads.get', kind))])
    }
  })

  it('has an entry for every verb ProviderSpec declares', () => {
    const uncovered: Uncovered[] = []

    expect(uncovered).toEqual([])
  })

  it('types verbs from the table, including the derived ones', () => {
    const verbs: ForgeVerb[] = ['repos.labels', 'repos.labels', 'threads.react', 'threads.events', 'installations.providers']
    // @ts-expect-error a capability group is not a verb
    const capability: ForgeVerb = 'writes.createComment'

    expect([...verbs, capability].every(verb => table.some(entry => entry.verbs?.includes(verb)))).toBe(false)
    expect(verbs.every(verb => table.some(entry => entry.verbs?.includes(verb)))).toBe(true)
  })

  it('maps every verb to one capability', () => {
    const verbs = table.flatMap(entry => entry.verbs ?? [])

    expect(new Set(verbs).size).toBe(verbs.length)
  })

  it('builds exactly the provider methods the table names', () => {
    const verbs = table.flatMap(entry => entry.verbs ?? []).sort()
    const provider = github({ auth }) as unknown as Record<string, Record<string, unknown>>
    const groups = [...new Set(verbs.map(verb => verb.split('.')[0]!))]
    const methods = groups.flatMap(group => Object.entries(provider[group]!).filter(([, value]) => typeof value === 'function').map(([name]) => `${group}.${name}`))

    expect(methods.sort()).toEqual(verbs)
  })

  it('reports the support level of a verb by its provider path', () => {
    const provider = azureDevOps({ auth, organization: 'acme' })

    expect(provider.support('threads.createComment', 'issue')).toBe(true)
    expect(provider.support('threads.createComment', 'pull_request')).toBe(true)
    expect(provider.support('threads.createComment')).toBe(true)
    expect(provider.support('threads.createComment', 'discussion')).toBe(false)
    expect(github({ auth }).support('repos.reviewerCandidates')).toBe('emulated')
    expect(github({ auth }).support('repos.reviewerCandidates')).toBe('emulated')
    expect(gitee({ auth }).support('threads.createComment', 'issue')).toBe(true)
    expect(github({}).support('ci.log')).toBe(false)
  })

  it('reports a capability the forge lacks as `not_applicable`, and rejects it', async () => {
    const provider = bitbucket({ auth })
    expect(provider.support('releases.list')).toBe('not_applicable')
    expect(provider.capabilities.notifications.list).toBe('not_applicable')
    expect(provider.can('releases.list')).toBe(false)
    expect(bitbucket({}).support('releases.list')).toBe('not_applicable')
    await expect(provider.releases.list({ forge: 'bitbucket', instance: 'bitbucket.org', owner: 'acme', name: 'widgets' }).page()).rejects.toThrow('bitbucket has no releases.list')

    // A per-kind capability the forge lacks is `not_applicable` for every kind.
    const tangledProvider = tangled({ auth: { type: 'app_password', identifier: 'h', password: 'p' }, notificationsUrl: 'https://notifications.example' })
    expect(tangledProvider.capabilities.threads.checks).toEqual({ issue: 'not_applicable', pull_request: 'not_applicable', discussion: 'not_applicable' })

    // Derived capabilities (`threads.getReview`, `threads.approve`) inherit `not_applicable` from their parts.
    expect(tangledProvider.support('threads.getReview')).toBe('not_applicable')
    expect(tangledProvider.support('threads.approve')).toBe('not_applicable')
  })

  it('reports experimental and unverified declarations as true, and keeps them in the declared capabilities', () => {
    const azure = azureDevOps({ auth, organization: 'acme' })
    const giteeProvider = gitee({ auth })

    expect(azure.capabilities.threads.createComment.issue).toBe(true)
    expect(declaredCapabilities(azure).threads.createComment).toMatchObject({ issue: 'experimental', pull_request: true })
    expect(giteeProvider.capabilities.threads.createComment.issue).toBe(true)
    expect(declaredCapabilities(giteeProvider).threads.createComment.issue).toBe('unverified')
  })

  it('emulates a single-item read from its listing, at the level the spec sets', () => {
    expect(bitbucket({ auth }).support('threads.getComment', 'pull_request')).toBe('emulated')
    expect(bitbucket({}).support('threads.getComment', 'pull_request')).toBe('emulated')
    expect(declaredCapabilities(bitbucket({})).threads.getComment.pull_request).toBe('unverified')
    expect(bitbucket({ auth }).support('threads.getComment', 'issue')).toBe(false)
    expect(github({ auth }).support('threads.getComment', 'issue')).toBe(true)
  })

  it('reports the strongest level across kinds without a kind', () => {
    expect(gitee({ auth }).support('threads.createComment')).toBe(true)
    expect(bitbucket({ auth }).support('threads.getComment')).toBe('emulated')
    expect(gitee({ auth }).can('threads.updateComment')).toBe(true)
  })

  it('names the problem when asked about an unknown verb', () => {
    expect(() => github({ auth }).can('threads.nope' as never)).toThrow('Unknown verb "threads.nope"')
  })
})
