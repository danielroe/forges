import type { FunctionalComponent } from 'vue'
import { h } from 'vue'

interface CapabilityCellProps {
  level: string
  kinds?: Array<{ kind: string, label: string, level: string }>
  /** The credentials that have the support, when only some of the forge's credentials do; marks the cell. */
  credentials?: string[]
  byCredential?: unknown
}

// Functional, as the matrices render hundreds of cells.
const CapabilityCell: FunctionalComponent<CapabilityCellProps> = ({ level, kinds, credentials }) => {
  const marked = credentials?.length ? { 'data-credentials': '' } : {}
  return kinds
    ? h('span', { 'class': 'capability-cell capability-kinds', 'aria-hidden': 'true', ...marked }, kinds.map(kind => h('span', { 'key': kind.kind, 'class': 'capability-swatch', 'data-level': kind.level })))
    : h('span', { 'class': 'capability-cell capability-swatch', 'data-level': level, 'aria-hidden': 'true', ...marked })
}

CapabilityCell.props = ['level', 'kinds', 'credentials', 'byCredential']

export default CapabilityCell
