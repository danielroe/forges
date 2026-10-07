import { defineEventHandler, getRouterParam, setResponseStatus } from 'nuxt/server'
import { errorBody, recordWebhookEvents, redactRaw, useForges } from '../../utils/forges'

export default defineEventHandler(async (event) => {
  const forge = getRouterParam(event, 'forge')!
  const provider = useForges().get(forge)
  if (!provider) {
    setResponseStatus(event, 404)
    return { error: { name: 'ProviderNotFound', message: `No ${forge} provider is configured` } }
  }
  try {
    const events = await provider.webhooks.ingest({
      headers: event.req.headers,
      body: new Uint8Array(await event.req.arrayBuffer()),
    })
    recordWebhookEvents(`${provider.forge}/${provider.instance}`, events)
    return redactRaw({ events })
  }
  catch (error) {
    const { status, body } = errorBody(error)
    setResponseStatus(event, status)
    return body
  }
})
