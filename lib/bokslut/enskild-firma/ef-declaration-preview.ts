import type { SupabaseClient } from '@supabase/supabase-js'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'
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
  /** NE R11 (bokfört resultat), whole kronor. */
  bookedSurplus: number
  /** NE R12 + R13 - R14: R29 as long as R15-R28, which are entered by hand, stay empty. */
  surplusBeforeRantefordelning: number
  items: EfDeclarationItem[]
}

/**
 * Server-side mirror of the EfDeclarationSection client logic. The MCP tool
 * (Phase 7) calls this so agents can preview the same numbers without
 * round-tripping through the browser. Without inputs the periodiseringsfond
 * is proposed at its maximum, which also lowers the schablonavdrag.
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

  // the declaration starts from NE R11, not the income statement, which
  // leaves out every year-end entry, booked avskrivningar included; R13 adds
  // back the costs that may not be deducted and R14 takes out tax-free income
  const { rutor } = await generateNEDeclaration(supabase, companyId, fiscalPeriodId)
  const bookedSurplus = rutor.R11
  const surplusBeforeRantefordelning = rutor.R12 + rutor.R13 - rutor.R14
  const fiscalYear = parseInt(period.period_end.slice(0, 4), 10)

  // follow the NE order: räntefördelning comes before the periodiseringsfond
  // cap in R33, and both fonder come before R42, the schablonavdrag base; the
  // schablonavdrag never lowers the periodiseringsfond base (IL 30 kap. 6 §)
  let surplus = surplusBeforeRantefordelning

  const r = calculateRantefordelning({ kapitalunderlag: input.kapitalunderlag ?? 0 })
  if (r) surplus += r.kind === 'rantefordelning_positive' ? -r.amount : r.amount

  const pfond = proposeEfPfondAvsattning({
    surplus,
    fiscalYear,
    desiredAmount: input.pfondDesiredAmount,
  })
  if (pfond) surplus -= pfond.amount

  let exp: EfDeclarationItem | null = null
  if (input.expansionsfondDesiredChange && input.expansionsfondDesiredChange !== 0) {
    exp = calculateExpansionsfondChange({
      kapitalunderlag: input.kapitalunderlag ?? 0,
      existingBalance: input.expansionsfondExistingBalance,
      desiredChange: input.expansionsfondDesiredChange,
    })
    if (exp) surplus += exp.kind === 'expansionsfond_avsattning' ? -exp.amount : exp.amount
  }

  const eg = calculateEgenavgifter({
    surplusBeforeEgenavgifter: surplus,
    category: input.category,
    priorYearSchablonavdrag: input.priorYearSchablonavdrag,
    priorYearActualCharged: input.priorYearActualCharged,
  })

  const items = [eg, r, pfond, exp].filter((item): item is EfDeclarationItem => item !== null)

  return {
    fiscalPeriod: period,
    bookedSurplus,
    surplusBeforeRantefordelning,
    items,
  }
}
