import type { ThemeRegistrationRaw } from 'shiki'

/** Colours come from the `--code-*` custom properties in `app.css`, so one theme follows the colour mode. */
export const codeTheme: ThemeRegistrationRaw = {
  name: 'forges',
  type: 'light',
  colors: {
    'editor.background': 'var(--code-background)',
    'editor.foreground': 'var(--code-text)',
  },
  settings: [
    { settings: { foreground: 'var(--code-text)', background: 'var(--code-background)' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--code-comment)', fontStyle: 'italic' } },
    { scope: ['string', 'markup.inline.raw', 'markup.inserted'], settings: { foreground: 'var(--code-string)' } },
    { scope: ['keyword', 'storage', 'entity.name.tag', 'markup.deleted'], settings: { foreground: 'var(--code-keyword)' } },
    { scope: ['keyword.operator', 'punctuation', 'meta.brace'], settings: { foreground: 'var(--code-text)' } },
    { scope: ['keyword.operator.expression', 'keyword.operator.new'], settings: { foreground: 'var(--code-keyword)' } },
    { scope: ['punctuation.definition.string'], settings: { foreground: 'var(--code-string)' } },
    { scope: ['variable.other.constant.property'], settings: { foreground: 'var(--code-strong)' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: 'var(--code-literal)' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: 'var(--code-strong)' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: 'var(--code-strong)', fontStyle: 'bold' } },
  ],
}

/** For highlighters that require a theme per colour mode. */
export const codeThemes = { default: codeTheme, light: codeTheme, dark: codeTheme }
