import type { Run } from '../../scripts/stabilise.ts'
import type { Fixture } from '../../src/testing/index.ts'
import { describe, expect, it } from 'vitest'
import { stabilise } from '../../scripts/stabilise.ts'

const api = 'https://api.github.com/repos/bot/forges-fixtures'

function created(run: string, issue: number, comment: number, extra: Record<string, unknown> = {}): Fixture[] {
  return [
    { request: { method: 'POST', url: `${api}/issues`, body: { title: `forges fixture ${run}: issue` } }, response: { status: 201, body: { number: issue, node_id: `I_kwDOAB${issue}xyz`, title: `forges fixture ${run}: issue`, comments: 0, ...extra } } },
    { request: { method: 'POST', url: `${api}/issues/${issue}/comments`, body: { body: `A comment from run ${run}.` } }, response: { status: 201, body: { id: comment, html_url: `https://github.com/bot/forges-fixtures/issues/${issue}#issuecomment-${comment}`, created_at: '2026-10-12T11:00:00Z' } } },
  ]
}

function run(id: string, fixtures: Fixture[]): Run {
  return { manifest: { run: { id, branches: [`forges-fixtures/${id}-1`] } }, steps: new Map([['create issue', fixtures]]) }
}

describe('stabilising a write recording', () => {
  it('renames the identifiers a run created to those the previous run created in their place', () => {
    const previous = run('20261011164520', created('20261011164520', 75, 6110273232))
    const { manifest, steps } = stabilise(run('20261012113502', created('20261012113502', 85, 6111313679)), previous)

    expect(manifest).toEqual(previous.manifest)
    expect(steps.get('create issue')!.map(fixture => [fixture.request, (fixture.response.body as { title?: string, id?: number }).title ?? (fixture.response.body as { id?: number }).id])).toEqual([
      [{ method: 'POST', url: `${api}/issues`, body: { title: 'forges fixture 20261011164520: issue' } }, 'forges fixture 20261011164520: issue'],
      [{ method: 'POST', url: `${api}/issues/75/comments`, body: { body: 'A comment from run 20261011164520.' } }, 6110273232],
    ])
    expect((steps.get('create issue')![0]!.response.body as { node_id: string }).node_id).toBe('I_kwDOAB75xyz')
  })

  it('leaves timestamps, counts and page sizes as they are', () => {
    const current = created('20261012113502', 85, 6111313679, { comments: 3 })
    current[1]!.request.url = `${api}/issues/85/comments?per_page=50`
    const before = created('20261011164520', 50, 6110273232, { comments: 2 })
    before[1]!.request.url = `${api}/issues/50/comments?per_page=50`
    const { steps } = stabilise(run('20261012113502', current), run('20261011164520', before))
    const [issue, comment] = steps.get('create issue')!

    expect((issue!.response.body as { comments: number }).comments).toBe(3)
    expect(comment!.request.url).toBe(`${api}/issues/50/comments?per_page=50`)
    expect((comment!.response.body as { created_at: string }).created_at).toBe('2026-10-12T11:00:00Z')
  })

  it('leaves an identifier whose previous value stands for something else in this run', () => {
    const current = run('20261012113502', created('20261012113502', 85, 6111313679))
    current.steps.set('list issues', [{ request: { method: 'GET', url: `${api}/issues` }, response: { status: 200, body: [{ number: 75, title: 'an older issue' }] } }])
    const { steps, skipped } = stabilise(current, run('20261011164520', created('20261011164520', 75, 6110273232)))

    expect(steps.get('create issue')![1]!.request.url).toBe(`${api}/issues/85/comments`)
    expect(skipped.get('85')).toMatch(/stands for something else/)
  })

  it('leaves identifiers that pair with more than one of the previous run', () => {
    const current = [...created('20261012113502', 85, 6111313679), ...created('20261012113502', 85, 6111313680)]
    const before = [...created('20261011164520', 75, 6110273232), ...created('20261011164520', 76, 6110273233)]
    const { skipped } = stabilise(run('20261012113502', current), run('20261011164520', before))

    expect(skipped.get('85')).toMatch(/pairs with 2/)
  })
})
