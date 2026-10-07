import type { Forges } from 'forges'
import type { Action, LabelBotOptions } from './bot.ts'
import { WebhookVerificationError } from 'forges'
import { createLabelBot } from './bot.ts'

export interface HandlerOptions extends LabelBotOptions {
  forges: Forges
  /** Path deliveries are posted to, before the `/{forge}` segment. Defaults to `/webhooks`. */
  basePath?: string
}

export interface DeliveryResult {
  forge: string
  actions: Action[]
}

/** A `(Request) => Promise<Response>` receiver, mountable anywhere that speaks web standards. */
export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const bot = createLabelBot(options)
  const basePath = options.basePath ?? '/webhooks'

  return async function handler(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method !== 'POST' || !pathname.startsWith(`${basePath}/`)) {
      return new Response('not found', { status: 404 })
    }

    const [kind, instance] = pathname.slice(basePath.length + 1).split('/')
    const provider = kind ? options.forges.get(kind, instance) : undefined
    if (!provider) {
      return Response.json({ error: `no provider configured for ${pathname}` }, { status: 404 })
    }

    const body = await request.text()
    try {
      const actions = await bot.ingest(provider, { headers: request.headers, body })
      return Response.json({ forge: provider.forge, actions } satisfies DeliveryResult)
    }
    catch (error) {
      if (error instanceof WebhookVerificationError) {
        return Response.json({ error: error.message }, { status: 401 })
      }
      throw error
    }
  }
}
