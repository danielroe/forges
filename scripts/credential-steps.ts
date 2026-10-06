/** One step of the credentials picker, with the sources it was checked against. */
export interface CredentialStep {
  /** Inline Markdown: code, links and bold. */
  text: string
  /** URLs, or paths in this repository, that support the step. */
  sources?: string[]
  /** The date (`YYYY-MM-DD`) the step was last checked against `sources`. A step without it is unverified. */
  verified?: string
}

/** Steps to create each credential, by forge slug and then by fields joined with `+`. */
export const credentialSteps: Record<string, Record<string, CredentialStep[]>> = {
  'github': {
    'TOKEN': [
      {
        text: 'Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for the repositories you need, with the listed permissions.',
        sources: ['https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens'],
        verified: '2026-10-07',
      },
      {
        text: 'A [classic token](https://github.com/settings/tokens/new) takes the token scopes instead. `public_repo` is enough for public repositories, and `admin:org_hook` is only for organisation webhooks.',
        sources: [
          'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps',
          'https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry',
        ],
        verified: '2026-10-07',
      },
    ],
    'APP_ID+PRIVATE_KEY': [
      {
        text: '[Register a GitHub App](https://github.com/settings/apps/new) with the listed permissions.',
        sources: [
          'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app',
          'https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters',
        ],
        verified: '2026-10-07',
      },
      {
        text: 'Copy the app ID from the app\'s settings page, and generate a private key there. Write the key\'s line breaks as `\\n`.',
        sources: [
          'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app',
          'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps',
          'src/env.ts',
        ],
        verified: '2026-10-07',
      },
      {
        text: 'Install the app. `INSTALLATION_ID` is the number at the end of the installation\'s settings URL.',
        sources: ['https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api'],
        verified: '2026-10-07',
      },
    ],
  },
  'gitlab': {
    TOKEN: [
      {
        text: 'Create a [personal access token](https://gitlab.com/-/user_settings/personal_access_tokens) with the listed scopes.',
        sources: ['https://docs.gitlab.com/user/profile/personal_access_tokens/'],
        verified: '2026-10-07',
      },
      {
        text: 'A project or group access token works too, and acts as a bot user.',
        sources: [
          'https://docs.gitlab.com/user/project/settings/project_access_tokens/',
          'https://docs.gitlab.com/user/group/settings/group_access_tokens/',
        ],
        verified: '2026-10-07',
      },
    ],
  },
  'bitbucket': {
    'TOKEN': [
      {
        text: 'Create a repository access token under **Settings > Security > Access tokens** in the repository, with the permissions that match the listed scopes. On Bitbucket Premium, a project or workspace access token works too.',
        sources: [
          'https://support.atlassian.com/bitbucket-cloud/docs/create-a-repository-access-token/',
          'https://support.atlassian.com/bitbucket-cloud/docs/repository-access-token-permissions/',
          'https://support.atlassian.com/bitbucket-cloud/docs/create-a-project-access-token/',
          'https://support.atlassian.com/bitbucket-cloud/docs/create-a-workspace-access-token/',
        ],
        verified: '2026-10-07',
      },
      {
        text: 'Access tokens have no issue permissions. For issues, use a username and an API token instead.',
        sources: [
          'https://support.atlassian.com/bitbucket-cloud/docs/repository-access-token-permissions/',
          'https://support.atlassian.com/bitbucket-cloud/docs/project-access-token-permissions/',
          'https://support.atlassian.com/bitbucket-cloud/docs/workspace-access-token-permissions/',
        ],
        verified: '2026-10-07',
      },
    ],
    'USERNAME+PASSWORD': [
      {
        text: 'Create an [API token with scopes](https://id.atlassian.com/manage-profile/security/api-tokens), and pick Bitbucket as the app. Its scopes have longer names, and a write scope doesn\'t include its read scope: for `issue:write`, tick `read:issue:bitbucket` and `write:issue:bitbucket`.',
        sources: [
          'https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/',
          'https://support.atlassian.com/bitbucket-cloud/docs/api-token-permissions/',
          'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
        ],
        verified: '2026-10-07',
      },
      {
        text: 'Set `USERNAME` to your Atlassian account email and `PASSWORD` to the token.',
        sources: ['https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/'],
        verified: '2026-10-07',
      },
    ],
  },
  'forgejo': {
    TOKEN: [
      {
        text: 'Create an access token under **Settings > Applications** on your instance, such as [Codeberg](https://codeberg.org/user/settings/applications), with the listed scopes.',
        sources: [
          'https://codeberg.org/forgejo/docs/src/branch/next/docs/user/api/usage.md',
          'https://codeberg.org/forgejo/docs/src/branch/next/docs/user/authentication/token-scope.md',
        ],
        verified: '2026-10-07',
      },
    ],
  },
  'gitea': {
    TOKEN: [
      {
        text: 'Create an access token under **Settings > Applications** on your instance, such as [gitea.com](https://gitea.com/user/settings/applications), with the listed scopes.',
        sources: ['https://gitea.com/gitea/docs/src/branch/main/docs/development/api-usage.md'],
        verified: '2026-10-07',
      },
    ],
  },
  'gitee': {
    TOKEN: [
      {
        text: 'Create a [personal access token](https://gitee.com/profile/personal_access_tokens) with the listed scopes.',
        sources: [
          'https://help.gitee.com/repository/settings/sync-between-gitee-github',
          'https://help.gitee.com/devops/connect/Jenkins-Plugin',
          'https://gitee.com/api/v5/oauth_doc',
        ],
        verified: '2026-10-07',
      },
    ],
  },
  'azure-devops': {
    'TOKEN': [
      {
        text: 'Create a personal access token under **User settings > Personal access tokens** in your organisation.',
        sources: ['https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate'],
        verified: '2026-10-07',
      },
      {
        text: 'Grant the listed scopes: `vso.code` is **Code (read)**, `vso.work` is **Work items (read)** and `vso.work_full` is **Work items (full)**.',
        sources: ['https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth#available-scopes'],
        verified: '2026-10-07',
      },
    ],
    'USERNAME+PASSWORD': [
      {
        text: 'Use any user name, with a personal access token as the password. Grant the listed scopes: `vso.code` is **Code (read)**, `vso.work` is **Work items (read)** and `vso.work_full` is **Work items (full)**.',
        sources: [
          'https://learn.microsoft.com/en-us/azure/devops/repos/git/auth-overview',
          'https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate',
          'https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth#available-scopes',
        ],
        verified: '2026-10-07',
      },
    ],
  },
  'cursor-origin': {
    'TOKEN': [
      {
        text: 'Use the user access token that the Origin CLI reads from `CURSOR_AUTH_TOKEN`. These tokens are short-lived. Personal Cursor API keys don\'t work.',
        sources: [
          'https://cursor.com/docs/origin/cli/reference/commands',
          'https://cursor.com/docs/api/origin',
        ],
        verified: '2026-10-07',
      },
    ],
    'APP_ID+PRIVATE_KEY': [
      {
        text: '[Create an Origin App](https://cursor.com/codebase/settings/apps) and install it. Set `APP_ID` to the app ID (`app_01...`) and `INSTALLATION_ID` to the installation (`i_01...`).',
        sources: [
          'https://cursor.com/docs/origin/apps/publish',
          'https://cursor.com/docs/api/origin',
        ],
        verified: '2026-10-07',
      },
      {
        text: 'Generate an Ed25519 key pair, and add the public key to the app as a signing key. Set `PRIVATE_KEY` to the private key in PKCS#8 PEM format, with its line breaks written as `\\n`.',
        sources: ['https://cursor.com/docs/api/origin', 'src/env.ts'],
        verified: '2026-10-07',
      },
    ],
  },
  'pushin': {
    TOKEN: [
      {
        text: 'Create a personal access token in your pushin.eu settings. Tokens start with `pun_pat_` and aren\'t scoped to specific resources.',
        sources: ['docs/content/4.providers/pushin.md', 'https://pushin.eu/api/v1/openapi.json'],
        verified: '2026-10-07',
      },
    ],
  },
  'tangled': {
    'IDENTIFIER+PASSWORD': [
      {
        text: 'Create an app password for your atproto account. On Bluesky, it\'s under [Settings > Privacy and security > App passwords](https://bsky.app/settings/app-passwords).',
        sources: [
          'https://github.com/bluesky-social/social-app/blob/main/src/screens/Settings/PrivacyAndSecuritySettings.tsx',
          'https://github.com/bluesky-social/social-app/blob/main/src/routes.ts',
        ],
        verified: '2026-10-07',
      },
      {
        text: 'Set `IDENTIFIER` to your handle or DID. Set `PDS` too, unless the account is on `bsky.social` or `IDENTIFIER` is a DID.',
        sources: ['src/tangled/session.ts', 'src/env.ts'],
        verified: '2026-10-07',
      },
      {
        text: 'For notifications, set `NOTIFICATIONS_URL` to the base URL of the notification service.',
        sources: ['docs/content/4.providers/tangled.md', 'src/env.ts'],
        verified: '2026-10-07',
      },
    ],
  },
}

/** Extra steps for a forge, whichever credential it uses. */
export const forgeSteps: Record<string, CredentialStep> = {
  'github': {
    text: 'On GitHub Enterprise Server, create the credential on the server and set `BASE_URL` to its API root.',
    sources: ['docs/content/4.providers/github.md'],
    verified: '2026-10-07',
  },
  'gitlab': {
    text: 'On a self-managed instance, create the token there and set `BASE_URL` to its root.',
    sources: ['docs/content/4.providers/gitlab.md'],
    verified: '2026-10-07',
  },
  'forgejo': {
    text: 'Set `BASE_URL` to the root of the instance, unless it\'s Codeberg.',
    sources: ['docs/content/4.providers/forgejo.md'],
    verified: '2026-10-07',
  },
  'gitea': {
    text: 'Set `BASE_URL` to the root of the instance, unless it\'s gitea.com.',
    sources: ['docs/content/4.providers/gitea.md'],
    verified: '2026-10-07',
  },
  'azure-devops': {
    text: 'Set `ORGANIZATION` to the name in `dev.azure.com/<organization>`. For Azure DevOps Server, set `BASE_URL` to the server root and `ORGANIZATION` to the collection.',
    sources: ['docs/content/4.providers/azure-devops.md', 'src/env.ts'],
    verified: '2026-10-07',
  },
}

/** The step for an anonymous provider, in place of the credential steps. */
export const anonymousStep: CredentialStep = {
  text: 'Set `ENABLED` to `1`. The provider sends no credentials and makes public reads only.',
  sources: ['src/env.ts', 'src/provider.ts'],
  verified: '2026-10-07',
}

/** The last step, for every forge and credential. */
export const envStep: CredentialStep = {
  text: 'Put the variables in your environment, and call `forgesFromEnv(process.env)`.',
  sources: ['src/env.ts'],
  verified: '2026-10-07',
}
