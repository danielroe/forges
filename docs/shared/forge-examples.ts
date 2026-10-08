interface Forge {
  name: string
  factory: string
  module: string
  options: string
  /** Notification `subjectTypeRaw` for a pull request; absent when the forge has no notifications. */
  notificationType?: string
  read: string
}

const unified = `import { createForges, github, gitlab } from 'forges'

const forges = createForges([
  github({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } }),
  gitlab({ auth: { type: 'token', token: process.env.GITLAB_TOKEN! } }),
])

for await (const notification of forges.notifications.list()) {
  console.log(notification.ref.forge, notification.title)
}`

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
  { name: 'GitHub', factory: 'github', module: 'github', options: token('GITHUB_TOKEN'), notificationType: 'PullRequest', read: readUrl('https://github.com/acme/api/pull/42', 'closed') },
  { name: 'GitLab', factory: 'gitlab', module: 'gitlab', options: token('GITLAB_TOKEN'), notificationType: 'MergeRequest', read: readUrl('https://gitlab.com/acme/api/-/merge_requests/42', 'merged') },
  {
    name: 'Bitbucket',
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
  { name: 'Codeberg', factory: 'forgejo', module: 'forgejo', options: token('CODEBERG_TOKEN'), notificationType: 'Pull', read: readUrl('https://codeberg.org/acme/api/pulls/42', 'closed') },
  { name: 'Gitea', factory: 'gitea', module: 'gitea', options: token('GITEA_TOKEN'), notificationType: 'Pull', read: readUrl('https://gitea.com/acme/api/pulls/42', 'closed') },
  { name: 'Gitee', factory: 'gitee', module: 'gitee', options: token('GITEE_TOKEN'), notificationType: 'PullRequest', read: readUrl('https://gitee.com/acme/api/pulls/42', 'merged') },
  {
    name: 'Azure DevOps',
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
  { name: 'pushin.eu', factory: 'pushin', module: 'pushin', options: token('PUSHIN_TOKEN'), notificationType: 'PullRequest', read: readUrl('https://pushin.eu/acme/api/pulls/42', 'merged') },
  {
    name: 'Tangled',
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

export const forgeExamples = [
  { name: 'Unified', slug: 'unified', code: unified },
  ...forges.map(forge => ({ name: forge.name, slug: forge.module, code: single(forge) })),
]
