import type { Fixture } from '../../src/testing/index.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { differingKeys, planSplice, spliceSteps } from '../../scripts/partial-writes.ts'
import { canReplay } from '../../scripts/stabilise-recordings.ts'

const api = 'https://api.github.com/repos/bot/forges-fixtures'

function patch(issue: number): Fixture {
  return { request: { method: 'PATCH', url: `${api}/issues/${issue}`, body: { state: 'closed' } }, response: { status: 200, body: { number: issue, state: 'closed' } } }
}

describe('planning which steps of a partial write run to save', () => {
  const ancestors = new Set(['author', 'create issue', 'issue update to closed'])

  it('writes the selected steps that changed, and the steps they read from that changed', () => {
    const plan = planSplice({ selected: ['issue update to closed'], ancestors, rewritten: ['create issue', 'issue update to closed'], skipped: new Map(), steps: new Map() })

    expect(plan).toEqual({ write: ['create issue', 'issue update to closed'], extra: ['create issue'], unchanged: [], unrenamed: [] })
  })

  it('leaves selected steps whose responses are the same apart from timestamps', () => {
    const plan = planSplice({ selected: ['issue update to closed'], ancestors, rewritten: [], skipped: new Map(), steps: new Map() })

    expect(plan).toMatchObject({ write: [], unchanged: ['issue update to closed'] })
  })

  it('finds identifiers that could not be renamed in the steps it writes', () => {
    const plan = planSplice({
      selected: ['issue update to closed'],
      ancestors,
      rewritten: ['issue update to closed'],
      skipped: new Map([['86', 'pairs with 2 identifiers of the previous run'], ['91', 'pairs with 2 identifiers of the previous run']]),
      steps: new Map([['issue update to closed', [patch(86)]], ['issue comment', [patch(91)]]]),
    })

    expect(plan.unrenamed).toEqual(['issue update to closed: 86 pairs with 2 identifiers of the previous run'])
  })
})

describe('splicing steps into a recording', () => {
  const directories: string[] = []
  function recording(steps: Record<string, string>): string {
    const directory = `${mkdtempSync(join(tmpdir(), 'forges-splice-'))}/`
    directories.push(directory)
    for (const [slug, content] of Object.entries(steps)) {
      mkdirSync(`${directory}steps/${slug}`, { recursive: true })
      writeFileSync(`${directory}steps/${slug}/01-patch-issues-N.json`, content)
      writeFileSync(`${directory}steps/${slug}/golden.json`, content)
    }
    return directory
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('replaces and adds the named steps, and leaves the others', () => {
    const committed = recording({ 'create-issue': 'committed', 'issue-update': 'committed', 'issue-close': 'committed' })
    const stabilised = recording({ 'create-issue': 'stabilised', 'issue-update-to-closed': 'stabilised', 'issue-close': 'stabilised' })
    writeFileSync(`${committed}steps/create-issue/02-get-issues-N.json`, 'stale')
    spliceSteps(stabilised, committed, ['create issue', 'issue update to closed'])

    expect(['create-issue', 'issue-update-to-closed', 'issue-update', 'issue-close'].map(slug => readFileSync(`${committed}steps/${slug}/golden.json`, 'utf8'))).toEqual(['stabilised', 'stabilised', 'committed', 'committed'])
    expect(existsSync(`${committed}steps/create-issue/02-get-issues-N.json`)).toBe(false)
  })

  it('removes the steps it is told to', () => {
    const committed = recording({ 'create-issue': 'committed', 'retired-step': 'committed' })
    spliceSteps(recording({}), committed, [], ['retired step'])

    expect(existsSync(`${committed}steps/retired-step`)).toBe(false)
    expect(existsSync(`${committed}steps/create-issue`)).toBe(true)
  })
})

describe('checking whether a recording can be replayed', () => {
  it('needs vitest installed in the checkout', () => {
    const checkout = `${mkdtempSync(join(tmpdir(), 'forges-checkout-'))}/`
    try {
      expect(canReplay(checkout)).toBe(false)
      mkdirSync(`${checkout}node_modules/.bin`, { recursive: true })
      writeFileSync(`${checkout}node_modules/.bin/vitest`, '')
      expect(canReplay(checkout)).toBe(true)
    }
    finally {
      rmSync(checkout, { recursive: true, force: true })
    }
  })
})

describe('comparing manifests', () => {
  it('lists the keys whose values differ, whatever the order of their keys', () => {
    expect(differingKeys(
      { repo: { owner: 'bot', name: 'forges-fixtures' }, run: { id: '1', salt: 'a' } },
      { repo: { name: 'forges-fixtures', owner: 'bot' }, run: { id: '1', salt: 'b' }, transfer: {} },
    )).toEqual(['run', 'transfer'])
  })
})
