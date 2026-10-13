import type { FileChange, FileContent, FileMetadata, FileOptions } from './model.ts'
import { toBase64 } from './crypto.ts'
import { ContentNotTextError, NotFoundError } from './errors.ts'

/** Decodes base64, tolerating the newlines GitHub and Gitea wrap it in. */
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replaceAll(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Shapes bytes as the caller asked: UTF-8 text for `as: 'text'`, bytes
 * otherwise. Rejects with {@link ContentNotTextError} when text was asked for
 * and the bytes are not valid UTF-8.
 */
export function toFileContent(
  bytes: Uint8Array,
  file: FileMetadata,
  options: FileOptions | undefined,
  context?: { forge?: string, instance?: string },
): FileContent {
  return options?.as === 'text'
    ? { ...file, content: decodeText(bytes, file.path, context), encoding: 'utf-8' }
    : { ...file, content: bytes, encoding: 'binary' }
}

/** Decodes UTF-8, rejecting with {@link ContentNotTextError} that names `what` when the bytes are not text. */
export function decodeText(bytes: Uint8Array, what: string, context?: { forge?: string, instance?: string }): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch (cause) {
    throw new ContentNotTextError(`${what} is not valid UTF-8 text`, context, { cause })
  }
}

/** The bytes of a file to write, with a string encoded as UTF-8. */
export function changeBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

/** Base64 of a file to write, with a string encoded as UTF-8. */
export function changeBase64(content: string | Uint8Array): string {
  return toBase64(changeBytes(content))
}

/** The directory that holds `path`, or `''` at the root. */
export function directoryOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/**
 * Looks up the files that `changes` touch with `find`, which resolves to `undefined` for a missing file,
 * and rejects with {@link NotFoundError} when a file to delete does not exist.
 */
export async function existingFiles<T>(
  changes: FileChange[],
  find: (path: string) => Promise<T | undefined>,
  context?: { forge?: string, instance?: string },
): Promise<Map<string, T>> {
  const found = await Promise.all(changes.map(async change => [change.path, await find(change.path)] as const))
  const missing = changes.find((change, index) => change.content === null && found[index]![1] === undefined)
  if (missing) {
    throw new NotFoundError(`${missing.path} does not exist, so it cannot be deleted`, 404, '', context)
  }
  return new Map(found.flatMap(([path, file]) => file === undefined ? [] : [[path, file]]))
}

/**
 * Finds files by listing their directories, once per directory.
 * @param list Reads the entries of a directory by their full path, or `undefined` when it does not exist.
 */
export function inDirectories<T>(list: (directory: string) => Promise<Map<string, T> | undefined>): (path: string) => Promise<T | undefined> {
  const listings = new Map<string, Promise<Map<string, T> | undefined>>()
  return async (path) => {
    const directory = directoryOf(path)
    if (!listings.has(directory)) {
      listings.set(directory, list(directory))
    }
    return (await listings.get(directory))?.get(path)
  }
}

/** The first line of a commit message and the rest, as forges that take them apart expect. */
export function splitMessage(message: string): { headline: string, body?: string } {
  const [headline = '', ...rest] = message.split('\n')
  const body = rest.join('\n').replace(/^\n+/, '')
  return body ? { headline, body } : { headline }
}

/** True for a full SHA-1 or SHA-256 commit id, which needs no lookup to resolve. */
export function isSha(ref: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref)
}
