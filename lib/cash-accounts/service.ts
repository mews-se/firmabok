import type { SupabaseClient } from '@supabase/supabase-js'
import type { CashAccount } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('cash-accounts')

/**
 * Read surface for cash_accounts.
 *
 * Accepts an authenticated SupabaseClient and relies on RLS for tenancy
 * isolation. Defense-in-depth filter by company_id is applied regardless.
 */

export interface ListCashAccountsOptions {
  enabledOnly?: boolean
}

export async function listForCompany(
  supabase: SupabaseClient,
  companyId: string,
  opts: ListCashAccountsOptions = {},
): Promise<CashAccount[]> {
  let q = supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .order('is_primary', { ascending: false })
    .order('ledger_account', { ascending: true })

  if (opts.enabledOnly) q = q.eq('enabled', true)

  const { data, error } = await q
  if (error) {
    log.error('listForCompany failed', { companyId, error: error.message })
    return []
  }
  return (data ?? []) as CashAccount[]
}

/**
 * Primary cash account for a company. Filters by currency when provided. Falls
 * back to the global primary (`is_primary = true`) when no currency-specific
 * match exists.
 */
export async function getPrimary(
  supabase: SupabaseClient,
  companyId: string,
  currency?: string,
): Promise<CashAccount | null> {
  let q = supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_primary', true)
    .limit(1)

  if (currency) q = q.eq('currency', currency.toUpperCase())

  const { data, error } = await q.maybeSingle()
  if (error) {
    log.warn('getPrimary failed', { companyId, currency, error: error.message })
  }
  if (data) return data as CashAccount

  if (currency) {
    // Fall back to any-currency primary so a company without a SEK account still
    // resolves the sentinel: rare but possible (manual cash-on-hand only).
    const { data: anyPrimary } = await supabase
      .from('cash_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_primary', true)
      .maybeSingle()
    if (anyPrimary) return anyPrimary as CashAccount
  }

  return null
}
