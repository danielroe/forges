import type { DocsSectionSource } from '../docs-sections.ts'
import { commandTable } from '../commands.ts'

const table = commandTable()

const sections: DocsSectionSource = () => [
  { page: '7.contributing/1.guidelines.md', marker: 'commands', content: table },
  { page: '../../CONTRIBUTING.md', marker: 'commands', content: table },
]

export default sections
