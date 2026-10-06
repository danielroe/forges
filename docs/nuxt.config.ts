import process from 'node:process'

// Vercel previews and branch deployments point at themselves.
const previewUrl = process.env.VERCEL_ENV !== 'production' && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined

export default defineNuxtConfig({
  extends: ['docus'],
  site: {
    name: 'forges',
    url: previewUrl ?? 'https://forges.link',
    description: 'One TypeScript API for issues, pull requests, notifications, checks and webhooks on every code forge.',
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
