import type { ForgeProvider, ForgeProviderFactory } from 'forges'
import type { DecorationItem, HighlighterCore } from 'shiki/core'
import type { ExplorerCredential, ExplorerInput } from '~~/shared/explorer'
import { codeTheme } from '~~/shared/code-theme'
import { authFromValues, EXPLORER_FORGES, placeholderAuth } from '~~/shared/explorer'

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

type Factory = (options: Record<string, unknown>) => ForgeProviderFactory

const factories = new Map<string, Promise<Factory>>()

/** The factory of a forge, loaded once. A forge's provider is its own chunk, which the bundler splits out. */
function explorerFactory(id: string): Promise<Factory> {
  let loaded = factories.get(id)
  if (!loaded) {
    const forge = EXPLORER_FORGES.find(entry => entry.forge === id)!
    loaded = forge.load().then(module => (module as Record<string, Factory>)[forge.factory]!)
    loaded.catch(() => factories.delete(id))
    factories.set(id, loaded)
  }
  return loaded
}

export interface ExplorerProviders {
  /** Makes the calls that run here. */
  anonymous: ForgeProvider
  /** Holds placeholder credentials, so it reports what a call with credentials supports. It never makes a call. */
  signedIn: ForgeProvider
}

const providers = new Map<string, Promise<ExplorerProviders>>()

/** The providers for a forge of the explorer, created once with the forge's options. */
export function explorerProviders(id: string): Promise<ExplorerProviders> {
  let loaded = providers.get(id)
  if (!loaded) {
    const forge = EXPLORER_FORGES.find(entry => entry.forge === id)!
    // Options can be required, such as Azure DevOps' `organization`; the forge's own options provide them.
    const options = forge.options?.(forge.sample) ?? {}
    loaded = explorerFactory(id).then(factory => ({
      anonymous: factory(options).create(),
      signedIn: factory({ ...options, auth: placeholderAuth(forge.credentials[0]!) }).create(),
    }))
    loaded.catch(() => providers.delete(id))
    providers.set(id, loaded)
  }
  return loaded
}

/** A provider that sends the credential the person typed. */
export async function explorerCredentialProvider(id: string, input: ExplorerInput, credential: ExplorerCredential, values: Record<string, string>): Promise<ForgeProvider> {
  const forge = EXPLORER_FORGES.find(entry => entry.forge === id)!
  const options = forge.options?.(input) ?? {}
  const factory = await explorerFactory(id)
  return factory({ ...options, auth: authFromValues(credential, values) }).create()
}

/** A credential the person typed, and the kind it is. */
export interface ExplorerCredentialState {
  /** The `ExplorerCredential.kind` the person chose, such as `token` or `basic`. */
  kind: string
  /** The value of each field, keyed by field name. */
  values: Record<string, string>
}

const CREDENTIALS_KEY = 'forges:explorer-credentials'
const REMEMBER_KEY = 'forges:explorer-remember'

let restoring = false

/**
 * The credential each explorer sends, keyed by forge and shared by every explorer. It stays in memory, or in
 * sessionStorage while "Remember in this tab" is on, and never reaches the URL or the docs server.
 */
export function useExplorerCredentials() {
  const credentials = useState<Record<string, ExplorerCredentialState>>('explorer-credentials', () => ({}))
  const remember = useState('explorer-remember', () => false)

  if (import.meta.client && !restoring) {
    restoring = true
    let restored = false
    // Read after hydration, so the server and the first client render agree.
    onMounted(() => {
      try {
        if (sessionStorage.getItem(REMEMBER_KEY) === '1') {
          remember.value = true
          const saved = sessionStorage.getItem(CREDENTIALS_KEY)
          if (saved) {
            credentials.value = JSON.parse(saved)
          }
        }
      }
      catch {}
      finally {
        restored = true
      }
    })
    // Detached, so the watcher outlives the explorer that created it.
    effectScope(true).run(() => watch([credentials, remember], () => {
      // A change before the restore finishes must not overwrite what is stored.
      if (!restored) {
        return
      }
      try {
        if (remember.value) {
          sessionStorage.setItem(REMEMBER_KEY, '1')
          sessionStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials.value))
        }
        else {
          sessionStorage.removeItem(REMEMBER_KEY)
          sessionStorage.removeItem(CREDENTIALS_KEY)
        }
      }
      catch {}
    }, { deep: true }))
  }

  return { credentials, remember }
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
