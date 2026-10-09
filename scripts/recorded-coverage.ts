/**
 * Lists the capabilities each provider declares that no recording of the live
 * forge exercises, as Markdown. Replays `test/recorded.test.ts` twice with the
 * verb tracker on, once for the anonymous recordings and once for the rest,
 * and compares the verbs each replay called with what the providers declare.
 * Pass `--out <file>` to write the table to a file instead of stdout.
 */
import type { CapabilityEntry } from '../src/capability-table.ts'
import type { ForgeProvider } from '../src/index.ts'
import type { SupportCell } from './capabilities.ts'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { CAPABILITY_TABLE } from '../src/capability-table.ts'
import { supportCell } from './capabilities.ts'
import { capabilityAt, CHECKED_PROVIDERS, readExercised } from './exercised.ts'

const FORGES: Array<[string, string]> = [
  ['github', 'GitHub'],
  ['gitlab', 'GitLab'],
  ['bitbucket', 'Bitbucket'],
  ['forgejo', 'Forgejo'],
  ['gitea', 'Gitea'],
  ['gitee', 'Gitee'],
  ['azure-devops', 'Azure DevOps'],
  ['cursor-origin', 'Cursor Origin'],
  ['pushin', 'Pushin.eu'],
  ['tangled', 'Tangled'],
]

const { values: flags } = parseArgs({ options: { out: { type: 'string' } } })
const root = new URL('../', import.meta.url)

function replay(pattern: string): Map<string, Set<string>> {
  const directory = mkdtempSync(join(tmpdir(), 'forges-verbs-'))
  try {
    const vitest = fileURLToPath(new URL('node_modules/vitest/vitest.mjs', root))
    const result = spawnSync(process.execPath, [vitest, 'run', '--project', 'unit', 'test/recorded.test.ts', '-t', pattern], {
      cwd: root,
      env: { ...process.env, FORGES_VERBS_DIR: directory },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    if (result.status !== 0) {
      console.error(`The replay of ${pattern} failed.`)
      process.exit(1)
    }
    return readExercised(pathToFileURL(`${directory}/`))
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const anonymousRun = replay(String.raw`recorded: \S+ \S+-anonymous `)
const authenticatedRun = replay(String.raw`recorded: \S+ \S+(?<!-anonymous) `)

const coveredWithout = (forge: string) => new Set([...anonymousRun.get(`${forge}:anonymous`) ?? [], ...authenticatedRun.get(`${forge}:anonymous`) ?? []])
const coveredWith = (forge: string) => authenticatedRun.get(forge) ?? new Set<string>()
const providersOf = (key: string) => CHECKED_PROVIDERS.filter(([name]) => name === key).map(([, provider]) => provider)

interface Cell { label: string, level: string, verified: boolean }

/** The declared support of one capability across `providers`, one cell per kind, or one for the whole capability. */
function cellsFor(providers: ForgeProvider[], covered: Set<string>, entry: CapabilityEntry): Cell[] {
  const cells = new Map<string, Cell>()
  const hit = (kind?: string) => entry.verbs!.some(verb => covered.has(kind ? `${verb}:${kind}` : verb))
  for (const provider of providers) {
    const { level, kinds }: SupportCell = supportCell(capabilityAt(provider.capabilities, entry.capability))
    for (const item of kinds ?? [{ kind: '', label: '', level }]) {
      if (item.level !== 'none' && !cells.has(item.kind)) {
        cells.set(item.kind, { label: item.label, level: item.level, verified: hit(item.kind || undefined) })
      }
    }
  }
  return [...cells.values()]
}

function render(cells: Cell[]): string {
  if (!cells.length) {
    return ''
  }
  const missing = cells.filter(cell => !cell.verified)
  if (!missing.length) {
    return '✅'
  }
  const verified = cells.filter(cell => cell.verified && cell.label).map(cell => cell.label)
  const text = missing.map(cell => [cell.label, cell.level === 'native' ? '⚠️' : `⚠️ ${cell.level}`].filter(Boolean).join(' ')).join(', ')
  return verified.length ? `${text} (✅ ${verified.join(', ')})` : text
}

function list(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? ''
}

function section(title: string, keyOf: (forge: string) => string, coveredOf: (forge: string) => Set<string>, include: (entry: CapabilityEntry) => boolean): string {
  const rows: string[] = []
  const declared = FORGES.map(() => 0)
  const verified = FORGES.map(() => 0)
  for (const entry of CAPABILITY_TABLE) {
    if (!entry.verbs?.length || !include(entry)) {
      continue
    }
    const cells = FORGES.map(([forge]) => cellsFor(providersOf(keyOf(forge)), coveredOf(forge), entry))
    cells.forEach((forge, index) => {
      declared[index]! += forge.length
      verified[index]! += forge.filter(cell => cell.verified).length
    })
    if (cells.flat().some(cell => !cell.verified)) {
      rows.push(`| \`${entry.capability}\` | ${cells.map(render).join(' | ')} |`)
    }
  }
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const unrecorded = list(FORGES.filter((_, index) => declared[index] && !verified[index]).map(([, name]) => name))
  return [
    `### ${title}`,
    '',
    `${sum(verified)} of ${sum(declared)} declared capabilities, counting each kind, are exercised by a recording.${unrecorded ? ` No recording exercises any for ${unrecorded}.` : ''}`,
    '',
    `| Capability | ${FORGES.map(([, name]) => name).join(' | ')} |`,
    `| --- | ${FORGES.map(() => '---').join(' | ')} |`,
    ...rows,
    `| Exercised | ${FORGES.map((_, index) => declared[index] ? `${verified[index]} of ${declared[index]}` : '').join(' | ')} |`,
    '',
  ].join('\n')
}

const isRead = (entry: CapabilityEntry) => !entry.write && entry.derived !== 'webhook'

const output = [
  '# Capabilities not verified by a recorded fixture',
  '',
  'Generated by `node scripts/recorded-coverage.ts` from a replay of `test/recorded.test.ts` with the verb tracker on. Unit tests with hand-written fixtures still cover many of these; this only shows what no recording of a live forge has exercised.',
  '',
  '- ⚠️ declared and not exercised by any recording, with the level when it is not native',
  '- ✅ every declared kind is exercised by a recording',
  '- empty: not supported',
  '- `(✅ …)` lists the kinds of a per-kind capability that are exercised',
  '',
  'Rows where every supported cell is exercised are left out.',
  '',
  '## Without credentials',
  '',
  'Every replay by a provider without credentials counts here, including recordings of forges that never send any.',
  '',
  section('Reads', forge => `${forge}:anonymous`, coveredWithout, isRead),
  '## With credentials',
  '',
  section('Reads', forge => forge, coveredWith, isRead),
  section('Writes and webhook ingest', forge => forge, coveredWith, entry => !isRead(entry)),
].join('\n')

if (flags.out) {
  writeFileSync(flags.out, output)
}
else {
  console.info(output)
}
