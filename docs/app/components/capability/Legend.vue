<script setup lang="ts">
withDefaults(defineProps<{
  levels?: Array<'native' | 'experimental' | 'emulated' | 'unverified' | 'not_applicable' | 'none'>
  kinds?: boolean
  /** Adds the mark for support that depends on the kind of credential. */
  credentials?: boolean
  /** Adds a disclosure that explains each level. */
  explain?: boolean
}>(), {
  levels: () => supportLevels,
})

const kindLabels = ['issue', 'PR', 'discussion']
</script>

<template>
  <div>
    <ul
      v-if="levels.length || kinds || credentials || $slots.default"
      class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted"
    >
      <li
        v-for="level of levels"
        :key="level"
        class="inline-flex items-center gap-2"
      >
        <CapabilityCell :level="level" />
        {{ supportLabels[level] }}
      </li>
      <li
        v-if="kinds"
        class="inline-flex items-center gap-2"
      >
        <span
          class="grid grid-cols-3 gap-px"
          aria-hidden="true"
        >
          <span
            v-for="label of kindLabels"
            :key="label"
            class="flex h-3.5 items-center justify-center bg-elevated px-1 font-mono text-[9px] leading-none text-toned"
          >{{ label }}</span>
        </span>
        <span>Per thread kind</span>
      </li>
      <li
        v-if="credentials"
        class="inline-flex items-center gap-2"
      >
        <CapabilityCell
          level="native"
          :credentials="['']"
        />
        Depends on the credential
      </li>
      <slot />
    </ul>

    <details
      v-if="explain"
      class="group text-xs"
      :class="{ 'mt-3': levels.length || kinds || credentials || $slots.default }"
    >
      <summary class="inline-flex cursor-pointer list-none items-center gap-1.5 text-muted hover:text-highlighted [&::-webkit-details-marker]:hidden">
        <UIcon
          name="i-lucide-chevron-right"
          class="size-3.5 transition group-open:rotate-90"
        />
        What the levels mean
      </summary>
      <dl class="mt-3 grid gap-x-4 gap-y-2.5 rounded-lg border border-default p-4 sm:grid-cols-[auto_1fr]">
        <template
          v-for="level of supportLevels"
          :key="level"
        >
          <dt class="flex items-center gap-2 font-medium text-highlighted">
            <CapabilityCell
              :level="level"
              class="[--capability-cell-size:0.75rem]"
            />
            {{ supportLabels[level] }}
          </dt>
          <dd class="text-muted max-sm:mb-1.5">
            {{ supportDescriptions[level] }}
          </dd>
        </template>
        <template v-if="credentials">
          <dt class="flex items-center gap-2 font-medium text-highlighted">
            <CapabilityCell
              level="native"
              :credentials="['']"
              class="[--capability-cell-size:0.75rem]"
            />
            Depends on the credential
          </dt>
          <dd class="text-muted max-sm:mb-1.5">
            Only some of the forge's kinds of credential have this support, and the cell names them.
          </dd>
        </template>
        <slot name="explain" />
        <dd class="text-muted sm:col-span-2">
          See <NuxtLink
            to="/concepts/capabilities#support-levels"
            class="text-primary hover:underline"
          >
            Capabilities
          </NuxtLink> for what each level means and how we check it.
        </dd>
      </dl>
    </details>
  </div>
</template>
