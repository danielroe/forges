import type { FileContent, FileMetadata, FileOptions } from './model.ts'
import { ContentNotTextError } from './errors.ts'

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

/** True for a full SHA-1 or SHA-256 commit id, which needs no lookup to resolve. */
export function isSha(ref: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref)
}
