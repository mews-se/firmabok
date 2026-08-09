import { NextResponse } from 'next/server'

/**
 * POST /api/team/invite
 * Team-level invitations are disabled.
 * Invitations should be made at the företag (company) level instead.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Teaminbjudningar är inaktiverade. Bjud in via enskilda företag.' },
    { status: 403 }
  )
}
