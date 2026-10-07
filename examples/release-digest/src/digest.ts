import type {
  ForgeProvider,
  Forges,
  ForgeWarning,
  RepoRef,
  Thread,
  ThreadRef,
} from 'forges'

export interface FailingPull {
  number: string
  title: string
  url?: string
  /** Failing and total check counts, where the forge reports them. */
  failed?: number
  total?: number
  /** Names of the individual failing checks, where the forge can list them. */
  checks: string[]
}

export interface DigestEntry {
  forge: string
  repo: string
  release?: { tag: string, name?: string, publishedAt?: Date }
  failing: FailingPull[]
  warnings: ForgeWarning[]
}

export interface DigestResult {
  entries: DigestEntry[]
  warnings: ForgeWarning[]
}

function repoName(repo: RepoRef): string {
  return repo.name ? `${repo.owner}/${repo.name}` : repo.owner
}

async function openPulls(provider: ForgeProvider, repo: RepoRef, warnings: ForgeWarning[], limit: number): Promise<Thread[]> {
  if (provider.capabilities.threads.list.pull_request === false) {
    warnings.push({
      code: 'threads_list_unsupported',
      message: `${provider.forge} cannot list pull requests`,
      subject: repoName(repo),
    })
    return []
  }

  const iterable = provider.threads.list(repo, { kind: 'pull_request', state: 'open' })
  const threads: Thread[] = []
  for await (const thread of iterable) {
    threads.push(thread)
    if (threads.length >= limit) {
      break
    }
  }
  warnings.push(...iterable.warnings)
  return threads
}

/** Failing check names and counts for one pull, from the single checks read. */
async function checkFailures(provider: ForgeProvider, ref: ThreadRef, warnings: ForgeWarning[]): Promise<{ checks: string[], failed: number, total: number } | undefined> {
  if (!provider.can('threads.checks', 'pull_request')) {
    return undefined
  }
  try {
    const page = await provider.threads.checks(ref)
    warnings.push(...page.warnings ?? [])
    const failing = page.items.filter(check => check.state === 'failure')
    return { checks: failing.map(check => check.name), failed: failing.length, total: page.items.length }
  }
  catch (error) {
    warnings.push({
      code: 'checks_unreadable',
      message: error instanceof Error ? error.message : 'could not read checks',
      subject: `${repoName(ref.repo)}#${ref.number ?? '?'}`,
    })
    return undefined
  }
}

async function latestRelease(provider: ForgeProvider, repo: RepoRef, warnings: ForgeWarning[]): Promise<DigestEntry['release']> {
  if (!provider.can('releases.latest')) {
    warnings.push({
      code: 'releases_unsupported',
      message: `${provider.forge} has no releases`,
      subject: repoName(repo),
    })
    return undefined
  }
  const release = await provider.releases.latest(repo)
  return release && { tag: release.tag, name: release.name, publishedAt: release.publishedAt }
}

export interface DigestOptions {
  /** Open pull requests read per repository. Defaults to 50. */
  limit?: number
}

/** Latest release and failing open pull requests, for repositories on any number of forges. */
export async function buildDigest(forges: Forges, repos: readonly RepoRef[], options: DigestOptions = {}): Promise<DigestResult> {
  const entries: DigestEntry[] = []
  const warnings: ForgeWarning[] = []

  for (const repo of repos) {
    const provider = forges.get(repo.forge, repo.instance)
    if (!provider) {
      warnings.push({
        code: 'provider_missing',
        message: `no provider configured for ${repo.forge} (${repo.instance})`,
        subject: repoName(repo),
      })
      continue
    }

    const entryWarnings: ForgeWarning[] = []
    const release = await latestRelease(provider, repo, entryWarnings)
    const threads = await openPulls(provider, repo, entryWarnings, options.limit ?? 50)

    const failing: FailingPull[] = []
    for (const thread of threads) {
      const result = await checkFailures(provider, thread.ref, entryWarnings)
      if (!result?.failed) {
        continue
      }
      failing.push({
        number: thread.ref.number ?? '?',
        title: thread.title,
        url: thread.url,
        failed: result.failed,
        total: result.total,
        checks: result.checks,
      })
    }

    entries.push({ forge: provider.forge, repo: repoName(repo), release, failing, warnings: entryWarnings })
    warnings.push(...entryWarnings)
  }

  return { entries, warnings }
}

export function formatDigest(result: DigestResult): string {
  const lines: string[] = []
  for (const entry of result.entries) {
    const release = entry.release
      ? `${entry.release.tag}${entry.release.publishedAt ? ` (${entry.release.publishedAt.toISOString().slice(0, 10)})` : ''}`
      : 'no release'
    lines.push(`${entry.forge}  ${entry.repo}  ${release}`)
    for (const pull of entry.failing) {
      const counts = pull.failed !== undefined && pull.total !== undefined ? ` ${pull.failed}/${pull.total} failed` : ''
      lines.push(`  #${pull.number}  ${pull.title}${counts}${pull.checks.length ? `  [${pull.checks.join(', ')}]` : ''}`)
    }
    if (entry.failing.length === 0) {
      lines.push('  no open pull requests with failing checks')
    }
  }
  return lines.join('\n')
}
