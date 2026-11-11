/**
 * Generates the JSON Schema types and provider verb signatures, as one document.
 *
 *   node scripts/generate-schemas.ts          writes src/schema/schema.json
 *   node scripts/generate-schemas.ts --check  exits 1 when src/schema/schema.json is stale
 */
import type { Json, Schema } from './schema/json.ts'
import type { VerbSignature } from './schema/verbs.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGenerator } from 'ts-json-schema-generator'
import { BYTES_SCHEMA, isRecord, refs, sortByKey, tidyDescriptions } from './schema/json.ts'
import { generateVerbSignatures } from './schema/verbs.ts'

/** Model types a schema is generated for; their dependencies are included. */
export const ROOT_TYPES = [
  'AddCollaboratorResult',
  'Branch',
  'BranchRules',
  'ChangedFile',
  'Check',
  'CiJob',
  'CiRun',
  'CodeMatch',
  'Collaborator',
  'Comment',
  'Commit',
  'CommitComment',
  'Comparison',
  'Contributor',
  'ContributorStats',
  'RepoTemplate',
  'Cursor',
  'FileContent',
  'ForgeCapabilities',
  'ForgeEvent',
  'ForgeWarning',
  'GetManyResult',
  'Installation',
  'InstallationToken',
  'Label',
  'MergeResult',
  'Milestone',
  'Notification',
  'Reaction',
  'Release',
  'Repo',
  'RepoRole',
  'Review',
  'ReviewCommentInput',
  'ReviewThread',
  'SecurityAlert',
  'SponsorableManyResult',
  'SubscriptionState',
  'Tag',
  'Thread',
  'TreeEntry',
  'UpdateBranchResult',
  'User',
  'Webhook',
  'WebhookDeliveryRecord',
]

const root = fileURLToPath(new URL('..', import.meta.url))

function rewriteRefs(value: Json, prefix: string): Json {
  if (Array.isArray(value)) {
    return value.map(item => rewriteRefs(item, prefix))
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === '$ref' && typeof item === 'string'
      ? item.replace(/^#\/(?:definitions|components\/schemas)\//, prefix)
      : rewriteRefs(item, prefix),
  ]))
}

function replaceByteArrays(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(replaceByteArrays)
  }
  if (!isRecord(value)) {
    return value
  }
  const { properties } = value
  if (isRecord(properties) && 'BYTES_PER_ELEMENT' in properties) {
    return BYTES_SCHEMA
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    replaceByteArrays(item),
  ]))
}

/** `name` and every model it references, directly or through another. */
function dependenciesOf(name: string, models: Record<string, Schema>): string[] {
  const found = new Set<string>()
  const visit = (current: string) => {
    for (const ref of refs(models[current]!)) {
      if (!found.has(ref)) {
        found.add(ref)
        visit(ref)
      }
    }
  }
  visit(name)
  return [...found].sort()
}

/** Every model root and its dependencies, keyed by model name, with refs pointing at OpenAPI components. */
function generateModels(): Record<string, Schema> {
  const generator = createGenerator({
    path: `${root}src/index.ts`,
    tsconfig: `${root}tsconfig.json`,
    expose: 'export',
    skipTypeCheck: true,
    topRef: false,
    jsDoc: 'extended',
    functions: 'hide',
    additionalProperties: true,
  })
  const definitions: Record<string, Schema> = {}
  for (const type of ROOT_TYPES) {
    const { definitions: found = {}, $schema: _, ...schema } = generator.createSchema(type) as Schema & { definitions?: Record<string, Schema> }
    Object.assign(definitions, found, { [type]: schema })
  }
  return sortByKey(Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [
    name,
    {
      ...rewriteRefs(tidyDescriptions(replaceByteArrays(definition)), '#/components/schemas/') as Schema,
      'x-forges-type': name,
    },
  ])))
}

export interface SchemaBundle {
  models: Record<string, Schema>
  verbs: Record<string, VerbSignature>
}

/** All published models and verb signatures. */
export function generateSchemaBundle(): SchemaBundle {
  const { components, verbs } = generateVerbSignatures()
  return {
    models: sortByKey({
      ...components,
      ...generateModels(),
    }),
    verbs,
  }
}

/** `name` as a self-contained draft-07 document, carrying only the definitions it references. */
export function standaloneSchema(name: string, models: Record<string, Schema>): Schema {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...rewriteRefs(models[name]!, '#/definitions/') as Schema,
    definitions: Object.fromEntries(dependenciesOf(name, models).map(other => [
      other,
      rewriteRefs(models[other]!, '#/definitions/'),
    ])),
  }
}

function main(): void {
  const { models, verbs } = generateSchemaBundle()
  const target = `${root}src/schema/schema.json`
  const output = `${JSON.stringify({ verbs, models }, null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== output) {
      console.error('src/schema/schema.json is stale; run node scripts/generate-schemas.ts')
      process.exitCode = 1
    }
    return
  }
  writeFileSync(target, output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
