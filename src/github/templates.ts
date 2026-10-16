import type { RepoRef, RepoTemplate } from '../model.ts'
import type { GitHubContentFile, GitHubRepositoryDetail } from './types.ts'
import { NotFoundError } from '../errors.ts'
import { mapConcurrent } from '../utils.ts'

type TemplateKind = RepoTemplate['kind']

/** How `readTemplates()` reads a repository. Each rejects with `NotFoundError` for something missing. */
export interface TemplateReader {
  /** Lists a directory of the default branch by its path, `''` for the root. */
  list: (repo: RepoRef, path: string) => Promise<GitHubContentFile[]>
  /** Reads a file of the default branch as text. */
  read: (repo: RepoRef, path: string) => Promise<string>
  /** Reads the repository itself. */
  repository: (repo: RepoRef) => Promise<GitHubRepositoryDetail>
}

/** Where GitHub looks for a pull request template and the legacy issue template, in its order of precedence. */
const LOCATIONS = ['.github', '', 'docs']
const ISSUE_TEMPLATE = /\.(?:md|ya?ml)$/i
const ISSUE_FORM = /\.ya?ml$/i
const CHOOSER_CONFIG = /^config\.ya?ml$/i
const CONTENTS_OWNER = /\/repos\/([^/]+)\/[^/]+\/contents(?:[/?]|$)/

/** No REST endpoint for templates, and GraphQL's `issueTemplates` skips issue forms, so this walks the folders GitHub reads. */
export async function readTemplates(repo: RepoRef, kinds: TemplateKind[], reader: TemplateReader): Promise<RepoTemplate[]> {
  const root = await rootOf(repo, reader)
  const own = await templatesOf(repo, root.entries, kinds, reader)
  const missing = kinds.filter(kind => kind === 'issue' ? !own.ownsIssues : !own.templates.some(template => template.kind === kind))
  if (!missing.length || repo.name.toLowerCase() === '.github') {
    return own.templates
  }
  const source: RepoRef = { forge: repo.forge, instance: repo.instance, owner: root.owner, name: '.github' }
  const fallback = await fallbackOf(source, missing, reader)
  return [...own.templates, ...fallback.map(template => ({ ...template, source }))]
}

/** The root of the default branch, and the owner the repository lives under now, which differs from `repo.owner` after a transfer. */
async function rootOf(repo: RepoRef, reader: TemplateReader): Promise<{ entries: GitHubContentFile[], owner: string }> {
  try {
    const entries = await reader.list(repo, '')
    const owner = entries.map(entry => entry.url && CONTENTS_OWNER.exec(new URL(entry.url).pathname)?.[1]).find(Boolean)
    return { entries, owner: owner ? decodeURIComponent(owner) : repo.owner }
  }
  catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error
    }
    // Listing the root of an empty repository is a 404 too.
    const detail = await reader.repository(repo)
    return { entries: [], owner: detail.owner?.login ?? repo.owner }
  }
}

/** The owner's `.github` repository serves defaults only while it is public, or internal in an enterprise. */
async function fallbackOf(source: RepoRef, kinds: TemplateKind[], reader: TemplateReader): Promise<RepoTemplate[]> {
  let detail: GitHubRepositoryDetail
  try {
    detail = await reader.repository(source)
  }
  catch (error) {
    if (error instanceof NotFoundError) {
      return []
    }
    throw error
  }
  if (detail.visibility ? detail.visibility === 'private' : detail.private) {
    return []
  }
  return (await templatesOf(source, await orEmpty(reader.list(source, '')), kinds, reader)).templates
}

/** A chooser `config.yml` alone still makes issue templates the repository's own, while any other file there doesn't. */
async function templatesOf(repo: RepoRef, root: GitHubContentFile[], kinds: TemplateKind[], reader: TemplateReader) {
  const locations = await Promise.all(LOCATIONS.map(directory => !directory
    ? root
    : root.some(entry => entry.type === 'dir' && entry.name === directory) ? orEmpty(reader.list(repo, directory)) : []))
  const folder = async (entries: GitHubContentFile[], name: string) => {
    const found = entries.find(entry => entry.type === 'dir' && entry.name.toLowerCase() === name)
    return found ? (await orEmpty(reader.list(repo, found.path))).filter(entry => entry.type === 'file') : []
  }
  const [issueFiles, pullFiles] = await Promise.all([
    kinds.includes('issue') ? folder(locations[0]!, 'issue_template') : [],
    kinds.includes('pull_request') ? folder(locations.flat(), 'pull_request_template') : [],
  ])

  const found: Array<Pick<RepoTemplate, 'kind' | 'format'> & { entry: GitHubContentFile }> = []
  let ownsIssues = false
  if (kinds.includes('issue')) {
    const templates = issueFiles.filter(entry => ISSUE_TEMPLATE.test(entry.name) && !CHOOSER_CONFIG.test(entry.name))
    const legacy = firstFile(locations, 'issue_template')
    if (templates.length) {
      const forms = templates.filter(entry => ISSUE_FORM.test(entry.name))
      found.push(
        ...forms.map(entry => ({ kind: 'issue' as const, format: 'form' as const, entry })),
        ...templates.filter(entry => !forms.includes(entry)).map(entry => ({ kind: 'issue' as const, format: 'markdown' as const, entry })),
      )
    }
    else if (legacy) {
      found.push({ kind: 'issue', format: 'markdown', entry: legacy })
    }
    ownsIssues = templates.length > 0 || issueFiles.some(entry => CHOOSER_CONFIG.test(entry.name)) || legacy !== undefined
  }
  if (kinds.includes('pull_request')) {
    const single = firstFile(locations, 'pull_request_template')
    found.push(...[...single ? [single] : [], ...pullFiles].map(entry => ({ kind: 'pull_request' as const, format: 'markdown' as const, entry })))
  }

  const templates = await mapConcurrent(found, 4, async ({ kind, format, entry }): Promise<RepoTemplate> => ({ kind, name: entry.name, path: entry.path, format, body: await reader.read(repo, entry.path), raw: entry }))
  return { templates, ownsIssues }
}

/** The first file named `name`, with any extension and in any case, across the locations in their order. */
function firstFile(locations: GitHubContentFile[][], name: string): GitHubContentFile | undefined {
  return locations.flat().find(entry => entry.type === 'file' && entry.name.toLowerCase().replace(/\.[^.]*$/, '') === name)
}

/** A listing of a directory that may not exist, or of a repository that is empty. */
async function orEmpty(listing: Promise<GitHubContentFile[]>): Promise<GitHubContentFile[]> {
  try {
    return await listing
  }
  catch (error) {
    if (error instanceof NotFoundError) {
      return []
    }
    throw error
  }
}
