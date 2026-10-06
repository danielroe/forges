import type { DocsSectionSource } from '../docs-sections.ts'
import { errorsSection } from '../errors.ts'

const sections: DocsSectionSource = forges => [
  { page: '5.reference/3.errors.md', marker: 'errors', content: errorsSection(forges) },
]

export default sections
