import { describe, expect, it } from 'vitest'
import { entire } from '../../src/entire/index.ts'
import { toCoreRepo } from '../../src/entire/normalise.ts'
import { BranchMovedError, UnsupportedOperationError } from '../../src/errors.ts'
import { fixtureFetch } from '../../src/testing/index.ts'

const origin = { forge: 'entire', instance: 'entire.com' } as const
const repo = { ...origin, owner: 'acme', name: 'widgets' }
const pull = {
  ...origin,
  repo,
  kind: 'pull_request',
  number: '3',
} as const
const core = 'https://us.console.entire.io/api/v1'
const cell = 'https://aws-eu-west-2.api.entire.io/api/v1'
const change = `${cell}/trails/et/acme/widgets/3`
const resolved = {
  status: 200,
  body: {
    resolutions: [
      {
        requestedFullName: 'acme/widgets',
        status: 'resolved',
        placements: [
          { id: 'repo1', apiBaseUrl: 'https://aws-eu-west-2.api.entire.io' },
        ],
      },
    ],
  },
}

function provider(overrides: Parameters<typeof fixtureFetch>[1]) {
  const fixtures = fixtureFetch([], { [`POST ${core}/repos/resolve`]: resolved, ...overrides })
  return {
    ...fixtures,
    forge: entire({
      auth: { type: 'token', token: 't' },
      fetch: fixtures.fetch,
    }),
  }
}

describe('entire', () => {
  it('quotes the commented lines of the change head, reading each file once', async () => {
    const finding = {
      id: 'f1',
      review_id: 'r1',
      status: 'open',
      created_at: '2026-01-01T00:00:00Z',
      body: 'Shout less',
      location: {
        granularity: 'range',
        file_path: 'src/a.ts',
        start_line: 2,
        end_line: 3,
      },
    }
    const raw = `${cell}/git/repos/repo1/raw?ref=abc&path=src%2Fa.ts`
    const { forge, calls } = provider({
      [`GET ${change}`]: {
        status: 200,
        body: {
          id: 'c1',
          number: 3,
          title: 'Shout',
          status: 'open',
          branch: 'feat',
          base: 'main',
          head_sha: 'abc',
        },
      },
      [`GET ${raw}`]: { status: 200, body: 'one\ntwo\nthree\nfour\n' },
      [`POST ${change}/reviews`]: {
        status: 201,
        body: { review_id: 'r1' },
      },
      [`POST ${change}/reviews/r1/comments`]: {
        status: 201,
        body: {
          results: [
            { client_id: '1', status: 'created', comment: finding },
          ],
        },
      },
    })

    const review = await forge.threads.createReview(pull, {
      event: 'comment',
      body: 'Summary',
      comments: [
        {
          path: 'src/a.ts',
          startLine: 2,
          line: 3,
          body: 'Shout less',
        },
        { path: 'src/a.ts', line: 4, body: 'End there' },
      ],
    })

    expect(JSON.parse(calls.find(call => call.url.endsWith('/reviews/r1/comments'))!.body!)).toEqual({
      summary: 'Summary',
      comments: [
        {
          client_id: '1',
          body: 'Shout less',
          location: {
            granularity: 'range',
            file_path: 'src/a.ts',
            start_line: 2,
            end_line: 3,
            selected_text: 'two\nthree',
          },
        },
        {
          client_id: '2',
          body: 'End there',
          location: {
            granularity: 'line',
            file_path: 'src/a.ts',
            start_line: 4,
            end_line: 4,
            selected_text: 'four',
          },
        },
      ],
    })
    expect(calls.filter(call => call.url === change)).toHaveLength(1)
    expect(calls.filter(call => call.url === raw)).toHaveLength(1)
    expect(review).toMatchObject({ state: 'commented', body: 'Summary' })
  })

  it('recomputes pending gates once before merging again', async () => {
    const merge = { method: 'POST', url: `${cell}/repos/repo1/trails/3/merge` }
    const { fetch, calls } = fixtureFetch([
      {
        handAuthored: true,
        request: merge,
        response: {
          status: 422,
          body: { code: 'merge_gates_pending' },
        },
      },
      {
        handAuthored: true,
        request: merge,
        response: {
          status: 200,
          body: { ok: true, mergeCommitSha: 'def' },
        },
      },
    ], {
      [`POST ${core}/repos/resolve`]: resolved,
      [`POST ${cell}/repos/repo1/trails/3/gates/recompute`]: { status: 200, body: {} },
    }, { sequential: true })
    const forge = entire({
      auth: { type: 'token', token: 't' },
      fetch,
    })

    expect(await forge.threads.merge(pull, { sha: 'abc' })).toMatchObject({ status: 'merged', sha: 'def' })
    expect(calls.map(call => call.url.replace(cell, ''))).toEqual([
      `${core}/repos/resolve`,
      '/repos/repo1/trails/3/merge',
      '/repos/repo1/trails/3/gates/recompute',
      '/repos/repo1/trails/3/merge',
    ])
  })

  it.each([412, 409])('reads a %i from a merge at a stale sha as a moved branch', async (status) => {
    const { forge } = provider({
      [`POST ${cell}/repos/repo1/trails/3/merge`]: {
        status,
        body: { code: 'head_mismatch' },
      },
    })
    await expect(forge.threads.merge(pull, { sha: 'abc' })).rejects.toBeInstanceOf(BranchMovedError)
  })

  it('refuses merge methods and labels that Entire has no equivalent for', async () => {
    const { forge, calls } = provider({})
    await expect(forge.threads.merge(pull, { method: 'squash' })).rejects.toBeInstanceOf(UnsupportedOperationError)
    await expect(forge.threads.create(repo, {
      kind: 'issue',
      title: 'A',
      labels: ['bug'],
    })).rejects.toBeInstanceOf(UnsupportedOperationError)
    expect(calls).toEqual([])
  })

  it.each([
    {
      label: 'a scoped name',
      full_name: 'acme/widgets',
      project: undefined,
      org: 'acme',
      expected: { owner: 'acme', name: 'widgets' },
    },
    {
      label: 'a scoped name over the project',
      full_name: 'acme/widgets',
      project: 'other',
      org: 'acme',
      expected: { owner: 'acme', name: 'widgets' },
    },
    {
      label: 'a bare name',
      full_name: 'widgets',
      project: undefined,
      org: 'acme',
      expected: { owner: 'acme', name: 'widgets' },
    },
    {
      label: 'no name',
      full_name: undefined,
      project: 'acme',
      org: 'acme',
      expected: { owner: 'acme', name: 'widgets' },
    },
    {
      label: 'no name and no org',
      full_name: undefined,
      project: 'acme',
      org: undefined,
      expected: { owner: 'acme', name: 'widgets' },
    },
  ])('places a control-plane repo with $label', ({ full_name, project, org, expected }) => {
    expect(toCoreRepo(origin, {
      id: 'r1',
      name: 'widgets',
      full_name,
      org,
    }, project)?.ref).toMatchObject(expected)
  })

  it('warns about the trail filters and orders Entire cannot apply', async () => {
    const { forge } = provider({
      [`GET ${cell}/trails/et/acme/widgets?status=open`]: {
        status: 200,
        body: { items: [] },
      },
    })

    const page = await forge.threads.list(repo, {
      kind: 'pull_request',
      labels: ['bug'],
      since: new Date('2026-01-01'),
      sort: 'updated',
    }).page()

    expect(page.warnings).toEqual([
      { code: 'filter_unsupported', message: 'Entire trails have no labels' },
      { code: 'filter_unsupported', message: 'Entire trails cannot be filtered by date' },
      { code: 'sort_unsupported', message: 'Entire lists trails in its own order' },
    ])
  })
})
