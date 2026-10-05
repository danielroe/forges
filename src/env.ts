import type { FetchLike } from './fetch.ts'
import type { ForgeOptionsBase, ForgeProviderFactory, Forges } from './provider.ts'
import { azureDevOps } from './azure-devops/index.ts'
import { bitbucket } from './bitbucket/index.ts'
import { cursorOrigin } from './cursor-origin/index.ts'
import { forgejo } from './forgejo/index.ts'
import { gitea } from './gitea/index.ts'
import { gitee } from './gitee/index.ts'
import { github } from './github/index.ts'
import { gitlab } from './gitlab/index.ts'
import { createForges } from './provider.ts'
import { pushin } from './pushin/index.ts'
import { tangled } from './tangled/index.ts'

const KINDS = ['GITHUB', 'GITLAB', 'BITBUCKET', 'FORGEJO', 'GITEA', 'TANGLED', 'CURSOR_ORIGIN', 'GITEE', 'AZURE_DEVOPS', 'PUSHIN'] as const

/** Field names, longest first so `INSTANCE_VERSION` is not read as `INSTANCE` with suffix `VERSION`. */
const FIELDS = [
  'NOTIFICATIONS_URL',
  'INSTANCE_VERSION',
  'INSTALLATION_ID',
  'WEBHOOK_SECRET',
  'PRIVATE_KEY',
  'ORGANIZATION',
  'IDENTIFIER',
  'READ_ONLY',
  'BASE_URL',
  'PASSWORD',
  'USERNAME',
  'DEMO_REPO',
  'INSTANCE',
  'API_URL',
  'ENABLED',
  'APP_ID',
  'TOKEN',
  'PDS',
] as const

type Field = typeof FIELDS[number]

export interface EnvProvider {
  kind: string
  /** The part after the field, for example `WORK` in `FORGES_GITHUB_TOKEN_WORK`. Empty for the unsuffixed set. */
  suffix: string
  factory?: ForgeProviderFactory
  /** Instance host the factory's providers report, when the set was not skipped. */
  instance?: string
  /** Why the set was skipped, when it was. Never contains a credential. */
  skipped?: string
  /** `DEMO_REPO`: a repository to show, as `owner/name`. GitLab owners may contain slashes. */
  demoRepo?: { owner: string, name: string }
}

function parseRepo(value: string | undefined): { owner: string, name: string } | undefined {
  const path = value?.replace(/^@/, '')
  const slash = path?.lastIndexOf('/') ?? -1
  return path && slash > 0 ? { owner: path.slice(0, slash), name: path.slice(slash + 1) } : undefined
}

export interface FromEnvOptions {
  /** Passed to every provider, for tests and runtimes without a global `fetch`. */
  fetch?: FetchLike
}

/**
 * Reads provider sets from `FORGES_<KIND>_<FIELD>[_<SUFFIX>]` variables. A
 * suffix starts another instance of the same forge.
 */
export function providersFromEnv(env: Record<string, string | undefined>, options: FromEnvOptions = {}): EnvProvider[] {
  const sets = new Map<string, { kind: typeof KINDS[number], suffix: string, fields: Partial<Record<Field, string>> }>()
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('FORGES_') || value === undefined || value === '') {
      continue
    }
    const rest = key.slice('FORGES_'.length)
    const kind = KINDS.find(candidate => rest === candidate || rest.startsWith(`${candidate}_`))
    if (!kind) {
      continue
    }
    const tail = rest.slice(kind.length + 1)
    const fieldName = FIELDS.find(candidate => tail === candidate || tail.startsWith(`${candidate}_`))
    if (!fieldName) {
      continue
    }
    const suffix = tail.slice(fieldName.length + 1)
    const id = `${kind}:${suffix}`
    const set = sets.get(id) ?? { kind, suffix, fields: {} }
    set.fields[fieldName] = value
    sets.set(id, set)
  }

  return [...sets.values()].map(set => withInstance(fromFields(set.kind, set.suffix, set.fields, options)))
}

/** Adds `instance`, creating a provider only when it is first read. */
function withInstance(entry: EnvProvider): EnvProvider {
  const { factory } = entry
  if (!factory) {
    return entry
  }
  let instance: string | undefined
  return Object.defineProperty({ ...entry }, 'instance', {
    enumerable: true,
    configurable: true,
    get: () => instance ??= factory.create().instance,
    set: (value: string | undefined) => {
      instance = value
    },
  })
}

function fromFields(kind: typeof KINDS[number], suffix: string, fields: Partial<Record<Field, string>>, options: FromEnvOptions): EnvProvider {
  const base: ForgeOptionsBase = {
    ...options.fetch ? { fetch: options.fetch } : {},
    ...fields.BASE_URL ? { baseUrl: fields.BASE_URL } : {},
    ...fields.WEBHOOK_SECRET ? { webhookSecret: fields.WEBHOOK_SECRET } : {},
    ...fields.INSTANCE ? { instance: fields.INSTANCE } : {},
    ...fields.INSTANCE_VERSION ? { instanceVersion: fields.INSTANCE_VERSION } : {},
    ...isOn(fields.READ_ONLY) ? { readOnly: true } : {},
  }
  const demoRepo = parseRepo(fields.DEMO_REPO)
  const anonymous = isOn(fields.ENABLED) || Boolean(demoRepo)
  const entry = { kind: kind.toLowerCase().replaceAll('_', '-'), suffix, ...demoRepo ? { demoRepo } : {} }
  if (fields.ENABLED === '0' || fields.ENABLED === 'false') {
    return { ...entry, skipped: 'ENABLED is off' }
  }
  switch (kind) {
    case 'GITHUB':
      if (fields.APP_ID && fields.PRIVATE_KEY) {
        return {
          ...entry,
          factory: github({
            ...base,
            auth: { type: 'app', appId: fields.APP_ID, privateKey: fields.PRIVATE_KEY.replaceAll('\\n', '\n'), installationId: fields.INSTALLATION_ID },
          }),
        }
      }
      if (fields.TOKEN || anonymous) {
        return { ...entry, factory: github({ ...base, ...fields.TOKEN ? { auth: { type: 'token', token: fields.TOKEN } } : {} }) }
      }
      return { ...entry, skipped: 'needs TOKEN, or APP_ID and PRIVATE_KEY, or ENABLED for anonymous reads' }
    case 'BITBUCKET':
      if (fields.USERNAME && fields.PASSWORD) {
        return { ...entry, factory: bitbucket({ ...base, auth: { type: 'basic', username: fields.USERNAME, password: fields.PASSWORD } }) }
      }
      if (fields.TOKEN || anonymous) {
        return { ...entry, factory: bitbucket({ ...base, ...fields.TOKEN ? { auth: { type: 'token', token: fields.TOKEN } } : {} }) }
      }
      return { ...entry, skipped: 'needs TOKEN, or USERNAME and PASSWORD, or ENABLED for anonymous reads' }
    case 'AZURE_DEVOPS': {
      if (!fields.ORGANIZATION) {
        return { ...entry, skipped: 'needs ORGANIZATION' }
      }
      const auth = fields.USERNAME && fields.PASSWORD
        ? { type: 'basic' as const, username: fields.USERNAME, password: fields.PASSWORD }
        : fields.TOKEN ? { type: 'token' as const, token: fields.TOKEN } : undefined
      return auth || anonymous
        ? { ...entry, factory: azureDevOps({ ...base, organization: fields.ORGANIZATION, ...auth ? { auth } : {} }) }
        : { ...entry, skipped: 'needs TOKEN, or USERNAME and PASSWORD, or ENABLED for anonymous reads' }
    }
    case 'CURSOR_ORIGIN':
      if (fields.APP_ID && fields.PRIVATE_KEY) {
        return {
          ...entry,
          factory: cursorOrigin({
            ...base,
            auth: { type: 'app', appId: fields.APP_ID, privateKey: fields.PRIVATE_KEY.replaceAll('\\n', '\n'), installationId: fields.INSTALLATION_ID },
          }),
        }
      }
      return fields.TOKEN
        ? { ...entry, factory: cursorOrigin({ ...base, auth: { type: 'token', token: fields.TOKEN } }) }
        : { ...entry, skipped: 'needs TOKEN, or APP_ID and PRIVATE_KEY' }
    case 'TANGLED':
      return {
        ...entry,
        factory: tangled({
          ...base,
          ...fields.API_URL ? { apiUrl: fields.API_URL } : {},
          ...fields.NOTIFICATIONS_URL ? { notificationsUrl: fields.NOTIFICATIONS_URL } : {},
          ...fields.IDENTIFIER && fields.PASSWORD
            ? { auth: { type: 'app_password', identifier: fields.IDENTIFIER, password: fields.PASSWORD, ...fields.PDS ? { pds: fields.PDS } : {} } }
            : {},
        }),
      }
    default: {
      if (!fields.TOKEN && !anonymous) {
        return { ...entry, skipped: 'needs TOKEN, or ENABLED for anonymous reads' }
      }
      const create = { GITLAB: gitlab, FORGEJO: forgejo, GITEA: gitea, GITEE: gitee, PUSHIN: pushin }[kind]
      return { ...entry, factory: create({ ...base, ...fields.TOKEN ? { auth: { type: 'token', token: fields.TOKEN } } : {} }) }
    }
  }
}

function isOn(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/** Builds `Forges` from environment variables; see {@link providersFromEnv}. */
export function forgesFromEnv(env: Record<string, string | undefined>, options: FromEnvOptions = {}): Forges {
  return createForges(providersFromEnv(env, options).flatMap(entry => entry.factory ? [entry.factory] : []))
}
