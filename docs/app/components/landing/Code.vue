<script setup lang="ts">
const props = defineProps<{
  code: string
  label: string
}>()

const TOKEN = /(\/\/.*)|('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|const|let|await|async|for|of|if|return|new|export|default|function|as|type)\b|\b(true|false|null|undefined)\b|(\b[A-Z]\w*\b)|(\b[a-z_$][\w$]*)(?=\()|(\b\d+\b)/g

interface Part {
  text: string
  kind?: 'comment' | 'string' | 'keyword' | 'literal' | 'type' | 'function' | 'number'
}

const KINDS = [undefined, 'comment', 'string', 'keyword', 'literal', 'type', 'function', 'number'] as const

// Minimal tokenizer for the landing snippets.
const lines = computed(() => props.code.split('\n').map((line) => {
  const parts: Part[] = []
  let last = 0
  for (const match of line.matchAll(TOKEN)) {
    if (match.index > last) {
      parts.push({ text: line.slice(last, match.index) })
    }
    const group = match.findIndex((value, index) => index > 0 && value !== undefined)
    parts.push({ text: match[0], kind: KINDS[group] })
    last = match.index + match[0].length
  }
  parts.push({ text: line.slice(last) })
  return parts
}))
</script>

<template>
  <figure class="overflow-hidden rounded-lg border border-default bg-elevated/50">
    <figcaption class="flex items-center gap-2 border-b border-default px-4 py-2.5 font-mono text-xs text-muted">
      <span class="size-1.5 bg-primary" />
      {{ label }}
    </figcaption>
    <pre tabindex="0" class="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-default"><code><template
      v-for="(line, index) of lines"
      :key="index"
    ><span
      v-for="(part, partIndex) of line"
      :key="partIndex"
      :class="part.kind ? `tok-${part.kind}` : undefined"
    >{{ part.text }}</span>{{ '\n' }}</template></code></pre>
  </figure>
</template>

<style>
.tok-comment {
  color: var(--ui-text-dimmed);
  font-style: italic;
}

.tok-string {
  color: var(--ui-color-primary-700);
}

.tok-keyword {
  color: var(--ui-color-secondary-700);
}

.tok-literal,
.tok-number {
  color: var(--ui-color-primary-800);
}

.tok-type {
  color: var(--ui-text-highlighted);
}

.tok-function {
  color: var(--ui-text-highlighted);
  font-weight: 600;
}

.dark .tok-string {
  color: var(--ui-color-primary-300);
}

.dark .tok-keyword {
  color: var(--ui-color-secondary-300);
}

.dark .tok-literal,
.dark .tok-number {
  color: var(--ui-color-primary-400);
}
</style>
