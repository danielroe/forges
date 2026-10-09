<script setup lang="ts">
import type { ForgeProvider, ThreadKind } from 'forges'
import type { ExplorerField, ExplorerInput } from '~~/shared/explorer'
import type { KeyInfo } from '~/utils/explorer-json'
import { EXPLORER_FIELDS, EXPLORER_FORGES, EXPLORER_OPERATIONS, explorerCode, explorerFields, explorerRefs, REPOSITORY_FIELDS } from '~~/shared/explorer'
import { annotateJson, pageSchema } from '~/utils/explorer-json'

const props = defineProps<{
  /** The verb to run, such as `threads.get`. */
  verb: string
  /** Starts open, without the button that opens it, as on the explorer page. */
  expanded?: boolean
}>()

function operationFor(verb: string) {
  const found = EXPLORER_OPERATIONS.find(entry => entry.verb === verb)
  if (!found) {
    throw new Error(`No explorer operation for ${verb}`)
  }
  return found
}

const operation = operationFor(props.verb)

// Colours go by position, so that any operation's fields are told apart.
const PALETTE = ['oklch(0.62 0.16 255)', 'oklch(0.6 0.17 300)', 'oklch(0.62 0.14 160)', 'oklch(0.7 0.15 70)', 'oklch(0.62 0.18 25)', 'oklch(0.64 0.11 205)', 'oklch(0.6 0.18 340)', 'oklch(0.62 0.12 110)']

const open = ref(props.expanded)
const panel = useTemplateRef<HTMLElement>('panel')
const id = useId()

/** Opens the explorer and moves focus into it, since the button that opened it goes away. */
async function openExplorer() {
  open.value = true
  await nextTick()
  panel.value?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
}
const forgeId = useExplorerForge()
const forgeRadios = useRadioGroup(forgeId, () => EXPLORER_FORGES.map(entry => entry.forge))
// An unknown saved forge, such as one from an older version of the site, falls back to the first.
const forge = computed(() => EXPLORER_FORGES.find(entry => entry.forge === forgeId.value) ?? EXPLORER_FORGES[0]!)
const input = reactive<ExplorerInput>({ ...forge.value.sample })
const provider = shallowRef<ForgeProvider>()
/** Why the forge's provider failed to load, such as a chunk that a newer deploy replaced. */
const providerError = ref('')

const fields = computed(() => explorerFields(operation, input).map((field, index) => {
  const config = EXPLORER_FIELDS[field]
  return {
    field,
    label: config.label,
    colour: PALETTE[index % PALETTE.length]!,
    items: config.items?.map(value => ({ label: value, value })),
    hint: config.optional ? 'optional' : config.list ? 'comma-separated' : undefined,
    placeholder: config.placeholder,
  }
}))

watch(forgeId, () => {
  Object.assign(input, forge.value.sample)
  cancelRun()
})

// Load the provider only once someone opens the explorer, and again when the forge changes.
watch([open, forgeId], async ([isOpen, id]) => {
  if (!isOpen) {
    return
  }
  provider.value = undefined
  providerError.value = ''
  try {
    const loaded = await explorerProvider(id)
    if (forgeId.value === id) {
      provider.value = loaded
    }
  }
  catch (caught) {
    if (forgeId.value === id) {
      providerError.value = `The ${forge.value.name} provider failed to load: ${caught instanceof Error ? caught.message : String(caught)}`
    }
  }
}, { immediate: true })

// Only operations that run here have a meaningful support level: the provider is anonymous, so it reports every write as unsupported.
const support = computed(() => operation.run ? provider.value?.support(operation.verb, operation.kind?.(input)) : undefined)
const unsupported = computed(() => support.value === false)

const code = computed(() => explorerCode(operation, forge.value, input))
const codeHtml = ref('')
// Collapsed explorers build no code: a reference page has dozens of them.
watch(() => open.value ? code.value : undefined, async (current) => {
  if (current) {
    const colours = new Map(fields.value.map(({ field, colour }) => [field, colour]))
    const decorations = [
      ...current.values.map(({ field, start, end }) => ({ start, end, properties: { 'class': 'explorer-value', 'data-field': field, 'style': `--field: ${colours.get(field)}` } })),
      ...current.symbols.map(({ id, start, end }) => ({ start, end, properties: { 'class': 'explorer-symbol', 'data-symbol': id, 'tabindex': -1 } })),
    ]
    const html = await highlightExplorerCode(current.text, 'typescript', decorations)
    if (code.value === current) {
      codeHtml.value = html
    }
  }
}, { immediate: true })
const { copied, copy, message } = useCopyToClipboard(() => code.value.text)

/** The field whose input and value are highlighted together. */
const activeField = ref<ExplorerField>()
const codeView = useTemplateRef<HTMLElement>('codeView')

watch([activeField, codeHtml], () => {
  for (const value of codeView.value?.querySelectorAll<HTMLElement>('.explorer-value') ?? []) {
    value.toggleAttribute('data-active', value.dataset.field === activeField.value)
  }
}, { flush: 'post' })

function onCodePointer(event: PointerEvent) {
  onHoverPointer(event)
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.explorer-value') : null
  activeField.value = (target?.dataset.field as ExplorerField | undefined) ?? undefined
}

const running = ref(false)
const result = shallowRef<{ value: unknown, ms: number }>()
const error = shallowRef<Error>()
const view = ref<'normalised' | 'raw'>('normalised')
const resultHtml = ref('')
/** The JSON the result shows, as plain text for the copy button. */
const resultText = ref('')
const resultCopy = useCopyToClipboard(() => resultText.value)

/** Counts runs, so that a run that a newer one or a forge change superseded drops its result. */
let runs = 0

/** Clears the result, and drops the run in flight, if any. */
function cancelRun() {
  runs++
  running.value = false
  result.value = undefined
  error.value = undefined
}

async function run() {
  if (!provider.value || !operation.run || running.value || unsupported.value) {
    return
  }
  cancelRun()
  const current = runs
  running.value = true
  const started = performance.now()
  try {
    const value = await operation.run(provider.value, { ...input }, explorerRefs(provider.value, input))
    if (current === runs) {
      result.value = { value, ms: Math.round(performance.now() - started) }
    }
  }
  catch (caught) {
    if (current === runs) {
      error.value = caught instanceof Error ? caught : new Error(String(caught))
    }
  }
  finally {
    if (current === runs) {
      running.value = false
    }
  }
}

/** The forge payloads in a result: a single `raw`, or one per item of a page. */
function rawOf(value: unknown): unknown {
  if (value && typeof value === 'object') {
    if ('raw' in value) {
      return value.raw
    }
    const items = 'items' in value && Array.isArray(value.items) ? value.items as unknown[] : []
    if (items.some(item => item && typeof item === 'object' && 'raw' in item)) {
      return items.map(item => (item && typeof item === 'object' && 'raw' in item ? item.raw : undefined))
    }
  }
  return undefined
}

const status = computed(() => {
  if (running.value) {
    return `Running ${operation.method}()…`
  }
  return result.value ? `Done in ${result.value.ms} ms.` : ''
})

const views = computed(() => [
  { label: 'Normalised', value: 'normalised', icon: 'i-lucide-layers' },
  { label: `Raw from ${forge.value.name}`, value: 'raw', icon: forge.value.icon },
])
const hasRaw = computed(() => rawOf(result.value?.value) !== undefined)

const hovers = shallowRef<Record<string, { signature: string, description?: string }>>({})
const pageMembers = shallowRef<Array<{ name: string, type: string, optional: boolean, description: string }>>([])

// The hovers load once someone opens the explorer, like the provider.
watch(open, async (isOpen) => {
  if (isOpen && !Object.keys(hovers.value).length) {
    const loaded = await import('#build/explorer-hovers.js')
    hovers.value = loaded.default
    pageMembers.value = loaded.page
  }
}, { immediate: true })

const resultKeys = shallowRef<KeyInfo[]>([])
/** The key of the result, or name in the code, whose hover is open. */
const hovered = shallowRef<HTMLElement | null>(null)

/** Counts renders of the result, so that a slower, older render never overwrites a newer one. */
let renders = 0

// The normalised view annotates keys with their schema, and leaves out the payloads, which the raw view shows.
// It renders again once the members of `Page<T>` load, if the result came first.
watch([result, view, pageMembers], async () => {
  const current = ++renders
  resultHtml.value = ''
  resultKeys.value = []
  hovered.value = null
  if (!result.value) {
    return
  }
  const raw = view.value === 'raw' && hasRaw.value
  const page = /^Page<(\w+)>$/.exec(operation.returns)
  const array = /^(\w+)\[\]$/.exec(operation.returns)
  const schema = page
    ? pageSchema(page[1]!, pageMembers.value)
    : array ? { type: 'array', items: { $ref: `#/components/schemas/${array[1]}` } } : { $ref: `#/components/schemas/${operation.returns}` }
  const { text, keys } = raw
    ? annotateJson(rawOf(result.value.value), undefined, {}, false)
    : annotateJson(result.value.value, schema, await explorerSchemas(), true)
  const decorations = keys.map(({ start, end }, index) => ({ start, end, properties: { 'class': 'explorer-key', 'data-key': index, 'tabindex': -1 } }))
  const html = await highlightExplorerCode(text, 'json', decorations)
  if (current === renders) {
    resultHtml.value = html
    resultText.value = text
    resultKeys.value = keys.map(key => key.info)
  }
})

/** What the hovered key of the result, or name in the code, shows: its signature and description. */
const hoveredInfo = computed((): { signature: string, description?: string } | undefined => {
  const { key, symbol } = hovered.value?.dataset ?? {}
  if (key !== undefined) {
    const info = resultKeys.value[Number(key)]
    return info && { signature: `(property) ${info.owner ? `${info.owner}.` : ''}${info.name}${info.optional ? '?' : ''}: ${info.type}`, description: info.description }
  }
  if (symbol?.startsWith('const:')) {
    // A constant the code declares, such as `const:result:Page<Thread>`, described by its type.
    const [, name, type] = symbol.split(':') as [string, string, string]
    const base = type.replace(/^Page<.+>$/, 'Page').replace(/\[\]$/, '')
    return { signature: `const ${name}: ${type}`, description: hovers.value[`type:${base}`]?.description }
  }
  return symbol ? hovers.value[symbol] : undefined
})
const signatureHtml = ref('')

watch(hovered, (element, previous) => {
  previous?.removeAttribute('data-active')
  element?.setAttribute('data-active', '')
})

watch(hoveredInfo, async (info) => {
  signatureHtml.value = ''
  if (info) {
    const html = await highlightExplorerCode(info.signature, 'typescript')
    if (hoveredInfo.value === info) {
      signatureHtml.value = html
    }
  }
})

/** What a screen reader hears for the key or name that has focus. */
const hoverAnnouncement = computed(() => hoveredInfo.value ? `${hoveredInfo.value.signature}. ${hoveredInfo.value.description ?? ''}` : '')

const HOVERABLE = '.explorer-key, .explorer-symbol'

/** Arrow keys move between the hoverable keys or names of a region, so their types are reachable without a pointer. */
function onHoverKeydown(event: KeyboardEvent) {
  const region = event.currentTarget as HTMLElement
  const targets = [...region.querySelectorAll<HTMLElement>(HOVERABLE)]
  if (!targets.length) {
    return
  }
  if (event.key === 'Escape') {
    hovered.value = null
    region.focus()
    return
  }
  const current = targets.indexOf(document.activeElement as HTMLElement)
  const next = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: targets.length - 1 }[event.key]
  if (next !== undefined) {
    event.preventDefault()
    targets[Math.max(0, Math.min(targets.length - 1, next))]!.focus()
  }
}

function onHoverFocus(event: FocusEvent) {
  hovered.value = event.target instanceof HTMLElement && event.target.matches(HOVERABLE) ? event.target : null
}

function onHoverPointer(event: PointerEvent) {
  if (event.pointerType !== 'touch') {
    hovered.value = event.target instanceof Element ? event.target.closest<HTMLElement>(HOVERABLE) : null
  }
}

/** A description as text and inline code, split on backticks. */
function descriptionParts(text: string) {
  return text.replace(/\{@link ([^}]+)\}/g, '`$1`').split('`').map((part, index) => ({ text: part, code: index % 2 === 1 }))
}

/** An example URL of the forge for the placeholder: a thread when the operation reads one, else the repository. */
const urlPlaceholder = computed(() => {
  const loaded = provider.value
  if (!loaded) {
    return 'Paste a URL'
  }
  const { sample } = forge.value
  const repo = { forge: loaded.forge, instance: loaded.instance, owner: sample.owner, name: sample.name }
  const example = (operation.uses === 'thread' && loaded.urlFor({ thread: { forge: loaded.forge, instance: loaded.instance, repo, kind: sample.kind as ThreadKind, number: sample.number } }))
    || loaded.urlFor({ repo })
  return example ? `Paste a URL, such as ${example}` : `${forge.value.name} has no web URLs to paste`
})

const url = ref('')
const urlError = ref('')

// Waits for a pause in typing, so a half-typed URL doesn't fill the form or show an error.
watch(url, (text, _, onCleanup) => {
  const timer = setTimeout(() => fillFromUrl(text.trim()), 400)
  onCleanup(() => clearTimeout(timer))
})

/** Fills the form from a web URL on one of the explorer's forges, and switches to that forge. */
async function fillFromUrl(text: string) {
  urlError.value = ''
  let host: string
  try {
    host = new URL(text).host
  }
  catch {
    return
  }
  const target = EXPLORER_FORGES.find(entry => entry.instance === host)
  if (!target) {
    urlError.value = `The explorer can call ${EXPLORER_FORGES.map(entry => entry.instance).join(', ')}.`
    return
  }
  forgeId.value = target.forge
  await nextTick()
  let parsed
  try {
    parsed = (await explorerProvider(target.forge))?.parseUrl(text)
  }
  catch (caught) {
    urlError.value = `The ${target.name} provider failed to load: ${caught instanceof Error ? caught.message : String(caught)}`
    return
  }
  if (url.value.trim() !== text) {
    return
  }
  if (!parsed) {
    urlError.value = `${target.name} has no repository at that URL.`
    return
  }
  // Start from the sample, and drop its values that only exist in its own repository, such as a commit sha.
  Object.assign(input, target.sample)
  if (parsed.repo.owner !== target.sample.owner || parsed.repo.name !== target.sample.name) {
    for (const field of REPOSITORY_FIELDS) {
      input[field] = ''
    }
  }
  input.owner = parsed.repo.owner
  input.name = parsed.repo.name
  if (parsed.thread?.number && (parsed.thread.kind === 'issue' || parsed.thread.kind === 'pull_request')) {
    input.kind = parsed.thread.kind
    input.number = parsed.thread.number
  }
  else if (parsed.thread && explorerFields(operation, input).includes('number')) {
    // Tangled URLs carry the number people see, not the record's AT-URI that a ref needs.
    urlError.value = `${target.name} URLs don't identify the record, so paste its AT-URI into Number.`
  }
}
</script>

<template>
  <div class="explorer not-prose my-6 overflow-hidden rounded-xl border border-default/70 bg-elevated/30">
    <button
      v-if="!open"
      type="button"
      class="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left text-sm text-muted transition hover:text-highlighted"
      :aria-expanded="false"
      @click="openExplorer"
    >
      <UIcon
        :name="operation.run ? 'i-lucide-play' : 'i-lucide-code'"
        class="size-4 text-primary"
      />
      <span v-if="operation.run">Try <code class="font-mono text-highlighted">{{ operation.method }}()</code> against a real forge</span>
      <span v-else>See the code for <code class="font-mono text-highlighted">{{ operation.method }}()</code></span>
    </button>

    <div
      v-else
      ref="panel"
      role="region"
      :aria-label="`Try ${operation.method}()`"
    >
      <div class="flex items-center justify-between gap-4 border-b border-default/70 bg-default/50 px-3">
        <div
          class="flex min-w-0 items-center gap-1 max-sm:overflow-x-auto"
          role="radiogroup"
          aria-label="Forge"
          @keydown="forgeRadios.onKeydown"
        >
          <button
            v-for="entry of EXPLORER_FORGES"
            :key="entry.forge"
            type="button"
            role="radio"
            :aria-checked="forgeId === entry.forge"
            :tabindex="forgeRadios.tabindex(entry.forge)"
            :aria-label="entry.name"
            :title="entry.name"
            class="explorer-tab relative flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-2 px-3 font-mono text-xs"
            :class="forgeId === entry.forge ? 'text-highlighted' : 'text-muted hover:text-highlighted'"
            @click="forgeId = entry.forge"
          >
            <UIcon
              :name="entry.icon"
              class="size-4"
              aria-hidden="true"
            />
          </button>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <!-- The forge's name sits here rather than in its tab, so that changing the forge doesn't shift the tabs. -->
          <span class="hidden items-center gap-1.5 font-mono text-xs text-muted sm:flex">
            <!-- The selected tab's icon and accent, so the name reads as that tab's. -->
            <UIcon
              :name="forge.icon"
              class="size-3.5 text-primary"
              aria-hidden="true"
            />
            <span class="text-primary">{{ forge.name }}</span>
          </span>
          <UButton
            v-if="!expanded"
            :to="`/getting-started/explorer?verb=${operation.verb}`"
            icon="i-lucide-maximize-2"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Open in the explorer"
            title="Open in the explorer"
          />
        </div>
      </div>

      <div class="flex flex-col gap-5 p-4 sm:p-6">
        <UInput
          v-model="url"
          size="sm"
          icon="i-lucide-link"
          :placeholder="urlPlaceholder"
          aria-label="URL of a repository, issue or pull request"
          :aria-describedby="`${id}-url-error`"
          :aria-invalid="Boolean(urlError) || undefined"
          :ui="{ trailing: 'pe-1' }"
        >
          <template #trailing>
            <!-- Opens on click, so focus can move into it and reach the link; a hover card can't be read by keyboard. -->
            <UPopover :content="{ side: 'top', align: 'end' }">
              <UButton
                icon="i-lucide-sparkles"
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="How URLs are read"
              />
              <template #content>
                <p class="max-w-xs p-3 text-sm text-muted">
                  This runs the library's own
                  <code class="font-mono text-highlighted">parseUrl()</code>, so a link from any of these forges becomes the same refs your code would get.
                  <ULink
                    to="/reference/provider#parseurl"
                    class="mt-2 block text-highlighted underline underline-offset-4"
                  >
                    See parseUrl()
                  </ULink>
                </p>
              </template>
            </UPopover>
          </template>
        </UInput>
        <!-- Always rendered, so a screen reader announces an error when it appears. -->
        <p
          :id="`${id}-url-error`"
          class="text-xs text-(--ui-color-error-700) empty:hidden dark:text-(--ui-color-error-300)"
          aria-live="polite"
          :class="urlError && '-mt-3'"
        >
          {{ urlError }}
        </p>

        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <UFormField
            v-for="{ field, label, items, hint, placeholder, colour } of fields"
            :key="field"
            :hint="hint"
            size="sm"
            class="explorer-field"
            :style="{ '--field': colour }"
            :data-field="field"
            :data-active="activeField === field || undefined"
            @pointerenter="activeField = field"
            @pointerleave="activeField = undefined"
            @focusin="activeField = field"
            @focusout="activeField = undefined"
          >
            <template #label>
              <span class="flex items-center gap-1.5">
                <span
                  class="explorer-swatch"
                  aria-hidden="true"
                />
                {{ label }}
              </span>
            </template>
            <USelect
              v-if="items"
              v-model="input[field]"
              :items="items"
              class="w-full"
            />
            <UInput
              v-else
              v-model="input[field]"
              :placeholder="placeholder"
              class="w-full"
            />
          </UFormField>
        </div>

        <div class="relative overflow-hidden rounded-lg border border-default/70 bg-default/40">
          <!-- eslint-disable vue/no-v-html -->
          <div
            v-if="codeHtml"
            ref="codeView"
            class="explorer-code syntax-code overflow-x-auto p-4 font-mono text-[13px] leading-6"
            role="region"
            aria-label="Code"
            tabindex="0"
            :aria-describedby="`${id}-hover-help`"
            @keydown="onHoverKeydown"
            @focusin="onHoverFocus"
            @focusout="hovered = null"
            @pointerover="onCodePointer"
            @pointerleave="activeField = undefined; hovered = null"
            v-html="codeHtml"
          />
          <!-- eslint-enable vue/no-v-html -->
          <pre
            v-else
            class="overflow-x-auto p-4 font-mono text-[13px] leading-6"
          >{{ code.text }}</pre>
          <UButton
            class="absolute top-2 right-2"
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            :aria-label="copied ? 'Copied' : 'Copy code'"
            @click="copy"
          />
          <span
            class="sr-only"
            aria-live="polite"
          >{{ message }}</span>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <p
            v-if="!operation.run"
            class="flex items-center gap-2 text-sm text-muted"
          >
            <UIcon
              name="i-lucide-info"
              class="size-4 shrink-0"
              aria-hidden="true"
            />
            Not yet supported in the explorer.
          </p>
          <p
            v-else-if="forge.blocked"
            class="flex items-center gap-2 text-sm text-muted"
          >
            <UIcon
              name="i-lucide-info"
              class="size-4 shrink-0"
              aria-hidden="true"
            />
            {{ forge.blocked }} Copy the code to run it outside the browser.
          </p>
          <UButton
            v-else
            icon="i-lucide-play"
            label="Run"
            color="neutral"
            :loading="running || (!provider && !providerError)"
            :disabled="!provider"
            :aria-disabled="unsupported || undefined"
            :aria-describedby="unsupported ? `${id}-unsupported` : undefined"
            @click="run"
          />
          <p
            v-if="unsupported"
            :id="`${id}-unsupported`"
            class="text-sm text-muted"
          >
            {{ forge.name }} doesn't support <code class="font-mono">{{ operation.verb }}</code><template v-if="operation.kind">
              for {{ input.kind === 'issue' ? 'issues' : 'pull requests' }}
            </template>. Calling it rejects with <code class="font-mono">UnsupportedOperationError</code>.
          </p>
          <p
            v-else-if="support === 'experimental' || support === 'emulated'"
            class="text-sm text-muted"
          >
            {{ forge.name }} support for this is {{ support }}.
          </p>
          <span
            v-if="result"
            class="font-mono text-xs text-muted"
            aria-hidden="true"
          >{{ result.ms }} ms</span>
          <span
            class="sr-only"
            role="status"
          >{{ status }}</span>
        </div>

        <div
          v-if="providerError"
          class="rounded-lg border border-error/40 bg-error/5 p-4 text-sm"
          role="alert"
        >
          {{ providerError }}
        </div>

        <div
          v-if="error"
          class="rounded-lg border border-error/40 bg-error/5 p-4 font-mono text-sm"
          role="alert"
        >
          <span class="text-(--ui-color-error-700) dark:text-(--ui-color-error-300)">{{ error.name }}</span>: {{ error.message }}
        </div>

        <div
          v-if="result"
          class="overflow-hidden rounded-lg border border-default/70 bg-default/40"
        >
          <UTabs
            v-if="hasRaw"
            v-model="view"
            :items="views"
            :content="false"
            variant="link"
            size="sm"
            color="neutral"
            class="border-b border-default/70 px-2"
          />
          <!-- The button sits outside the scrolling result, so it stays in place as the JSON scrolls. -->
          <div class="relative">
            <UButton
              class="absolute top-2 right-2 z-10"
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="resultCopy.copied.value ? 'i-lucide-check' : 'i-lucide-copy'"
              :aria-label="resultCopy.copied.value ? 'Copied' : 'Copy result'"
              @click="resultCopy.copy"
            />
            <span
              class="sr-only"
              aria-live="polite"
            >{{ resultCopy.message.value }}</span>
            <!-- eslint-disable vue/no-v-html -->
            <div
              class="explorer-code syntax-code max-h-96 overflow-auto p-4 font-mono text-[13px] leading-6"
              role="region"
              aria-label="Result"
              tabindex="0"
              :aria-describedby="resultKeys.length ? `${id}-hover-help` : undefined"
              @keydown="onHoverKeydown"
              @focusin="onHoverFocus"
              @focusout="hovered = null"
              @pointerover="onHoverPointer"
              @pointerleave="hovered = null"
              @scroll="hovered = null"
              v-html="resultHtml"
            />
            <!-- eslint-enable vue/no-v-html -->
          </div>
        </div>
        <p
          :id="`${id}-hover-help`"
          class="sr-only"
        >
          Use the up and down arrow keys to move between names and hear their types.
        </p>
        <span
          class="sr-only"
          aria-live="polite"
        >{{ hoverAnnouncement }}</span>
        <UTooltip
          :reference="hovered ?? undefined"
          :open="Boolean(hovered && hoveredInfo)"
          :content="{ side: 'top', align: 'start', sideOffset: 6, collisionPadding: 16, hideWhenDetached: true }"
          :ui="{ content: 'block h-auto max-w-[min(36rem,calc(100vw-2rem))] rounded-lg bg-elevated px-4 py-3 text-default shadow-lg ring-default' }"
        >
          <span
            class="hidden"
            aria-hidden="true"
          />
          <template #content>
            <!-- eslint-disable vue/no-v-html -->
            <div
              class="explorer-code syntax-code font-mono text-xs leading-5"
              v-html="signatureHtml"
            />
            <!-- eslint-enable vue/no-v-html -->
            <p
              v-if="hoveredInfo?.description"
              class="mt-2 border-t border-default pt-2 text-sm text-muted"
            >
              <template
                v-for="(part, index) of descriptionParts(hoveredInfo.description)"
                :key="index"
              >
                <code
                  v-if="part.code"
                  class="font-mono text-xs text-highlighted"
                >{{ part.text }}</code>
                <template v-else>
                  {{ part.text }}
                </template>
              </template>
            </p>
          </template>
        </UTooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.explorer-tab[aria-checked='true'] {
  box-shadow: inset 0 -1px 0 var(--ui-primary);
}

.explorer-tab:focus-visible {
  outline-offset: -2px;
}

.explorer-code :deep(pre) {
  margin: 0;
  background: transparent !important;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

.explorer-swatch {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 2px;
  background: var(--field);
}

.explorer-field[data-active] :deep(:is(input, button)) {
  box-shadow: 0 0 0 1px var(--field);
}

.explorer-code :deep(.explorer-value) {
  border-radius: 3px;
  outline: 1px solid color-mix(in oklab, var(--field) 55%, transparent);
  background: color-mix(in oklab, var(--field) 8%, transparent);
  transition: background-color 120ms ease, outline-color 120ms ease;
}

.explorer-code :deep(.explorer-key) {
  cursor: help;
  border-radius: 3px;
  transition: background-color 120ms ease;
}

.explorer-code :deep(.explorer-key:is(:hover, [data-active])) {
  background-color: color-mix(in oklab, var(--ui-primary) 12%, transparent);
}

.explorer-code :deep(.explorer-value span) {
  background: transparent;
}

.explorer-code :deep(.explorer-value[data-active]) {
  outline: 2px solid var(--field);
  background: color-mix(in oklab, var(--field) 22%, transparent);
}
</style>
