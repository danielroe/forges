<script setup lang="ts">
type Support = 'yes' | 'experimental' | 'emulated' | 'no'

const forges = ['GitHub', 'GitLab', 'Bitbucket', 'Forgejo', 'Gitea', 'Gitee', 'Azure DevOps', 'Cursor Origin', 'pushin.eu', 'Tangled']

// Mirrors the capability matrix: Y native, E experimental, M emulated, N unsupported.
const rows: Array<{ verb: string, support: string }> = [
  { verb: 'writes.merge', support: 'YYYYYYYYNN' },
  { verb: 'notifications.list', support: 'YYNYYYNNEE' },
  { verb: 'releases.list', support: 'YYNYYYNNNN' },
  { verb: 'checks.list', support: 'YYYYYEEENN' },
  { verb: 'search.threads', support: 'YYEYYEENNN' },
  { verb: 'webhooks.create', support: 'YEEEEENNNN' },
  { verb: 'ci.runs', support: 'YYNNNNNNNN' },
]

const levels: Record<string, Support> = { Y: 'yes', E: 'experimental', M: 'emulated', N: 'no' }

const legend: Array<{ level: Support, label: string }> = [
  { level: 'yes', label: 'Native and verified' },
  { level: 'experimental', label: 'Experimental' },
  { level: 'no', label: 'Not available' },
]
</script>

<template>
  <div>
    <div class="overflow-x-auto">
      <!-- Fixed column widths -->
      <div class="mx-auto grid w-max grid-cols-[11rem_repeat(10,2.25rem)] items-center gap-y-1.5 pr-16">
        <div />
        <div
          v-for="forge of forges"
          :key="forge"
          class="relative h-24"
        >
          <span class="absolute bottom-0 left-1/2 origin-bottom-left -rotate-45 whitespace-nowrap font-mono text-xs text-muted">{{ forge }}</span>
        </div>

        <template
          v-for="row of rows"
          :key="row.verb"
        >
          <div class="font-mono text-xs text-highlighted">
            {{ row.verb }}
          </div>
          <div
            v-for="(char, index) of row.support"
            :key="index"
            class="flex justify-center"
          >
            <span
              class="cell"
              :data-level="levels[char]"
              :title="`${forges[index]}: ${levels[char]}`"
            />
          </div>
        </template>
      </div>
    </div>

    <ul class="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-muted">
      <li
        v-for="item of legend"
        :key="item.level"
        class="inline-flex items-center gap-2"
      >
        <span
          class="cell"
          :data-level="item.level"
        />
        {{ item.label }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.cell {
  display: inline-block;
  width: 1.125rem;
  height: 1.125rem;
}

.cell[data-level='yes'] {
  background: var(--ui-primary);
}

.cell[data-level='experimental'] {
  background: repeating-linear-gradient(135deg, var(--ui-primary) 0 2px, transparent 2px 4px);
  outline: 1px solid color-mix(in oklab, var(--ui-primary) 55%, transparent);
  outline-offset: -1px;
}

.cell[data-level='emulated'] {
  background: color-mix(in oklab, var(--ui-primary) 45%, transparent);
}

.cell[data-level='no'] {
  background: var(--ui-bg-accented);
  opacity: 0.55;
}
</style>
