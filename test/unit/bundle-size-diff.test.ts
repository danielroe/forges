import { describe, expect, it } from 'vitest'
import { parseBundleSnapshot, renderBundleSizeDiff } from '../../scripts/bundle-size-diff.ts'

function bundle(name = 'forges', minified = 1000, gzipped = 500, lazy = 0) {
  return { name, minified, gzipped, lazy }
}

function snapshot(...bundles: ReturnType<typeof bundle>[]) {
  return { version: 1 as const, bundles }
}

describe('bundle size snapshots', () => {
  it('keeps only measurement fields', () => {
    const value = {
      version: 1,
      bundles: [
        {
          ...bundle(),
          script: 'ignored',
        },
      ],
      comment: 'ignored',
    }
    expect(parseBundleSnapshot(JSON.stringify(value))).toEqual(snapshot(bundle()))
  })

  it.each([
    [
      'another version',
      { version: 2, bundles: [] },
    ],
    [
      'missing measurements',
      { version: 1 },
    ],
    [
      'too many bundles',
      snapshot(...Array.from({ length: 65 }, (_, i) => bundle(`bundle${i}`))),
    ],
    [
      'a duplicate name',
      snapshot(bundle(), bundle()),
    ],
    [
      'Markdown in a name',
      snapshot(bundle('[link](https://example.com)')),
    ],
    [
      'a mention',
      snapshot(bundle('@someone')),
    ],
    [
      'a newline',
      snapshot(bundle('forges\ntext')),
    ],
    [
      'a negative size',
      snapshot(bundle('forges', -1)),
    ],
    [
      'a fractional size',
      snapshot(bundle('forges', 1.5)),
    ],
    [
      'an excessive size',
      snapshot(bundle('forges', 1_000_000_001)),
    ],
    [
      'a string size',
      {
        version: 1,
        bundles: [
          {
            ...bundle(),
            gzipped: '500',
          },
        ],
      },
    ],
    [
      'a missing size',
      {
        version: 1,
        bundles: [
          { name: 'forges', minified: 1000, gzipped: 500 },
        ],
      },
    ],
    [
      'a null bundle',
      {
        version: 1,
        bundles: [null],
      },
    ],
  ])('rejects %s', (_, value) => {
    expect(() => parseBundleSnapshot(JSON.stringify(value))).toThrow()
  })

  it('rejects oversized input', () => {
    expect(() => parseBundleSnapshot(' '.repeat(65 * 1024))).toThrow('too large')
  })
})

describe('bundle size diff', () => {
  it('reports increases, decreases and unchanged sizes', () => {
    const result = renderBundleSizeDiff(snapshot(bundle()), snapshot(bundle('forges', 1200, 450)))
    expect(result).toContain('| forges | 1,000 → 1,200 (+200, +20.0%) | 500 → 450 (-50, -10.0%) | 0 |')
    expect(result).toContain('<!-- forges:bundle-size -->')
    expect(result).toContain('Size changes are informational.')
  })

  it('reports lazy chunks added to a zero-byte base without a percentage', () => {
    const result = renderBundleSizeDiff(snapshot(bundle()), snapshot(bundle('forges', 1000, 500, 100)))
    expect(result).toContain('| 0 → 100 (+100) |')
    expect(result).not.toMatch(/NaN|Infinity/)
  })

  it('matches bundles by name and reports added and removed bundles', () => {
    const result = renderBundleSizeDiff(
      snapshot(bundle('forges/github'), bundle('forges/gitlab')),
      snapshot(bundle('forges/tangled'), bundle('forges/github', 900)),
    )
    expect(result).toContain('| forges/github | 1,000 → 900 (-100, -10.0%) | 500 | 0 |')
    expect(result).toContain('| forges/gitlab | 1,000 (removed) | 500 (removed) | 0 (removed) |')
    expect(result).toContain('| forges/tangled | 1,000 (new) | 500 (new) | 0 (new) |')
  })
})
