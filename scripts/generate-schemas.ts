/**
 * Generates JSON Schemas for the public model types.
 *
 *   node scripts/generate-schemas.ts          writes src/schema/schemas.json
 *   node scripts/generate-schemas.ts --check  exits 1 when src/schema/schemas.json is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGenerator } from 'ts-json-schema-generator'

/** Model types a schema is generated for; their dependencies are included. */
export const ROOT_TYPES = [
  'Branch',
  'ChangedFile',
  'Check',
  'CiJob',
  'CiRun',
  'Collaborator',
  'Comment',
  'Commit',
  'Comparison',
  'Cursor',
  'FileContent',
  'ForgeCapabilities',
  'ForgeEvent',
  'ForgeWarning',
  'GetManyResult',
  'Installation',
  'InstallationToken',
  'Label',
  'Milestone',
  'Notification',
  'Reaction',
  'Release',
  'Repo',
  'RepoRole',
  'Review',
  'ReviewCommentInput',
  'SecurityAlert',
  'SubscriptionState',
  'Tag',
  'Thread',
  'TreeEntry',
  'UpsertCommentResult',
  'User',
  'Webhook',
  'WebhookDeliveryRecord',
]

type Schema = Record<string, unknown>

const root = fileURLToPath(new URL('..', import.meta.url))

function rewriteRefs(value: unknown, prefix: string): unknown {
  if (Array.isArray(value)) {
    return value.map(item => rewriteRefs(item, prefix))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      key === '$ref' && typeof item === 'string' ? item.replace(/^#\/(?:definitions|components\/schemas)\//, prefix) : rewriteRefs(item, prefix),
    ]))
  }
  return value
}

const BYTES_SCHEMA: Schema = { 'description': 'Bytes, as a `Uint8Array`. JSON cannot carry them.', 'x-forges-type': 'Uint8Array' }

function replaceByteArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(replaceByteArrays)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if ('BYTES_PER_ELEMENT' in ((value as { properties?: object }).properties ?? {})) {
    return BYTES_SCHEMA
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceByteArrays(item)]))
}

/** `name` and every schema it references, directly or through another. */
function dependenciesOf(name: string, schemas: Record<string, Schema>): string[] {
  const found = new Set<string>()
  const visit = (current: string) => {
    for (const [, ref] of JSON.stringify(schemas[current]).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
      if (!found.has(ref!)) {
        found.add(ref!)
        visit(ref!)
      }
    }
  }
  visit(name)
  return [...found].sort()
}

/** Every root type and its dependencies, keyed by type name, with refs pointing at OpenAPI components. */
export function generateSchemas(): Record<string, Schema> {
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
  return Object.fromEntries(Object.keys(definitions).sort().map(name => [
    name,
    { ...rewriteRefs(replaceByteArrays(definitions[name]), '#/components/schemas/') as Schema, 'x-forges-type': name },
  ]))
}

/** `name` as a self-contained draft-07 document, carrying only the definitions it references. */
export function standaloneSchema(name: string, schemas: Record<string, Schema>): Schema {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...rewriteRefs(schemas[name], '#/definitions/') as Schema,
    definitions: Object.fromEntries(dependenciesOf(name, schemas).map(other => [other, rewriteRefs(schemas[other], '#/definitions/')])),
  }
}

function main(): void {
  const target = `${root}src/schema/schemas.json`
  const output = `${JSON.stringify(generateSchemas(), null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== output) {
      console.error('src/schema/schemas.json is stale; run node scripts/generate-schemas.ts')
      process.exitCode = 1
    }
    return
  }
  writeFileSync(target, output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
