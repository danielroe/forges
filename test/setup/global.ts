import { rmSync } from 'node:fs'
import { verbsDirectory } from './verbs-directory.ts'

export function setup(): void {
  rmSync(verbsDirectory, { recursive: true, force: true })
}
