import type { CapabilityRow, SupportCell, SupportLevel } from '#capabilities'

export const supportLevels: SupportLevel[] = ['native', 'experimental', 'emulated', 'none']

export const supportLabels: Record<SupportLevel, string> = {
  native: 'Native and verified',
  experimental: 'Experimental',
  emulated: 'Emulated',
  none: 'Not available',
}

export const supportDescriptions: Record<SupportLevel, string> = {
  native: 'A test exercises the operation.',
  experimental: 'Native, but not verified against a recording of the live forge, or built on an API that the forge marks unstable.',
  emulated: 'Composed from other calls, so its behaviour can differ from a native operation.',
  none: 'Calling it rejects with UnsupportedOperationError.',
}

export const eventKindDescriptions: Record<string, string> = {
  native: 'The forge reports what kind of change each event is.',
  heuristic: 'Some kinds are read from the text of system notes, so wording the provider does not recognise comes through as other.',
}

export const shortSupportLabels: Record<SupportLevel, string> = {
  native: 'Native',
  experimental: 'Experimental',
  emulated: 'Emulated',
  none: 'Not available',
}

/**
 * Height of a header row whose labels are rotated 45 degrees, so the longest
 * label fits. Lengths are in characters of the label's monospace font.
 */
export function rotatedHeaderHeight(lengths: number[]): string {
  return `calc(${Math.max(...lengths)}ch * 0.71 + 3.5rem)`
}

/** Text for one cell, for screen readers. */
export function describeCell(cell: SupportCell): string {
  if (!cell.kinds) {
    return shortSupportLabels[cell.level]
  }
  const supported = cell.kinds.filter(kind => kind.level !== 'none')
  return supported.length
    ? supported.map(kind => `${kind.label} ${shortSupportLabels[kind.level].toLowerCase()}`).join(', ')
    : shortSupportLabels.none
}

/** Text for what a row does, for screen readers. */
export function describeRow(row: CapabilityRow): string {
  return [
    row.verbs.length ? `Calls ${row.verbs.map(verb => `${verb}()`).join(', ')}.` : '',
    row.write ? 'Changes state.' : '',
    row.account ? 'Needs an account.' : '',
  ].filter(Boolean).join(' ')
}
