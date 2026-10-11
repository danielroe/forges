import type { ChangedFile, Commit, ForgeOrigin, ForgeWarning, Page, RepoRef } from '../model.ts'

/** One commit of a `git format-patch` series. */
export interface PatchCommit {
  sha: string
  authorName?: string
  authorEmail?: string
  date?: Date
  message: string
  files: ChangedFile[]
}

/** Decodes RFC 2047 encoded words, as `git format-patch` writes non-ASCII headers. */
function decodeWords(value: string): string {
  return value.replaceAll(/=\?([^?]+)\?([qb])\?([^?]*)\?=(?:\s+(?==\?))?/gi, (_, charset: string, encoding: string, text: string) => {
    const bytes = encoding.toLowerCase() === 'b'
      ? Uint8Array.from(atob(text), char => char.charCodeAt(0))
      : Uint8Array.from(text.replaceAll('_', ' ').replaceAll(/=([0-9a-f]{2})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16))), char => char.charCodeAt(0))
    try {
      return new TextDecoder(charset).decode(bytes)
    }
    catch {
      return text
    }
  })
}

function headersOf(block: string): Record<string, string> {
  const headers: Record<string, string> = {}
  let last: string | undefined
  for (const line of block.split('\n')) {
    if (/^\s/.test(line) && last) {
      headers[last] += ` ${line.trim()}`
      continue
    }
    const match = /^([\w-]+):\s?(.*)$/.exec(line)
    if (match) {
      last = match[1]!.toLowerCase()
      headers[last] = match[2]!
    }
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, decodeWords(value)]))
}

/** The files of a unified diff in `git diff` format. */
export function parseDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section)
    if (!header) {
      continue
    }
    const hunk = section.search(/^@@ /m)
    const meta = hunk === -1 ? section : section.slice(0, hunk)
    const body = hunk === -1 ? '' : section.slice(hunk).replace(/\n-- \n[^\n]*\n*$/, '').replace(/\n+$/, '')
    const renamed = /^rename from (.+)$/m.exec(meta)
    const copied = /^copy from (.+)$/m.exec(meta)
    const oldPath = renamed?.[1] ?? copied?.[1] ?? header[1]!
    const newPath = /^(?:rename|copy) to (.+)$/m.exec(meta)?.[1] ?? header[2]!
    const deleted = /^deleted file mode/m.test(meta)
    let additions = 0
    let deletions = 0
    for (const line of body.split('\n')) {
      if (line.startsWith('+')) {
        additions++
      }
      else if (line.startsWith('-')) {
        deletions++
      }
    }
    const binary = /^(?:Binary files |GIT binary patch)/m.test(meta)
    files.push({
      path: deleted ? oldPath : newPath,
      previousPath: renamed || copied ? oldPath : undefined,
      status: /^new file mode/m.test(meta) ? 'added' : deleted ? 'removed' : renamed ? 'renamed' : copied ? 'copied' : 'modified',
      additions,
      deletions,
      patch: body || undefined,
      sha: /^index [0-9a-f]+\.\.([0-9a-f]+)/m.exec(meta)?.[1],
      ...binary ? { isBinary: true } : {},
    })
  }
  return files
}

/** The files a series changes, one entry per path. */
export function patchFiles(commits: PatchCommit[]): Page<ChangedFile> {
  const files = new Map<string, ChangedFile>()
  const warnings: ForgeWarning[] = []
  for (const file of commits.flatMap(commit => commit.files)) {
    const seen = files.get(file.path)
    if (!seen) {
      files.set(file.path, file)
      continue
    }
    warnings.push({ code: 'files_approximate', message: `Several commits change ${file.path}; its counts and patch are those of each commit together`, subject: file.path })
    files.set(file.path, {
      ...seen,
      additions: (seen.additions ?? 0) + (file.additions ?? 0),
      deletions: (seen.deletions ?? 0) + (file.deletions ?? 0),
      patch: seen.patch && file.patch ? `${seen.patch}\n${file.patch}` : undefined,
      sha: file.sha,
    })
  }
  return warnings.length ? { items: [...files.values()], warnings } : { items: [...files.values()] }
}

export function patchCommits(commits: PatchCommit[], origin: ForgeOrigin & { repo: RepoRef }): Commit[] {
  return commits.filter(commit => commit.sha).map(commit => ({
    ref: { ...origin, sha: commit.sha },
    sha: commit.sha,
    message: commit.message,
    author: { name: commit.authorName, email: commit.authorEmail, date: commit.date },
    parents: [],
    files: commit.files,
    stats: {
      additions: commit.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: commit.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
    raw: { sha: commit.sha },
  }))
}

/**
 * The commits of a `git format-patch` series. A plain diff has no commit
 * headers and yields one commit with an empty `sha`.
 */
export function parsePatch(patch: string): PatchCommit[] {
  const text = patch.replaceAll('\r\n', '\n')
  const parts = text.split(/^(?=From [0-9a-f]{40} )/m).filter(part => /^From [0-9a-f]{40} /.test(part))
  if (!parts.length) {
    return [{ sha: '', message: '', files: parseDiff(text) }]
  }
  return parts.map((part) => {
    const sha = part.slice(5, 45)
    const headerEnd = part.indexOf('\n\n')
    const headers = headersOf(part.slice(part.indexOf('\n') + 1, headerEnd === -1 ? undefined : headerEnd))
    const rest = headerEnd === -1 ? '' : part.slice(headerEnd + 2)
    const diffAt = rest.search(/^diff --git /m)
    const description = (diffAt === -1 ? rest : rest.slice(0, diffAt)).split(/^---$/m)[0]!.trim()
    const subject = (headers.subject ?? '').replace(/^\[PATCH[^\]]*\]\s*/, '')
    const from = /^([^<]*)<([^>]+)>$/.exec(headers.from ?? '')
    const date = headers.date ? new Date(headers.date) : undefined
    return {
      sha,
      authorName: from?.[1]?.trim().replace(/^"|"$/g, '') || undefined,
      authorEmail: from?.[2],
      date: date && !Number.isNaN(date.getTime()) ? date : undefined,
      message: description ? `${subject}\n\n${description}` : subject,
      files: diffAt === -1 ? [] : parseDiff(rest.slice(diffAt)),
    }
  })
}
