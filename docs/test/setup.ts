import type { TestProject } from 'vitest/node'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

declare module 'vitest' {
  export interface ProvidedContext {
    baseURL: string
  }
}

const entry = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port')))
    })
  })
}

export default async function setup(project: TestProject) {
  if (!existsSync(entry)) {
    throw new Error('Build the docs first: `pnpm build:docs`')
  }

  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NITRO_PORT: String(port), NITRO_HOST: '127.0.0.1' },
    stdio: 'ignore',
  })

  const deadline = Date.now() + 30_000
  while (true) {
    try {
      await fetch(`${baseURL}/robots.txt`)
      break
    }
    catch {
      if (Date.now() > deadline || server.exitCode !== null) {
        server.kill()
        throw new Error(`The docs server did not start on ${baseURL}`)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  project.provide('baseURL', baseURL)

  return () => {
    server.kill()
  }
}
