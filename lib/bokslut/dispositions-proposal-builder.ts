import type { SupabaseClient } from '@supabase/supabase-js'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import type { DispositionsProposal } from './types'

/**
 * Result before year-end for the dispositions step of the bokslut wizard and
 * the MCP tool. An enskild firma books no bokslutsdispositioner: egenavgifter,
 * räntefördelning, periodiseringsfond and expansionsfond are declared in the
 * NE-bilaga (see enskild-firma/ef-declaration-preview) and never produce
 * journal entries.
 */
export async function buildDispositionsProposal(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<DispositionsProposal> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const entityType = (settings?.entity_type ?? 'aktiebolag') as DispositionsProposal['entityType']

  const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
  return {
    entityType,
    fiscalPeriod: period,
    netResultBefore: incomeStatement.net_result,
  }
}
