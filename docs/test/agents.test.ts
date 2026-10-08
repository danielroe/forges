import { request } from 'node:http'
import { describe, expect, inject, it } from 'vitest'

const baseURL = inject('baseURL')

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${baseURL}${path}`, { headers, redirect: 'follow' })
}

function curl(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number, contentType?: string, body: string }>((resolve, reject) => {
    request(`${baseURL}${path}`, { headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode!, contentType: response.headers['content-type'], body }))
    }).on('error', reject).end()
  })
}

async function mcp<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${baseURL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6)
    : text
  const message = JSON.parse(json)
  expect(message.error).toBeUndefined()
  return message.result
}

const docsResources = [
  { uri: 'forges://docs/pages', heading: '# forges documentation' },
  { uri: 'forges://docs/getting-started/quick-start', heading: '# Quick start' },
  { uri: 'forges://docs/reference/overview', heading: '# Reference' },
  { uri: 'forges://docs/reference/capability-matrix', heading: '# Capability matrix' },
  { uri: 'forges://docs/reference/errors', heading: '# Errors' },
]

describe('not found', () => {
  it.each([
    '/some-path-that-does-not-exist',
    '/__agent-404-probe',
    '/_agent-404-probe',
    '/guides/missing',
  ])('responds to a markdown request for %s with a markdown 404', async (path) => {
    const response = await get(path, { accept: 'text/markdown' })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toMatch(/^text\/markdown/)

    const body = await response.text()
    expect(body).toContain('# 404')
    expect(body).toContain(`The page \`${path}\` does not exist`)
    expect(body).toContain('/llms.txt)')
    expect(body).toContain('/sitemap.md)')
  })

  it('responds to curl with a markdown 404', async () => {
    const response = await curl('/__agent-404-probe', { 'accept': '*/*', 'user-agent': 'curl/8.7.1' })
    expect(response.status).toBe(404)
    expect(response.contentType).toMatch(/^text\/markdown/)
    expect(response.body).toContain('/llms.txt)')
  })

  it('responds to a browser with the HTML error page', async () => {
    const response = await get('/__agent-404-probe', { 'accept': 'text/html', 'sec-fetch-mode': 'navigate' })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toMatch(/^text\/html/)
  })

  it('leaves errors on internal routes alone', async () => {
    const response = await get('/api/missing', { accept: 'text/markdown' })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).not.toMatch(/markdown/)
  })

  it('serves internal routes unchanged to markdown requests', async () => {
    const response = await get('/api/__sitemap__/urls', { accept: 'text/markdown' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^application\/json/)
  })
})

describe('mcp', () => {
  it('names the server and advertises resources', async () => {
    const result = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    })
    expect(result.serverInfo.name).toBe('forges')
    expect(result.capabilities.resources).toBeDefined()
  })

  it('lists the documentation resources', async () => {
    const { resources } = await mcp<{ resources: Array<Record<string, string>> }>('resources/list')
    expect(resources.map(resource => resource.uri).sort()).toEqual(docsResources.map(resource => resource.uri).sort())
    for (const resource of resources) {
      expect(resource.name).toBeTruthy()
      expect(resource.title).toBeTruthy()
      expect(resource.description!.length).toBeGreaterThan(20)
      expect(resource.mimeType).toBe('text/markdown')
    }
  })

  it.each(docsResources)('reads $uri as markdown', async ({ uri, heading }) => {
    const { contents } = await mcp<{ contents: Array<Record<string, string>> }>('resources/read', { uri })
    expect(contents).toHaveLength(1)
    expect(contents[0]!.uri).toBe(uri)
    expect(contents[0]!.mimeType).toBe('text/markdown')
    expect(contents[0]!.text).toContain(heading)
  })

  it('links every page from the page index', async () => {
    const { contents } = await mcp<{ contents: Array<Record<string, string>> }>('resources/read', { uri: 'forges://docs/pages' })
    expect(contents[0]!.text).toMatch(/^- \[Quick start\]\(https?:\/\/[^)]+\/getting-started\/quick-start\): /m)
    expect(contents[0]!.text).toMatch(/^- \[Developers\]\(https?:\/\/[^)]+\/developers\): /m)
  })

  it('lists the resources on the server card', async () => {
    const response = await get('/.well-known/mcp/server-card.json')
    expect(response.status).toBe(200)
    const card = await response.json()
    expect(card.serverInfo.name).toBe('forges')
    expect(card.resources.map((resource: { uri: string }) => resource.uri).sort()).toEqual(docsResources.map(resource => resource.uri).sort())
  })
})

describe('generated reference', () => {
  it.each(['/reference/overview', '/reference/providers', '/reference/threads', '/reference/errors', '/contributing/provider-kit'])('serves %s', async (path) => {
    const response = await get(path)
    expect(response.status).toBe(200)
  })

  it('gives each heading the id that the generated links use', async () => {
    const html = await get('/reference/providers').then(response => response.text())
    expect(html).toMatch(/<h3 id="createforges"/)
    const threads = await get('/reference/threads').then(response => response.text())
    expect(threads).toMatch(/<h2 id="providerthreads"/)
    expect(threads).toContain('href="/reference/data-model#threadref"')
  })

  it('keeps the sidebar entry of the overview short', async () => {
    const html = await get('/reference/providers').then(response => response.text())
    const start = html.indexOf('href="/reference/overview"')
    const link = html.slice(start, start + html.slice(start).indexOf('</a>'))
    expect([...link.matchAll(/>([^<>]+)</g)].map(match => match[1])).toEqual(['Overview'])
  })
})

describe('developer portal', () => {
  it('serves /developers', async () => {
    const response = await get('/developers')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/html/)
    const html = await response.text()
    expect(html).toContain('<title>Developers - forges</title>')
    for (const path of ['/getting-started/quick-start', '/guides/authentication', '/guides/testing', '/reference/overview', '/llms.txt']) {
      expect(html).toContain(`href="${path}"`)
    }
  })

  it('serves /developers as markdown', async () => {
    const response = await get('/developers.md')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/markdown/)
    const body = await response.text()
    expect(body).toContain('# Developers')
    expect(body).toContain('import { fake } from \'forges/fake\'')
  })

  it('lists /developers in the sitemaps', async () => {
    expect(await get('/sitemap.xml').then(response => response.text())).toMatch(/<loc>[^<]*\/developers<\/loc>/)
    expect(await get('/sitemap.md').then(response => response.text())).toContain('/developers')
  })

  it('links the documentation from the homepage', async () => {
    const html = await get('/').then(response => response.text())
    expect(html).toContain('<title>One TypeScript client, every forge - forges</title>')
    for (const path of ['/developers', '/reference/overview', '/getting-started/introduction']) {
      expect(html).toContain(`href="${path}"`)
    }
  })
})
