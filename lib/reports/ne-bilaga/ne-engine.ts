import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { formatCurrency } from '@/lib/utils'
import type { FiscalPeriod } from '@/types'
import type {
  NEDeclaration,
  NEDeclarationRutor,
  NEAccountMapping,
} from './types'

/**
 * NE-bilaga (Enskild Firma / Sole Proprietorship Declaration)
 *
 * Maps BAS account balances to NE declaration rutor (R1-R14) for
 * tax reporting to Skatteverket.
 *
 * The ranges follow BAS-kontogruppen's kopplingstabell NE_EJ_K1
 * (bas.se/kontoplaner/sru), which covers every result account:
 * R1:  Momspliktiga intäkter (3000-3799 excl 3100)
 * R2:  Momsfria intäkter (3100, 3900-3999)
 * R3:  Bil- och bostadsförmån: no BAS account, entered by hand
 * R4:  Ränteintäkter m.m. (38xx and the financial income groups in 80xx-88xx)
 * R5:  Varor, material och tjänster (4000-4999)
 * R6:  Övriga externa kostnader (5000-6999)
 * R7:  Anställd personal (7000-7699)
 * R8:  Räntekostnader m.m. (774x, 779x, 79xx and the financial cost groups in 80xx-89xx)
 * R9:  Av- och nedskrivningar byggnader och markanläggningar (772x, 777x, 782x, 784x)
 * R10: Av- och nedskrivningar maskiner, inventarier och immateriella tillgångar
 *      (771x, 773x, 776x, 778x, 781x, 783x, 885x)
 * R11: Bokfört resultat (calculated)
 *
 * BAS splits 30xx-37xx and 39xx between R1 and R2 by the VAT on each account;
 * 3100 and 39xx count as momsfria here. Groups that BAS marks (+) or (-) go to
 * R4 when they hold an intäkt and to R8 when they hold a kostnad.
 *
 * On page 2, R12 carries R11 over, R13 adds back the costs booked on
 * NE_NON_DEDUCTIBLE_ACCOUNTS and R14 takes out the income booked on
 * NE_TAX_FREE_INCOME_ACCOUNTS; both stay in R1-R10 as well.
 */

/**
 * Accounts whose BAS name says the cost is ej avdragsgill, plus 8423 where the
 * skattekonto rules book the kostnadsränta. Other costs that may not be
 * deducted are entered in R13 by hand.
 */
export const NE_NON_DEDUCTIBLE_ACCOUNTS = [
  '5982', // Ej avdragsgill sponsring
  '6072', // Representation, ej avdragsgill
  '6342', // Lämnade skadestånd, ej avdragsgilla
  '6392', // Övriga riskkostnader, ej avdragsgilla
  '6982', // Föreningsavgifter, ej avdragsgilla
  '6992', // Övriga externa kostnader, ej avdragsgilla
  '7622', // Sjuk- och hälsovård, ej avdragsgill
  '7623', // Sjukvårdsförsäkring, ej avdragsgill
  '7632', // Personalrepresentation, ej avdragsgill
  '8423', // Räntekostnader för skatter och avgifter
]

/**
 * Interest that is not taxed, such as the intäktsränta on the skattekonto (8314)
 */
export const NE_TAX_FREE_INCOME_ACCOUNTS = [
  '8254', // Skattefria ränteintäkter, långfristiga tillgångar
  '8314', // Skattefria ränteintäkter
]

/**
 * Account mapping configuration for NE declaration
 */
export const NE_ACCOUNT_MAPPINGS: NEAccountMapping[] = [
  {
    ruta: 'R1',
    description: 'Försäljning och utfört arbete samt övriga momspliktiga intäkter',
    accountRanges: [
      { start: '3000', end: '3799', exclude: ['3100'] },
    ],
    isExpense: false,
  },
  {
    ruta: 'R2',
    description: 'Momsfria intäkter',
    accountRanges: [
      { start: '3100', end: '3100' },
      { start: '3900', end: '3999' },
    ],
    isExpense: false,
  },
  {
    ruta: 'R4',
    description: 'Ränteintäkter m.m.',
    accountRanges: [
      { start: '3800', end: '3899' },
      { start: '8010', end: '8019' },
      { start: '8020', end: '8039', side: 'credit' },
      { start: '8110', end: '8119' },
      { start: '8120', end: '8139', side: 'credit' },
      { start: '8200', end: '8219' },
      { start: '8220', end: '8249', side: 'credit' },
      { start: '8250', end: '8269' },
      { start: '8290', end: '8299', side: 'credit' },
      { start: '8300', end: '8319' },
      { start: '8320', end: '8339', side: 'credit' },
      { start: '8340', end: '8349' },
      { start: '8350', end: '8359', side: 'credit' },
      { start: '8360', end: '8369' },
      { start: '8390', end: '8399' },
      { start: '8430', end: '8439', side: 'credit' },
      { start: '8440', end: '8449' },
      { start: '8450', end: '8459', side: 'credit' },
      { start: '8490', end: '8499', side: 'credit' },
      { start: '8810', end: '8819', side: 'credit' },
      { start: '8860', end: '8869', side: 'credit' },
      { start: '8880', end: '8899', side: 'credit' },
    ],
    isExpense: false,
  },
  {
    ruta: 'R5',
    description: 'Varor, material och tjänster',
    accountRanges: [
      { start: '4000', end: '4999' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R6',
    description: 'Övriga externa kostnader',
    accountRanges: [
      { start: '5000', end: '6999' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R7',
    description: 'Anställd personal',
    accountRanges: [
      { start: '7000', end: '7699' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R8',
    description: 'Räntekostnader m.m.',
    accountRanges: [
      { start: '7740', end: '7749' },
      { start: '7790', end: '7799' },
      { start: '7900', end: '7999' },
      { start: '8020', end: '8039', side: 'debit' },
      { start: '8070', end: '8089' },
      { start: '8120', end: '8139', side: 'debit' },
      { start: '8170', end: '8189' },
      { start: '8220', end: '8249', side: 'debit' },
      { start: '8270', end: '8289' },
      { start: '8290', end: '8299', side: 'debit' },
      { start: '8320', end: '8339', side: 'debit' },
      { start: '8350', end: '8359', side: 'debit' },
      { start: '8370', end: '8389' },
      { start: '8400', end: '8429' },
      { start: '8430', end: '8439', side: 'debit' },
      { start: '8450', end: '8459', side: 'debit' },
      { start: '8460', end: '8469' },
      { start: '8480', end: '8489' },
      { start: '8490', end: '8499', side: 'debit' },
      { start: '8810', end: '8819', side: 'debit' },
      { start: '8860', end: '8869', side: 'debit' },
      { start: '8880', end: '8899', side: 'debit' },
      { start: '8900', end: '8989' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R9',
    description: 'Av- och nedskrivningar byggnader och markanläggningar',
    accountRanges: [
      { start: '7720', end: '7729' },
      { start: '7770', end: '7779' },
      { start: '7820', end: '7829' },
      { start: '7840', end: '7849' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R10',
    description: 'Av- och nedskrivningar maskiner, inventarier och immateriella tillgångar',
    accountRanges: [
      { start: '7710', end: '7719' },
      { start: '7730', end: '7739' },
      { start: '7760', end: '7769' },
      { start: '7780', end: '7789' },
      { start: '7810', end: '7819' },
      { start: '7830', end: '7839' },
      { start: '8850', end: '8859' },
    ],
    isExpense: true,
  },
]

/**
 * Check if an account balance falls within a mapping's ranges
 */
function isAccountInMapping(accountNumber: string, balance: number, mapping: NEAccountMapping): boolean {
  for (const range of mapping.accountRanges) {
    const num = accountNumber
    if (num >= range.start && num <= range.end) {
      // Check exclusions
      if (range.exclude && range.exclude.includes(num)) {
        continue
      }
      // balance is debit - credit, so a credit balance is negative
      if (range.side && range.side !== (balance < 0 ? 'credit' : 'debit')) {
        continue
      }
      return true
    }
  }
  return false
}

/**
 * The mapping whose ruta an account balance belongs to, or null when no ruta takes it
 */
export function findNEMapping(accountNumber: string, balance: number): NEAccountMapping | null {
  return NE_ACCOUNT_MAPPINGS.find((mapping) => isAccountInMapping(accountNumber, balance, mapping)) ?? null
}

/**
 * Round to the nearest krona. Skatteverket wants whole kronor on the NE without
 * saying which way; "öretal faller bort" (SFF 22 kap. 1 §) covers skatt and avgift.
 */
function roundToKrona(value: number): number {
  return Math.round(value)
}

/**
 * Generate NE declaration for a fiscal period
 */
export async function generateNEDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<NEDeclaration> {

  // Fetch fiscal period
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  // Fetch company settings
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name, org_number, entity_type, address_line1, postal_code, city, email')
    .eq('company_id', companyId)
    .single()

  // Resolve entity_type: prefer company_settings, fall back to companies table (NOT NULL, always reliable)
  let entityType = settings?.entity_type
  if (!entityType) {
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()
    if (companyError) throw new Error(`Failed to resolve entity type: ${companyError.message}`)
    entityType = company?.entity_type
  }

  if (entityType !== 'enskild_firma') {
    throw new Error('NE declaration is only for enskild firma (sole proprietorship)')
  }

  // R1-R11 are an income statement, so read the PRE-CLOSING books. The
  // resultatavslut zeroes every P&L account against 2019/2099 at year-end, and
  // NE-bilaga is always filed after bokslut, so including it would report an
  // empty näringsverksamhet. 'exclude-final' drops only
  // fiscal_periods.closing_entry_id: avskrivningar and other bokslut entries
  // also carry source_type 'year_end' and belong on the form.
  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    closingEntry: 'exclude-final',
  })

  const accountNameMap = new Map<string, string>()
  const accountBalances = new Map<string, number>()
  for (const row of trialBalance.rows) {
    accountNameMap.set(row.account_number, row.account_name)
    accountBalances.set(
      row.account_number,
      (Number(row.closing_debit) || 0) - (Number(row.closing_credit) || 0),
    )
  }

  // Map account balances to NE rutor
  const rutor: NEDeclarationRutor = {
    R1: 0,
    R2: 0,
    R3: 0,
    R4: 0,
    R5: 0,
    R6: 0,
    R7: 0,
    R8: 0,
    R9: 0,
    R10: 0,
    R11: 0,
    R12: 0,
    R13: 0,
    R14: 0,
  }

  const breakdown: Record<keyof NEDeclarationRutor, {
    accounts: Array<{ accountNumber: string; accountName: string; amount: number }>
    total: number
  }> = {
    R1: { accounts: [], total: 0 },
    R2: { accounts: [], total: 0 },
    R3: { accounts: [], total: 0 },
    R4: { accounts: [], total: 0 },
    R5: { accounts: [], total: 0 },
    R6: { accounts: [], total: 0 },
    R7: { accounts: [], total: 0 },
    R8: { accounts: [], total: 0 },
    R9: { accounts: [], total: 0 },
    R10: { accounts: [], total: 0 },
    R11: { accounts: [], total: 0 },
    R12: { accounts: [], total: 0 },
    R13: { accounts: [], total: 0 },
    R14: { accounts: [], total: 0 },
  }

  const warnings: string[] = []
  const unmappedWarnings: string[] = []

  // Process each account balance
  for (const [accountNumber, balance] of accountBalances) {
    // Skip zero balances
    if (Math.abs(balance) < 0.01) continue

    const mapping = findNEMapping(accountNumber, balance)
    if (!mapping) {
      // classes 1-2 are the balance sheet; a result account left here is missing from R11
      if (accountNumber[0] >= '3' && accountNumber[0] <= '8') {
        const amount = formatCurrency(Math.abs(balance), 'SEK', { minimumFractionDigits: 2 })
        unmappedWarnings.push(
          `Konto ${accountNumber} ${accountNameMap.get(accountNumber) ?? ''} (${amount} i ${balance > 0 ? 'debet' : 'kredit'}) ` +
            'hör inte till någon ruta och saknas i NE-bilagan, så R11 skiljer sig från det bokförda resultatet.',
        )
      }
      continue
    }

    // For revenue accounts (credit normal), negate the balance
    // For expense accounts (debit normal), use as-is
    // Net balance is debit - credit, so:
    // - Revenue accounts have negative net balance (credit > debit)
    // - Expense accounts have positive net balance (debit > credit)
    const amount = mapping.isExpense ? balance : -balance
    const accountName = accountNameMap.get(accountNumber) || `Konto ${accountNumber}`

    rutor[mapping.ruta] += amount

    breakdown[mapping.ruta].accounts.push({
      accountNumber,
      accountName,
      amount: roundToKrona(amount),
    })

    if (NE_NON_DEDUCTIBLE_ACCOUNTS.includes(accountNumber)) {
      rutor.R13 += balance
      breakdown.R13.accounts.push({ accountNumber, accountName, amount: roundToKrona(balance) })
    }
    if (NE_TAX_FREE_INCOME_ACCOUNTS.includes(accountNumber)) {
      rutor.R14 -= balance
      breakdown.R14.accounts.push({ accountNumber, accountName, amount: roundToKrona(-balance) })
    }
  }

  // Round all rutor to whole numbers
  for (const key of Object.keys(rutor) as (keyof NEDeclarationRutor)[]) {
    if (key !== 'R11' && key !== 'R12') {
      rutor[key] = roundToKrona(rutor[key])
      breakdown[key].total = rutor[key]
    }
  }

  // Calculate R11 (Bokfört resultat)
  // Result = Revenue (R1+R2+R3+R4) - Expenses (R5+R6+R7+R8+R9+R10)
  const totalRevenue = rutor.R1 + rutor.R2 + rutor.R3 + rutor.R4
  const totalExpenses = rutor.R5 + rutor.R6 + rutor.R7 + rutor.R8 + rutor.R9 + rutor.R10
  rutor.R11 = totalRevenue - totalExpenses
  breakdown.R11.total = rutor.R11
  rutor.R12 = rutor.R11
  breakdown.R12.total = rutor.R12

  // Add warnings
  if (!(period as FiscalPeriod).is_closed) {
    warnings.push('Räkenskapsåret är inte stängt; deklarationen kan genereras, men siffrorna kan ändras om fler bokföringar görs.')
  }

  if (rutor.R11 === 0 && totalRevenue === 0) {
    warnings.push('Inga bokförda intäkter eller kostnader hittades för perioden.')
  }

  warnings.push(...unmappedWarnings)

  // the SRU fields only take a positive amount; the other sign means a reversal outweighed the year
  if (rutor.R13 < 0) {
    warnings.push('Kontona för ej avdragsgilla kostnader har sammanlagt ett kreditsaldo, så R13 lämnas tom.')
    rutor.R13 = 0
    breakdown.R13.total = 0
  }
  if (rutor.R14 < 0) {
    warnings.push('Kontona för skattefria ränteintäkter har sammanlagt ett debetsaldo, så R14 lämnas tom.')
    rutor.R14 = 0
    breakdown.R14.total = 0
  }

  return {
    fiscalYear: {
      id: period.id,
      name: period.name,
      start: period.period_start,
      end: period.period_end,
      isClosed: period.is_closed,
    },
    rutor,
    breakdown,
    companyInfo: {
      companyName: settings?.company_name || 'Okänt företag',
      orgNumber: settings?.org_number || null,
      addressLine1: settings?.address_line1 || null,
      postalCode: settings?.postal_code || null,
      city: settings?.city || null,
      email: settings?.email || null,
    },
    warnings,
  }
}

/**
 * Get totals for display
 */
export function getNEDeclarationTotals(declaration: NEDeclaration): {
  totalRevenue: number
  totalExpenses: number
  netResult: number
} {
  const { rutor } = declaration

  return {
    totalRevenue: rutor.R1 + rutor.R2 + rutor.R3 + rutor.R4,
    totalExpenses: rutor.R5 + rutor.R6 + rutor.R7 + rutor.R8 + rutor.R9 + rutor.R10,
    netResult: rutor.R11,
  }
}
