/**
 * Keeps the credentials of a recording out of its logs and its fixtures:
 *
 *   node scripts/fixture-secrets.ts mask <env-file>
 *   node scripts/fixture-secrets.ts scan <env-file> <path>...
 *
 * `mask` prints a GitHub Actions `add-mask` command for each credential in
 * the env file, and for the forms a request sends it in. `scan` exits with 1,
 * naming the file and the variable, when a file under any path holds one.
 * Variables whose name includes `TOKEN`, `PASSWORD`, `SECRET` or
 * `PRIVATE_KEY` are credentials; repositories, accounts and ids are not.
 */
import { Buffer } from 'node:buffer'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const CREDENTIAL = /TOKEN|PASSWORD|SECRET|PRIVATE_KEY/
const ACCOUNT = /(?:USERNAME|IDENTIFIER)$/

function base64(text: string): string {
  return Buffer.from(text).toString('base64')
}

/** Each credential, with the forms an `Authorization` header or a URL sends it in, by variable name. */
function credentialForms(env: Record<string, string | undefined>): Array<[name: string, form: string]> {
  const accounts = Object.entries(env).filter(([name, value]) => ACCOUNT.test(name) && value).map(([, value]) => value!)
  const forms: Array<[string, string]> = []
  for (const [name, value] of Object.entries(env)) {
    if (!CREDENTIAL.test(name) || !value || value.length < 8) {
      continue
    }
    const lines = value.includes('\n') ? value.split('\n').map(line => line.trim()).filter(line => line.length >= 20 && !line.startsWith('-----')) : []
    for (const form of [value, ...lines, base64(value), encodeURIComponent(value), base64(`:${value}`), base64(`x-access-token:${value}`), ...accounts.map(account => base64(`${account}:${value}`))]) {
      forms.push([name, form])
    }
  }
  return forms
}

function* files(path: string): Generator<string> {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) {
      yield* files(`${path}/${entry}`)
    }
  }
  else {
    yield path
  }
}

/** The files under `paths` that hold a credential, with the variable it came from. */
export function scanForCredentials(env: Record<string, string | undefined>, paths: string[]): Array<{ file: string, name: string }> {
  const forms = credentialForms(env)
  const found: Array<{ file: string, name: string }> = []
  for (const file of paths.flatMap(path => [...files(path)])) {
    const text = readFileSync(file, 'utf8')
    for (const name of new Set(forms.filter(([, form]) => text.includes(form)).map(([name]) => name))) {
      found.push({ file, name })
    }
  }
  return found
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, envFile, ...paths] = process.argv.slice(2)
  if (!envFile || (command !== 'mask' && command !== 'scan') || (command === 'scan' && !paths.length)) {
    console.error('Usage: node scripts/fixture-secrets.ts mask <env-file> | scan <env-file> <path>...')
    process.exit(1)
  }
  const env = parseEnv(readFileSync(envFile, 'utf8'))
  if (command === 'mask') {
    for (const [, form] of credentialForms(env)) {
      for (const line of form.split('\n').filter(Boolean)) {
        console.info(`::add-mask::${line}`)
      }
    }
  }
  else {
    const found = scanForCredentials(env, paths)
    for (const { file, name } of found) {
      console.error(`${file} holds the value of ${name}.`)
    }
    process.exitCode = found.length ? 1 : 0
  }
}
