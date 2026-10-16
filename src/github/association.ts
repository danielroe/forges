import type { AuthorAssociation } from '../model.ts'

const AUTHOR_ASSOCIATIONS: Record<string, AuthorAssociation> = {
  OWNER: 'owner',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
  CONTRIBUTOR: 'contributor',
  FIRST_TIME_CONTRIBUTOR: 'first_time_contributor',
  FIRST_TIMER: 'first_timer',
  MANNEQUIN: 'none',
  NONE: 'none',
}

export function toAuthorAssociation(raw: string | null | undefined): { authorAssociation?: AuthorAssociation, authorAssociationRaw?: string } {
  return raw ? { authorAssociation: AUTHOR_ASSOCIATIONS[raw] ?? 'unknown', authorAssociationRaw: raw } : {}
}
