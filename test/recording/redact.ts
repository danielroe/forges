const USER_KEYS_TO_DROP = new Set([
  'account_status',
  'can_create_group',
  'can_create_project',
  'collaborators',
  'color_scheme_id',
  'confirmed_at',
  'created',
  'current_sign_in_at',
  'disk_usage',
  'external',
  'has_2fa_enabled',
  'identities',
  'is_admin',
  'is_auditor',
  'language',
  'last_activity_on',
  'last_login',
  'last_sign_in_at',
  'login_name',
  'namespace_id',
  'owned_private_repos',
  'plan',
  'private_gists',
  'private_profile',
  'prohibit_login',
  'projects_limit',
  'restricted',
  'scim_identities',
  'theme_id',
  'total_private_repos',
  'two_factor_authentication',
  'two_factor_enabled',
  'using_license_seat',
  'visibility',
])
const TOKEN_PATTERN = /\b(?:gh[pousr]_\w{20,}|github_pat_\w{20,}|pun_pat_\w{20,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)/g
const SECRET_KEY = /password|secret|^(?:token|access_token|refresh_token|accessJwt|refreshJwt)$/i

const UNATTACHED_UPLOAD = /\/attachments\/[\da-f-]{36}$/

/** Keeps one upload that a release lists but does not own, with nothing that identifies it, and drops the rest. */
function withoutUnattachedUploads(assets: unknown[]): unknown[] {
  const isUpload = (asset: unknown) => UNATTACHED_UPLOAD.test(String((asset as { browser_download_url?: unknown } | null)?.browser_download_url))
  const upload = assets.find(isUpload) as Record<string, unknown> | undefined
  const uuid = '00000000-0000-0000-0000-000000000000'
  return [
    ...assets.filter(asset => !isUpload(asset)),
    ...upload ? [{ ...upload, id: 0, name: 'redacted', uuid, size: 0, download_count: 0, browser_download_url: String(upload.browser_download_url).replace(UNATTACHED_UPLOAD, `/attachments/${uuid}`) }] : [],
  ]
}

function isPrivate(value: unknown): boolean {
  const item = value as { private?: boolean, visibility?: string, is_private?: boolean } | null | undefined
  return Boolean(item && typeof item === 'object' && (item.private || item.is_private || item.visibility === 'private'))
}

/**
 * Removes what a recording must not keep from a recorded body: tokens,
 * passwords and secrets, email addresses, private account details and
 * private repositories.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    // Azure DevOps names accounts by their email address.
    if (/^[^@\s:/]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) {
      return 'redacted@example.invalid'
    }
    return value
      .replace(TOKEN_PATTERN, 'REDACTED_TOKEN')
      .replace(/<[^<>@\s]+@[^<>\s]+>/g, '<redacted@example.invalid>')
      .replace(/^(https:\/\/)[^@/]+@/, '$1')
  }
  if (Array.isArray(value)) {
    return value
      .filter(item => !isPrivate(item) && !isPrivate((item as { repository?: unknown } | null)?.repository))
      .map(redact)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const isUser = 'login' in value || 'username' in value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/email/i.test(key)) {
      result[key] = entry ? 'redacted@example.invalid' : entry
    }
    else if (SECRET_KEY.test(key) && typeof entry === 'string') {
      result[key] = 'REDACTED'
    }
    else if (isUser && USER_KEYS_TO_DROP.has(key)) {
      continue
    }
    else if (isUser && key === 'node_id') {
      result[key] = 'REDACTED'
    }
    // A Forgejo Actions run repeats its whole webhook delivery, commit messages and all, and nothing reads it.
    else if (key === 'event_payload') {
      continue
    }
    else if (key === 'assets' && 'tag_name' in value && Array.isArray(entry)) {
      result[key] = redact(withoutUnattachedUploads(entry))
    }
    else {
      result[key] = redact(entry)
    }
  }
  return result
}
