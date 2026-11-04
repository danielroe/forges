import { describe, expect, it } from 'vitest'
import { redact } from '../recording/redact.ts'

const fake = (prefix: string) => `${prefix}${'x'.repeat(20)}`

describe('redact', () => {
  it('redacts a GitLab project runners token', () => {
    expect(redact({
      path_with_namespace: 'owner/repo',
      runners_token: fake('GR1348941'),
    })).toEqual({ path_with_namespace: 'owner/repo', runners_token: 'REDACTED' })
  })

  it.each([
    'GR1348941',
    'glpat-',
    'glrt-',
    'glrtr-',
    'gldt-',
    'glptt-',
    'glcbt-',
    'glft-',
    'gloas-',
  ])('redacts a %s token in a string', (prefix) => {
    expect(redact(`token ${fake(prefix)} here`)).toBe('token REDACTED_TOKEN here')
  })
})
