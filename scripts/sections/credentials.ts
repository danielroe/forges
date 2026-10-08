import type { DocsSectionSource } from '../docs-sections.ts'
import * as forges from '../../src/index.ts'
import { requirementsTable, taskTable } from '../credentials.ts'

const requirements = await requirementsTable(forges)

const sections: DocsSectionSource = source => [
  { page: '5.reference/13.environment-variables.md', marker: 'forge-requirements', content: requirements },
  { page: '2.guides/3.environment.md', marker: 'credentials-wizard', content: taskTable(source) },
]

export default sections
