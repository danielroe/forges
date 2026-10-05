/**
 * Bundles a one-line browser consumer of each public subpath with rolldown and
 * checks the entry chunk against a budget. `--report` prints without failing.
 */
import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'

/** `absent` is a string only the webhook code contains; a Lite bundle must not carry it. */
const BUDGETS: Array<{ name: string, source: string, imports: string, minified: number, gzipped: number, absent?: string }> = [
  { name: 'forges', source: 'index.mjs', imports: 'createForges', minified: 9_000, gzipped: 2_500 },
  { name: 'forges/github', source: 'github/index.mjs', imports: 'github', minified: 95_500, gzipped: 29_000 },
  { name: 'github lite', source: 'github/index.mjs', imports: 'githubLite', minified: 88_000, gzipped: 26_900, absent: 'x-hub-signature-256' },
  { name: 'forges/gitlab', source: 'gitlab/index.mjs', imports: 'gitlab', minified: 74_000, gzipped: 23_250 },
  { name: 'gitlab lite', source: 'gitlab/index.mjs', imports: 'gitlabLite', minified: 67_000, gzipped: 21_000, absent: 'x-gitlab-token' },
  { name: 'forges/tangled', source: 'tangled/index.mjs', imports: 'tangled', minified: 55_500, gzipped: 18_500 },
  { name: 'tangled lite', source: 'tangled/index.mjs', imports: 'tangledLite', minified: 52_000, gzipped: 17_250, absent: 'x-tangled-signature-256' },
]

async function measure(source: string, imports: string): Promise<{ minified: number, gzipped: number, lazy: number, code: string }> {
  const directory = join(tmpdir(), 'forges-bundle-size')
  mkdirSync(directory, { recursive: true })
  const entry = join(directory, `${imports}.mjs`)
  const target = new URL(`../dist/${source}`, import.meta.url).pathname
  writeFileSync(entry, `import { ${imports} } from '${target}'\nconsole.info(${imports})\n`)
  const bundle = await rolldown({ input: entry, platform: 'browser' })
  const { output } = await bundle.generate({ format: 'esm', minify: true })
  const code = (chunk: (typeof output)[number]) => Buffer.from('code' in chunk ? chunk.code : '')
  const loaded = output.filter(chunk => 'isEntry' in chunk && chunk.isEntry).map(code)
  const lazy = output.filter(chunk => 'isDynamicEntry' in chunk && chunk.isDynamicEntry).map(code)
  const eager = Buffer.concat(loaded)
  return { minified: eager.byteLength, gzipped: gzipSync(eager).byteLength, lazy: Buffer.concat(lazy).byteLength, code: eager.toString() }
}

const failures: string[] = []
for (const budget of BUDGETS) {
  const { minified, gzipped, lazy, code } = await measure(budget.source, budget.imports)
  console.info(`${budget.name.padEnd(16)} ${String(minified).padStart(7)} min (budget ${budget.minified})  ${String(gzipped).padStart(6)} gz (budget ${budget.gzipped})  ${String(lazy).padStart(6)} lazy`)
  if (minified > budget.minified || gzipped > budget.gzipped) {
    failures.push(`${budget.name} is over budget: ${minified} min, ${gzipped} gz`)
  }
  if (budget.absent && code.includes(budget.absent)) {
    failures.push(`${budget.name} contains ${budget.absent}`)
  }
}

if (failures.length && !process.argv.includes('--report')) {
  console.error(failures.join('\n'))
  process.exit(1)
}
