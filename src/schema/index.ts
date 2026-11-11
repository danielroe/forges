import generated from './schema.json' with { type: 'json' }

/** A JSON Schema, with references in the OpenAPI form `#/components/schemas/<Type>`. */
export type Schema = Record<string, unknown>

/** One parameter of a provider verb. */
export interface VerbParam {
  name: string
  schema: Schema
  optional: boolean
  /** The parameter carries the request's `signal`. */
  options?: boolean
  description?: string
}

/** The signature of one provider verb. */
export interface VerbSignature {
  summary?: string
  write: boolean
  account: boolean
  /** Answers with one `Page` of a listing. */
  listing?: boolean
  params: VerbParam[]
  /** The result is a byte stream. */
  stream?: boolean
  result: Schema
}

/** A JSON Schema for each published model, keyed by model name. */
export const models: Record<string, Schema> = generated.models

/** The signature of every provider verb on `ForgeProvider`, keyed by its path. */
export const verbs: Record<string, VerbSignature> = generated.verbs
