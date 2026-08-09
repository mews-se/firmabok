import type { SupabaseClient } from '@supabase/supabase-js'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { calculateEgenavgifter, type EgenavgiftCategory } from './egenavgifter-calculator'
import { calculateRantefordelning } from './rantefordelning-calculator'
import { proposeEfPfondAvsattning } from './periodiseringsfond-ef'
import { calculateExpansionsfondChange } from './expansionsfond-calculator'
import type { EfDeclarationItem } from './types'

export interface EfDeclarationPreviewInput {
  category?: EgenavgiftCategory
  kapitalunderlag?: number
  priorYearSchablonavdrag?: number
  priorYearActualCharged?: number
  pfondDesiredAmount?: number
  expansionsfondExistingBalance?: number
  expansionsfondDesiredChange?: number
}

export interface EfDeclarationPreview {
  fiscalPeriod: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  bookedSurplus: number
  items: EfDeclarationItem[]
}

/**
 * Server-side mirror of the EfDeclarationSection client logic. The MCP tool
 * (Phase 7) calls this so agents can preview the same numbers without
 * round-tripping through the browser. Inputs default to "no adjustment"
 * which produces just the egenavgifter line.
 */
export async function computeEfDeclarationPreview(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  input: EfDeclarationPreviewInput = {},
): Promise<EfDeclarationPreview> {
  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (error || !period) throw new Error('Fiscal period not found')

  const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
  const bookedSurplus = incomeStatement.net_result
  const fiscalYear = parseInt(period.period_end.slice(0, 4), 10)

  const items: EfDeclarationItem[] = []

  const eg = calculateEgenavgifter({
    surplusBeforeEgenavgifter: bookedSurplus,
    category: input.category,
    priorYearSchablonavdrag: input.priorYearSchablonavdrag,
    priorYearActualCharged: input.priorYearActualCharged,
  })
  items.push(eg)

  const r = calculateRantefordelning({ kapitalunderlag: input.kapitalunderlag ?? 0 })
  if (r) items.push(r)

  const surplusAfterEg = bookedSurplus - eg.amount
  const pfond = proposeEfPfondAvsattning({
    surplus: surplusAfterEg,
    fiscalYear,
    desiredAmount: input.pfondDesiredAmount,
  })
  if (pfond) items.push(pfond)

  if (input.expansionsfondDesiredChange && input.expansionsfondDesiredChange !== 0) {
    const exp = calculateExpansionsfondChange({
      kapitalunderlag: input.kapitalunderlag ?? 0,
      existingBalance: input.expansionsfondExistingBalance,
      desiredChange: input.expansionsfondDesiredChange,
    })
    if (exp) items.push(exp)
  }

  return {
    fiscalPeriod: period,
    bookedSurplus,
    items,
  }
}
