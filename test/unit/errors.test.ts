import { describe, expect, it } from 'vitest'
import { AuthenticationRequiredError, forbiddenReason, ForgeApiError, MergeConflictError, MergeMethodRequiredError, NotFoundError, TokenRevokedError, toMergeError } from '../../src/errors.ts'
import { createFetcher } from '../../src/fetch.ts'

describe('status mapping', () => {
  const fetcherAnswering = (status: number, authHeaders?: () => Record<string, string>) => createFetcher({
    baseUrl: 'https://api.example',
    authHeaders,
    fetch: async () => new Response('{"message":"nope"}', { status }),
  })

  it('maps a 404 to NotFoundError, which is still a ForgeApiError', async () => {
    const error = await fetcherAnswering(404).json('/missing').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toBeInstanceOf(ForgeApiError)
    expect(error).toMatchObject({ status: 404 })
  })

  it('tells a rejected credential apart from a missing one on a 401', async () => {
    await expect(fetcherAnswering(401, () => ({ authorization: 'Bearer t' })).json('/me')).rejects.toBeInstanceOf(TokenRevokedError)
    await expect(fetcherAnswering(401).json('/me')).rejects.toBeInstanceOf(AuthenticationRequiredError)
  })

  it('maps a 401 to TokenRevokedError when the fetch carries the credential', async () => {
    const fetcher = createFetcher({
      baseUrl: 'https://api.example',
      authenticated: true,
      fetch: async () => new Response('{"message":"nope"}', { status: 401 }),
    })

    await expect(fetcher.json('/me')).rejects.toBeInstanceOf(TokenRevokedError)
  })
})

describe('merge errors', () => {
  it('keeps the status and the original error when mapping a merge failure', () => {
    const original = new ForgeApiError('Not acceptable', 406, 'body', { forge: 'github' })
    const mapped = toMergeError(original)

    expect(mapped).toBeInstanceOf(MergeConflictError)
    expect(mapped).toMatchObject({ status: 406, forge: 'github', cause: original })
  })

  it('says what to do whether the repository allows several merge methods or none', () => {
    expect(new MergeMethodRequiredError(['merge', 'squash']).message).toBe('Repository allows merge, squash; pass `method` to choose one')
    expect(new MergeMethodRequiredError([]).message).toBe('Repository reports no merge method this provider can use; pass `method` explicitly')
  })
})

describe('forbiddenReason', () => {
  it('matches SSO as a word only', () => {
    expect(forbiddenReason('Resource protected by SSO enforcement')).toMatchObject({ reason: 'sso_required' })
    expect(forbiddenReason('Lasso is not allowed here')).toBeUndefined()
  })
})
