import type { StepRecording } from '../../scripts/recording-store.ts'
import type { Fixture } from '../../src/testing/index.ts'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectedSteps, writeRecording } from '../../scripts/recording-store.ts'

function fixture(url: string, body: unknown, headers: Record<string, string> = {}): Fixture {
  return { request: { method: 'GET', url }, response: { status: 200, headers, body } }
}

const repo = (stars: number, remaining: string) => fixture('https://api.github.com/repos/h3js/h3', { full_name: 'h3js/h3', stargazers_count: stars }, { 'x-ratelimit-remaining': remaining })
const comment = (id: number) => fixture(`https://api.github.com/repos/h3js/h3/issues/comments/${id}`, { id, body: 'Hello' })

function step(name: string, fixtures: Fixture[], { needs = [] as string[], recordedAt = '2026-01-01T00:00:00.000Z' } = {}): StepRecording {
  return { name, recordedAt, needs, fixtures }
}

const directories: string[] = []
function recording(): string {
  const directory = `${mkdtempSync(join(tmpdir(), 'forges-recording-'))}/`
  directories.push(directory)
  return directory
}

function stepFile(directory: string, slug: string, file: string): string {
  return readFileSync(`${directory}steps/${slug}/${file}`, 'utf8')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('recording store', () => {
  it('writes each step to its own directory with names that leave out ids', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('pull getComment', [comment(123)], { needs: ['pull comments'] })], failed: [], setup: [] })

    expect(readdirSync(`${directory}steps/pull-getcomment`).sort()).toEqual(['01-get-comments-N.json', 'step.json'])
    expect(JSON.parse(stepFile(directory, 'pull-getcomment', 'step.json'))).toEqual({ name: 'pull getComment', recordedAt: '2026-01-01T00:00:00.000Z', needs: ['pull comments'] })
  })

  it('keeps a step whose responses differ only in rate limits and counters', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('repo', [repo(10, '4999')])], failed: [], setup: [] })
    const result = writeRecording(directory, { steps: [step('repo', [repo(12, '4000')], { recordedAt: '2026-02-01T00:00:00.000Z' })], failed: [], setup: [] })

    expect(result.unchanged).toEqual(['repo'])
    expect(JSON.parse(stepFile(directory, 'repo', 'step.json')).recordedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(stepFile(directory, 'repo', '01-get-h3js-h3.json')).toContain('"stargazers_count": 10')
  })

  it('keeps a step whose download was signed again', () => {
    const directory = recording()
    const asset = (expiry: string) => fixture(`https://release-assets.githubusercontent.com/asset/1?sp=r&se=${expiry}&sig=REDACTED`, 'fixture')
    writeRecording(directory, { steps: [step('release asset', [asset('2026-01-01T01%3A00%3A00Z')])], failed: [], setup: [] })
    const result = writeRecording(directory, { steps: [step('release asset', [asset('2026-02-01T01%3A00%3A00Z')])], failed: [], setup: [] })

    expect(result.unchanged).toEqual(['release asset'])
  })

  it('rewrites a step whose responses changed', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('repo', [repo(10, '4999'), comment(1)])], failed: [], setup: [] })
    const result = writeRecording(directory, { steps: [step('repo', [repo(10, '4999')])], failed: [], setup: [] })

    expect(result.written).toEqual(['repo'])
    expect(readdirSync(`${directory}steps/repo`).sort()).toEqual(['01-get-h3js-h3.json', 'step.json'])
  })

  it('keeps the earlier recording of a failed step and removes steps no longer recorded', () => {
    const directory = recording()
    writeRecording(directory, { steps: ['repo', 'labels', 'tags'].map(name => step(name, [repo(1, '1')])), failed: [], setup: [] })
    const result = writeRecording(directory, { steps: [step('repo', [repo(1, '1')])], failed: [{ name: 'labels', needs: [] }], setup: [] })

    expect(result).toMatchObject({ kept: ['labels'], removed: ['tags'] })
    expect(existsSync(`${directory}steps/labels/step.json`)).toBe(true)
    expect(existsSync(`${directory}steps/tags`)).toBe(false)
  })

  it('drops the earlier recording of a failed step that read findings that changed', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('ci jobs', [comment(1)]), step('ci log', [comment(2)], { needs: ['ci jobs'] })], failed: [], setup: [] })
    const result = writeRecording(directory, { steps: [step('ci jobs', [comment(3)], { recordedAt: '2026-02-01T00:00:00.000Z' })], failed: [{ name: 'ci log', needs: [] }], setup: [] })

    expect(result).toMatchObject({ written: ['ci jobs'], kept: [], dropped: ['ci log'] })
    expect(existsSync(`${directory}steps/ci-log`)).toBe(false)
  })

  it('drops the earlier recording of a failed step that read findings recorded since', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('ci jobs', [comment(1)]), step('ci log', [comment(2)])], failed: [], setup: [] })
    writeRecording(directory, { steps: [step('ci jobs', [comment(3)], { recordedAt: '2026-02-01T00:00:00.000Z' })], failed: [{ name: 'ci log', needs: [] }], setup: [] })
    const result = writeRecording(directory, { steps: [step('ci jobs', [comment(3)], { recordedAt: '2026-03-01T00:00:00.000Z' })], failed: [{ name: 'ci log', needs: ['ci jobs'] }], setup: [] })

    expect(result).toMatchObject({ unchanged: ['ci jobs'], kept: [], dropped: ['ci log'] })
  })

  it('writes the selected steps, and the changed steps they read from or that read from them', () => {
    const directory = recording()
    const first = ['pull', 'checks', 'labels'].map(name => step(name, [comment(1)], { needs: name === 'checks' ? ['pull'] : [] }))
    writeRecording(directory, { steps: first, failed: [], setup: [comment(9)] })
    const second = ['pull', 'checks', 'labels'].map(name => step(name, [comment(2)], { needs: name === 'checks' ? ['pull'] : [] }))
    const result = writeRecording(directory, { steps: second, failed: [], setup: [], only: new Set(['checks']) })

    expect(result).toMatchObject({ written: ['pull', 'checks'], extra: ['pull'] })
    expect(stepFile(directory, 'labels', '01-get-comments-N.json')).toContain('"id": 1')
    expect(readdirSync(`${directory}setup`)).toEqual(['01-get-comments-N.json'])
  })

  it('finds the steps connected to a selection through what they read', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('pull', []), step('checks', [], { needs: ['pull'] }), step('pull events', [], { needs: ['pull'] }), step('labels', [])], failed: [], setup: [] })

    expect([...connectedSteps(directory, ['checks'])].sort()).toEqual(['checks', 'pull', 'pull events'])
  })
})
