/** Resolves the name of an exported symbol to the URL of its section, or `undefined` when it is not documented. */
export type LinkResolver = (name: string) => string | undefined

const FENCE_RE = /^\s*(?:```|~~~)/
const IDENTIFIER_RE = /'[^']*'|"[^"]*"|[A-Z_$][\w$]*/gi
const INLINE_LINK_RE = /\{@link(?:code|plain)? ([^ }|]+)(?:[ |]([^}]*))?\}/g
const NON_SLUG_RE = /[^\p{L}\p{N}\s_-]/gu
const SPACE_RE = /\s/g

/** The `id` Nuxt Content gives a heading, following `github-slugger`. */
export function slug(heading: string): string {
  return heading.toLowerCase().replace(NON_SLUG_RE, '').replace(SPACE_RE, '-')
}

/** An inline code span that survives backticks in `text`. */
export function code(text: string): string {
  if (!text.includes('`')) {
    return `\`${text}\``
  }
  return `\`\` ${text} \`\``
}

/** Generic wrappers that say how a value is delivered, not what it is, so a type that wraps one documented type is still about that type. */
const WRAPPERS = new Set(['Array', 'AsyncGenerator', 'AsyncIterable', 'Awaited', 'Exclude', 'Extract', 'ForgeIterable', 'Iterable', 'Map', 'NonNullable', 'Omit', 'Page', 'Partial', 'Pick', 'Promise', 'ReadonlyArray', 'Readonly', 'Record', 'Required', 'Set'])

/**
 * A type as one inline code chip. When the type is, or wraps, exactly one
 * documented type, the whole chip links to it. Otherwise it is plain, so that a
 * chip is never part link and part not.
 */
export function typeToMarkdown(type: string, resolve: LinkResolver): string {
  const targets = new Set<string>()
  for (const [name] of type.matchAll(IDENTIFIER_RE)) {
    if (/^[A-Z]/.test(name) && !WRAPPERS.has(name) && resolve(name)) {
      targets.add(name)
    }
  }
  const [only] = targets
  return only && targets.size === 1 ? `[${code(type)}](${resolve(only)})` : code(type)
}

/**
 * JSDoc prose as Markdown: `{@link Name}` becomes a link or a code span, and
 * `<` outside code becomes an entity so that `Promise<Thread>` is not read as a
 * component.
 */
export function prose(text: string, resolve: LinkResolver): string {
  let fenced = false
  const lines = text.split('\n').map((line) => {
    if (FENCE_RE.test(line)) {
      fenced = !fenced
      return line
    }
    return fenced ? line : escapeLine(line.replace(INLINE_LINK_RE, (_, name: string, label?: string) => linkTo(name, label?.trim(), resolve)))
  })
  return lines.join('\n').trim()
}

/** Prose on one line, for a table cell. */
export function cell(text: string, resolve: LinkResolver): string {
  return prose(text, resolve).replace(/\n+/g, ' ').replace(/\|/g, '\\|')
}

/** A type in a table cell. */
export function typeCell(type: string, resolve: LinkResolver): string {
  return typeToMarkdown(type, resolve).replace(/\|/g, '\\|')
}

function linkTo(name: string, label: string | undefined, resolve: LinkResolver): string {
  const url = resolve(name)
  const text = code(label || name)
  return url ? `[${text}](${url})` : text
}

function escapeLine(line: string): string {
  return line.split(/(`+[^`]*`+)/).map((part, index) => index % 2 ? part : part.replace(/</g, '&lt;')).join('')
}
