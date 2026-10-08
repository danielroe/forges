<script setup lang="ts">
interface Forge {
  name: string
  icon: string
  factory: string
  module: string
  options: string
  /** Notification `subjectTypeRaw` for a pull request; absent when the forge has no notifications. */
  notificationType?: string
  read: string
}

const unified = `import { createForges, forgejo, github, gitlab, tangled } from 'forges'

const forges = createForges([
  github({ auth: { type: 'token', token: () => session.accessToken() } }),
  gitlab({ auth: { type: 'token', token: process.env.GITLAB_TOKEN! } }),
  forgejo({ baseUrl: 'https://codeberg.org', auth: { type: 'token', token: process.env.CODEBERG_TOKEN! } }),
  tangled({ auth: { type: 'app_password', identifier: 'alice.example.com', password: process.env.TANGLED_APP_PASSWORD! } }),
])

for await (const notification of forges.notifications.list()) {
  console.log(notification.ref.forge, notification.title)
}

// Routed to the GitLab provider
const ref = forges.parseUrl('https://gitlab.com/acme/api/-/merge_requests/42')?.thread
const thread = await forges.threads.get(ref!)`

function token(env: string): string {
  return `{
  auth: { type: 'token', token: process.env.${env}! },
}`
}

function readUrl(url: string, stateRaw: string): string {
  return `const ref = forge.parseUrl('${url}')?.thread
const thread = await forge.threads.get(ref!)

thread.kind      // 'pull_request'
thread.state     // 'merged'
thread.stateRaw  // '${stateRaw}'`
}

// Values follow each provider's normaliser for a merged pull request. Cursor Origin
// has no web URLs to parse, and a Tangled URL carries a display number rather than the record key.
const forges: Forge[] = [
  { name: 'GitHub', icon: 'i-simple-icons-github', factory: 'github', module: 'github', options: token('GITHUB_TOKEN'), notificationType: 'PullRequest', read: readUrl('https://github.com/acme/api/pull/42', 'closed') },
  { name: 'GitLab', icon: 'i-simple-icons-gitlab', factory: 'gitlab', module: 'gitlab', options: token('GITLAB_TOKEN'), notificationType: 'MergeRequest', read: readUrl('https://gitlab.com/acme/api/-/merge_requests/42', 'merged') },
  {
    name: 'Bitbucket',
    icon: 'i-simple-icons-bitbucket',
    factory: 'bitbucket',
    module: 'bitbucket',
    options: `{
  auth: {
    type: 'basic',
    username: process.env.BITBUCKET_USERNAME!,
    password: process.env.BITBUCKET_APP_PASSWORD!,
  },
}`,
    read: readUrl('https://bitbucket.org/acme/api/pull-requests/42', 'MERGED'),
  },
  { name: 'Codeberg', icon: 'i-simple-icons-forgejo', factory: 'forgejo', module: 'forgejo', options: token('CODEBERG_TOKEN'), notificationType: 'Pull', read: readUrl('https://codeberg.org/acme/api/pulls/42', 'closed') },
  { name: 'Gitea', icon: 'i-simple-icons-gitea', factory: 'gitea', module: 'gitea', options: token('GITEA_TOKEN'), notificationType: 'Pull', read: readUrl('https://gitea.com/acme/api/pulls/42', 'closed') },
  { name: 'Gitee', icon: 'i-simple-icons-gitee', factory: 'gitee', module: 'gitee', options: token('GITEE_TOKEN'), notificationType: 'PullRequest', read: readUrl('https://gitee.com/acme/api/pulls/42', 'merged') },
  {
    name: 'Azure DevOps',
    icon: 'i-simple-icons-azuredevops',
    factory: 'azureDevOps',
    module: 'azure-devops',
    options: `{
  organization: 'acme',
  auth: { type: 'token', token: process.env.AZURE_DEVOPS_TOKEN! },
}`,
    read: readUrl('https://dev.azure.com/acme/Widgets/_git/api/pullrequest/42', 'completed'),
  },
  {
    name: 'Cursor Origin',
    icon: 'i-simple-icons-cursor',
    factory: 'cursorOrigin',
    module: 'cursor-origin',
    options: `{
  auth: {
    type: 'app',
    appId: 'app_01...',
    privateKey: process.env.ORIGIN_APP_PRIVATE_KEY!,
    installationId: 'i_01...',
  },
}`,
    read: `const thread = await forge.threads.get({
  forge: 'cursor-origin',
  instance: 'origin.cursor.com',
  repo: { forge: 'cursor-origin', instance: 'origin.cursor.com', owner: 'acme', name: 'api' },
  kind: 'pull_request',
  number: '42',
})

thread.kind      // 'pull_request'
thread.state     // 'merged'
thread.stateRaw  // 'merged'`,
  },
  { name: 'pushin.eu', icon: 'i-lucide-send', factory: 'pushin', module: 'pushin', options: token('PUSHIN_TOKEN'), notificationType: 'PullRequest', read: readUrl('https://pushin.eu/acme/api/pulls/42', 'merged') },
  {
    name: 'Tangled',
    icon: 'i-lucide-spool',
    factory: 'tangled',
    module: 'tangled',
    options: `{
  auth: {
    type: 'app_password',
    identifier: 'alice.example.com',
    password: process.env.TANGLED_APP_PASSWORD!,
  },
}`,
    read: `const { repo } = forge.parseUrl('https://tangled.org/@alice.example.com/api')!

for await (const thread of forge.threads.list(repo, { state: 'merged' })) {
  thread.kind      // 'pull_request'
  thread.state     // 'merged'
  thread.stateRaw  // 'merged'
}`,
  },
]

function single(forge: Forge): string {
  const parts = [
    `import { ${forge.factory} } from 'forges/${forge.module}'`,
    `const forge = ${forge.factory}(${forge.options}).create()`,
  ]
  if (forge.notificationType) {
    parts.push(`for await (const notification of forge.notifications.list()) {
  notification.subject         // { type: 'thread', thread: { kind: 'pull_request', … } }
  notification.subjectTypeRaw  // '${forge.notificationType}'
}`)
  }
  parts.push(forge.read)
  return parts.join('\n\n')
}

const PRIMARY = ['GitHub', 'GitLab', 'Codeberg', 'Tangled']

const tabs = [
  { name: 'Unified', icon: 'i-lucide-layers', code: unified },
  ...forges.map(forge => ({ name: forge.name, icon: forge.icon, code: single(forge) })),
]
const primary = tabs.filter(tab => tab.name === 'Unified' || PRIMARY.includes(tab.name))
const more = tabs.filter(tab => !primary.includes(tab))

const selected = ref('Unified')
const code = computed(() => tabs.find(tab => tab.name === selected.value)!.code)
const selectedMore = computed(() => more.find(tab => tab.name === selected.value))
const moreItems = computed(() => more.map(tab => ({
  label: tab.name,
  icon: tab.icon,
  type: 'checkbox' as const,
  checked: tab.name === selected.value,
  onSelect: () => {
    selected.value = tab.name
  },
})))
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <div
      class="-mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0"
      role="group"
      aria-label="Forge"
    >
      <UButton
        v-for="tab of primary"
        :key="tab.name"
        :icon="tab.icon"
        :label="tab.name"
        :aria-pressed="selected === tab.name"
        :variant="selected === tab.name ? 'solid' : 'outline'"
        color="neutral"
        size="xs"
        class="shrink-0"
        @click="selected = tab.name"
      />
      <UDropdownMenu
        :items="moreItems"
        :content="{ align: 'start' }"
      >
        <UButton
          :icon="selectedMore?.icon"
          :label="selectedMore?.name ?? `${more.length} more`"
          :variant="selectedMore ? 'solid' : 'outline'"
          trailing-icon="i-lucide-chevron-down"
          color="neutral"
          size="xs"
          class="shrink-0"
        />
      </UDropdownMenu>
    </div>
    <LandingCode :code="code" />
  </div>
</template>
