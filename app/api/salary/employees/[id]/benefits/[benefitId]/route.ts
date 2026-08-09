import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeBenefitSchema, BENEFIT_PERIOD_ORDER_MESSAGE } from '@/lib/api/schemas'
import { calculateBikeBenefit } from '@/lib/salary/benefits'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const PATCH = withRouteContext<{ params: Promise<{ id: string; benefitId: string }> }>(
  'salary.employees.benefits.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id, benefitId } = await params

    const validation = await validateBody(request, UpdateEmployeeBenefitSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: existing, error: fetchError } = await supabase
      .from('employee_benefits')
      .select('benefit_type, metadata, valid_from, valid_to')
      .eq('id', benefitId)
      .eq('employee_id', id)
      .eq('company_id', companyId)
      .single()

    // Only zero rows (PGRST116) means the benefit really isn't there. A
    // transport/DB failure is not a missing record and must not be reported as
    // one.
    if (fetchError && fetchError.code !== 'PGRST116') {
      return NextResponse.json({ error: getUserErrorMessage(fetchError) }, { status: 500 })
    }
    if (!existing) {
      return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
    }

    // Validity period against the MERGED state. UpdateEmployeeBenefitSchema can
    // only compare the two dates when the body carries both; when only one is
    // patched, the other half lives on the row we just fetched. Without this the
    // CHECK (valid_to IS NULL OR valid_to >= valid_from) fired in Postgres and
    // the error branch below dressed it up as "Förmån hittades inte".
    // Inclusive bound, and a null/cleared valid_to stays legal.
    const mergedValidFrom = (body.valid_from ?? existing.valid_from ?? null) as string | null
    const mergedValidTo = (
      body.valid_to !== undefined ? body.valid_to : existing.valid_to ?? null
    ) as string | null
    if (mergedValidFrom !== null && mergedValidTo !== null && mergedValidTo < mergedValidFrom) {
      return NextResponse.json({ error: BENEFIT_PERIOD_ORDER_MESSAGE }, { status: 400 })
    }

    const updates: Record<string, unknown> = { ...body }

    if (body.annual_market_value !== undefined) {
      if (existing.benefit_type !== 'bike') {
        return NextResponse.json(
          { error: 'annual_market_value gäller endast cykelförmån' },
          { status: 400 },
        )
      }
      const calc = calculateBikeBenefit(body.annual_market_value)
      updates.monthly_value = calc.monthlyValue
      updates.metadata = {
        ...(existing.metadata as Record<string, unknown> ?? {}),
        ...(body.metadata ?? {}),
        annual_market_value: body.annual_market_value,
        annual_taxable: calc.annualTaxable,
        tax_free_portion: calc.taxFreePortion,
      }
      delete (updates as Record<string, unknown>).annual_market_value
    }

    const { data, error } = await supabase
      .from('employee_benefits')
      .update(updates)
      .eq('id', benefitId)
      .eq('employee_id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      // The row's existence was already established above, so `error` here is a
      // write failure, not a lookup miss. Collapsing every error into 404
      // "Förmån hittades inte" sent users hunting for a record that exists: a
      // check_violation on valid_to >= valid_from is the one they actually hit.
      // PGRST116 (zero rows) is the only shape that still means not-found: the
      // row was deleted or moved out of the company between fetch and update.
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
      }
      // employee_benefits has exactly three CHECKs (migration 20260512200100):
      // benefit_type IN (...) and monthly_value >= 0 are unreachable from this
      // body (benefit_type is not patchable; the schema and the bike calc both
      // keep monthly_value non-negative), leaving the validity-period range as
      // the only one an UPDATE can trip: a concurrent write that moved the other
      // date after the merged check above.
      if (error.code === '23514') {
        return NextResponse.json({ error: BENEFIT_PERIOD_ORDER_MESSAGE }, { status: 400 })
      }
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    if (!data) {
      return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; benefitId: string }> }>(
  'salary.employees.benefits.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id, benefitId } = await params

    const { error } = await supabase
      .from('employee_benefits')
      .delete()
      .eq('id', benefitId)
      .eq('employee_id', id)
      .eq('company_id', companyId)

    if (error) return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })

    return NextResponse.json({ data: { id: benefitId, deleted: true } })
  },
  { requireWrite: true },
)
