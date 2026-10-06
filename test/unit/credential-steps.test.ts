import type { CredentialStep } from '../../scripts/credential-steps.ts'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { anonymousStep, credentialSteps, envStep, forgeSteps } from '../../scripts/credential-steps.ts'

const steps: Array<[string, CredentialStep]> = [
  ...Object.entries(credentialSteps).flatMap(([forge, sets]) => Object.entries(sets).flatMap(([fields, list]) =>
    list.map((step, index): [string, CredentialStep] => [`${forge} ${fields} step ${index + 1}`, step]))),
  ...Object.entries(forgeSteps).map(([forge, step]): [string, CredentialStep] => [`${forge} forge step`, step]),
  ['anonymous step', anonymousStep],
  ['environment step', envStep],
]

const verified = steps.filter(([, step]) => step.verified)
const unverified = steps.filter(([, step]) => !step.verified)

describe('credential steps', () => {
  it.each(verified)('records the sources of the %s', (_, step) => {
    expect(step.sources?.length).toBeGreaterThan(0)
    expect(step.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Number.isNaN(Date.parse(step.verified!))).toBe(false)
  })

  it.each(steps.filter(([, step]) => step.sources))('cites sources that exist for the %s', (_, step) => {
    for (const source of step.sources!) {
      expect(source.startsWith('https://') || existsSync(new URL(`../../${source}`, import.meta.url)), source).toBe(true)
    }
  })

  for (const [name, step] of unverified) {
    it.todo(`verify the ${name}: ${step.text}`)
  }
})
