import { getAgentDocument } from '#agent-discovery'

interface DocsResourceOptions {
  /** MCP resource name, unique on the server. */
  name: string
  /** Route of the documentation page, such as `/getting-started/quick-start`. */
  path: string
  title: string
  description: string
}

/** URI of the MCP resource that serves the documentation page at `path`. */
export function docsResourceUri(path: string): string {
  return `forges://docs${path}`
}

/** An MCP resource serving one documentation page as markdown. */
export function defineDocsResource({ name, path, title, description }: DocsResourceOptions) {
  return defineMcpResource({
    name,
    title,
    description,
    uri: docsResourceUri(path),
    metadata: { mimeType: 'text/markdown' },
    cache: '1h',
    handler: async (uri: URL) => {
      const document = await getAgentDocument(useEvent(), path)

      if (!document || 'redirect' in document) {
        throw createError({ statusCode: 404, message: `No documentation page at ${path}` })
      }

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/markdown',
            text: document.markdown,
          },
        ],
      }
    },
  })
}
