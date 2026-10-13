import type { StepRecording } from '../../scripts/recording-store.ts'
import type { Fixture } from '../../src/testing/index.ts'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectedSteps, trackReads, withAncestors, writeRecording } from '../../scripts/recording-store.ts'

function fixture(url: string, body: unknown, headers: Record<string, string> = {}): Fixture {
  return { request: { method: 'GET', url }, response: { status: 200, headers, body } }
}

const repo = (stars: number, remaining: string) => fixture('https://api.github.com/repos/h3js/h3', { full_name: 'h3js/h3', stargazers_count: stars, owner: { login: 'h3js', followers: stars * 2, local_time: `${stars}:00 PM` } }, { 'x-ratelimit-remaining': remaining, 'ratelimit': `"baseline";r=${remaining};t=600` })
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

  it('leaves ids out of the names of fixtures whose path holds them within a segment', () => {
    const directory = recording()
    const label = fixture('https://api.github.com/repos/h3js/h3/issues/85/labels/forges-fixture-20261012113502', [])
    const hook = fixture('https://api.bitbucket.org/2.0/repositories/bot/forges-fixtures/hooks/%7B9e802850-0c69-4230-90d6-6b40c0a310a1%7D', {})
    const compare = fixture('https://api.github.com/repos/h3js/h3/compare/main...4348bba01b5300d6d0c0218dc48e3de88068018b', {})
    writeRecording(directory, { steps: [step('labels', [label, hook, compare])], failed: [], setup: [] })

    expect(readdirSync(`${directory}steps/labels`).sort()).toEqual(['01-get-hooks-ID.json', '02-get-compare-main...SHA.json', '03-get-labels-forges-fixture-N.json', 'step.json'])
  })

  it('keeps a step whose responses differ only in rate limits and counters', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('repo', [repo(10, '4999')])], failed: [], setup: [] })
    const result = writeRecording(directory, { steps: [step('repo', [repo(12, '4000')], { recordedAt: '2026-02-01T00:00:00.000Z' })], failed: [], setup: [] })

    expect(result.unchanged).toEqual(['repo'])
    expect(JSON.parse(stepFile(directory, 'repo', 'step.json')).recordedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(stepFile(directory, 'repo', '01-get-h3js-h3.json')).toContain('"stargazers_count": 10')
  })

  it('keeps a step whose responses differ only in structured rate limit fields', () => {
    const directory = recording()
    const limited = (remaining: number) => fixture('https://codeberg.org/api/v1/repos/forgejo/forgejo', { full_name: 'forgejo/forgejo' }, { 'ratelimit': `"baseline";r=${remaining};t=600`, 'ratelimit-policy': '"baseline";q=2000;w=600' })
    writeRecording(directory, { steps: [step('repo', [limited(1994)])], failed: [], setup: [] })
    const result = writeRecording(directory, { steps: [step('repo', [limited(1500)])], failed: [], setup: [] })

    expect(result.unchanged).toEqual(['repo'])
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

  it('updates what an unchanged step reads only when every step is recorded', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('pull', [comment(1)]), step('checks', [comment(2)]), step('labels', [comment(3)])], failed: [], setup: [] })
    const second = [step('pull', [comment(1)]), step('checks', [comment(2)], { needs: ['pull'] }), step('labels', [comment(4)])]
    writeRecording(directory, { steps: second, failed: [], setup: [], only: new Set(['labels']) })

    expect(JSON.parse(stepFile(directory, 'checks', 'step.json')).needs).toBeUndefined()

    writeRecording(directory, { steps: second, failed: [], setup: [] })

    expect(JSON.parse(stepFile(directory, 'checks', 'step.json')).needs).toEqual(['pull'])
  })

  it('finds the steps connected to a selection through what they read', () => {
    const directory = recording()
    writeRecording(directory, { steps: [step('pull', []), step('checks', [], { needs: ['pull'] }), step('pull events', [], { needs: ['pull'] }), step('labels', [])], failed: [], setup: [] })

    expect([...connectedSteps(directory, ['checks'])].sort()).toEqual(['checks', 'pull', 'pull events'])
  })
})

describe('tracking what steps read', () => {
  function runSteps(steps: Array<[string, (context: { author?: string, pulls: string[], comments: Record<string, string> }) => void]>): Record<string, string[]> {
    const { context, start, reads } = trackReads<{ author?: string, pulls: string[], comments: Record<string, string> }>({ pulls: [], comments: {} })
    return Object.fromEntries(steps.map(([name, run]) => {
      start(name)
      run(context)
      return [name, reads()]
    }))
  }

  it('records the step that set each finding a later step reads', () => {
    expect(runSteps([
      ['author', (context) => { context.author = 'bot' }],
      ['create issue', (context) => { context.author ??= 'other' }],
      ['assign', context => void context.author],
    ])).toEqual({ 'author': [], 'create issue': ['author'], 'assign': ['author'] })
  })

  it('records the step that set an entry of an array or object the context starts with', () => {
    expect(runSteps([
      ['create pull', (context) => { context.pulls[0] = 'first' }],
      ['create third pull', (context) => { context.pulls[2] = 'third' }],
      ['pull comment', (context) => { context.comments.pull = `on ${context.pulls[0]}` }],
      ['pull edit comment', context => void context.comments.pull],
      ['pull close', context => void context.pulls[2]],
    ])).toEqual({ 'create pull': [], 'create third pull': [], 'pull comment': ['create pull'], 'pull edit comment': ['pull comment'], 'pull close': ['create third pull'] })
  })

  it('records the step that replaced an array the context starts with', () => {
    expect(runSteps([
      ['existing pull', (context) => { context.pulls = ['pull', 'pull', 'pull'] }],
      ['pull comment', context => void context.pulls[0]],
    ])).toEqual({ 'existing pull': [], 'pull comment': ['existing pull'] })
  })
})

describe('finding the steps a selection reads from', () => {
  const steps = [
    { name: 'author', needs: [] },
    { name: 'create issue', needs: ['author'] },
    { name: 'issue comment', needs: ['create issue'] },
    { name: 'create pull', needs: [] },
    { name: 'issue update to closed', needs: ['create issue', 'author'] },
  ]

  it('adds what the selected steps read, directly or through others, in the order the steps ran', () => {
    expect([...withAncestors(['issue update to closed'], steps)]).toEqual(['author', 'create issue', 'issue update to closed'])
  })

  it('leaves out the steps that read from the selected ones', () => {
    expect([...withAncestors(['create issue'], steps)]).toEqual(['author', 'create issue'])
  })

  it('leaves out steps that did not run', () => {
    expect([...withAncestors(['issue comment'], steps.filter(step => step.name !== 'author'))]).toEqual(['create issue', 'issue comment'])
  })
})
