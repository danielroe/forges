import process from 'node:process'

// Vercel previews and branch deployments point at themselves.
const previewUrl = process.env.VERCEL_ENV !== 'production' && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined
const url = previewUrl ?? 'https://forges.link'

export default defineNuxtConfig({
  extends: ['docus'],
  docus: {
    assistant: {
      enabled: false,
    },
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
  runtimeConfig: {
    // Server-only token for listing contributors of a private repository.
    githubToken: process.env.GITHUB_TOKEN ?? '',
  },
  app: {
    head: {
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
})
