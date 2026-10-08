import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { computeEfDeclarationPreview } from '@/lib/bokslut/enskild-firma/ef-declaration-preview'

/** An absent field means "not entered"; amounts that can only be zero or more are refused when negative. */
const QuerySchema = z.object({
  category: z.enum(['full', 'pensioner', 'passive']).optional(),
  kapitalunderlag: z.coerce.number().optional(),
  priorYearSchablonavdrag: z.coerce.number().nonnegative().optional(),
  priorYearActualCharged: z.coerce.number().nonnegative().optional(),
  pfondDesiredAmount: z.coerce.number().nonnegative().optional(),
  expansionsfondExistingBalance: z.coerce.number().nonnegative().optional(),
  expansionsfondDesiredChange: z.coerce.number().optional(),
})

// räntefördelning needs the kapitalunderlag, which the books cannot give:
// an empty field means the item is missing, not zero
const KAPITALUNDERLAG_MISSING =
  'Kapitalunderlag saknas: räntefördelning beräknas inte. Fyll i kapitalunderlaget vid årets ingång, även om det är 0 eller negativt.'

/**
 * GET /api/bookkeeping/fiscal-periods/[id]/ef-declaration
 *
 * The year-end wizard's NE-bilaga panel (EfDeclarationSection). Read-only:
 * egenavgifter, räntefördelning, periodiseringsfond and expansionsfond are
 * declaration-only and never booked. Same computation as the MCP tool
 * gnubok_preview_ef_declaration.
 */
export const GET = withRouteContext(
  'period.ef_declaration_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const query = validateQuery(request, QuerySchema, {
      log,
      operation: 'period.ef_declaration_preview',
    })
    if (!query.success) return query.response

    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (periodError) throw periodError
    if (!period) return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })

    const preview = await computeEfDeclarationPreview(supabase, companyId, id, query.data)

    // same count as the entry-count route: zero tells the owner the surplus
    // is empty because nothing is booked yet
    const { count, error: countError } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', id)
      .in('status', ['posted', 'reversed'])
    if (countError) throw countError

    return NextResponse.json({
      data: {
        ...preview,
        postedEntryCount: count ?? 0,
        inputWarnings: query.data.kapitalunderlag === undefined ? [KAPITALUNDERLAG_MISSING] : [],
      },
    })
  },
)
