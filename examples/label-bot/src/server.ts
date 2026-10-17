import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import process from 'node:process'
import { createForges } from 'forges'
import { providersFromEnv } from 'forges/env'
import { createHandler } from './handler.ts'

const providers = providersFromEnv(process.env).flatMap(entry => entry.provider ? [entry.provider] : [])
if (providers.length === 0) {
  process.stderr.write('No providers configured. Set FORGES_GITHUB_TOKEN and FORGES_GITHUB_WEBHOOK_SECRET.\n')
  process.exit(1)
}

const handler = createHandler({
  forges: createForges(providers),
  titlePattern: new RegExp(process.env.LABEL_BOT_PATTERN ?? '^(feat|fix)[(:]', 'i'),
  label: process.env.LABEL_BOT_LABEL ?? 'triage',
  comment: process.env.LABEL_BOT_COMMENT ?? 'Thanks! This has been queued for triage.',
})

const port = Number(process.env.PORT ?? 3000)

createServer((incoming, outgoing) => {
  const chunks: Buffer[] = []
  incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
  incoming.on('end', () => {
    const request = new Request(`http://localhost:${port}${incoming.url ?? '/'}`, {
      method: incoming.method,
      headers: Object.entries(incoming.headers).map(([name, value]): [string, string] => [
        name,
        Array.isArray(value) ? value.join(',') : value ?? '',
      ]),
      body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    })
    handler(request)
      .then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(await response.text())
      })
      .catch((error: unknown) => {
        outgoing.writeHead(500, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown error' }))
      })
  })
}).listen(port, () => process.stdout.write(`label-bot listening on http://127.0.0.1:${port}/webhooks/<forge>\n`))
