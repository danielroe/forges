import type { Fetcher } from '../fetch.ts'
import type { RepoRef } from '../model.ts'
import type { AtUri } from './atproto.ts'
import { toDate } from '../utils.ts'
import { createdAtOf } from './atproto.ts'
import { repoPath } from './web.ts'

/** A thread as the appview lists it. */
export interface AppviewThread {
  /** The number the appview shows the thread as. */
  number: string
  /** The title the appview renders, as {@link titleKey} compares it. */
  key: string
  /** The DID of the account that opened the thread. */
  author?: string
  /** When the appview saw the thread. */
  at?: Date
}

/** A thread as its record describes it, to find in the appview's list. */
export interface ListedThread {
  /** The title of the thread, as the record stores it. */
  title: string
  /** The DID of the account that opened the thread. */
  author: string
  /** When the thread was created. */
  createdAt?: Date
}

/** The path of a repository's list of threads, as the appview serves it. */
const SECTIONS = { issue: 'issues', pull_request: 'pulls' } as const

const PAGE_SIZE = 100

/** How far the appview's timestamp of a thread may be from the moment it was created, which is how long the appview took to see it. */
const SEEN_WITHIN = 24 * 60 * 60 * 1000

/** How much closer the appview's timestamp of a thread must be than another's, to tell two apart. */
const CLOSER_BY = 60 * 1000

/** One page of the appview's list of a repository's threads. */
export interface AppviewPage {
  /** The threads whose number and title the page names. */
  threads: AppviewThread[]
  /** The number of every thread the page links to, read or not. */
  listed: string[]
}

/**
 * Reads one page of the appview's list of a repository's threads. The URL is
 * absolute because a relative path that starts with a DID reads as a URL.
 */
export async function listAppviewThreads(fetcher: Fetcher, baseUrl: string, repo: RepoRef, kind: 'issue' | 'pull_request', author: string | undefined, offset: number, signal?: AbortSignal): Promise<AppviewPage> {
  const response = await fetcher.raw(`${baseUrl}${repoPath(repo)}/${SECTIONS[kind]}`, { query: { q: author ? `state:all author:${author}` : 'state:all', limit: PAGE_SIZE, offset }, signal })
  return parseAppviewThreads(await response.text(), kind)
}

/** The threads in a page of the appview's list, each named by the link to its page and the title beside it. */
export function parseAppviewThreads(html: string, kind: 'issue' | 'pull_request'): AppviewPage {
  const section = SECTIONS[kind]
  const pattern = new RegExp(`href="[^"]*?/${section}/(\\d+)"[^>]*>\\s*([\\s\\S]*?)\\s*<span[^>]*>#\\1</span>`, 'g')
  const matches = [...html.matchAll(pattern)]
  const threads = matches.map((match, index) => {
    const rest = html.slice(match.index! + match[0].length, matches[index + 1]?.index ?? html.length)
    return {
      number: match[1]!,
      key: titleKey(match[2]!.replace(/<[^>]*>|&(?:#\d+|[a-z]+);/gi, '')),
      author: /avatar\.tangled\.sh\/[^"?]*\/([^"?/]+)\?/.exec(rest)?.[1],
      at: date(/<time datetime="([^"]+)"/.exec(rest)?.[1]),
    }
  })
  const listed = [...new Set([...html.matchAll(new RegExp(`/${section}/(\\d+)`, 'g'))].map(match => match[1]!))]
  return { threads, listed }
}

/**
 * The number the appview shows a thread as, where its list names the thread.
 * A thread is told apart by the account that opened it and by its title, and
 * where several threads share those, by the moment the appview saw them.
 */
export function appviewNumber(threads: AppviewThread[], thread: ListedThread): string | undefined {
  const key = titleKey(thread.title)
  if (!key) {
    return undefined
  }
  const same = threads.filter(candidate => candidate.author === thread.author && candidate.key === key)
  const seen = same.filter(candidate => !thread.createdAt || !candidate.at || Math.abs(candidate.at.getTime() - thread.createdAt.getTime()) <= SEEN_WITHIN)
  if (seen.length === 1) {
    return seen[0]!.number
  }
  if (seen.length > 1 && thread.createdAt) {
    const [closest, other] = seen.toSorted((a, b) => distance(a, thread.createdAt!) - distance(b, thread.createdAt!))
    if (closest && other && distance(closest, thread.createdAt) + CLOSER_BY <= distance(other, thread.createdAt)) {
      return closest.number
    }
  }
  return undefined
}

/** A thread record, to find in the appview's list. */
export function listedThread(uri: AtUri, record: { title: string, createdAt?: string }): ListedThread {
  return { title: record.title, author: uri.did, createdAt: createdAtOf(uri.rkey, toDate(record.createdAt)) }
}

/** A title reduced to its letters and digits, so that markup and punctuation do not tell the rendered and stored titles apart. */
function titleKey(title: string): string {
  return title.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** How far the appview saw a thread from the moment it was created. */
function distance(thread: AppviewThread, createdAt: Date): number {
  return thread.at ? Math.abs(thread.at.getTime() - createdAt.getTime()) : Number.POSITIVE_INFINITY
}

function date(value: string | undefined): Date | undefined {
  const parsed = value ? new Date(value.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))) : undefined
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined
}
