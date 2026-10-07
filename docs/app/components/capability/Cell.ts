import type { FunctionalComponent } from 'vue'
import { h } from 'vue'

interface CapabilityCellProps {
  level: string
  kinds?: Array<{ kind: string, label: string, level: string }>
}

// Functional, as the matrices render hundreds of cells.
const CapabilityCell: FunctionalComponent<CapabilityCellProps> = ({ level, kinds }) => kinds
  ? h('span', { 'class': 'capability-cell capability-kinds', 'aria-hidden': 'true' }, kinds.map(kind => h('span', { 'key': kind.kind, 'class': 'capability-swatch', 'data-level': kind.level })))
  : h('span', { 'class': 'capability-cell capability-swatch', 'data-level': level, 'aria-hidden': 'true' })

CapabilityCell.props = ['level', 'kinds']

export default CapabilityCell
