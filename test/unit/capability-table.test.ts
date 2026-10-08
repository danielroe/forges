import type { CapabilityFlags } from '../../src/capabilities.ts'
import type { ForgeVerb, TableSpecPath } from '../../src/capability-table.ts'
import type { CapabilityEnv, ProviderSpec } from '../../src/define.ts'
import { describe, expect, it, vi } from 'vitest'
import { CAPABILITY_TABLE } from '../../src/capability-table.ts'
import { fake } from '../../src/fake/index.ts'
import { azureDevOps, bitbucket, cursorOrigin, forgejo, gitea, gitee, github, gitlab, tangled } from '../../src/index.ts'

const specs: ProviderSpec[] = []

vi.mock('../../src/capabilities.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../src/capabilities.ts')>()
  return {
    ...actual,
    capabilitiesOf: (spec: ProviderSpec, env: CapabilityEnv, flags: CapabilityFlags) => {
      specs.push(spec)
      return actual.capabilitiesOf(spec, env, flags)
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
  ['github token', () => github({ auth }).create()],
  ['github app', () => github({ auth: { type: 'app', appId: 1, privateKey: '', installationId: 1 } }).create()],
  ['github anonymous', () => github({}).create()],
  ['github read-only', () => github({ auth, readOnly: true }).create()],
  ['gitlab token', () => gitlab({ auth }).create()],
  ['gitlab anonymous', () => gitlab({}).create()],
  ['bitbucket token', () => bitbucket({ auth }).create()],
  ['forgejo token', () => forgejo({ auth }).create()],
  ['forgejo anonymous', () => forgejo({}).create()],
  ['gitea token', () => gitea({ auth }).create()],
  ['gitee token', () => gitee({ auth }).create()],
  ['azure devops token', () => azureDevOps({ auth, organization: 'acme' }).create()],
  ['cursor origin token', () => cursorOrigin({ auth }).create()],
  ['tangled app password', () => tangled({ auth: { type: 'app_password', identifier: 'handle', password: 'password' }, notificationsUrl: 'https://notifications.example' }).create()],
  ['fake', () => fake().create()],
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
  it('declares listings as their page verb and covers the iterable', () => {
    const labels = table.find(entry => entry.capability === 'repos.labels')

    expect(labels).toEqual({ capability: 'repos.labels', spec: 'repos.labelsPage', verbs: ['repos.labels', 'repos.labelsPage'] })
    expect(table.filter(entry => 'listing' in entry)).toEqual([])
  })

  it('produces every capability leaf exactly once', () => {
    const produced = table.map(entry => entry.capability)

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
    const kinds = ['issue', 'pull_request', 'discussion', 'commit'] as const

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
    const verbs: ForgeVerb[] = ['repos.labels', 'repos.labelsPage', 'threads.react', 'threads.events', 'installations.providers']
    // @ts-expect-error a capability path is not a verb
    const capability: ForgeVerb = 'writes.comment'

    expect([...verbs, capability].every(verb => table.some(entry => entry.verbs?.includes(verb)))).toBe(false)
    expect(verbs.every(verb => table.some(entry => entry.verbs?.includes(verb)))).toBe(true)
  })

  it('maps every verb to one capability', () => {
    const verbs = table.flatMap(entry => entry.verbs ?? [])

    expect(new Set(verbs).size).toBe(verbs.length)
  })

  it('builds exactly the provider methods the table names', () => {
    const verbs = table.flatMap(entry => entry.verbs ?? []).sort()
    const provider = github({ auth }).create() as unknown as Record<string, Record<string, unknown>>
    const groups = [...new Set(verbs.map(verb => verb.split('.')[0]!))]
    const methods = groups.flatMap(group => Object.entries(provider[group]!).filter(([, value]) => typeof value === 'function').map(([name]) => `${group}.${name}`))

    expect(methods.sort()).toEqual(verbs)
  })

  it('reports the support level of a verb by its provider path', () => {
    const provider = github({ auth }).create()

    expect(provider.support('threads.addLabels', 'issue')).toBe('experimental')
    expect(provider.support('threads.addLabels', 'pull_request')).toBe(true)
    expect(provider.support('threads.addLabels')).toBe(true)
    expect(provider.support('threads.addLabels', 'discussion')).toBe(false)
    expect(provider.support('repos.reviewerCandidates')).toBe('emulated')
    expect(provider.support('repos.reviewerCandidatesPage')).toBe('emulated')
    expect(github({}).create().support('ci.log')).toBe(false)
  })

  it('reports the strongest level across kinds without a kind', () => {
    const provider = github({ auth }).create()

    expect(provider.support('threads.setMilestone')).toBe('experimental')
    expect(provider.can('threads.setMilestone')).toBe(true)
  })

  it('names the problem when asked about an unknown verb', () => {
    expect(() => github({ auth }).create().can('threads.nope' as never)).toThrow('Unknown verb "threads.nope"')
  })
})
