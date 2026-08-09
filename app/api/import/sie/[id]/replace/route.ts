import { NextResponse } from 'next/server'
import { replaceSIEImport } from '@/lib/import/sie-import'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

// Hard-deleting a large import (thousands of audit-logged journal entries +
// cascading lines) can take well over the default function timeout. Match the
// SIE execute route so the serverless function doesn't kill the request first.
export const maxDuration = 300

/**
 * POST /api/import/sie/[id]/replace
 *
 * Replace a completed SIE import by hard-deleting its entries, allowing the
 * user to re-import corrected data for the same fiscal period.
 */
export const POST = withRouteContext(
  'sie_import.replace',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ sieImportId: id })

    // The replace_sie_import RPC gates on owner/admin membership. It usually
    // runs on the service client where auth.uid() is NULL, so the authorising
    // user is passed explicitly; the RPC honors it only for service_role
    // callers (migration 20260727120000).
    const result = await replaceSIEImport(supabase, companyId!, id, user.id)

    if (!result.success) {
      // The RPC raises 42501 with this exact text when the actor is not an
      // owner/admin. replaceSIEImport flattens the PostgREST error into a
      // message string, so the route detects the authorization raise by the
      // text, which is pinned by migration 20260727120000 and by
      // lib/import/__tests__/sie-import.replace.pg.test.ts. Surface it as a
      // structured 403 instead of a 400 with raw English prose in details.
      if (result.error?.includes('Only company owners and admins can replace SIE imports')) {
        return errorResponseFromCode('SIE_REPLACE_FORBIDDEN', opLog, { requestId })
      }
      return errorResponseFromCode('SIE_REPLACE_FAILED', opLog, {
        requestId,
        details: { reason: result.error },
      })
    }

    return NextResponse.json({ success: true, deletedEntries: result.deletedEntries })
  },
  { requireWrite: true },
)
