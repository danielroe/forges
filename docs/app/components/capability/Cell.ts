import type { FunctionalComponent } from 'vue'
import { h } from 'vue'

interface CapabilityCellProps {
  level: string
  signedIn?: boolean
  kinds?: Array<{ kind: string, label: string, level: string, signedIn?: boolean }>
}

// Functional, as the matrices render hundreds of cells.
const CapabilityCell: FunctionalComponent<CapabilityCellProps> = ({ level, signedIn, kinds }) => kinds
  ? h('span', { 'class': 'capability-cell capability-kinds', 'aria-hidden': 'true' }, kinds.map(kind => h('span', { 'key': kind.kind, 'class': 'capability-swatch', 'data-level': kind.level, 'data-signed-in': kind.signedIn || undefined })))
  : h('span', { 'class': 'capability-cell capability-swatch', 'data-level': level, 'data-signed-in': signedIn || undefined, 'aria-hidden': 'true' })

CapabilityCell.props = ['level', 'signedIn', 'kinds']

export default CapabilityCell
