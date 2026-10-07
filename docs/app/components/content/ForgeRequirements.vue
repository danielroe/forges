<script setup lang="ts">
import { providers } from '#capabilities'
import { requirements } from '#credentials'

const headings = ['Forge', 'Credentials', 'Optional', 'Anonymous reads']
const rows = requirements.map(forge => ({ ...forge, provider: providers.find(({ slug }) => slug === forge.slug)! }))
</script>

<template>
  <div
    class="not-prose my-6 rounded-lg border border-default sm:overflow-x-auto"
    tabindex="0"
    role="region"
    aria-label="Forge requirements"
  >
    <table
      role="table"
      class="forge-requirements w-full text-left text-sm sm:min-w-[44rem]"
    >
      <caption class="sr-only">
        The fields each forge needs
      </caption>
      <thead
        role="rowgroup"
        class="bg-elevated/50 text-xs text-muted"
      >
        <tr role="row">
          <th
            v-for="heading of headings"
            :key="heading"
            scope="col"
            role="columnheader"
            class="px-4 py-2.5 font-medium whitespace-nowrap"
          >
            {{ heading }}
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        <tr
          v-for="forge of rows"
          :key="forge.slug"
          role="row"
          class="border-t border-default align-top"
        >
          <th
            scope="row"
            role="rowheader"
            class="px-4 py-3 font-normal whitespace-nowrap"
          >
            <NuxtLink
              :to="forge.provider.to"
              class="inline-flex items-center gap-2 text-highlighted hover:text-primary"
            >
              <UIcon
                :name="forge.provider.icon"
                class="size-4 text-muted"
              />
              {{ forge.name }}
            </NuxtLink>
          </th>
          <td
            role="cell"
            :data-label="headings[1]"
            class="px-4 py-3 text-xs text-muted"
          >
            <p
              v-if="forge.required.length"
              class="mb-2 flex flex-wrap items-center gap-1.5"
            >
              <CredentialsField
                v-for="field of forge.required"
                :key="field"
              >
                {{ field }}
              </CredentialsField>
              and
            </p>
            <ul class="flex flex-wrap items-center gap-1.5">
              <li
                v-for="(set, index) of forge.credentials"
                :key="set.fields.join()"
                class="inline-flex items-center gap-1.5"
              >
                <span v-if="index">or</span>
                <template
                  v-for="(field, position) of set.fields"
                  :key="field"
                >
                  <span v-if="position">and</span>
                  <CredentialsField>{{ field }}</CredentialsField>
                </template>
              </li>
            </ul>
          </td>
          <td
            role="cell"
            :data-label="headings[2]"
            class="px-4 py-3 text-xs text-muted"
          >
            <ul
              v-if="forge.credentials.some(set => set.optional.length)"
              class="space-y-2"
            >
              <template
                v-for="set of forge.credentials"
                :key="set.fields.join()"
              >
                <li
                  v-if="set.optional.length"
                  class="flex flex-wrap items-center gap-1.5"
                >
                  <CredentialsField
                    v-for="{ field } of set.optional"
                    :key="field"
                  >
                    {{ field }}
                  </CredentialsField>
                  <span v-if="forge.credentials.length > 1">with {{ credentialLabel(set.fields).toLowerCase() }} credentials</span>
                </li>
              </template>
            </ul>
            <template v-else>
              None
            </template>
          </td>
          <td
            role="cell"
            :data-label="headings[3]"
            class="px-4 py-3 text-xs whitespace-nowrap"
          >
            <p
              v-if="forge.anonymous.default"
              class="flex items-center gap-1.5 text-default"
            >
              <UIcon
                name="i-lucide-globe"
                class="size-3.5 shrink-0 text-primary"
              />
              By default
            </p>
            <p
              v-else-if="forge.anonymous.with.length"
              class="flex items-center gap-1.5 text-default"
            >
              <UIcon
                name="i-lucide-globe"
                class="size-3.5 shrink-0 text-primary"
              />
              With
              <template
                v-for="(field, index) of forge.anonymous.with"
                :key="field"
              >
                <span v-if="index">or</span>
                <CredentialsField>{{ field }}</CredentialsField>
              </template>
            </p>
            <p
              v-else
              class="flex flex-wrap items-center gap-1.5 text-muted"
            >
              <UIcon
                name="i-lucide-ban"
                class="size-3.5 shrink-0"
              />
              Not available
            </p>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="border-t border-default px-4 py-2.5 text-xs text-muted">
      Without a credential, a set is skipped unless the forge reads anonymously by default or the set has one of the fields above.
    </p>
  </div>
</template>

<style>
@media (width < 40rem) {
  .forge-requirements thead {
    display: none;
  }

  .forge-requirements tr,
  .forge-requirements :is(th, td) {
    display: block;
  }

  .forge-requirements td {
    padding-top: 0;
  }

  .forge-requirements td::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 0.375rem;
    color: var(--ui-text-muted);
    font-family: var(--font-sans);
  }
}
</style>
