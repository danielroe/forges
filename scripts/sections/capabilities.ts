import type { DocsSectionSource } from '../docs-sections.ts'
import { matrix, matrixProviders, providerIndex, providerSection } from '../capabilities.ts'

const sections: DocsSectionSource = forges => [
  ...matrixProviders(forges).map(({ slug, provider }) => ({ page: `4.providers/${slug}.md`, marker: 'capabilities', content: providerSection(slug, provider) })),
  { page: '4.providers/index.md', marker: 'capabilities', content: providerIndex(forges) },
  { page: '5.reference/2.capability-matrix.md', marker: 'capabilities', content: matrix(forges) },
]

export default sections
