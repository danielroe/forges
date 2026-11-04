import { listAgentPages } from '#agent-discovery'

export default defineMcpResource({
  name: 'pages',
  title: 'Documentation pages',
  description: 'Every page of the forges documentation with its URL and summary. Read a page with the `get-page` tool, or fetch its URL with `Accept: text/markdown`.',
  uri: docsResourceUri('/pages'),
  metadata: { mimeType: 'text/markdown' },
  cache: '1h',
  handler: async (uri: URL) => {
    const pages = await listAgentPages(useEvent())
    const lines = pages
      .filter(page => page.route !== '/')
      .map(page => `- [${page.title || page.route}](${page.url})${page.description
        ? `: ${page.description}`
        : ''}`)

    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/markdown',
          text: [
            '# forges documentation',
            '',
            ...lines,
            '',
          ].join('\n'),
        },
      ],
    }
  },
})
