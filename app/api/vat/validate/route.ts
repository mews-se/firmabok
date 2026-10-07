import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ValidateVatNumberSchema } from '@/lib/api/schemas'
import { validateVatNumber } from '@/lib/vat/vies-client'

export const POST = withRouteContext('vat.validate', async (request, { supabase, companyId }) => {
  const result = await validateBody(request, ValidateVatNumberSchema)
  if (!result.success) return result.response
  const { vat_number, customer_id } = result.data

  const validation = await validateVatNumber(vat_number)

  // Update customer record if customer_id provided and VAT is valid
  if (customer_id && validation.valid) {
    await supabase
      .from('customers')
      .update({
        vat_number: validation.vat_number,
        vat_number_validated: true,
        vat_number_validated_at: new Date().toISOString(),
      })
      .eq('id', customer_id)
      .eq('company_id', companyId)
  }

  return NextResponse.json(validation)
})
