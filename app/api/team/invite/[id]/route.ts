import { NextResponse } from 'next/server'

/**
 * DELETE /api/team/invite/[id]
 * Team-level invitations are disabled.
 */
export async function DELETE() {
  return NextResponse.json(
    { error: 'Teaminbjudningar är inaktiverade.' },
    { status: 403 }
  )
}
