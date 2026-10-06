import type { DocsSectionSource } from '../docs-sections.ts'
import { eventKindsSection, eventMatrix } from '../events.ts'

const sections: DocsSectionSource = forges => [
  { page: '5.reference/6.events.md', marker: 'events', content: eventMatrix(forges) },
  { page: '5.reference/6.events.md', marker: 'event-kinds', content: eventKindsSection(forges) },
]

export default sections
