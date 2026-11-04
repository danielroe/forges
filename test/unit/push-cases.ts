const zero = '0000000000000000000000000000000000000000'
const ghRepo = {
  id: 1,
  name: 'widgets',
  full_name: 'acme/widgets',
  owner: { login: 'acme', id: 2 },
}
const ada = { login: 'ada', id: 3 }
const commit = {
  id: 'b0b',
  message: 'Fix retry',
  url: 'https://example.test/c/b0b',
  author: { name: 'Ada', username: 'ada' },
}

/** One push, and one ref creation or deletion, per forge that delivers push webhooks. */
export const CASES: Record<string, { forge: string, instance: string, headers: Record<string, string>, payload: unknown }> = {
  'github push': {
    forge: 'github',
    instance: 'github.com',
    headers: { 'x-github-event': 'push' },
    payload: {
      ref: 'refs/heads/main',
      before: 'a0a',
      after: 'b0b',
      forced: true,
      commits: [commit],
      head_commit: { id: 'b0b', timestamp: '2026-09-20T10:00:00Z' },
      sender: ada,
      repository: ghRepo,
    },
  },
  'github delete push': {
    forge: 'github',
    instance: 'github.com',
    headers: { 'x-github-event': 'push' },
    payload: {
      ref: 'refs/tags/v1',
      before: 'a0a',
      after: zero,
      deleted: true,
      commits: [],
      sender: ada,
      repository: ghRepo,
    },
  },
  'gitlab push': {
    forge: 'gitlab',
    instance: 'gitlab.com',
    headers: { 'x-gitlab-event': 'Push Hook' },
    payload: {
      object_kind: 'push',
      ref: 'refs/heads/main',
      before: 'a0a',
      after: 'b0b',
      user_username: 'ada',
      total_commits_count: 3,
      commits: [commit],
      project: { id: 1, path_with_namespace: 'acme/widgets' },
    },
  },
  'gitlab delete': {
    forge: 'gitlab',
    instance: 'gitlab.com',
    headers: { 'x-gitlab-event': 'Push Hook' },
    payload: {
      object_kind: 'push',
      ref: 'refs/heads/old',
      before: 'a0a',
      after: zero,
      user_username: 'ada',
      commits: [],
      project: { id: 1, path_with_namespace: 'acme/widgets' },
    },
  },
  'gitlab tag create': {
    forge: 'gitlab',
    instance: 'gitlab.com',
    headers: { 'x-gitlab-event': 'Tag Push Hook' },
    payload: {
      object_kind: 'tag_push',
      ref: 'refs/tags/v1.0.0',
      before: zero,
      after: 'abc',
      user_username: 'ada',
      project: { id: 1, path_with_namespace: 'acme/widgets' },
    },
  },
  'forgejo push': {
    forge: 'forgejo',
    instance: 'codeberg.org',
    headers: { 'x-forgejo-event': 'push' },
    payload: {
      ref: 'refs/heads/main',
      before: 'a0a',
      after: 'b0b',
      total_commits: 2,
      commits: [commit],
      sender: ada,
      repository: ghRepo,
    },
  },
  'forgejo delete push': {
    forge: 'forgejo',
    instance: 'codeberg.org',
    headers: { 'x-forgejo-event': 'push' },
    payload: {
      ref: 'refs/heads/old',
      before: 'a0a',
      after: zero,
      commits: [],
      sender: ada,
      repository: ghRepo,
    },
  },
  'bitbucket push': {
    forge: 'bitbucket',
    instance: 'bitbucket.org',
    headers: { 'x-event-key': 'repo:push' },
    payload: {
      actor: { nickname: 'ada', uuid: '{a}' },
      repository: { full_name: 'acme/widgets', uuid: '{r}' },
      push: {
        changes: [
          {
            new: {
              name: 'main',
              type: 'branch',
              target: { hash: 'b0b' },
            },
            old: {
              name: 'main',
              type: 'branch',
              target: { hash: 'a0a' },
            },
            forced: true,
            commits: [
              {
                hash: 'b0b',
                message: 'Fix retry',
                date: '2026-09-20T10:00:00Z',
                author: { raw: 'Ada <ada@example.test>' },
                links: {
                  html: { href: 'https://example.test/c/b0b' },
                },
              },
            ],
          },
          {
            new: {
              name: 'v1',
              type: 'tag',
              target: { hash: 'c0c' },
            },
            old: null,
            created: true,
            commits: [],
          },
          {
            old: { name: 'gone', type: 'branch' },
            new: null,
            closed: true,
          },
        ],
      },
    },
  },
  'gitee push': {
    forge: 'gitee',
    instance: 'gitee.com',
    headers: { 'x-gitee-event': 'Push Hook' },
    payload: {
      hook_name: 'push_hooks',
      ref: 'refs/heads/main',
      before: 'a0a',
      after: 'b0b',
      created: false,
      deleted: false,
      commits: [commit],
      sender: ada,
      repository: { id: 1, full_name: 'acme/widgets', path: 'widgets' },
    },
  },
  'gitee tag create': {
    forge: 'gitee',
    instance: 'gitee.com',
    headers: { 'x-gitee-event': 'Tag Push Hook' },
    payload: {
      hook_name: 'tag_push_hooks',
      ref: 'refs/tags/v1',
      before: zero,
      after: 'c0c',
      created: true,
      deleted: false,
      commits: [],
      sender: ada,
      repository: { id: 1, full_name: 'acme/widgets', path: 'widgets' },
    },
  },
  'azure push': {
    forge: 'azure',
    instance: 'dev.azure.com',
    headers: {},
    payload: {
      id: 'e1',
      eventType: 'git.push',
      createdDate: '2026-09-20T10:00:00Z',
      resource: {
        refUpdates: [
          { name: 'refs/heads/main', oldObjectId: 'a0a', newObjectId: 'b0b' },
          { name: 'refs/heads/new', oldObjectId: zero, newObjectId: 'd0d' },
          { name: 'refs/tags/old', oldObjectId: 'e0e', newObjectId: zero },
        ],
        commits: [
          {
            commitId: 'b0b',
            comment: 'Fix retry',
            url: 'https://example.test/c/b0b',
            author: { name: 'Ada' },
          },
        ],
        pushedBy: { id: 'u1', displayName: 'Ada', uniqueName: 'ada@contoso.com' },
        repository: {
          id: 'r1',
          name: 'widgets',
          project: { id: 'p1', name: 'Widgets' },
        },
      },
    },
  },
  'origin push': {
    forge: 'origin',
    instance: 'origin.cursor.com',
    headers: {},
    payload: {
      deliveryId: 'whd_1',
      event: {
        id: 'evt_1',
        type: 'repository.pushed',
        eventTime: '2026-09-20T10:00:00Z',
        payload: {
          repository: {
            id: 'repo_1',
            name: 'widgets',
            owner: { slug: 'acme' },
          },
          pusher: {
            user: { id: 'user_1', handle: 'ada' },
          },
          refUpdates: [
            {
              ref: 'refs/heads/main',
              before: 'a0a',
              after: 'b0b',
              forced: true,
              headCommit: { sha: 'b0b', message: 'Fix retry' },
            },
            {
              ref: 'refs/tags/v1',
              before: zero,
              after: 'c0c',
              created: true,
            },
            {
              ref: 'refs/heads/gone',
              before: 'f0f',
              after: zero,
              deleted: true,
            },
          ],
        },
      },
    },
  },
  'tangled push': {
    forge: 'tangled',
    instance: 'tangled.sh',
    headers: { 'x-tangled-event': 'push' },
    payload: {
      ref: 'refs/heads/main',
      before: 'a0a',
      after: 'b0b',
      pusher: { did: 'did:plc:ada' },
      repository: {
        name: 'widgets',
        full_name: 'did:plc:ada/widgets',
        owner: { did: 'did:plc:ada' },
      },
      commits: [
        {
          sha: 'b0b',
          message: 'Fix retry',
          author: { did: 'did:plc:ada' },
        },
      ],
    },
  },
  'tangled delete push': {
    forge: 'tangled',
    instance: 'tangled.sh',
    headers: { 'x-tangled-event': 'push' },
    payload: {
      ref: 'refs/tags/v1',
      before: 'a0a',
      after: zero,
      pusher: { did: 'did:plc:ada' },
      repository: {
        name: 'widgets',
        full_name: 'did:plc:ada/widgets',
        owner: { did: 'did:plc:ada' },
      },
    },
  },
}
