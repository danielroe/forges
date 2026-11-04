import type { ForgeProvider } from 'forges'
import type { getContributors } from './contributors.ts'

export function contributorHomepage(blog: string | null, profileUrl: string): string {
  const website = blog?.trim()
  if (!website) {
    return profileUrl
  }

  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(website)
      ? website
      : `https://${website}`)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : profileUrl
  }
  catch {
    return profileUrl
  }
}

export async function getFooterContributors(forge: Pick<ForgeProvider, 'users'>, contributors: Awaited<ReturnType<typeof getContributors>>) {
  const otherContributors = contributors.filter(contributor => contributor.login.toLowerCase() !== 'danielroe')
  const topContributors = otherContributors.slice(0, 3)

  const namedContributors = await Promise.all([
    'danielroe',
    ...topContributors.map(contributor => contributor.login),
  ].map(async (login) => {
    const fallback = `https://github.com/${login}`
    const profile = await forge.users.get(login).catch(() => null)
    return {
      login,
      to: profile
        ? contributorHomepage(profile.websiteUrl ?? null, profile.url ?? fallback)
        : fallback,
    }
  }))

  return {
    contributors: namedContributors,
    remaining: otherContributors.length - topContributors.length,
  }
}
