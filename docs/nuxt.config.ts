import process from 'node:process'
import { codeThemes } from './shared/code-theme.ts'

// magic comment to trigger deployment until repo is public - abracadabra 👀

// Vercel previews and branch deployments point at themselves.
const previewUrl = process.env.VERCEL_ENV !== 'production' && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined
const url = previewUrl ?? 'https://forges.link'

// CI builds only to run the docs tests, so drop server source maps and the
// node_modules trace. Env-gated: Vercel's deploy needs the trace.
const isTestBuild = process.env.DOCS_TEST_ONLY_BUILD === '1'

export default defineNuxtConfig({
  extends: ['docus'],
  nitro: isTestBuild
    ? { sourceMap: false, externals: { trace: false } }
    : {},
  modules: ['@nuxt/fonts', '@nuxtjs/critters'],
  content: {
    build: {
      markdown: {
        highlight: { theme: codeThemes },
      },
    },
  },
  docus: {
    assistant: {
      enabled: false,
    },
  },
  agentDiscovery: {
    // Narrower than the default `/_`, so a missing `/__*` page still gets a markdown 404.
    excludePrefixes: {
      replace: ['/_nuxt/', '/__nuxt', '/_og', '/_ipx/', '/_fonts/', '/_vercel/', '/__sitemap__/', '/api/', '/mcp', '/.well-known/'],
    },
  },
  mcp: {
    name: 'forges',
  },
  critters: {
    config: {
      // The color mode script adds `.dark` to `<html>` before first paint, so the dark theme stays inlined.
      allowRules: [/\.dark\b/],
      inlineFonts: true,
    },
  },
  fonts: {
    families: [
      {
        name: 'Fraenkisch',
        provider: 'local',
        weights: [400],
        styles: ['normal'],
        display: 'swap',
        global: true,
        fallbacks: ['Georgia', 'Noto Serif', 'Times New Roman'],
      },
      {
        name: 'JetBrains Mono',
        provider: 'fontsource',
        weights: [400, 500, 700],
        styles: ['normal', 'italic'],
      },
    ],
    defaults: { subsets: ['latin'] },
  },
  site: {
    name: 'forges',
    url,
  },
  icon: {
    clientBundle: {
      // Not found by the bundle scan.
      icons: [
        'lucide:book-marked',
        'lucide:compass',
        'lucide:git-pull-request',
        'lucide:rocket',
        'vscode-icons:file-type-bun',
        'vscode-icons:file-type-npm',
        'vscode-icons:file-type-pnpm',
        'vscode-icons:file-type-yarn',
      ],
    },
  },
  experimental: {
    defaults: {
      nuxtLink: {
        prefetchOn: { visibility: false, interaction: true },
      },
    },
  },
  runtimeConfig: {
    // Server-only token for listing contributors of a private repository.
    githubToken: process.env.GITHUB_TOKEN ?? '',
  },
  app: {
    head: {
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
  hooks: {
    // Links prefetch on interaction and lazy components load on hydration, so no chunk needs `<link rel="prefetch">`.
    'build:manifest': (manifest) => {
      for (const chunk of Object.values(manifest)) {
        chunk.prefetch = false
      }
    },
  },
})
