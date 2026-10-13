/**
 * Runs every recording of a forge, one after another, as the scheduled
 * `fixtures` workflow does:
 *
 *   node scripts/record-forge.ts <forge> --kind reads|writes [--env-file <file>] [--only <step>]... [--summary <file>]
 *   node scripts/record-forge.ts --list reads|writes
 *
 * Reads record with credentials, without them and, for GitHub, as an app,
 * and for Forgejo also on code.forgejo.org. Writes record the scratch
 * repository and, for Tangled, then seed it for the next read recording.
 * `--summary` writes the outcome of each recording as Markdown. The exit code
 * is 1 when any recording failed. `--list` prints the forges that record
 * that kind, as a JSON array.
 */
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

interface Recording {
  label: string
  args: string[]
  env?: Record<string, string>
}

const CODE_FORGEJO = { CODEBERG_BASE_URL: 'https://code.forgejo.org' }

/** The recordings of each forge, by kind. */
export const PLANS: Record<string, { reads: Recording[], writes: Recording[] }> = {
  'github': {
    reads: [{ label: 'github.com', args: [] }, { label: 'anonymous', args: ['--anonymous'] }, { label: 'app', args: ['--app'] }],
    writes: [{ label: 'writes', args: ['--writes'] }],
  },
  'gitlab': { reads: [{ label: 'gitlab.com', args: [] }, { label: 'anonymous', args: ['--anonymous'] }], writes: [{ label: 'writes', args: ['--writes'] }] },
  'bitbucket': { reads: [{ label: 'bitbucket.org', args: [] }, { label: 'anonymous', args: ['--anonymous'] }], writes: [{ label: 'writes', args: ['--writes'] }] },
  'forgejo': {
    reads: [
      { label: 'codeberg.org', args: [] },
      { label: 'anonymous', args: ['--anonymous'] },
      { label: 'code.forgejo.org', args: [], env: CODE_FORGEJO },
      { label: 'code.forgejo.org anonymous', args: ['--anonymous'], env: CODE_FORGEJO },
    ],
    writes: [{ label: 'writes', args: ['--writes'] }],
  },
  'gitea': { reads: [{ label: 'gitea.com', args: [] }, { label: 'anonymous', args: ['--anonymous'] }], writes: [{ label: 'writes', args: ['--writes'] }] },
  'gitee': { reads: [{ label: 'gitee.com', args: [] }, { label: 'anonymous', args: ['--anonymous'] }], writes: [] },
  'azure-devops': { reads: [{ label: 'dev.azure.com', args: [] }, { label: 'anonymous', args: ['--anonymous'] }], writes: [{ label: 'writes', args: ['--writes'] }] },
  'pushin': { reads: [{ label: 'pushin.eu', args: [] }, { label: 'anonymous', args: ['--anonymous'] }], writes: [] },
  'cloudflare-artifacts': { reads: [{ label: 'artifacts.cloudflare.net', args: [] }], writes: [] },
  'tangled': {
    reads: [{ label: 'tangled.org', args: [] }, { label: 'anonymous', args: ['--anonymous'] }],
    writes: [{ label: 'writes', args: ['--writes'] }, { label: 'seed', args: ['--seed'] }],
  },
}

/** Lines of the recorder's output that say what it wrote, kept and failed. */
const OUTCOME = /^(?:FAILED|\d+ step\(s\)|Kept|Removed|Also|These|No |`|--| {2}\S)/

function record(forge: string, recording: Recording, options: { envFile?: string, only: string[] }): Promise<{ code: number, outcome: string[] }> {
  const script = fileURLToPath(new URL('./record-fixtures.ts', import.meta.url))
  const args = [options.envFile ? `--env-file=${options.envFile}` : '--env-file-if-exists=.env', script, forge, ...recording.args, ...options.only.flatMap(step => ['--only', step])]
  const child = spawn(process.execPath, args, { env: { ...process.env, ...recording.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const outcome: string[] = []
  let pending = ''
  const collect = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    stream.write(chunk)
    const lines = (pending + chunk.toString()).split('\n')
    pending = lines.pop() ?? ''
    outcome.push(...lines.filter(line => OUTCOME.test(line)))
  }
  child.stdout.on('data', chunk => collect(chunk, process.stdout))
  child.stderr.on('data', chunk => collect(chunk, process.stderr))
  return new Promise(resolve => child.on('close', code => resolve({ code: code ?? 1, outcome })))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals: [forge], values } = parseArgs({ allowPositionals: true, options: { 'kind': { type: 'string' }, 'list': { type: 'string' }, 'env-file': { type: 'string' }, 'only': { type: 'string', multiple: true, default: [] }, 'summary': { type: 'string' } } })
  if (values.list === 'reads' || values.list === 'writes') {
    console.info(JSON.stringify(Object.keys(PLANS).filter(name => PLANS[name]![values.list as 'reads' | 'writes'].length)))
    process.exit(0)
  }
  const kind = values.kind
  if (!forge || !(forge in PLANS) || (kind !== 'reads' && kind !== 'writes')) {
    console.error(`Usage: node scripts/record-forge.ts <${Object.keys(PLANS).join('|')}> --kind reads|writes [--env-file <file>] [--only <step>]... [--summary <file>]`)
    process.exit(1)
  }
  if (kind === 'writes' && values.only.length) {
    console.error('--only records read steps.')
    process.exit(1)
  }
  const summary: string[] = []
  let failed = false
  for (const recording of PLANS[forge]![kind]) {
    const actions = process.env.GITHUB_ACTIONS === 'true'
    console.info(actions ? `::group::${forge} ${recording.label}` : `Recording ${forge} ${recording.label}`)
    const { code, outcome } = await record(forge, recording, { envFile: values['env-file'], only: values.only })
    if (actions) {
      console.info('::endgroup::')
    }
    failed ||= code !== 0
    summary.push(`#### ${forge}: ${recording.label}${code ? ` (exit ${code})` : ''}`, '', '```text', ...outcome.map(line => line.replaceAll('`', '\'')), '```', '')
  }
  if (values.summary) {
    writeFileSync(values.summary, `${summary.join('\n')}\n`)
  }
  process.exitCode = failed ? 1 : 0
}
