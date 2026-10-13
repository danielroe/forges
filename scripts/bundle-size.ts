/**
 * Measures browser entry bundles, checks that Lite bundles exclude webhook
 * code, that the provider-free bundle stays within its budget, and that the
 * sizes the docs quote are within 10% of the measured ones. `lazy` totals
 * every chunk besides the entry.
 *
 *   node scripts/bundle-size.ts [--dist dist] [--out snapshot.json] [--report] [--update-docs]
 *
 * `--report` prints each of those chunks without failing. `--update-docs`
 * writes the measured sizes into the docs. The docs are checked only against
 * the default `dist`.
 */
import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'

/** `absent` is a string only the webhook code holds; `budget` is the most the entry chunk may weigh, minified. */
const BUNDLES: Array<{ name: string, source: string, imports: string, absent?: string, budget?: number }> = [
  { name: 'forges', source: 'index.mjs', imports: 'createForges', budget: 5_000 },
  { name: 'forges/github', source: 'github/index.mjs', imports: 'github' },
  { name: 'github lite', source: 'github/index.mjs', imports: 'githubLite', absent: 'x-hub-signature-256' },
  { name: 'forges/gitlab', source: 'gitlab/index.mjs', imports: 'gitlab' },
  { name: 'gitlab lite', source: 'gitlab/index.mjs', imports: 'gitlabLite', absent: 'x-gitlab-token' },
  { name: 'forges/tangled', source: 'tangled/index.mjs', imports: 'tangled' },
  { name: 'tangled lite', source: 'tangled/index.mjs', imports: 'tangledLite', absent: 'x-tangled-signature-256' },
  { name: 'gitea lite', source: 'gitea/index.mjs', imports: 'giteaLite' },
  { name: 'bitbucket lite', source: 'bitbucket/index.mjs', imports: 'bitbucketLite', absent: 'x-event-key' },
]

interface Size {
  minified: number
  gzipped: number
}

const kB = (bytes: number, digits = 1) => (bytes / 1000).toFixed(digits)

/** The sizes the docs quote: `read` takes them from a match of `pattern`, and `render` writes them back. */
const DOCUMENTED: Array<{ file: string, bundle: string, pattern: RegExp, read: (match: RegExpMatchArray) => Partial<Size>, render: (size: Size) => string }> = [
  ...[['GitHub', 'github lite'], ['GitLab', 'gitlab lite'], ['Gitea / Forgejo', 'gitea lite'], ['Bitbucket', 'bitbucket lite']].map(([label, bundle]) => ({
    file: 'docs/content/2.guides/8.bundling.md',
    bundle: bundle!,
    pattern: new RegExp(`^\\| ${label!.replace('/', '\\/')} \\| ([\\d.]+) kB, ([\\d.]+) kB gzip \\|`, 'm'),
    read: (match: RegExpMatchArray) => ({ minified: Number(match[1]) * 1000, gzipped: Number(match[2]) * 1000 }),
    render: (size: Size) => `| ${label} | ${kB(size.minified)} kB, ${kB(size.gzipped)} kB gzip |`,
  })),
  {
    file: 'docs/app/components/content/LandingPage.vue',
    bundle: 'github lite',
    pattern: /The GitHub Lite provider is about (\d+) kB gzipped/,
    read: match => ({ gzipped: Number(match[1]) * 1000 }),
    render: size => `The GitHub Lite provider is about ${kB(size.gzipped, 0)} kB gzipped`,
  },
]

/** How far a documented size may be from the measured one before the docs count as stale. */
const TOLERANCE = 0.1

const defaultDist = fileURLToPath(new URL('../dist', import.meta.url))
const { values } = parseArgs({
  options: {
    'dist': { type: 'string', default: defaultDist },
    'out': { type: 'string' },
    'report': { type: 'boolean', default: false },
    'update-docs': { type: 'boolean', default: false },
  },
})

async function measure(directory: string, source: string, imports: string) {
  const entry = join(directory, `${imports}.mjs`)
  const target = resolve(values.dist, source)
  writeFileSync(entry, `import { ${imports} } from ${JSON.stringify(target)}\nconsole.info(${imports})\n`)
  const bundle = await rolldown({ input: entry, platform: 'browser' })
  try {
    const { output } = await bundle.generate({ format: 'esm', minify: true })
    const chunks = output.flatMap(chunk => chunk.type === 'chunk' ? [chunk] : [])
    const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]))
    const reached = new Set(chunks.filter(chunk => chunk.isEntry).map(chunk => chunk.fileName))
    for (const name of reached) {
      for (const next of [...byName.get(name)?.imports ?? [], ...byName.get(name)?.dynamicImports ?? []]) {
        reached.add(next)
      }
    }
    const eager = Buffer.concat(chunks.filter(chunk => chunk.isEntry).map(chunk => Buffer.from(chunk.code)))
    const others = chunks.filter(chunk => !chunk.isEntry).map(chunk => ({
      name: chunk.fileName,
      size: Buffer.byteLength(chunk.code),
      kind: !reached.has(chunk.fileName) ? 'unreachable' : chunk.isDynamicEntry ? 'dynamic import' : 'shared',
    }))
    return { minified: eager.byteLength, gzipped: gzipSync(eager).byteLength, lazy: others.reduce((total, chunk) => total + chunk.size, 0), others, code: eager.toString() }
  }
  finally {
    await bundle.close()
  }
}

const directory = mkdtempSync(join(tmpdir(), 'forges-bundle-size-'))
const failures: string[] = []
const bundles: Array<Size & { name: string, lazy: number }> = []
try {
  for (const { name, source, imports, absent, budget } of BUNDLES) {
    const result = await measure(directory, source, imports).catch((error: unknown) => {
      if (!values.report) {
        throw error
      }
      console.warn(`${name.padEnd(16)} skipped: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
    })
    if (!result) {
      continue
    }
    const { minified, gzipped, lazy, others, code } = result
    bundles.push({ name, minified, gzipped, lazy })
    console.info(`${name.padEnd(16)} ${String(minified).padStart(7)} min  ${String(gzipped).padStart(6)} gz  ${String(lazy).padStart(6)} lazy`)
    if (values.report) {
      for (const chunk of others) {
        console.info(`  ${chunk.name} ${chunk.size} (${chunk.kind})`)
      }
    }
    if (absent && code.includes(absent)) {
      failures.push(`${name} contains ${absent}`)
    }
    if (budget && minified > budget) {
      failures.push(`${name} is ${minified} bytes minified, over its budget of ${budget}`)
    }
  }
  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify({ version: 1, bundles }, null, 2)}\n`)
  }
}
finally {
  rmSync(directory, { recursive: true, force: true })
}

if (resolve(values.dist) === defaultDist) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const originals = new Map(DOCUMENTED.map(({ file }) => [file, readFileSync(join(root, file), 'utf8')]))
  const texts = new Map(originals)
  for (const { file, bundle, pattern, read, render } of DOCUMENTED) {
    const size = bundles.find(entry => entry.name === bundle)
    if (!size) {
      continue
    }
    const text = texts.get(file)!
    const match = text.match(pattern)
    if (!match) {
      failures.push(`${file} no longer quotes the size of ${bundle} as ${pattern}`)
      continue
    }
    texts.set(file, text.replace(pattern, render(size)))
    const stale = Object.entries(read(match)).some(([key, quoted]) => Math.abs(quoted - size[key as keyof Size]) > size[key as keyof Size] * TOLERANCE)
    if (stale && !values['update-docs']) {
      failures.push(`${file} quotes "${match[0]}", but ${bundle} is now "${render(size)}"; run \`node scripts/bundle-size.ts --update-docs\``)
    }
  }
  if (values['update-docs']) {
    for (const [file, text] of texts) {
      if (text !== originals.get(file)) {
        writeFileSync(join(root, file), text)
        console.info(`Updated the sizes in ${file}`)
      }
    }
  }
}

if (failures.length && !values.report) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
