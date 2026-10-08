import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { generateApiDocs } from './api-docs/generate.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const contentDir = fileURLToPath(new URL('../docs/content/', import.meta.url))

const { files, undocumented, unplaced } = generateApiDocs({ root, contentDir })
console.log(`Wrote ${files.length} pages to docs/content`)
if (unplaced.length) {
  console.log(`No page of scripts/api-docs/config.ts has a place for: ${unplaced.join(', ')}`)
}
if (undocumented.length) {
  console.log(`${undocumented.length} symbols and members have no JSDoc description. Run with --list to see them.`)
  if (process.argv.includes('--list')) {
    console.log(undocumented.join('\n'))
  }
}
if (process.argv.includes('--check') && (unplaced.length || undocumented.length)) {
  process.exitCode = 1
}
