import { readFileSync, statSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

interface BundleSize {
  name: string
  minified: number
  gzipped: number
  lazy: number
}

interface BundleSnapshot {
  version: 1
  bundles: BundleSize[]
}

/** Parses bundle measurements from an untrusted workflow artifact. */
export function parseBundleSnapshot(text: string): BundleSnapshot {
  if (text.length > 64 * 1024) {
    throw new Error('Bundle snapshot is too large')
  }
  const value = JSON.parse(text)
  if (value?.version !== 1 || !Array.isArray(value.bundles) || value.bundles.length > 64) {
    throw new Error('Expected a version 1 bundle snapshot with at most 64 bundles')
  }
  const names = new Set<string>()
  const bundles = value.bundles.map((bundle: unknown): BundleSize => {
    if (!bundle || typeof bundle !== 'object') {
      throw new Error('Invalid bundle measurement')
    }
    const { name, minified, gzipped, lazy } = bundle as Record<string, unknown>
    if (typeof name !== 'string' || !/^[a-z][a-z\d /-]{0,63}$/.test(name) || names.has(name)) {
      throw new Error('Invalid or duplicate bundle name')
    }
    if (![minified, gzipped, lazy].every(size => typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= 1_000_000_000)) {
      throw new Error('Invalid bundle size')
    }
    names.add(name)
    return { name, minified: minified as number, gzipped: gzipped as number, lazy: lazy as number }
  })
  return { version: 1, bundles }
}

function format(size: number): string {
  return size.toLocaleString('en-US')
}

function cell(before: number | undefined, after: number | undefined): string {
  if (before === undefined) {
    return `${format(after!)} (new)`
  }
  if (after === undefined) {
    return `${format(before)} (removed)`
  }
  const delta = after - before
  if (!delta) {
    return format(after)
  }
  const sign = delta > 0 ? '+' : '-'
  const percent = before ? `, ${sign}${(Math.abs(delta) / before * 100).toFixed(1)}%` : ''
  return `${format(before)} → ${format(after)} (${sign}${format(Math.abs(delta))}${percent})`
}

/** Renders base and PR browser bundle sizes as a Markdown table. */
export function renderBundleSizeDiff(base: BundleSnapshot, head: BundleSnapshot): string {
  const before = new Map(base.bundles.map(bundle => [bundle.name, bundle]))
  const after = new Map(head.bundles.map(bundle => [bundle.name, bundle]))
  const names = new Set([...before.keys(), ...after.keys()])
  return [
    '<!-- forges:bundle-size -->',
    '## Bundle size',
    '',
    'Browser entry bundles compared with the PR base. All sizes are in bytes. Lazy totals the minified chunks besides the entry, which load on demand or never.',
    '',
    '| Bundle | Minified | Gzip | Lazy |',
    '| --- | ---: | ---: | ---: |',
    ...[...names].map((name) => {
      const previous = before.get(name)
      const current = after.get(name)
      return `| ${name} | ${cell(previous?.minified, current?.minified)} | ${cell(previous?.gzipped, current?.gzipped)} | ${cell(previous?.lazy, current?.lazy)} |`
    }),
    '',
    'Size changes are informational. `pnpm test:size` checks entry chunks for webhook translation, and the provider-free bundle against its budget.',
    '',
  ].join('\n')
}

function readSnapshot(path: string): BundleSnapshot {
  if (statSync(path).size > 64 * 1024) {
    throw new Error('Bundle snapshot is too large')
  }
  return parseBundleSnapshot(readFileSync(path, 'utf8'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } })
  if (!values.base || !values.head) {
    throw new Error('Expected --base and --head snapshot paths')
  }
  process.stdout.write(renderBundleSizeDiff(readSnapshot(values.base), readSnapshot(values.head)))
}
