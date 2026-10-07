/**
 * Static configuration of all Swedish tax deadlines (Skatteverket)
 * Based on Skatteverket's official deadline schedule
 */

import type { TaxDeadlineType, EntityType, MomsPeriod, TaxFilingMethod } from '@/types'

// Condition function type for determining if a deadline applies
export type DeadlineCondition = (settings: CompanySettingsForDeadlines) => boolean

export interface TaxAssessmentNoticeForDeadline {
  id: string
  fiscalPeriodName: string
  decisionType: 'final' | 'reassessment'
  paymentDueDate: string
}

// Subset of company settings needed for deadline generation
export interface CompanySettingsForDeadlines {
  entity_type: EntityType
  moms_period: MomsPeriod | null
  f_skatt: boolean
  preliminary_tax_monthly: number | null
  vat_registered: boolean
  fiscal_year_start_month: number // 1-12
  vat_taxable_base_over_40m: boolean
  vat_has_eu_trade: boolean
  vat_filing_method: TaxFilingMethod
  periodisk_sammanstallning_enabled: boolean
  periodisk_sammanstallning_period: 'monthly' | 'quarterly'
  periodisk_sammanstallning_filing_method: TaxFilingMethod
  rot_rut_enabled: boolean
  fyllnadsinbetalning_enabled: boolean
  /**
   * Derived, NOT a company_settings column: distinct years with paid ROT/RUT
   * invoices. Populated by the generator from the invoices table (a begäran
   * deadline for year Y only exists when Y actually has ROT/RUT payments,
   * Lag 2009:194 8 §). Undefined in pure-settings contexts (backfill
   * detection), where rot_rut_begaran rows are simply never expected.
   */
  rot_rut_payment_years?: number[]
  /** Derived from active tax_assessment_notices rows by the generator. */
  tax_assessment_notices?: TaxAssessmentNoticeForDeadline[]
}

// Configuration for a single tax deadline type
export interface TaxDeadlineConfig {
  type: TaxDeadlineType
  titleTemplate: string
  description: string
  condition: DeadlineCondition
  priority: 'critical' | 'important' | 'normal'
  // Function to generate all instances for a year
  generateDates: (year: number, settings: CompanySettingsForDeadlines) => DeadlineInstance[]
  // Link to report type for navigation
  linkedReportType: string | null
  /**
   * Dates that must not move to the next banking day, such as a payment
   * date Skatteverket has already decided (kvarskatt).
   */
  skipBankingDayAdjustment?: boolean
}

// A specific instance of a deadline
export interface DeadlineInstance {
  day: number      // Day of month
  month: number    // 0-indexed month
  year: number
  period: string   // e.g., "2025-Q1", "2025-01", "2025"
  periodLabel: string // Human-readable, e.g., "Q1 2025", "januari 2025"
  taxAssessmentNoticeId?: string
}

function getFiscalYearLabel(fiscalYearEndMonth: number, fiscalYearEndYear: number): string {
  return fiscalYearEndMonth === 12
    ? `${fiscalYearEndYear}`
    : `${fiscalYearEndYear - 1}/${fiscalYearEndYear}`
}

function getAnnualVatDeadline(
  fiscalYearEndMonth: number,
  fiscalYearEndYear: number,
  settings: CompanySettingsForDeadlines,
): { day: number; month: number; year: number } {
  // Enskild firma (calendar year only, BFL 3 kap.): without EU trade the
  // annual momsdeklaration follows the income tax return (12 May); with EU
  // trade it is due 26 February (26 kap. 33-33a §§ SFL, Skatteverket's
  // published helårsmoms schedule).
  if (settings.entity_type === 'enskild_firma') {
    return settings.vat_has_eu_trade
      ? { day: 26, month: 1, year: fiscalYearEndYear + 1 }
      : { day: 12, month: 4, year: fiscalYearEndYear + 1 }
  }

  if (settings.vat_has_eu_trade) {
    const month = (fiscalYearEndMonth + 1) % 12
    const year = fiscalYearEndYear + (fiscalYearEndMonth >= 11 ? 1 : 0)
    // A 26 December due date lands on annandag jul; the banking-day
    // adjustment moves it to Skatteverket's published 27th (or later).
    return { day: 26, month, year }
  }

  const paper = settings.vat_filing_method === 'paper'
  if (fiscalYearEndMonth <= 4) {
    return { day: 12, month: paper ? 10 : 11, year: fiscalYearEndYear }
  }
  if (fiscalYearEndMonth <= 6) {
    return paper
      ? { day: 27, month: 11, year: fiscalYearEndYear }
      : { day: 17, month: 0, year: fiscalYearEndYear + 1 }
  }
  if (fiscalYearEndMonth <= 8) {
    return { day: 12, month: paper ? 2 : 3, year: fiscalYearEndYear + 1 }
  }
  return { day: paper ? 12 : 17, month: paper ? 6 : 7, year: fiscalYearEndYear + 1 }
}

function generateAnnualVatDates(
  deadlineYear: number,
  settings: CompanySettingsForDeadlines,
): DeadlineInstance[] {
  const fiscalYearEndMonth = settings.entity_type === 'enskild_firma'
    ? 12
    : (settings.fiscal_year_start_month === 1 ? 12 : settings.fiscal_year_start_month - 1)
  const results: DeadlineInstance[] = []

  for (const fiscalYearEndYear of [deadlineYear - 1, deadlineYear]) {
    const deadline = getAnnualVatDeadline(fiscalYearEndMonth, fiscalYearEndYear, settings)
    if (deadline.year !== deadlineYear) continue

    const period = getFiscalYearLabel(fiscalYearEndMonth, fiscalYearEndYear)
    results.push({
      ...deadline,
      period,
      periodLabel: period,
    })
  }

  return results
}

/**
 * All tax deadline configurations
 */
export const TAX_DEADLINE_CONFIGS: TaxDeadlineConfig[] = [
  // Momsdeklaration (monthly)
  {
    type: 'moms_monthly',
    titleTemplate: 'Momsdeklaration {periodLabel}',
    description: 'Momsdeklaration för månadsredovisare',
    condition: (s) => s.vat_registered && s.moms_period === 'monthly',
    priority: 'important',
    linkedReportType: 'vat',
    generateDates: (year, settings) => {
      const instances: DeadlineInstance[] = []
      for (let month = 0; month < 12; month++) {
        const monthOffset = settings.vat_taxable_base_over_40m ? 1 : 2
        const deadlineMonth = (month + monthOffset) % 12
        const deadlineYear = year + Math.floor((month + monthOffset) / 12)
        // Above SEK 40M the 26th applies year-round; 26 December is annandag
        // jul, and the banking-day adjustment yields Skatteverket's 27th.
        const day = settings.vat_taxable_base_over_40m
          ? 26
          : (deadlineMonth === 0 || deadlineMonth === 7 ? 17 : 12)
        instances.push({
          day,
          month: deadlineMonth,
          year: deadlineYear,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        })
      }
      return instances
    },
  },

  // Momsdeklaration (quarterly)
  {
    type: 'moms_quarterly',
    titleTemplate: 'Momsdeklaration {periodLabel}',
    description: 'Momsdeklaration för kvartalsredovisare',
    condition: (s) => s.vat_registered && s.moms_period === 'quarterly',
    priority: 'important',
    linkedReportType: 'vat',
    generateDates: (year) => {
      return [
        { day: 12, month: 4, year, period: `${year}-Q1`, periodLabel: `Q1 ${year}` },
        { day: 17, month: 7, year, period: `${year}-Q2`, periodLabel: `Q2 ${year}` },
        { day: 12, month: 10, year, period: `${year}-Q3`, periodLabel: `Q3 ${year}` },
        { day: 12, month: 1, year: year + 1, period: `${year}-Q4`, periodLabel: `Q4 ${year}` },
      ]
    },
  },

  // Momsdeklaration (yearly)
  {
    type: 'moms_yearly',
    titleTemplate: 'Momsdeklaration {periodLabel}',
    description: 'Momsdeklaration för årsredovisare',
    condition: (s) => s.vat_registered && s.moms_period === 'yearly',
    priority: 'important',
    linkedReportType: 'vat',
    generateDates: (year, settings) => generateAnnualVatDates(year, settings),
  },

  // Debiterad preliminärskatt (monthly payment). Gated on the debited amount,
  // NOT on F-skatt approval: approval is a status with no recurring duty, and
  // Skatteverket debits nothing below 2 400 kr/år (SFL 55 kap. 2 §). The
  // monthly payment obligation exists only while an amount > 0 is debited
  // (SFL 62 kap. 4-5 §§).
  {
    type: 'f_skatt',
    titleTemplate: 'Betala preliminärskatt {periodLabel}',
    description: 'Inbetalning av debiterad preliminärskatt',
    condition: (s) => (s.preliminary_tax_monthly ?? 0) > 0,
    priority: 'important',
    linkedReportType: null,
    generateDates: (year, settings) => {
      // Small-company förfallodagar are the 12th, with the 17th in January
      // and August; storföretag (VAT taxable base over SEK 40M) keep the
      // 12th in August, January-only 17th (62 kap. 3-4 §§ SFL and
      // Skatteverket's published storföretag calendar).
      const storforetag = settings.vat_registered && settings.vat_taxable_base_over_40m
      const instances: DeadlineInstance[] = []
      for (let month = 0; month < 12; month++) {
        instances.push({
          day: month === 0 || (month === 7 && !storforetag) ? 17 : 12,
          month,
          year,
          period: `${year}-${String(month + 1).padStart(2, '0')}`,
          periodLabel: getMonthLabel(month, year),
        })
      }
      return instances
    },
  },

  // Periodisk sammanställning (EU sales)
  {
    type: 'periodisk_sammanstallning',
    titleTemplate: 'Periodisk sammanställning {periodLabel}',
    description: 'Periodisk sammanställning för EU-försäljning',
    condition: (s) => s.vat_registered && s.periodisk_sammanstallning_enabled,
    priority: 'normal',
    linkedReportType: null,
    generateDates: (year, settings) => {
      const day = settings.periodisk_sammanstallning_filing_method === 'paper' ? 20 : 25
      if (settings.periodisk_sammanstallning_period === 'quarterly') {
        return [
          { day, month: 3, year, period: `${year}-Q1`, periodLabel: `Q1 ${year}` },
          { day, month: 6, year, period: `${year}-Q2`, periodLabel: `Q2 ${year}` },
          { day, month: 9, year, period: `${year}-Q3`, periodLabel: `Q3 ${year}` },
          { day, month: 0, year: year + 1, period: `${year}-Q4`, periodLabel: `Q4 ${year}` },
        ]
      }

      return Array.from({ length: 12 }, (_, month) => ({
        day,
        month: (month + 1) % 12,
        year: month === 11 ? year + 1 : year,
        period: `${year}-${String(month + 1).padStart(2, '0')}`,
        periodLabel: getMonthLabel(month, year),
      }))
    },
  },

  // Fyllnadsinbetalning: extra preliminary tax payments that stop
  // kostnadsränta on the coming kvarskatt (SFL 62 kap. 8 §, 65 kap.).
  // Parts over 30 000 kr must be on skattekontot by the 12th of the second
  // month after the beskattningsår ends (12 Feb for calendar years); the
  // remainder by the 3rd of the fifth month (3 May). Both dates are
  // generated since the app cannot know the kvarskatt amount; the labels
  // say which part each date covers.
  {
    type: 'fyllnadsinbetalning',
    titleTemplate: 'Fyllnadsinbetalning {periodLabel}',
    description: 'Extra inbetalning av preliminärskatt för att undvika kostnadsränta',
    condition: (s) => s.fyllnadsinbetalning_enabled,
    priority: 'normal',
    linkedReportType: null,
    generateDates: (year, settings) => {
      const fyEndMonth = settings.entity_type === 'enskild_firma'
        ? 12
        : (settings.fiscal_year_start_month === 1 ? 12 : settings.fiscal_year_start_month - 1)
      const results: DeadlineInstance[] = []
      for (const fyEndYear of [year - 1, year]) {
        const fyLabel = getFiscalYearLabel(fyEndMonth, fyEndYear)
        // fyEndMonth is 1-indexed; (fyEndMonth - 1 + n) is the 0-indexed
        // month n months after FY end, counted from fyEndYear's January.
        // 12th of the second month after FY end (amounts over 30 000 kr):
        // February for a calendar fiscal year.
        const over = {
          day: 12,
          month: (fyEndMonth + 1) % 12,
          year: fyEndYear + Math.floor((fyEndMonth + 1) / 12),
        }
        if (over.year === year) {
          results.push({
            ...over,
            period: `${fyLabel}-over30k`,
            periodLabel: `belopp över 30 000 kr, beskattningsår ${fyLabel}`,
          })
        }
        // 3rd of the fifth month after FY end (the remainder): May for a
        // calendar fiscal year.
        const rest = {
          day: 3,
          month: (fyEndMonth + 4) % 12,
          year: fyEndYear + Math.floor((fyEndMonth + 4) / 12),
        }
        if (rest.year === year) {
          results.push({
            ...rest,
            period: `${fyLabel}-rest`,
            periodLabel: `resterande belopp, beskattningsår ${fyLabel}`,
          })
        }
      }
      return results
    },
  },

  // Kvarskatt: the payment date is copied exactly from the final tax notice
  // or reassessment decision. It must not be estimated or moved to a banking
  // day because Skatteverket has already determined the statutory due date.
  {
    type: 'kvarskatt',
    titleTemplate: 'Kvarskatt {periodLabel}',
    description: 'Kvarskatt enligt slutskattebesked eller omprövningsbeslut',
    condition: (s) => (s.tax_assessment_notices?.length ?? 0) > 0,
    priority: 'critical',
    linkedReportType: null,
    skipBankingDayAdjustment: true,
    generateDates: (year, settings) => (settings.tax_assessment_notices ?? [])
      .filter((notice) => Number(notice.paymentDueDate.slice(0, 4)) === year)
      .map((notice) => ({
        day: Number(notice.paymentDueDate.slice(8, 10)),
        month: Number(notice.paymentDueDate.slice(5, 7)) - 1,
        year,
        period: `notice:${notice.id}`,
        periodLabel: notice.decisionType === 'reassessment'
          ? `omprövning, ${notice.fiscalPeriodName}`
          : `slutskattebesked, ${notice.fiscalPeriodName}`,
        taxAssessmentNoticeId: notice.id,
      })),
  },

  // ROT/RUT begäran om utbetalning: the payout request for deductions given
  // during year Y must reach Skatteverket by 31 January of year Y+1
  // (Lag 2009:194 8 §). Missing the date forfeits the payout on account
  // 1513, so this is the one deadline where lateness costs the principal,
  // not a fee. Keyed on PAYMENT years (buyer paid), never invoice dates:
  // rows only exist for years present in rot_rut_payment_years.
  {
    type: 'rot_rut_begaran',
    titleTemplate: 'ROT/RUT-begäran om utbetalning {periodLabel}',
    description: 'Begäran om utbetalning för ROT/RUT-avdrag till Skatteverket',
    condition: (s) => s.rot_rut_enabled,
    priority: 'critical',
    linkedReportType: null,
    generateDates: (year, settings) => {
      if (!(settings.rot_rut_payment_years ?? []).includes(year - 1)) {
        return []
      }
      return [
        { day: 31, month: 0, year, period: `${year - 1}`, periodLabel: `${year - 1}` },
      ]
    },
  },

  // Inkomstdeklaration (EF) - 2 maj
  {
    type: 'inkomstdeklaration_ef',
    titleTemplate: 'Inkomstdeklaration + NE-bilaga {periodLabel}',
    description: 'Inkomstdeklaration för enskild firma',
    condition: (s) => s.entity_type === 'enskild_firma',
    priority: 'critical',
    linkedReportType: 'ne-declaration',
    generateDates: (year) => {
      // Due May 2nd for previous year's income
      return [
        { day: 2, month: 4, year, period: `${year - 1}`, periodLabel: `${year - 1}` },
      ]
    },
  },
]

/**
 * Helper to get month label in Swedish
 */
function getMonthLabel(month: number, year: number): string {
  const months = [
    'januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december'
  ]
  return `${months[month]} ${year}`
}

/**
 * Get all applicable deadline configs for given company settings
 */
export function getApplicableDeadlineConfigs(
  settings: CompanySettingsForDeadlines
): TaxDeadlineConfig[] {
  return TAX_DEADLINE_CONFIGS.filter((config) => config.condition(settings))
}

/**
 * Map from tax deadline type to report URL generator
 */
export const REPORT_URLS: Record<string, (period: { year: number; quarter?: number; month?: number }) => string> = {
  vat: (p) => {
    if (p.quarter) {
      return `/reports?tab=vat&year=${p.year}&period=${p.quarter}`
    }
    if (p.month) {
      return `/reports?tab=vat&year=${p.year}&period=${p.month}`
    }
    return `/reports?tab=vat&year=${p.year}`
  },
  'ne-declaration': () => '/reports?tab=ne-declaration',
}

/**
 * Get the report URL for a deadline
 */
export function getReportUrl(
  linkedReportType: string | null,
  linkedReportPeriod: Record<string, unknown> | null
): string | null {
  if (!linkedReportType || !linkedReportPeriod) {
    return null
  }

  const urlGenerator = REPORT_URLS[linkedReportType]
  if (!urlGenerator) {
    return null
  }

  return urlGenerator(linkedReportPeriod as { year: number; quarter?: number; month?: number })
}
