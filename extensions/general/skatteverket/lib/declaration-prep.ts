import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatPeriodType } from '@/types'
import { calculateVatDeclaration, resolvePeriodDates } from '@/lib/reports/vat-declaration'
import { rutorToMomsuppgift, formatRedovisare, formatRedovisningsperiod } from './mappers'
import type { SkatteverketMomsuppgift } from '../types'

/**
 * Request-free Skatteverket declaration prep.
 *
 * These functions are the single source of truth for what gets filed to
 * Skatteverket. They are shared by the HTTP route handlers
 * (parseDeclarationRequest) and the commit-side service
 * (commitSubmitVatDeclaration) so the numbers computed at preview time match
 * exactly what is filed at commit time.
 *
 * Compliance-critical: drift between the two paths would mean different
 * figures filed to SKV than the user reviewed. Keep these the only place that
 * computes momsuppgift.
 */

export interface VatDeclarationPrep {
  redovisare: string
  redovisningsperiod: string
  momsuppgift: SkatteverketMomsuppgift
}

/**
 * Resolve a company's 12-digit "redovisare" string from company_settings.
 * Shared by the VAT path and by the status tools that only need the
 * identifier (no momsuppgift compute).
 */
export async function resolveRedovisare(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('org_number, entity_type')
    .eq('company_id', companyId)
    .single()

  if (!settings?.org_number) {
    throw new Error('Organisationsnummer saknas i företagsinställningar')
  }

  return formatRedovisare(settings.org_number, settings.entity_type)
}

/**
 * Compute the momsuppgift filed to SKV for a period, from the general ledger.
 * Body lifted verbatim from the former parseDeclarationRequest so route and
 * commit paths produce identical payloads.
 */
export async function buildMomsuppgift(
  supabase: SupabaseClient,
  companyId: string,
  input: { periodType: VatPeriodType; year: number; period: number; fiscalPeriodId?: string },
): Promise<VatDeclarationPrep> {
  const { periodType, year, period, fiscalPeriodId } = input

  const redovisare = await resolveRedovisare(supabase, companyId)

  // Helårsmoms is filed per räkenskapsår (SFL 26 kap 10-11 §§): the SKV
  // redovisningsperiod is the FY-end month, which for a broken fiscal year is
  // not December. Resolve the fiscal period's actual bounds so the period
  // identifier and the figures below always describe the same räkenskapsår.
  let fiscalYearEnd: { year: number; month: number } | undefined
  if (periodType === 'yearly') {
    const { end } = await resolvePeriodDates(
      supabase, companyId, periodType, year, period, fiscalPeriodId,
    )
    fiscalYearEnd = { year: Number(end.slice(0, 4)), month: Number(end.slice(5, 7)) }
  }
  const redovisningsperiod = formatRedovisningsperiod(periodType, year, period, fiscalYearEnd)

  // Calculate VAT declaration from the general ledger
  const declaration = await calculateVatDeclaration(
    supabase,
    companyId,
    periodType,
    year,
    period,
    { fiscalPeriodId },
  )

  const momsuppgift = rutorToMomsuppgift(declaration.rutor)

  return { redovisare, redovisningsperiod, momsuppgift }
}
