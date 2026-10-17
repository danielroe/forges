import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBundleSnapshot } from '../../scripts/bundle-size-diff.ts'

const script = fileURLToPath(new URL('../../scripts/bundle-size.ts', import.meta.url))
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'forges-bundle-test-'))
  writeFileSync(join(directory, 'index.mjs'), `export const createForges = ${JSON.stringify('x'.repeat(4_000))}`)
  for (const name of ['github', 'gitlab', 'tangled', 'gitea', 'bitbucket']) {
    mkdirSync(join(directory, name))
    writeFileSync(join(directory, name, 'index.mjs'), `export const ${name} = 'full'`)
  }
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function measure(...args: string[]) {
  return spawnSync(process.execPath, [script, '--dist', directory, ...args], { encoding: 'utf8' })
}

describe('browser bundle measurements', () => {
  it('writes the size of every bundle', () => {
    const out = join(directory, 'snapshot.json')
    const result = measure('--out', out)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const snapshot = parseBundleSnapshot(readFileSync(out, 'utf8'))
    expect(snapshot.bundles).toHaveLength(6)
    expect(snapshot.bundles[0]!.minified).toBeGreaterThan(4_000)
    expect(snapshot.bundles.every(bundle => bundle.gzipped > 0)).toBe(true)
  })

  it('fails when the provider-free bundle is over its budget, except in report mode', () => {
    writeFileSync(join(directory, 'index.mjs'), `export const createForges = ${JSON.stringify('x'.repeat(17_000))}`)
    const result = measure()

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^forges is \d+ bytes minified, over its budget of 5000$/m)
    expect(measure('--report').status).toBe(0)
  })

  it.each([
    ['github', 'x-github-event'],
    ['gitlab', 'x-gitlab-event'],
    ['tangled', 'x-tangled-event'],
    ['gitea', 'pull_request_review_comment_created'],
    ['bitbucket', 'x-event-key'],
  ])('fails when the %s entry chunk contains webhook translation', (name, marker) => {
    writeFileSync(join(directory, name, 'index.mjs'), `export const ${name} = '${marker}'`)
    const result = measure()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`forges/${name} contains ${marker}`)
  })

  it('measures the base in report mode without enforcing its tree-shaking checks', () => {
    writeFileSync(join(directory, 'github/index.mjs'), 'export const github = "x-github-event"')
    const out = join(directory, 'base.json')
    const result = measure('--report', '--out', out)
    expect(result.status).toBe(0)
    expect(parseBundleSnapshot(readFileSync(out, 'utf8')).bundles).toHaveLength(6)
    expect(result.stdout).toContain('forges/github')
  })

  it('skips bundles the base does not have in report mode', () => {
    rmSync(join(directory, 'tangled'), { recursive: true })
    const out = join(directory, 'base.json')
    const result = measure('--report', '--out', out)
    expect(result.status).toBe(0)
    expect(parseBundleSnapshot(readFileSync(out, 'utf8')).bundles.map(bundle => bundle.name)).toEqual(['forges', 'forges/github', 'forges/gitlab', 'forges/gitea', 'forges/bitbucket'])
  })

  it('counts and reports every chunk besides the entry', () => {
    writeFileSync(join(directory, 'shared.mjs'), `export const shared = ${JSON.stringify('s'.repeat(2_000))}`)
    writeFileSync(join(directory, 'one.mjs'), `import { shared } from './shared.mjs'; export const one = shared + 1`)
    writeFileSync(join(directory, 'two.mjs'), `import { shared } from './shared.mjs'; export const two = shared + 2`)
    writeFileSync(join(directory, 'github/index.mjs'), 'export const github = () => Promise.all([import("../one.mjs"), import("../two.mjs")])')
    const out = join(directory, 'snapshot.json')
    const result = measure('--report', '--out', out)
    const github = parseBundleSnapshot(readFileSync(out, 'utf8')).bundles.find(bundle => bundle.name === 'forges/github')!

    expect(result.stdout).toMatch(/one-\S+\.js \d+ \(dynamic import\)/)
    expect(result.stdout).toMatch(/shared-\S+\.js \d+ \(shared\)/)
    expect(github.lazy).toBeGreaterThan(2_000)
  })

  it('fails for a missing bundle outside report mode', () => {
    rmSync(join(directory, 'tangled'), { recursive: true })
    expect(measure().status).not.toBe(0)
  })
})
