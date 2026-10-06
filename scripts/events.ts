import type * as Forges from '../src/index.ts'
import type { NativeEventMap } from '../src/webhooks.ts'
import { BITBUCKET_NATIVE_EVENTS } from '../src/bitbucket/webhook-events.ts'
import { FORGEJO_NATIVE_EVENTS } from '../src/forgejo/webhook-events.ts'
import { GITEE_NATIVE_EVENTS } from '../src/gitee/webhook-events.ts'
import { GITHUB_NATIVE_EVENTS } from '../src/github/webhook-events.ts'
import { GITLAB_NATIVE_EVENTS } from '../src/gitlab/webhook-events.ts'
import { schemas } from '../src/schema/index.ts'
import { matrixProviders } from './capabilities.ts'

/** The native event map each provider's `webhooks.create()` translates `events` with, by docs slug. */
const SUBSCRIPTIONS: Record<string, NativeEventMap> = {
  github: GITHUB_NATIVE_EVENTS,
  gitlab: GITLAB_NATIVE_EVENTS,
  bitbucket: BITBUCKET_NATIVE_EVENTS,
  forgejo: FORGEJO_NATIVE_EVENTS,
  gitea: FORGEJO_NATIVE_EVENTS,
  gitee: GITEE_NATIVE_EVENTS,
}

export interface EventProvider {
  slug: string
  name: string
  /** `heuristic` when some kinds are inferred from free text. */
  eventKinds: string
  poll: boolean
  subscribe: boolean
  /** Whether `webhooks.create()` translates normalised kinds into native event names. */
  subscriptions: boolean
}

export interface EventCell {
  /** Whether `webhooks.events` lists the kind. */
  declared: boolean
  /** Actions `webhooks.events` lists for the kind. Empty when the kind is declared without an action. */
  actions: string[]
  /** Native event names `webhooks.create({ events: [kind] })` subscribes to. */
  subscribe: string[]
}

export interface EventDetailField {
  name: string
  type: string
  optional: boolean
}

export interface EventDetailShape {
  /** The `detail.type` discriminant. */
  type: string
  fields: EventDetailField[]
}

export interface EventKindRow {
  kind: string
  /** Every action any provider declares for the kind, in the order the providers declare them. */
  actions: string[]
  details: EventDetailShape[]
  /** One cell per provider, in `eventData().providers` order. */
  cells: EventCell[]
}

interface Schema {
  type?: string
  enum?: string[]
  const?: string
  $ref?: string
  items?: Schema
  anyOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
}

function typeName(schema: Schema): string {
  if (schema.$ref) {
    return schema.$ref.split('/').pop()!
  }
  if (schema.anyOf) {
    return schema.anyOf.map(typeName).join(' | ')
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const)
  }
  if (schema.enum) {
    return schema.enum.map(value => JSON.stringify(value)).join(' | ')
  }
  if (schema.type === 'array' && schema.items) {
    return `${typeName(schema.items)}[]`
  }
  return schema.type ?? 'unknown'
}

/** The `EventDetail` variants, from the generated JSON Schema, keyed by the kind they belong to. */
function detailShapes(kinds: string[]): Map<string, EventDetailShape[]> {
  const shapes = new Map<string, EventDetailShape[]>()
  for (const variant of (schemas.EventDetail as Schema).anyOf ?? []) {
    const type = variant.properties?.type?.const
    if (!type) {
      continue
    }
    const kind = kinds.find(kind => kind === type) ?? kinds.find(kind => type.startsWith(`${kind}_`))
    if (!kind) {
      continue
    }
    const fields = Object.entries(variant.properties ?? {})
      .filter(([name]) => name !== 'type')
      .map(([name, schema]) => ({ name, type: typeName(schema), optional: !variant.required?.includes(name) }))
    shapes.set(kind, [...shapes.get(kind) ?? [], { type, fields }])
  }
  return shapes
}

/** Event kinds and actions per provider that receives webhooks, from each provider's `webhooks.events`. */
export function eventData(forges: typeof Forges): { providers: EventProvider[], kinds: EventKindRow[], withoutWebhooks: string[] } {
  const all = matrixProviders(forges)
  const entries = all.filter(({ provider }) => provider.capabilities.sources.webhook)
  const kinds = (schemas.EventKind as Schema).enum ?? []
  const shapes = detailShapes(kinds)
  const unmapped = entries.find(({ slug, provider }) => provider.capabilities.webhooks.create && !(slug in SUBSCRIPTIONS))
  if (unmapped) {
    throw new Error(`No native event map for ${unmapped.name}, which supports webhooks.create`)
  }
  return {
    providers: entries.map(({ slug, name, provider: { capabilities } }) => ({
      slug,
      name,
      eventKinds: capabilities.eventKinds,
      poll: Boolean(capabilities.sources.poll),
      subscribe: Boolean(capabilities.sources.subscribe),
      subscriptions: Boolean(capabilities.webhooks.create),
    })),
    kinds: kinds.map((kind) => {
      const cells = entries.map(({ slug, provider }) => {
        const declared = provider.webhooks.events.filter(event => event.kind === kind)
        return {
          declared: declared.length > 0,
          actions: [...new Set(declared.flatMap(event => event.action ? [event.action] : []))],
          subscribe: [...SUBSCRIPTIONS[slug]?.[kind as Forges.EventKind] ?? []],
        }
      })
      return {
        kind,
        actions: [...new Set(cells.flatMap(cell => cell.actions))],
        details: shapes.get(kind) ?? [],
        cells,
      }
    }),
    withoutWebhooks: all.filter(entry => !entries.includes(entry)).map(({ name }) => name),
  }
}

const GENERATED = '<!-- Generated by `pnpm capability-matrix`; do not edit by hand. -->'

function list(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('')
}

/** Kinds and actions per provider, as the generated section of the events reference. */
export function eventMatrix(forges: typeof Forges): string {
  const { providers, kinds, withoutWebhooks } = eventData(forges)
  const heuristic = providers.filter(provider => provider.eventKinds === 'heuristic').map(({ name }) => name)
  return [
    GENERATED,
    '::event-matrix',
    `| Kind | ${providers.map(({ name }) => name).join(' | ')} |`,
    `| --- | ${providers.map(() => '---').join(' | ')} |`,
    ...kinds.map(({ kind, cells }) => `| \`${kind}\` | ${cells.map(cell => !cell.declared ? '❌' : cell.actions.length ? cell.actions.map(action => `\`${action}\``).join(', ') : 'any').join(' | ')} |`),
    '',
    ...withoutWebhooks.length ? [`${list(withoutWebhooks)} ${withoutWebhooks.length > 1 ? 'receive' : 'receives'} no webhooks.`, ''] : [],
    ...heuristic.length ? [`${list(heuristic)} ${heuristic.length > 1 ? 'report' : 'reports'} \`eventKinds: 'heuristic'\`, so \`kind\` can be \`other\` for wording the provider doesn't recognise.`] : [],
    '::',
  ].join('\n')
}

/** The `detail` fields and native event names of each kind, as the generated section of the events reference. */
export function eventKindsSection(forges: typeof Forges): string {
  const { providers, kinds } = eventData(forges)
  const subscribing = providers.flatMap((provider, index) => provider.subscriptions ? [{ provider, index }] : [])
  const fields = (shape: EventDetailShape) => shape.fields.map(field => `\`${field.name}${field.optional ? '?' : ''}: ${field.type.replaceAll('|', '\\|')}\``).join(', ')
  return [
    GENERATED,
    '::event-kinds',
    '| Kind | `detail.type` | Fields |',
    '| --- | --- | --- |',
    ...kinds.flatMap(({ kind, details }) => details.length
      ? details.map(shape => `| \`${kind}\` | \`${shape.type}\` | ${fields(shape) || 'none'} |`)
      : [`| \`${kind}\` | none | none |`]),
    '',
    `| Kind | ${subscribing.map(({ provider }) => provider.name).join(' | ')} |`,
    `| --- | ${subscribing.map(() => '---').join(' | ')} |`,
    ...kinds
      .filter(({ cells }) => subscribing.some(({ index }) => cells[index]!.subscribe.length))
      .map(({ kind, cells }) => `| \`${kind}\` | ${subscribing.map(({ index }) => cells[index]!.subscribe.map(name => `\`${name}\``).join(', ') || '❌').join(' | ')} |`),
    '::',
  ].join('\n')
}
