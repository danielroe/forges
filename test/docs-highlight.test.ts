import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forgeExamples } from '../docs/shared/forge-examples.ts'
import { createExampleHighlighter } from '../docs/shared/highlight.ts'

let highlighter: Awaited<ReturnType<typeof createExampleHighlighter>>

function text(html: string) {
  return html.replace(/<[^>]+>/g, '').replace(/&#x3C;/g, '<')
}

beforeAll(async () => {
  highlighter = await createExampleHighlighter()
})

afterAll(() => {
  highlighter?.dispose()
})

describe('landing examples', () => {
  it.each(forgeExamples)('highlights and type-checks $name', (example) => {
    const html = highlighter.highlight(example.code)
    expect(html).toContain('twoslash-hover')
    expect(html).toContain('color:var(--code-')
    expect(html).not.toContain('twoslash-error')
  })

  it('expands object types declared by the library', () => {
    const html = text(highlighter.highlight(forgeExamples[0]!.code))
    expect(html).toContain('const notification: Notification\n\ninterface Notification {')
    expect(html).toMatch(/^ {2}title: string$/m)
  })

  it('leaves types from other packages and anonymous objects collapsed', () => {
    const html = text(highlighter.highlight(forgeExamples[0]!.code))
    expect(html).not.toContain('interface Process')
    expect(html).not.toContain('interface __object')
  })

  it('rejects invalid TypeScript', () => {
    expect(() => highlighter.highlight('const value: string = 1')).toThrow()
  })
})
