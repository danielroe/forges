import type { DocsSectionSource } from '../docs-sections.ts'
import { matrix, matrixProviders, providerIndex, providerSection } from '../capabilities.ts'

const sections: DocsSectionSource = forges => [
  ...matrixProviders(forges).map(entry => ({ page: `4.providers/${entry.slug}.md`, marker: 'capabilities', content: providerSection(entry) })),
  { page: '4.providers/index.md', marker: 'capabilities', content: providerIndex(forges) },
  { page: '5.reference/11.capability-matrix.md', marker: 'capabilities', content: matrix(forges) },
]

export default sections
