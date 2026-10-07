import type { RepoRef } from 'forges'
import process from 'node:process'
import { createForges } from 'forges'
import { providersFromEnv } from 'forges/env'
import { buildDigest, formatDigest } from './digest.ts'

const providers = providersFromEnv(process.env).flatMap(entry => entry.factory ? [entry.factory.create()] : [])
const forges = createForges(providers)

/** `forge:owner/name`, for example `github:acme/widgets` or `gitlab:acme/platform/widgets`. */
function parseRepo(argument: string): RepoRef {
  const [forge, path] = argument.split(':')
  const provider = forge ? forges.get(forge) : undefined
  if (!forge || !path || !provider) {
    throw new Error(`Expected <forge>:<owner>/<name> for a configured forge, got ${argument}`)
  }
  const segments = path.split('/')
  const name = segments.pop()
  if (!name || segments.length === 0) {
    throw new Error(`Expected <forge>:<owner>/<name>, got ${argument}`)
  }
  return { forge: provider.forge, instance: provider.instance, owner: segments.join('/'), name }
}

const repos = process.argv.slice(2).map(parseRepo)
if (repos.length === 0) {
  process.stderr.write('Usage: release-digest <forge>:<owner>/<name> ...\n')
  process.exit(1)
}

const result = await buildDigest(forges, repos)
process.stdout.write(`${formatDigest(result)}\n`)
for (const warning of result.warnings) {
  process.stderr.write(`warning: ${warning.code}: ${warning.message}\n`)
}
