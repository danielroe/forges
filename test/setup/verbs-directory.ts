import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Where `test/setup/verbs.ts` writes the verbs a run called: `test/.verbs/`, or `FORGES_VERBS_DIR` when set. */
export const verbsDirectory = process.env.FORGES_VERBS_DIR
  ? pathToFileURL(process.env.FORGES_VERBS_DIR.replace(/\/?$/, '/'))
  : new URL('../.verbs/', import.meta.url)

/** The name of the file in `verbsDirectory` that describes the run, which `test/setup/global.ts` writes once it ends. */
export const VERB_RUN = 'run.json'

/** What a run left out, so that a check of its verbs can refuse a partial run. */
export interface VerbRun {
  /** The test files of the project that did not run. */
  missing: string[]
  /** The test files that failed. */
  failed: string[]
  /** The `-t` filter of the run. */
  testNamePattern?: string
  /** The recording `FORGES_RECORDING` limited the replay to. */
  recording?: string
}
