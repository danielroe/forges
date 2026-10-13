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
    writeFileSync(join(directory, name, 'index.mjs'), `export const ${name} = 'full'; export const ${name}Lite = 'lite'`)
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
    expect(snapshot.bundles).toHaveLength(9)
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
    ['github', 'x-hub-signature-256'],
    ['gitlab', 'x-gitlab-token'],
    ['tangled', 'x-tangled-signature-256'],
    ['bitbucket', 'x-event-key'],
  ])('fails when %s Lite contains webhook code', (name, signature) => {
    writeFileSync(join(directory, name, 'index.mjs'), `export const ${name} = 'full'; export const ${name}Lite = '${signature}'`)
    const result = measure()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${name} lite contains ${signature}`)
  })

  it('measures the base in report mode without enforcing its tree-shaking checks', () => {
    writeFileSync(join(directory, 'github/index.mjs'), 'export const github = "full"; export const githubLite = "x-hub-signature-256"')
    const out = join(directory, 'base.json')
    const result = measure('--report', '--out', out)
    expect(result.status).toBe(0)
    expect(parseBundleSnapshot(readFileSync(out, 'utf8')).bundles).toHaveLength(9)
    expect(result.stdout).toContain('github lite')
  })

  it('skips bundles the base does not have in report mode', () => {
    rmSync(join(directory, 'tangled'), { recursive: true })
    writeFileSync(join(directory, 'gitlab/index.mjs'), 'export const gitlab = "full"')
    const out = join(directory, 'base.json')
    const result = measure('--report', '--out', out)
    expect(result.status).toBe(0)
    expect(parseBundleSnapshot(readFileSync(out, 'utf8')).bundles.map(bundle => bundle.name)).toEqual(['forges', 'forges/github', 'github lite', 'forges/gitlab', 'gitea lite', 'bitbucket lite'])
  })

  it('counts and reports every chunk besides the entry', () => {
    writeFileSync(join(directory, 'shared.mjs'), `export const shared = ${JSON.stringify('s'.repeat(2_000))}`)
    writeFileSync(join(directory, 'one.mjs'), `import { shared } from './shared.mjs'; export const one = shared + 1`)
    writeFileSync(join(directory, 'two.mjs'), `import { shared } from './shared.mjs'; export const two = shared + 2`)
    writeFileSync(join(directory, 'github/index.mjs'), 'export const github = "full"; export const githubLite = () => Promise.all([import("../one.mjs"), import("../two.mjs")])')
    const out = join(directory, 'snapshot.json')
    const result = measure('--report', '--out', out)
    const lite = parseBundleSnapshot(readFileSync(out, 'utf8')).bundles.find(bundle => bundle.name === 'github lite')!

    expect(result.stdout).toMatch(/one-\S+\.js \d+ \(dynamic import\)/)
    expect(result.stdout).toMatch(/shared-\S+\.js \d+ \(shared\)/)
    expect(lite.lazy).toBeGreaterThan(2_000)
  })

  it('fails for a missing bundle outside report mode', () => {
    rmSync(join(directory, 'tangled'), { recursive: true })
    expect(measure().status).not.toBe(0)
  })
})
