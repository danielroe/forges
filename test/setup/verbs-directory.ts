import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Where `test/setup/verbs.ts` writes the verbs a run called: `test/.verbs/`, or `FORGES_VERBS_DIR` when set. */
export const verbsDirectory = process.env.FORGES_VERBS_DIR
  ? pathToFileURL(process.env.FORGES_VERBS_DIR.replace(/\/?$/, '/'))
  : new URL('../.verbs/', import.meta.url)
