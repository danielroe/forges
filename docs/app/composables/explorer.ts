import type { ForgeProvider, ForgeProviderFactory } from 'forges'
import type { DecorationItem, HighlighterCore } from 'shiki/core'
import { codeTheme } from '~~/shared/code-theme'
import { EXPLORER_FORGES } from '~~/shared/explorer'

const STORAGE_KEY = 'forges:explorer-forge'

let persisting = false

/** The forge that every explorer uses. It persists across pages and visits. */
export function useExplorerForge() {
  const id = useState('explorer-forge', () => EXPLORER_FORGES[0]!.forge)

  // One explorer sets up the persistence for all of them: a reference page has dozens.
  if (import.meta.client && !persisting) {
    persisting = true
    // Read after hydration, so the server and the first client render agree.
    onMounted(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved && EXPLORER_FORGES.some(forge => forge.forge === saved)) {
          id.value = saved
        }
      }
      catch {}
    })
    // Detached, so the watcher outlives the explorer that created it.
    effectScope(true).run(() => watch(id, (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, value)
      }
      catch {}
    }))
  }

  return id
}

type Factory = (options: Record<string, string>) => ForgeProviderFactory

const providers = new Map<string, Promise<ForgeProvider | undefined>>()

/** An anonymous provider for a forge of the explorer, created once with the forge's options, if the forge has one. */
export function explorerProvider(id: string): Promise<ForgeProvider | undefined> {
  let provider = providers.get(id)
  if (!provider) {
    const forge = EXPLORER_FORGES.find(entry => entry.forge === id)!
    // Options can be required, such as Azure DevOps' `organization`; the forge's own options provide them.
    provider = forge.load
      ? forge.load().then(module => (module as Record<string, Factory>)[forge.factory]!(forge.options?.(forge.sample) ?? {}).create())
      : Promise.resolve(undefined)
    provider.catch(() => providers.delete(id))
    providers.set(id, provider)
  }
  return provider
}

let schemas: Promise<Record<string, Record<string, any>>> | undefined

/** The published JSON Schemas of the model, loaded on first use. */
export function explorerSchemas() {
  schemas ??= import('forges/schema').then(module => module.schemas)
  return schemas
}

let highlighter: Promise<HighlighterCore> | undefined

/** HTML for TypeScript or JSON in the site's code theme. The highlighter loads on first use. */
export async function highlightExplorerCode(code: string, lang: 'typescript' | 'json', decorations: DecorationItem[] = []): Promise<string> {
  highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) => createHighlighterCore({
    themes: [codeTheme],
    langs: [import('shiki/langs/typescript.mjs'), import('shiki/langs/json.mjs')],
    engine: createJavaScriptRegexEngine(),
  }))
  // Without the `shiki` class, Docus's dark-mode rules leave the theme's colours alone.
  return (await highlighter).codeToHtml(code, { lang, theme: codeTheme.name!, decorations }).replace(/<pre[^>]*>/, '<pre>')
}
