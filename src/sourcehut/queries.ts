/**
 * The GraphQL documents this provider runs, one per read, each named so
 * recordings match on the operation as well as the URL.
 */

const ACTOR = `
  canonicalName
  ... on User { id created updated username email url location bio }
`

const REPOSITORY = `
  id
  rid
  created
  updated
  owner { ${ACTOR} }
  name
  description
  visibility
  HEAD { name target }
  access
`

const TICKET = `
  id
  created
  updated
  ref
  subject
  body
  status
  resolution
  submitter { ${ACTOR} }
  tracker { id rid name owner { ${ACTOR} } }
  labels { id name backgroundColor foregroundColor }
  assignees { ${ACTOR} }
  subscription { id created }
`

const PATCHSET = `
  id
  created
  updated
  subject
  version
  prefix
  status
  submitter { ${ACTOR} }
  coverLetter { id body }
  list { id rid name owner { ${ACTOR} } }
`

const EMAIL = `
  id
  sender { ${ACTOR} }
  received
  date
  subject
  body
  messageID
  inReplyTo
  patch { index count }
`

const JOB = `
  id
  created
  updated
  status
  manifest
  note
  tags
  visibility
  image
  runner
  owner { ${ACTOR} }
  tasks { id created updated name status log { last128KiB fullURL } }
  log { last128KiB fullURL }
`

const USER = `
  id
  created
  updated
  canonicalName
  username
  email
  url
  location
  bio
  avatar
`

const EVENT_CHANGES = `
  changes {
    eventType
    ... on Comment { author { ${ACTOR} } text authenticity }
    ... on Created { author { ${ACTOR} } }
    ... on StatusChange { editor { ${ACTOR} } oldStatus newStatus oldResolution newResolution }
    ... on LabelUpdate { labeler { ${ACTOR} } label { id name backgroundColor foregroundColor } }
    ... on Assignment { assigner { ${ACTOR} } assignee { ${ACTOR} } }
    ... on UserMention { author { ${ACTOR} } mentioned { ${ACTOR} } }
    ... on TicketMention { author { ${ACTOR} } mentioned { id subject } }
  }
`

export const RepositoryByOwner = `
query RepositoryByOwner($owner: String!, $name: String!) {
  user(username: $owner) {
    repository(name: $name) { ${REPOSITORY} }
  }
}
`

export const MyRepositories = `
query MyRepositories($cursor: Cursor, $filter: Filter) {
  repositories(cursor: $cursor, filter: $filter) {
    cursor
    results { ${REPOSITORY} }
  }
}
`

export const OwnerRepositories = `
query OwnerRepositories($owner: String!, $cursor: Cursor, $filter: Filter) {
  user(username: $owner) {
    repositories(cursor: $cursor, filter: $filter) {
      cursor
      results { ${REPOSITORY} }
    }
  }
}
`

export const RepositoryAcls = `
query RepositoryAcls($owner: String!, $name: String!, $cursor: Cursor) {
  user(username: $owner) {
    repository(name: $name) {
      acls(cursor: $cursor) {
        cursor
        results { id created mode entity { ${ACTOR} } }
      }
    }
  }
}
`

export const RepositoryRefs = `
query RepositoryRefs($owner: String!, $name: String!, $cursor: Cursor) {
  user(username: $owner) {
    repository(name: $name) {
      HEAD { name }
      references(cursor: $cursor) {
        cursor
        results {
          name
          target
          follow {
            ... on Commit { id committer { time } }
            ... on Tag { tagger { time } target { ... on Commit { id committer { time } } } }
          }
          artifacts { results { id created filename checksum size url } cursor }
        }
      }
    }
  }
}
`

export const RepositoryLog = `
query RepositoryLog($owner: String!, $name: String!, $from: String, $cursor: Cursor) {
  user(username: $owner) {
    repository(name: $name) {
      log(cursor: $cursor, from: $from) {
        cursor
        results {
          id
          shortId
          author { name email time }
          committer { name email time }
          message
          parents { id }
        }
      }
    }
  }
}
`

export const RepositoryCommit = `
query RepositoryCommit($owner: String!, $name: String!, $revspec: String!) {
  user(username: $owner) {
    repository(name: $name) {
      revparse_single(revspec: $revspec) {
        id
        shortId
        author { name email time }
        committer { name email time }
        message
        parents { id }
      }
    }
  }
}
`

export const RepositoryResolveRef = `
query RepositoryResolveRef($owner: String!, $name: String!, $revspec: String!) {
  user(username: $owner) {
    repository(name: $name) {
      revparse_single(revspec: $revspec) { id }
    }
  }
}
`

export const RepositoryReference = `
query RepositoryReference($owner: String!, $name: String!, $refName: String!) {
  user(username: $owner) {
    repository(name: $name) {
      reference(name: $refName) {
        name
        target
        follow {
          ... on Commit { id committer { time } }
          ... on Tag { tagger { time } target { ... on Commit { id committer { time } } } }
        }
        artifacts { results { id created filename checksum size url } cursor }
      }
    }
  }
}
`

export const RepositoryRootTree = `
query RepositoryRootTree($owner: String!, $name: String!, $revspec: String!, $cursor: Cursor) {
  user(username: $owner) {
    repository(name: $name) {
      revparse_single(revspec: $revspec) {
        tree {
          entries(cursor: $cursor) {
            cursor
            results { id name mode object { type id shortId ... on Blob { size } } }
          }
        }
      }
    }
  }
}
`

export const RepositoryTree = `
query RepositoryTree($owner: String!, $name: String!, $revspec: String!, $path: String!, $cursor: Cursor) {
  user(username: $owner) {
    repository(name: $name) {
      path(revspec: $revspec, path: $path) {
        object {
          ... on Tree {
            entries(cursor: $cursor) {
              cursor
              results { id name mode object { type id shortId ... on Blob { size } } }
            }
          }
        }
      }
    }
  }
}
`

export const RepositoryFile = `
query RepositoryFile($owner: String!, $name: String!, $revspec: String!, $path: String!) {
  user(username: $owner) {
    repository(name: $name) {
      path(revspec: $revspec, path: $path) {
        id
        object {
          type
          id
          shortId
          ... on TextBlob { text size content }
          ... on BinaryBlob { base64 size content }
        }
      }
    }
  }
}
`

export const RepositoryCodeSearch = `
query RepositoryCodeSearch($owner: String!, $name: String!, $query: String!, $cursor: Cursor) {
  user(username: $owner) {
    repository(name: $name) {
      codeSearch(cursor: $cursor, query: $query) {
        totalFiles
        totalMatches
        cursor
        results { lang name score lines { line lineNo } }
      }
    }
  }
}
`

export const TrackerTickets = `
query TrackerTickets($owner: String!, $name: String!, $cursor: Cursor) {
  user(username: $owner) {
    tracker(name: $name) {
      tickets(cursor: $cursor) {
        cursor
        results { ${TICKET} }
      }
    }
  }
}
`

export const Ticket = `
query Ticket($owner: String!, $name: String!, $id: Int!) {
  user(username: $owner) {
    tracker(name: $name) {
      ticket(id: $id) { ${TICKET} }
    }
  }
}
`

export const TicketEvents = `
query TicketEvents($owner: String!, $name: String!, $id: Int!, $cursor: Cursor) {
  user(username: $owner) {
    tracker(name: $name) {
      ticket(id: $id) {
        events(cursor: $cursor) {
          cursor
          results { id created ${EVENT_CHANGES} }
        }
      }
    }
  }
}
`

export const TrackerLabels = `
query TrackerLabels($owner: String!, $name: String!, $cursor: Cursor) {
  user(username: $owner) {
    tracker(name: $name) {
      labels(cursor: $cursor) {
        cursor
        results { id name backgroundColor foregroundColor }
      }
    }
  }
}
`

export const ListPatches = `
query ListPatches($owner: String!, $name: String!, $cursor: Cursor) {
  user(username: $owner) {
    list(name: $name) {
      patches(cursor: $cursor) {
        cursor
        results { ${PATCHSET} }
      }
    }
  }
}
`

export const Patchset = `
query Patchset($id: Int!) {
  patchset(id: $id) { ${PATCHSET} }
}
`

export const PatchsetEmails = `
query PatchsetEmails($id: Int!, $cursor: Cursor) {
  patchset(id: $id) {
    id
    list { id rid name owner { ${ACTOR} } }
    thread {
      descendants(cursor: $cursor) {
        cursor
        results { ${EMAIL} }
      }
    }
  }
}
`

export const Jobs = `
query Jobs($cursor: Cursor) {
  jobs(cursor: $cursor) {
    cursor
    results { ${JOB} }
  }
}
`

export const Job = `
query Job($id: Int!) {
  job(id: $id) { ${JOB} }
}
`

export const UserByName = `
query UserByName($username: String!) {
  userByName(username: $username) { ${USER} }
}
`

export const Me = `
query Me {
  me { ${USER} }
}
`
