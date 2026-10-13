import type { CapabilityProvider, CapabilityRow, SupportCell, SupportLevel } from '#capabilities'

/**
 * A credential view: `true` or `'anonymous'` for none, a credential id for
 * one kind of credential, or anything else for the best of any credential.
 */
type View = boolean | string | undefined

const isAnonymous = (view: View) => view === true || view === 'anonymous'

/** A row's cells in a view. Forges without the credential show their best support. */
export function cellsFor(row: CapabilityRow, view: View): SupportCell[] {
  if (isAnonymous(view)) {
    return row.anonymousCells
  }
  return typeof view === 'string' ? row.cells.map(cell => cell.byCredential?.[view] ?? cell) : row.cells
}

/** A provider's summary in a view. */
export function summaryFor(provider: CapabilityProvider, view: View): Record<SupportLevel, number> {
  if (isAnonymous(view)) {
    return provider.anonymousSummary
  }
  return (typeof view === 'string' && provider.credentials?.find(({ id }) => id === view)?.summary) || provider.summary
}

/** The labels of credentials by id, as prose such as "a classic token or an app". */
export function credentialNames(ids: string[], provider: CapabilityProvider): string {
  const names = ids.map((id) => {
    const label = provider.credentials?.find(credential => credential.id === id)?.label ?? id
    return `${/^[aeio]/i.test(label) ? 'an' : 'a'} ${label.charAt(0).toLowerCase()}${label.slice(1)}`
  })
  return new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(names)
}

export const supportLevels: SupportLevel[] = ['native', 'experimental', 'emulated', 'unverified', 'none']

export const supportLabels: Record<SupportLevel, string> = {
  native: 'Native and verified',
  experimental: 'Experimental',
  emulated: 'Emulated',
  unverified: 'Unverified',
  none: 'Not available',
}

export const supportDescriptions: Record<SupportLevel, string> = {
  native: 'A test verifies the operation against the forge\'s own responses.',
  experimental: 'Verified, but built on an API that the forge marks unstable or in preview.',
  emulated: 'Composed from other calls, so its behaviour can differ from a native operation.',
  unverified: 'Implemented, but not yet verified against the forge\'s responses, so it may not work.',
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
  unverified: 'Unverified',
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
export function describeCell(cell: SupportCell, provider?: CapabilityProvider): string {
  const supported = cell.kinds?.filter(kind => kind.level !== 'none')
  const text = !supported
    ? shortSupportLabels[cell.level]
    : supported.length
      ? supported.map(kind => `${kind.label} ${shortSupportLabels[kind.level].toLowerCase()}`).join(', ')
      : shortSupportLabels.none
  return cell.credentials && provider ? `${text}, only with ${credentialNames(cell.credentials, provider)}` : text
}

/** A provider's coverage as text, for the bars that only show the native count. */
export function describeSummary(summary: Record<SupportLevel, number>): string {
  return supportLevels.filter(level => summary[level]).map(level => `${summary[level]} ${shortSupportLabels[level].toLowerCase()}`).join(', ')
}

/** Text for what a row does, for screen readers. */
export function describeRow(row: CapabilityRow): string {
  return [
    row.verbs.length ? `Calls ${row.verbs.map(verb => `${verb}()`).join(', ')}.` : '',
    row.write ? 'Changes state.' : '',
    row.account ? 'Needs an account.' : '',
  ].filter(Boolean).join(' ')
}
