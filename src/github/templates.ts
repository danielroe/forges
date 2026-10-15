import type { RepoRef, RepoTemplate } from '../model.ts'
import type { GitHubContentFile } from './types.ts'
import { NotFoundError } from '../errors.ts'
import { mapConcurrent } from '../utils.ts'

type TemplateKind = RepoTemplate['kind']

/** Lists a directory by its path, `''` for the root. Rejects with `NotFoundError` when it's missing. */
export type ListDirectory = (repo: RepoRef, path: string) => Promise<GitHubContentFile[]>

/** Reads a file of the default branch as text. */
export type ReadText = (repo: RepoRef, path: string) => Promise<string>

/** Where GitHub looks for a pull request template and the legacy issue template, in its order of precedence. */
const LOCATIONS = ['.github', '', 'docs']
const ISSUE_TEMPLATE = /\.(?:md|ya?ml)$/i
const ISSUE_FORM = /\.ya?ml$/i
const CHOOSER_CONFIG = /^config\.ya?ml$/i

/**
 * No REST endpoint for templates, and GraphQL's `issueTemplates` skips issue forms, so this walks the folders GitHub reads.
 * A failed fallback to `.github` keeps the repository's own templates rather than losing them too.
 */
export async function readTemplates(repo: RepoRef, kinds: TemplateKind[], list: ListDirectory, read: ReadText, signal?: AbortSignal): Promise<RepoTemplate[]> {
  const own = await templatesOf(repo, kinds, list, read)
  const missing = kinds.filter(kind => kind === 'issue' ? !own.ownsIssues : !own.templates.some(template => template.kind === kind))
  if (!missing.length || repo.name.toLowerCase() === '.github') {
    return own.templates
  }
  const source: RepoRef = { forge: repo.forge, instance: repo.instance, owner: repo.owner, name: '.github' }
  try {
    const fallback = await templatesOf(source, missing, (ref, path) => orEmpty(list(ref, path)), read)
    return [...own.templates, ...fallback.templates.map(template => ({ ...template, source }))]
  }
  catch (error) {
    if (signal?.aborted || !own.templates.length) {
      throw error
    }
    return own.templates
  }
}

/** A chooser `config.yml` alone still makes issue templates the repository's own, so GitHub skips the `.github` ones. */
async function templatesOf(repo: RepoRef, kinds: TemplateKind[], list: ListDirectory, read: ReadText) {
  const root = await list(repo, '')
  const locations = await Promise.all(LOCATIONS.map(directory => !directory
    ? root
    : root.some(entry => entry.type === 'dir' && entry.name === directory) ? orEmpty(list(repo, directory)) : []))
  const folder = async (entries: GitHubContentFile[], name: string) => {
    const found = entries.find(entry => entry.type === 'dir' && entry.name.toLowerCase() === name)
    return found ? (await orEmpty(list(repo, found.path))).filter(entry => entry.type === 'file') : []
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
      found.push(...templates.map(entry => ({ kind: 'issue' as const, format: ISSUE_FORM.test(entry.name) ? 'form' as const : 'markdown' as const, entry })))
    }
    else if (legacy) {
      found.push({ kind: 'issue', format: 'markdown', entry: legacy })
    }
    ownsIssues = issueFiles.length > 0 || legacy !== undefined
  }
  if (kinds.includes('pull_request')) {
    const single = firstFile(locations, 'pull_request_template')
    found.push(...[...single ? [single] : [], ...pullFiles].map(entry => ({ kind: 'pull_request' as const, format: 'markdown' as const, entry })))
  }

  const templates = await mapConcurrent(found, 4, async ({ kind, format, entry }): Promise<RepoTemplate> => ({ kind, name: entry.name, path: entry.path, format, body: await read(repo, entry.path), raw: entry }))
  return { templates, ownsIssues }
}

/** The first file named `name`, with any extension and in any case, across the locations in their order. */
function firstFile(locations: GitHubContentFile[][], name: string): GitHubContentFile | undefined {
  return locations.flat().find(entry => entry.type === 'file' && entry.name.toLowerCase().replace(/\.[^.]*$/, '') === name)
}

/** A listing of a directory that may not exist, such as the `.github` repository of an owner that has none. */
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
