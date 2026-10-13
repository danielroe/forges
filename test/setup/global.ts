import type { TestProject } from 'vitest/node'
import type { VerbRun } from './verbs-directory.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import process from 'node:process'
import { VERB_RUN, verbsDirectory } from './verbs-directory.ts'

export function setup(project: TestProject): () => Promise<void> {
  rmSync(verbsDirectory, { recursive: true, force: true })
  return async () => {
    const modules = project.vitest.state.getTestModules().filter(module => module.project.name === project.name)
    const ran = new Set(modules.map(module => module.moduleId))
    const { testFiles } = await project.globTestFiles()
    const run: VerbRun = {
      missing: testFiles.filter(file => !ran.has(file)).map(file => relative(project.config.root, file)).sort(),
      failed: modules.filter(module => module.state() !== 'passed' && module.state() !== 'skipped').map(module => relative(project.config.root, module.moduleId)).sort(),
      testNamePattern: project.config.testNamePattern?.source,
      recording: process.env.FORGES_RECORDING,
    }
    mkdirSync(verbsDirectory, { recursive: true })
    writeFileSync(new URL(VERB_RUN, verbsDirectory), JSON.stringify(run))
  }
}
