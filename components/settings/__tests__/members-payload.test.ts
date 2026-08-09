import { describe, expect, it } from 'vitest'
import {
  parseCompanyMembersPayload,
  parseTeamMembersPayload,
} from '@/components/settings/members-payload'

// Read-side guards for the member rosters. A 200 whose body does not carry
// the expected lists is a failed read, not an empty roster: the original bug
// was `setMembers(data.data.members)` straight off `res.json()`, so a
// wrong-shape 200 rendered an apparently member-less company, and a
// consultant looking at that list re-invites people who are already members.
describe('parseCompanyMembersPayload', () => {
  const valid = {
    data: {
      members: [{ id: 'm1', email: 'anna@example.se' }],
      invitations: [{ id: 'i1', email: 'bo@example.se' }],
      canInvite: true,
    },
  }

  it('passes a well-formed payload through', () => {
    expect(parseCompanyMembersPayload(valid)).toEqual({
      members: [{ id: 'm1', email: 'anna@example.se' }],
      invitations: [{ id: 'i1', email: 'bo@example.se' }],
      canInvite: true,
    })
  })

  it('accepts a confirmed-empty roster (that is data, not a failure)', () => {
    expect(
      parseCompanyMembersPayload({ data: { members: [], invitations: [], canInvite: false } }),
    ).toEqual({ members: [], invitations: [], canInvite: false })
  })

  it('rejects a 200 with no data envelope instead of fabricating an empty roster', () => {
    expect(parseCompanyMembersPayload({})).toBeNull()
    expect(parseCompanyMembersPayload(null)).toBeNull()
    expect(parseCompanyMembersPayload('ok')).toBeNull()
  })

  it('rejects a 200 whose data lacks the lists', () => {
    expect(parseCompanyMembersPayload({ data: {} })).toBeNull()
    expect(parseCompanyMembersPayload({ data: { members: [] } })).toBeNull()
    expect(
      parseCompanyMembersPayload({ data: { members: 'oops', invitations: [] } }),
    ).toBeNull()
  })

  it('only grants canInvite on an explicit boolean true', () => {
    // A truthy non-boolean must not unlock the invite form.
    expect(
      parseCompanyMembersPayload({ data: { members: [], invitations: [], canInvite: 'yes' } }),
    ).toEqual({ members: [], invitations: [], canInvite: false })
  })
})

describe('parseTeamMembersPayload', () => {
  it('passes a well-formed payload through', () => {
    expect(
      parseTeamMembersPayload({ data: { members: [{ id: 'm1' }], teamName: 'Byrån AB' } }),
    ).toEqual({ members: [{ id: 'm1' }], teamName: 'Byrån AB' })
  })

  it('accepts a confirmed-empty roster and a missing team name', () => {
    expect(parseTeamMembersPayload({ data: { members: [] } })).toEqual({
      members: [],
      teamName: null,
    })
  })

  it('rejects wrong-shape 200s instead of fabricating an empty roster', () => {
    expect(parseTeamMembersPayload({})).toBeNull()
    expect(parseTeamMembersPayload(null)).toBeNull()
    expect(parseTeamMembersPayload({ data: {} })).toBeNull()
    expect(parseTeamMembersPayload({ data: { members: 'oops' } })).toBeNull()
  })

  it('drops a non-string team name instead of rendering it', () => {
    expect(parseTeamMembersPayload({ data: { members: [], teamName: 42 } })).toEqual({
      members: [],
      teamName: null,
    })
  })
})
