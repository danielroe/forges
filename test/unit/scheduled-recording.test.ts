import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRecordings } from '../../scripts/apply-recordings.ts'
import { scanForCredentials } from '../../scripts/fixture-secrets.ts'

const directories: string[] = []
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forges-scheduled-'))
  directories.push(directory)
  return directory
}

function write(path: string, content: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  writeFileSync(path, content)
}

/** An artifact as the `record` job uploads it, with a reads and a writes recording of the forge. */
function artifact(kind: 'reads' | 'writes', forge = 'github'): { downloads: string, recorded: string } {
  const downloads = temporary()
  const recorded = `${downloads}/recording-${kind}-${forge}/recorded`
  write(`${recorded}/github.com/manifest.json`, '{}')
  write(`${recorded}/github.com/steps/repo/step.json`, '{"name":"repo"}')
  write(`${recorded}/github.com/steps/repo/01-get-h3js-h3.json`, '{"request":{}}')
  write(`${recorded}/github.com-writes/steps/create-issue/01-post-issues.json`, '{"request":{}}')
  write(`${downloads}/recording-${kind}-${forge}/summary.md`, '#### github')
  return { downloads, recorded }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('applying scheduled recordings', () => {
  it('replaces the recordings of the kind it applies, and leaves the others', () => {
    const { downloads } = artifact('reads')
    const fixtures = temporary()
    write(`${fixtures}/github/recorded/github.com/steps/old/step.json`, '{}')
    write(`${fixtures}/github/recorded/github.com-writes/manifest.json`, '"kept"')

    expect(applyRecordings(downloads, 'reads', fixtures)).toEqual([{ forge: 'github', summary: '#### github' }])
    expect(existsSync(`${fixtures}/github/recorded/github.com/steps/old`)).toBe(false)
    expect(existsSync(`${fixtures}/github/recorded/github.com/steps/repo/01-get-h3js-h3.json`)).toBe(true)
    expect(readFileSync(`${fixtures}/github/recorded/github.com-writes/manifest.json`, 'utf8')).toBe('"kept"')
  })

  it.each([
    ['an unknown forge', ({ downloads }: ReturnType<typeof artifact>) => write(`${downloads}/recording-reads-evil/recorded/x/manifest.json`, '{}')],
    ['a file that is not fixture JSON', ({ recorded }: ReturnType<typeof artifact>) => write(`${recorded}/github.com/steps/repo/01-get-x.sh`, 'echo')],
    ['a file outside a step', ({ recorded }: ReturnType<typeof artifact>) => write(`${recorded}/github.com/package.json`, '{}')],
    ['JSON that does not parse', ({ recorded }: ReturnType<typeof artifact>) => write(`${recorded}/github.com/steps/repo/02-get-x.json`, '{')],
    ['a symbolic link', ({ recorded }: ReturnType<typeof artifact>) => symlinkSync('/etc/passwd', `${recorded}/github.com/steps/repo/02-get-x.json`)],
    ['a directory named like a path', ({ recorded }: ReturnType<typeof artifact>) => write(`${recorded}/github.com/steps/..repo/01-get-x.json`, '{}')],
  ])('refuses every recording when one holds %s', (_, tamper) => {
    const files = artifact('reads')
    tamper(files)
    const fixtures = temporary()

    expect(() => applyRecordings(files.downloads, 'reads', fixtures)).toThrow(/Refusing the recordings/)
    expect(existsSync(`${fixtures}/github`)).toBe(false)
  })
})

describe('searching recordings for credentials', () => {
  it('finds a credential as sent in a URL or a Basic header, and ignores repositories and accounts', () => {
    const directory = temporary()
    const env = { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz', BITBUCKET_USERNAME: 'bot@example.com', BITBUCKET_APP_PASSWORD: 'app-password-123', FIXTURE_GITHUB_REPO: 'h3js/h3' }
    write(`${directory}/a.json`, JSON.stringify({ url: `https://x.test/?t=${encodeURIComponent(env.GITHUB_TOKEN)}`, repo: 'h3js/h3', login: 'bot@example.com' }))
    write(`${directory}/b.json`, JSON.stringify({ authorization: `Basic ${Buffer.from(`${env.BITBUCKET_USERNAME}:${env.BITBUCKET_APP_PASSWORD}`).toString('base64')}` }))
    write(`${directory}/c.json`, '{"clean":true}')

    expect(scanForCredentials(env, [directory]).map(({ file, name }) => `${file.slice(directory.length + 1)} ${name}`).sort()).toEqual(['a.json GITHUB_TOKEN', 'b.json BITBUCKET_APP_PASSWORD'])
  })
})
