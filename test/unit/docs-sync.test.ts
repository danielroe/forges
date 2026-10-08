import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PAGES } from '../../scripts/api-docs/config.ts'
import { COMMANDS, INTERNAL_SCRIPTS } from '../../scripts/commands.ts'

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8')

describe('commands', () => {
  const scripts = Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts)

  it('lists every script that someone runs by hand', () => {
    const listed = new Set([...COMMANDS.flatMap(command => command.scripts), ...INTERNAL_SCRIPTS])

    expect(scripts.filter(script => !listed.has(script))).toEqual([])
  })

  it('lists only scripts that exist', () => {
    expect(COMMANDS.flatMap(command => command.scripts).filter(script => !scripts.includes(script))).toEqual([])
  })
})

describe('environment variables page', () => {
  const page = read('docs/content/5.reference/13.environment-variables.md')
  const source = read('src/env.ts')
  const names = (list: string) => [...new RegExp(`const ${list} = \\[([^\\]]*)\\]`).exec(source)![1]!.matchAll(/'([A-Z_]+)'/g)].map(match => match[1]!)

  it('names every kind that `providersFromEnv()` reads', () => {
    expect(names('KINDS').filter(kind => !page.includes(kind))).toEqual([])
  })

  it('describes every field that `providersFromEnv()` reads', () => {
    expect(names('FIELDS').filter(field => !page.includes(`\`${field}\``))).toEqual([])
  })
})

describe('reference page numbers', () => {
  it('number the hand-written pages continuously after the generated ones', () => {
    const directory = fileURLToPath(new URL('docs/content/5.reference/', root))
    const handWritten = readdirSync(directory)
      .filter(name => name.endsWith('.md') && !readFileSync(`${directory}${name}`, 'utf8').includes('Do not edit by hand: `pnpm docs:api`'))
      .map(name => Number.parseInt(name, 10))
      .sort((a, b) => a - b)
    const generated = 1 + PAGES.filter(page => !page.location).length

    expect(handWritten).toEqual(handWritten.map((_, index) => generated + 1 + index))
  })
})
