import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/github/index.ts', 'src/gitlab/index.ts', 'src/bitbucket/index.ts', 'src/forgejo/index.ts', 'src/gitea/index.ts', 'src/tangled/index.ts', 'src/cursor-origin/index.ts', 'src/gitee/index.ts', 'src/pushin/index.ts', 'src/azure-devops/index.ts', 'src/env.ts', 'src/kit.ts', 'src/schema/index.ts', 'src/testing/index.ts', 'src/fake/index.ts'],
  dts: { generator: 'oxc' },
  exports: {
    devExports: true,
    customExports: { './schema/*.json': './dist/schema/*.json' },
  },
  publint: true,
  attw: {
    profile: 'esm-only',
    level: 'error',
  },
})
