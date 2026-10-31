import type { Fetcher } from '../fetch.ts'
import type { GitHubCombinedStatus, GitHubIssue } from '../github/types.ts'
import type { Commit, CommitQuery, ForgeOrigin, ForgeWarning, Page, RepoRef, Thread, ThreadQuery } from '../model.ts'
import { toStatusCheck, toThread } from '../github/normalise.ts'
import { degradesToWarning, isFirstPage, summariseChecks, toWarning } from '../utils.ts'

/** GitBucket lists issues and pull requests 25 to a page, whatever `per_page` asks for. */
const THREAD_PAGE_SIZE = 25

/** GitHub's default, which GitBucket keeps for commits. */
const COMMIT_PAGE_SIZE = 30

/** Lists issues or pull requests by page number and with GitBucket's filter names, since it sends no `Link` header and ignores GitHub's. */
export function threadsPage(fetcher: Fetcher, origin: ForgeOrigin) {
  return async (repo: RepoRef, query: ThreadQuery = {}): Promise<Page<Thread>> => {
    const first = isFirstPage(query.cursor)
    const kind = query.kind === 'pull_request' ? 'pull_request' : 'issue'
    const warnings: ForgeWarning[] = []
    if (first && !query.kind) {
      warnings.push({ code: 'kind_unsupported', message: 'GitBucket lists issues and pull requests apart, so this lists issues; pass `kind` to list pull requests' })
    }
    for (const filter of ['since', 'involves'] as const) {
      if (first && query[filter]) {
        warnings.push({ code: 'filter_unsupported', message: `GitBucket lists issues and pull requests without a ${filter} filter; it was ignored` })
      }
    }
    const merged = query.state === 'merged'
    const page = query.cursor?.token === undefined ? 1 : Number(query.cursor.token)
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new TypeError(`A GitBucket thread cursor is a page number, not ${JSON.stringify(query.cursor?.token)}`)
    }
    const { data } = await fetcher.json<GitHubIssue[]>(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${kind === 'pull_request' ? 'pulls' : 'issues'}`, {
      query: {
        state: merged ? 'closed' : query.state ?? 'open',
        labels: query.labels?.join(','),
        author: query.author,
        assigned: query.assignee,
        mentioned: query.mentions,
        // GitBucket filters milestones by title, not by number.
        milestone: query.milestone,
        sort: query.sort ?? 'created',
        direction: query.direction ?? 'desc',
        page: page > 1 ? String(page) : undefined,
      },
      signal: query.signal,
    })
    const createdAfter = query.createdAfter?.getTime()
    const older = (raw: GitHubIssue) => createdAfter !== undefined && (Date.parse(raw.created_at ?? '') || 0) < createdAfter
    const listed = data.filter(raw => (!merged || raw.merged) && !older(raw))
    const items = await Promise.all(listed.map(async (raw) => {
      const thread = toThread({ ...origin, repo, kind, number: String(raw.number) }, raw)
      const sha = raw.head?.sha
      if (kind !== 'pull_request' || !sha) {
        return thread
      }
      // The listing already names the head, so one read of its statuses gives the checks.
      try {
        const { data: status } = await fetcher.json<GitHubCombinedStatus>(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${sha}/status`, { query: { per_page: 100 }, signal: query.signal })
        thread.checks = summariseChecks(status.statuses.map(entry => toStatusCheck(repo, entry).state), raw.html_url)
      }
      catch (error) {
        if (!degradesToWarning(error)) {
          throw error
        }
        warnings.push(toWarning('checks_unreadable', error, thread.ref.number))
      }
      return thread
    }))
    // Sorted newest first, an item older than `createdAfter` means every later page is older too.
    const past = (query.sort ?? 'created') === 'created' && (query.direction ?? 'desc') === 'desc' && data.some(older)
    return {
      items,
      cursor: data.length === THREAD_PAGE_SIZE && !past ? { token: String(page + 1) } : undefined,
      ...warnings.length ? { warnings } : {},
    }
  }
}

/** Lists one page of commits: past it, GitBucket skips commits, so a full page says where the listing stops. */
export function commitsPage(listPage: (repo: RepoRef, query?: CommitQuery) => Promise<Page<Commit>>) {
  return async (repo: RepoRef, query: CommitQuery = {}): Promise<Page<Commit>> => {
    const page = await listPage(repo, query)
    if (page.items.length < (query.perPage ?? COMMIT_PAGE_SIZE)) {
      return page
    }
    return { ...page, cursor: undefined, warnings: [...page.warnings ?? [], { code: 'commits_truncated', message: `GitBucket pages commits past the first ${page.items.length} wrongly, so the listing stops there; narrow it with \`since\`, \`until\` or \`path\`` }] }
  }
}
