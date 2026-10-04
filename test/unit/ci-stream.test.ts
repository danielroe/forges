import { expect, it } from 'vitest'
import { github } from '../../src/github/index.ts'
import { gitlab } from '../../src/gitlab/index.ts'

it.each([
  { kind: 'github', factory: github, instance: 'github.com' },
  { kind: 'gitlab', factory: gitlab, instance: 'gitlab.com' },
])('streams $kind CI logs beyond the header timeout', async ({ kind, factory, instance }) => {
  const provider = factory({ auth: { type: 'token', token: 't' }, timeout: 10, fetch: async (_url, init) => new Response(new ReadableStream({
    async start(controller) {
      await new Promise(resolve => setTimeout(resolve, 30))
      if (init!.signal!.aborted) {
        controller.error(init!.signal!.reason)
      }
      else {
        controller.enqueue(new TextEncoder().encode('log'))
        controller.close()
      }
    },
  })) }).create()
  const repo = { forge: kind, instance, owner: 'acme', name: 'widgets' }
  const run = { forge: kind, instance, repo, id: '1' }
  const body = await provider.ci.log({ forge: kind, instance, repo, run, id: '2' })

  expect(await new Response(body).text()).toBe('log')
})
