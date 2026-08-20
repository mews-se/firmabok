import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { sparsePatchBody } from '@/lib/api/sparse-patch'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const BookingTemplateLineSchema = z.object({
  account: z.string().regex(/^\d{4}$/),
  label: z.string().min(1),
  side: z.enum(['debit', 'credit']),
  type: z.enum(['business', 'vat', 'settlement']),
  ratio: z.number().min(0).max(10).optional(),
  vat_rate: z.number().min(0).max(1).optional(),
})

const UpdateBookingTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.enum([
    'eu_trade', 'tax_account', 'private_transfer',
    'salary', 'representation', 'year_end',
    'vat', 'financial', 'other',
  ]).optional(),
  entity_type: z.enum(['all', 'enskild_firma', 'aktiebolag']).optional(),
  lines: z.array(BookingTemplateLineSchema).min(2).optional(),
})

/**
 * PUT /api/settings/booking-templates/[id]
 * Update a non-system template belonging to the active company.
 */
export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'booking_template.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    // result.data is spread straight into .update(), so it must carry only the
    // fields the caller named. UpdateBookingTemplateSchema has no .default()
    // today; sparsePatchBody makes that a structural property rather than a
    // thing a future edit to the schema can quietly undo.
    const result = await validateBody(request, sparsePatchBody(UpdateBookingTemplateSchema))
    if (!result.success) return result.response

    // Read the template first so a missing row is a clean 404: .single() on
    // the update chain reported zero rows as a PGRST116 ERROR, which fell into
    // the 500 branch and left the 404 below unreachable.
    const { data: existing, error: fetchError } = await supabase
      .from('booking_template_library')
      .select('id, company_id, is_system')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) {
      return NextResponse.json({ error: getUserErrorMessage(fetchError) }, { status: 500 })
    }
    // System templates are never editable (customize duplicates them instead);
    // reported as not-found rather than forbidden, matching the RLS view.
    if (!existing || existing.is_system) {
      return NextResponse.json({ error: 'Mallen hittades inte' }, { status: 404 })
    }

    // Defense in depth alongside RLS (which is membership-wide): only
    // templates scoped to the ACTIVE company are editable in this context.
    // Without this, a user who belongs to several companies could edit
    // company B's template while acting in company A.
    if (existing.company_id !== companyId) {
      return NextResponse.json({ error: 'Mallen hittades inte' }, { status: 404 })
    }

    // RLS prevents updating system templates; is_system is re-checked here so
    // the guard holds even on a service-role client.
    const { data, error } = await supabase
      .from('booking_template_library')
      .update(result.data)
      .eq('id', id)
      .eq('is_system', false)
      .select()
      .maybeSingle()

    if (error) return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    // The row can vanish between the scope check and the update.
    if (!data) return NextResponse.json({ error: 'Mallen hittades inte' }, { status: 404 })

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
