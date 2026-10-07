<script setup lang="ts">
import examples from '#examples'

const props = defineProps<{
  example: string
}>()

const load = examples[props.example]
if (!load) {
  throw new Error(`Unknown example: ${props.example}`)
}
const { data } = await useAsyncData(`example-files-${props.example}`, load)

const ICONS: Record<string, string> = {
  'package.json': 'i-vscode-icons-file-type-npm',
  'tsconfig.json': 'i-vscode-icons-file-type-tsconfig',
  'json': 'i-vscode-icons-file-type-json',
  'md': 'i-vscode-icons-file-type-markdown',
  'test.ts': 'i-vscode-icons-file-type-testts',
  'ts': 'i-vscode-icons-file-type-typescript',
}

function icon(path: string) {
  const name = path.split('/').pop()!
  return ICONS[name] ?? ICONS[name.split('.').slice(-2).join('.')] ?? ICONS[name.split('.').pop()!] ?? 'i-lucide-file'
}

interface Entry {
  path: string
  name: string
  depth: number
  directory: boolean
}

const entries = computed(() => {
  const list: Entry[] = []
  const seen = new Set<string>()
  for (const { path } of data.value?.files ?? []) {
    const parts = path.split('/')
    parts.slice(0, -1).forEach((name, depth) => {
      const directory = parts.slice(0, depth + 1).join('/')
      if (!seen.has(directory)) {
        seen.add(directory)
        list.push({ path: directory, name, depth, directory: true })
      }
    })
    list.push({ path, name: parts.at(-1)!, depth: parts.length - 1, directory: false })
  }
  return list
})

const collapsed = ref(new Set<string>())
const visible = computed(() => entries.value.filter(entry => ![...collapsed.value].some(directory => entry.path.startsWith(`${directory}/`))))

function toggle(directory: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(directory)) {
    next.add(directory)
  }
  collapsed.value = next
}

const selected = ref(data.value?.entry)
const file = computed(() => data.value?.files.find(file => file.path === selected.value))

const { copied, copy, message } = useCopyToClipboard(() => file.value?.content ?? '')
</script>

<template>
  <div
    v-if="data"
    class="not-prose my-6 overflow-hidden rounded-lg border border-default"
  >
    <div class="flex items-center gap-3 border-b border-default bg-elevated/40 py-2 pr-2 pl-4">
      <UIcon
        name="i-lucide-folder-git-2"
        class="size-4 shrink-0 text-muted"
      />
      <span class="min-w-0 flex-1 truncate font-mono text-xs text-highlighted">examples/{{ data.name }}</span>
      <UButton
        :to="data.url"
        target="_blank"
        icon="i-simple-icons-github"
        label="View on GitHub"
        aria-label="View on GitHub (opens in a new tab)"
        color="neutral"
        variant="ghost"
        size="xs"
      />
    </div>

    <div class="grid lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav
        :aria-label="`Files in examples/${data.name}`"
        class="max-h-48 overflow-y-auto border-b border-default py-2 lg:max-h-[34rem] lg:border-r lg:border-b-0"
      >
        <ul class="font-mono text-xs">
          <li
            v-for="entry of visible"
            :key="entry.path"
          >
            <button
              v-if="entry.directory"
              type="button"
              class="flex w-full items-center gap-1.5 py-1 pr-3 text-left text-muted hover:text-highlighted"
              :style="{ paddingLeft: `${0.75 + entry.depth * 0.875}rem` }"
              :aria-expanded="!collapsed.has(entry.path)"
              @click="toggle(entry.path)"
            >
              <UIcon
                :name="collapsed.has(entry.path) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                class="size-3.5 shrink-0"
              />
              <UIcon
                :name="collapsed.has(entry.path) ? 'i-lucide-folder' : 'i-lucide-folder-open'"
                class="size-3.5 shrink-0"
              />
              {{ entry.name }}
            </button>
            <button
              v-else
              type="button"
              class="flex w-full items-center gap-1.5 py-1 pr-3 text-left"
              :class="entry.path === selected ? 'bg-primary/10 text-highlighted' : 'text-toned hover:bg-elevated hover:text-highlighted'"
              :style="{ paddingLeft: `${0.75 + entry.depth * 0.875 + 1.25}rem` }"
              :aria-current="entry.path === selected ? 'true' : undefined"
              @click="selected = entry.path"
            >
              <UIcon
                :name="icon(entry.path)"
                class="size-3.5 shrink-0"
              />
              <span class="truncate">{{ entry.name }}</span>
              <UIcon
                v-if="entry.path === selected"
                name="i-lucide-check"
                class="ml-auto size-3 shrink-0"
              />
            </button>
          </li>
        </ul>
      </nav>

      <div
        v-if="file"
        class="min-w-0"
      >
        <div class="flex items-center gap-2 border-b border-default py-1.5 pr-2 pl-4">
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{{ file.path }}</span>
          <UButton
            :to="file.url"
            target="_blank"
            icon="i-lucide-external-link"
            :aria-label="`Open ${file.path} on GitHub (opens in a new tab)`"
            color="neutral"
            variant="ghost"
            size="xs"
          />
          <UButton
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            :aria-label="copied ? 'Copied' : `Copy ${file.path}`"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="copy"
          />
          <span
            class="sr-only"
            aria-live="polite"
          >{{ message }}</span>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div
          class="example-code max-h-[32rem] overflow-auto bg-muted/40 text-[13px] leading-6"
          tabindex="0"
          role="region"
          :aria-label="file.path"
          v-html="file.html"
        />
      </div>
    </div>
  </div>
</template>

<style>
.example-code pre {
  width: max-content;
  min-width: 100%;
  padding-block: 0.75rem;
  font-family: var(--font-mono);
}

.example-code code {
  counter-reset: line;
}

.example-code .line {
  display: inline-block;
  padding-right: 1rem;
}

.example-code .line::before {
  counter-increment: line;
  content: counter(line);
  display: inline-block;
  width: 3rem;
  padding-right: 1rem;
  text-align: right;
  color: var(--ui-text-muted);
  user-select: none;
}

.example-code span {
  color: var(--shiki-light);
  font-style: var(--shiki-light-font-style);
}

.dark .example-code span {
  color: var(--shiki-dark);
  font-style: var(--shiki-dark-font-style);
}
</style>
