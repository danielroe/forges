import { defineEventHandler, getRouterParam, setResponseStatus } from 'nuxt/server'
import { errorBody, redactRaw, useForges } from '../../utils/forges'

/** The `sources.stream` stream of the first provider of a forge, as server-sent events. */
export default defineEventHandler((event) => {
  const forge = getRouterParam(event, 'forge')!
  const provider = useForges().get(forge)
  if (!provider?.can('sources.stream')) {
    setResponseStatus(event, 404)
    return {
      error: { name: 'ProviderNotFound', message: `No ${forge} provider with a live feed is configured` },
    }
  }
  const encoder = new TextEncoder()
  const signal = event.req.signal
  const items = provider.sources.stream({ cursor: event.req.headers.get('last-event-id') ?? undefined, signal })
  const iterator = items[Symbol.asyncIterator]()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'))
    },
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(`id: ${value.cursor}\nevent: event\ndata: ${JSON.stringify(redactRaw(value))}\n\n`))
      }
      catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errorBody(error).body)}\n\n`))
        controller.close()
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
})
