import { addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from 'nuxt/kit'
import { credentialTasks, forgeRequirements, taskScopes } from '../../scripts/credentials.ts'
import * as forges from '../../src/index.ts'

export default defineNuxtModule({
  meta: { name: 'credentials' },
  async setup(_options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const scopes = taskScopes(forges)
    const data = {
      tasks: credentialTasks(forges),
      requirements: (await forgeRequirements(forges)).map(forge => ({ ...forge, scopes: scopes[forge.slug]! })),
    }

    nuxt.options.alias['#credentials'] = addTemplate({
      filename: 'credentials.js',
      getContents: () => [
        ...Object.entries(data).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)}`),
        `export { anonymousStep, credentialSteps, envStep, forgeSteps } from '${resolve('../../scripts/credential-steps.ts')}'`,
      ].join('\n'),
    }).dst

    addTypeTemplate({
      filename: 'credentials.d.ts',
      getContents: () => [
        `import type { CredentialTask, ForgeRequirements } from '${resolve('../../scripts/credentials.ts')}'`,
        `import type { VerbScopes } from '${resolve('../../src/provider.ts')}'`,
        `export type { CredentialSet, CredentialTask, ForgeRequirements } from '${resolve('../../scripts/credentials.ts')}'`,
        `export type { VerbScopes }`,
        `export type { CredentialStep } from '${resolve('../../scripts/credential-steps.ts')}'`,
        `export { anonymousStep, credentialSteps, envStep, forgeSteps } from '${resolve('../../scripts/credential-steps.ts')}'`,
        `export interface DocsForgeRequirements extends ForgeRequirements {`,
        `  /** Distinct \`scopesFor()\` results for the verbs of each task, keyed by task id. */`,
        `  scopes: Record<string, VerbScopes[]>`,
        `}`,
        `export declare const tasks: CredentialTask[]`,
        `export declare const requirements: DocsForgeRequirements[]`,
      ].join('\n'),
    })
  },
})
