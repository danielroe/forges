import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import { standaloneSchema } from './scripts/generate-schemas.ts'

export default defineConfig({
  entry: ['src/index.ts', 'src/github/index.ts', 'src/gitlab/index.ts', 'src/bitbucket/index.ts', 'src/forgejo/index.ts', 'src/gitea/index.ts', 'src/tangled/index.ts', 'src/cursor-origin/index.ts', 'src/gitee/index.ts', 'src/pushin/index.ts', 'src/azure-devops/index.ts', 'src/env.ts', 'src/kit.ts', 'src/schema/index.ts', 'src/testing/index.ts', 'src/fake/index.ts'],
  dts: { generator: 'oxc' },
  exports: {
    devExports: true,
    customExports: { './schema/*.json': './dist/schema/*.json' },
  },
  /** Writes the schema files with the bundle, so publint and attw pack what npm will ship. */
  plugins: [{
    name: 'forges:schema-files',
    generateBundle() {
      const schemas = JSON.parse(readFileSync(new URL('./src/schema/schemas.json', import.meta.url), 'utf8'))
      for (const name of Object.keys(schemas)) {
        this.emitFile({ type: 'asset', fileName: `schema/${name}.json`, source: `${JSON.stringify(standaloneSchema(name, schemas), null, 2)}\n` })
      }
    },
  }],
  publint: true,
  attw: {
    profile: 'esm-only',
    level: 'error',
  },
})
