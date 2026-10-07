import type { VerbScopes } from '#credentials'

type Access = NonNullable<VerbScopes['permissions']>[string]

const ACCESS: Access[] = ['read', 'write', 'admin']

function impliedBy(scope: string): string[] {
  return [scope.replace(/^read:/, 'write:'), `${scope}:write`, scope === 'read_api' ? 'api' : ''].filter(other => other && other !== scope)
}

/** Combines `scopesFor()` results: every token scope, the highest access for each permission, and every note. */
export function mergeScopes(list: VerbScopes[]): { token: string[], permissions: Array<[string, Access]>, notes: string[] } {
  const all = new Set(list.flatMap(scopes => scopes.token ?? []))
  const permissions = new Map<string, Access>()
  for (const [name, access] of list.flatMap(scopes => Object.entries(scopes.permissions ?? {}))) {
    if (ACCESS.indexOf(access) > ACCESS.indexOf(permissions.get(name) ?? 'read') || !permissions.has(name)) {
      permissions.set(name, access)
    }
  }
  return {
    token: [...all].filter(scope => !impliedBy(scope).some(other => all.has(other))),
    permissions: [...permissions].sort(([a], [b]) => a.localeCompare(b)),
    notes: [...new Set(list.flatMap(scopes => scopes.note ? [scopes.note] : []))],
  }
}

const CREDENTIAL_LABELS: Record<string, string> = {
  'TOKEN': 'Token',
  'APP_ID+PRIVATE_KEY': 'App',
  'USERNAME+PASSWORD': 'Username and password',
  'IDENTIFIER+PASSWORD': 'App password',
}

/** A short name for a credential made of `fields`. */
export function credentialLabel(fields: string[]): string {
  return CREDENTIAL_LABELS[fields.join('+')] ?? fields.join(' and ')
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Renders the inline Markdown of a step: code, links and bold. */
export function stepHtml(text: string): string {
  return text.split(/(`[^`]+`)/).map(part => part.startsWith('`')
    ? `<code>${escape(part.slice(1, -1))}</code>`
    : escape(part)
        .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1<span class="sr-only"> (opens in a new tab)</span></a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')).join('')
}
